import { genkit } from "genkit";
import { vertexAI } from "@genkit-ai/google-genai";

// One place tying the orchestrator to Gemini. MCP server connections live in
// ./mcp/client.ts (via the official MCP SDK directly, see that file for why).
// Note: @genkit-ai/vertexai is deprecated in favor of this unified package —
// same vertexAI export, just a different home.
export const ai = genkit({
  plugins: [vertexAI({ location: process.env.VERTEX_LOCATION ?? "us-central1" })],
});

// Referenced by string ID rather than a named export: this repo was scaffolded
// with a training cutoff of Jan 2026, so pin whatever the current small/cheap
// Gemini model is in the Vertex AI model garden at build time rather than
// trusting a hardcoded named import to still exist or be current.
export const synthesisModel = vertexAI.model(process.env.GEMINI_MODEL_ID ?? "gemini-3.1-flash-lite");

// text-embedding-004 was retired in favor of text-embedding-005 (both 768-dim,
// matching firestore.indexes.json's vector index) — confirm against the
// current Vertex AI model garden if this drifts further.
export const embedder = vertexAI.embedder(
  (process.env.EMBEDDING_MODEL_ID ?? "text-embedding-005") as Parameters<typeof vertexAI.embedder>[0]
);
