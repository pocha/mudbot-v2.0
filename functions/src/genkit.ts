import { genkit } from "genkit";
import { googleAI } from "@genkit-ai/google-genai";
import { EMBEDDING_DIMENSION } from "./config";

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
