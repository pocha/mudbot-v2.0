/**
 * Plain REST calls rather than pulling in Genkit here — this container is
 * meant to stay lean (Genkit's dependency graph is a Cloud-Functions-side
 * concern), and both calls this file needs are simple enough not to need a
 * framework. Model choice mirrors functions/src/genkit.ts exactly — the
 * embedding call in particular MUST match (same model, same
 * outputDimensionality) or vectors this container writes won't compare
 * meaningfully against the ones Decision Maker matches against.
 */

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
