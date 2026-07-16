import { genkit } from "genkit";
import { vertexAI, textEmbedding004 } from "@genkit-ai/vertexai";

// One place tying the orchestrator to Gemini. MCP server connections live in
// ./mcp/client.ts (via the official MCP SDK directly, see that file for why).
export const ai = genkit({
  plugins: [vertexAI({ location: process.env.VERTEX_LOCATION ?? "us-central1" })],
});

// Referenced by string ID rather than a named export: this repo was scaffolded
// with a training cutoff of Jan 2026, so pin whatever the current small/cheap
// Gemini model is in the Vertex AI model garden at build time rather than
// trusting a hardcoded named import to still exist or be current.
export const synthesisModel = vertexAI.model(process.env.GEMINI_MODEL_ID ?? "gemini-3.1-flash-lite");
export const embedder = textEmbedding004;
