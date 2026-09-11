/**
 * Everything this container needs from Gemini, plus this user's capability
 * registry (which is fetched/written using those same calls) — one file for
 * the same reason functions/src/ai.ts is: the registry functions only exist
 * to call the Gemini functions above them, so keeping them apart was just
 * fragmentation.
 *
 * Plain REST calls rather than pulling in Genkit — this container is meant
 * to stay lean (Genkit's dependency graph is a Cloud-Functions-side concern),
 * and both calls this file needs are simple enough not to need a framework.
 * Model choice mirrors functions/src/ai.ts exactly — the embedding call in
 * particular MUST match (same model, same outputDimensionality) or vectors
 * this container writes won't compare meaningfully against the ones Decision
 * Maker matches against.
 */

import { collection, doc, getDoc, addDoc } from "firebase/firestore";
import { db } from "./firebaseClient";
import { EMBEDDING_DIMENSION } from "./config";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GENERATION_MODEL = process.env.GEMINI_MODEL_ID ?? "gemini-3.1-flash-lite";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL_ID ?? "gemini-embedding-001";

function requireApiKey(): string {
  if (!GEMINI_API_KEY) throw new Error("missing required env var GEMINI_API_KEY");
  return GEMINI_API_KEY;
}

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export async function generateText(prompt: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GENERATION_MODEL}:generateContent?key=${requireApiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!res.ok) throw new Error(`Gemini generateContent failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as GenerateContentResponse;
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini generateContent returned no text");
  return text;
}

interface EmbedContentResponse {
  embedding?: { values?: number[] };
}

export async function embedText(text: string): Promise<number[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${requireApiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: EMBEDDING_DIMENSION }),
    }
  );
  if (!res.ok) throw new Error(`Gemini embedContent failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as EmbedContentResponse;
  if (!data.embedding?.values) throw new Error("Gemini embedContent returned no embedding");
  return data.embedding.values;
}

/** Strips a possible markdown code fence — models asked for "only code" or
 * "only JSON" still sometimes wrap the answer in one anyway. */
export function stripFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/i, "").trim();
}

// --- This user's capability registry ---

export interface CapabilityDoc {
  description: string;
  descriptionEmbedding: number[];
  code: string;
  paramsSchema: Record<string, string>;
  runtime: "node";
  dependencies: string[];
  createdAt: unknown;
  updatedAt: unknown;
  runCount: number;
}

/** Matching already happened server-side (Decision Maker dispatched this
 * exact capabilityId) — Executor just needs the one doc, not the whole
 * registry, so this stays a plain get, not a scan+embed. */
export async function getCapability(uid: string, capabilityId: string): Promise<CapabilityDoc> {
  const snap = await getDoc(doc(db, `users/${uid}/capabilities/${capabilityId}`));
  if (!snap.exists()) throw new Error(`capability ${capabilityId} not found for uid ${uid}`);
  return snap.data() as CapabilityDoc;
}

export async function registerCapability(
  uid: string,
  entry: { description: string; code: string; paramsSchema: Record<string, string> }
): Promise<string> {
  const descriptionEmbedding = await embedText(entry.description);
  const now = new Date();
  const ref = await addDoc(collection(db, `users/${uid}/capabilities`), {
    description: entry.description,
    descriptionEmbedding,
    code: entry.code,
    paramsSchema: entry.paramsSchema,
    runtime: "node",
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  } satisfies CapabilityDoc);
  return ref.id;
}
