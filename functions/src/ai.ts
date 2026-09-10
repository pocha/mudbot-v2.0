import { genkit, z } from "genkit";
import { googleAI } from "@genkit-ai/google-genai";
import { defineFirestoreRetriever } from "@genkit-ai/firebase";
import { getFirestore } from "firebase-admin/firestore";
import { EMBEDDING_DIMENSION, MEMORY_RETRIEVAL_TOP_K, CAPABILITY_SHORTLIST_TOP_K, CAPABILITY_SHORTLIST_MIN_SIMILARITY } from "./config";
import { CapabilityCandidateSchema, DecisionSchema } from "./types/domain";
import type { CapabilityCandidate, CapabilityDoc, MemoryDoc } from "./types/domain";

/**
 * Everything that talks to Gemini or to the embeddings it produces, in one
 * file — setup, memory (embed/store/retrieve), capability matching, and the
 * single decision call, all built on the same `ai`/`embedder` instance.
 * Previously split across genkit.ts, flows/decide.ts, capabilities/registry.ts
 * and memory/firestoreRetriever.ts; consolidated since none of them are big
 * or independent enough on their own to earn a separate file, and every one
 * of them exists only in service of that one `ai` instance below.
 */

// One place tying the orchestrator to Gemini. Uses the Gemini Developer API
// (Google AI Studio), not Vertex AI — that's what actually has a free tier;
// Vertex is pay-per-use even on a fresh project. GEMINI_API_KEY defaults to a
// shared "house" key with free-tier quota; a per-user key (once a user plugs
// in their own) should override it here before this module is loaded.
export const ai = genkit({
  plugins: [googleAI({ apiKey: process.env.GEMINI_API_KEY })],
});

// Referenced by string ID rather than a named export: this repo was scaffolded
// with a training cutoff of Jan 2026, so pin whatever the current small/cheap
// Gemini model is in the model garden at build time rather than trusting a
// hardcoded named import to still exist or be current.
export const synthesisModel = googleAI.model(process.env.GEMINI_MODEL_ID ?? "gemini-3.1-flash-lite");

// text-embedding-005 (the old default here) is a Vertex AI model name — it
// 404s against the Gemini Developer API's embedContent endpoint, which only
// serves gemini-embedding-*. That model's native output is 3072-dim; pinned
// down via EMBEDDING_DIMENSION (config.ts) to match firestore.indexes.json's
// vector index. Confirm against the current model garden if this drifts further.
export const embedder = googleAI.embedder(
  (process.env.EMBEDDING_MODEL_ID ?? "gemini-embedding-001") as Parameters<typeof googleAI.embedder>[0],
  { outputDimensionality: EMBEDDING_DIMENSION }
);

// --- Memory: embed, store, and retrieve a user's own conversation history ---

/**
 * Vector-search retriever scoped to one user's memories subcollection.
 * Firestore vector search + the per-uid collection path is what gives
 * structural tenant isolation, independent of any application-level filtering.
 */
function getMemoryRetriever(uid: string) {
  return defineFirestoreRetriever(ai, {
    name: `memories-${uid}`,
    firestore: getFirestore(),
    collection: `users/${uid}/memories`,
    contentField: "text",
    vectorField: "embedding",
    embedder,
    distanceMeasure: "COSINE",
  });
}

export async function retrieveRelevantMemories(uid: string, queryText: string) {
  const retriever = getMemoryRetriever(uid);
  const docs = await ai.retrieve({
    retriever,
    query: queryText,
    options: { limit: MEMORY_RETRIEVAL_TOP_K },
  });
  return docs.map((d) => d.text);
}

export async function storeMemory(
  uid: string,
  entry: Omit<MemoryDoc, "embedding" | "createdAt">
): Promise<string> {
  const db = getFirestore();
  const { embedding } = (
    await ai.embed({ embedder, content: entry.text })
  )[0];

  const ref = await db.collection(`users/${uid}/memories`).add({
    ...entry,
    embedding,
    createdAt: new Date(),
  } satisfies MemoryDoc);
  return ref.id;
}

// --- Capabilities: embedding-similarity shortlist + registration ---

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Scans this user's whole capability registry. Fine at the scale a single
 * small business's bot accumulates (dozens, not thousands, of distinct
 * request shapes) — revisit with a proper ANN/limit query if that stops
 * being true. Only returns the lightweight fields decideFlow's prompt
 * actually needs (not `code`) — keeps the prompt small regardless of how
 * much code a capability holds. */
export async function shortlistCapabilities(uid: string, queryText: string): Promise<CapabilityCandidate[]> {
  const db = getFirestore();
  const [{ embedding }] = await ai.embed({ embedder, content: queryText });
  const snap = await db.collection(`users/${uid}/capabilities`).get();

  const scored: Array<CapabilityCandidate & { score: number }> = [];
  for (const doc of snap.docs) {
    const capability = doc.data() as CapabilityDoc;
    const score = cosineSimilarity(embedding, capability.descriptionEmbedding);
    if (score >= CAPABILITY_SHORTLIST_MIN_SIMILARITY) {
      scored.push({
        capabilityId: doc.id,
        description: capability.description,
        paramsSchema: capability.paramsSchema ?? {},
        score,
      });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, CAPABILITY_SHORTLIST_TOP_K)
    .map(({ score: _score, ...candidate }) => candidate);
}

export async function registerCapability(
  uid: string,
  entry: Pick<CapabilityDoc, "description" | "code" | "runtime" | "dependencies" | "paramsSchema">
): Promise<string> {
  const db = getFirestore();
  const [{ embedding }] = await ai.embed({ embedder, content: entry.description });
  const now = new Date();
  const doc: CapabilityDoc = {
    ...entry,
    descriptionEmbedding: embedding,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
  const ref = await db.collection(`users/${uid}/capabilities`).add(doc);
  return ref.id;
}

// --- Decision: the single LLM call for the explicit-query path ---

/**
 * Replaces what used to be two calls (synthesize, then a separate
 * embedding-only capability match) and also absorbs the param-extraction call
 * Executor used to make on its own — decideFlow already has the winning
 * capability's param schema in front of it, so it can extract params in the
 * same pass. Candidates are pre-narrowed by embedding similarity
 * (shortlistCapabilities above) before reaching this prompt, so cost stays
 * roughly constant as the registry grows rather than scaling with it.
 */
export const decideFlow = ai.defineFlow(
  {
    name: "decide",
    inputSchema: z.object({
      uid: z.string(),
      rawText: z.string(),
      candidates: z.array(CapabilityCandidateSchema),
    }),
    outputSchema: DecisionSchema,
  },
  async ({ uid, rawText, candidates }) => {
    const context = await retrieveRelevantMemories(uid, rawText);

    const candidateBlock = candidates.length
      ? candidates
          .map((c) => `- id: ${c.capabilityId}\n  description: ${c.description}\n  params: ${JSON.stringify(c.paramsSchema)}`)
          .join("\n")
      : "(none available)";

    const { output } = await ai.generate({
      model: synthesisModel,
      output: { schema: DecisionSchema },
      prompt: `You are the decision layer for a small business's self-building chat assistant.
Given a user's request, prior context, and the capabilities already available, decide what to do next.

Prior context (most relevant memories, most relevant first):
${context.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none yet)"}

Capabilities already available (only these — never invent a capabilityId that isn't listed here):
${candidateBlock}

User's request:
"""${rawText}"""

Decide exactly one action:
- "clarify" if information needed to act on this is missing — set clarifyQuestion.
- "execute" if one of the capabilities above already does this — set capabilityId to its exact id and
  params to the values extracted from the request matching that capability's param schema.
- "create" if none of the capabilities above do this.

Always set "intent": a generalized, reusable description of the underlying capability this request needs,
phrased the way you'd name a reusable function — not as this specific instance of the request.`,
    });

    if (!output) throw new Error("decide: model returned no structured output");
    return output;
  }
);
