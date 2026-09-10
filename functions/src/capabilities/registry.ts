import { getFirestore } from "firebase-admin/firestore";
import { ai, embedder } from "../genkit";
import { CAPABILITY_SHORTLIST_TOP_K, CAPABILITY_SHORTLIST_MIN_SIMILARITY } from "../config";
import type { CapabilityCandidate, CapabilityDoc } from "../types/domain";

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
