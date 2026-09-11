import { generateText, stripFences, registerCapability } from "./ai";
import { runCapabilityCode } from "./runCode";
import { createCapabilityContext } from "./capabilityContext";
import { replyToCommand } from "./firebaseClient";
import { CREATOR_MAX_ATTEMPTS } from "./config";

/**
 * Bounded generate-and-retry, not open-ended exploration — see the
 * architecture writeup's discussion of why this doesn't need (and shouldn't
 * default to) a Claude-Code-scale agentic loop for most requests. Caps at a
 * few attempts (CREATOR_MAX_ATTEMPTS, see config.ts) and gives up gracefully
 * rather than looping indefinitely; real novel-integration requests that need
 * genuine multi-step exploration (new external API, credentials the owner
 * hasn't provided yet) aren't handled by this loop shape yet — that's a
 * known gap, not an oversight.
 */
export async function runCreator(uid: string, commandId: string, rawText: string, intent?: string): Promise<void> {
  const ctx = createCapabilityContext(uid);
  let lastError: string | null = null;

  // Registered under the generalized intent, not the literal query — matching
  // one instance's exact wording against a later, differently-phrased request
  // for the same capability undershoots the similarity threshold used to
  // shortlist candidates for Decision Maker. Falls back to rawText only if
  // Decision Maker didn't send one.
  const description = intent && intent.trim() ? intent : rawText;

  for (let attempt = 1; attempt <= CREATOR_MAX_ATTEMPTS; attempt++) {
    const generated = await generateCapability(rawText, lastError);
    try {
      const result = await runCapabilityCode(generated.code, {}, ctx);
      const replyText = typeof result === "string" ? result : JSON.stringify(result);

      // A registration failure shouldn't cost the user their answer — they
      // still get the reply either way, they just don't get the reuse
      // benefit (next similar query pays the build cost again) this time.
      try {
        await registerCapability(uid, { description, code: generated.code, paramsSchema: generated.paramsSchema });
      } catch (err) {
        console.error("[creator] capability ran fine but failed to register:", (err as Error).message);
      }

      await replyToCommand(uid, commandId, replyText);
      return;
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(`[creator] attempt ${attempt}/${CREATOR_MAX_ATTEMPTS} failed:`, lastError);
    }
  }

  await replyToCommand(uid, commandId, "I couldn't figure out how to do that yet — flagging this for the owner to look at.");
}

interface GeneratedCapability {
  code: string;
  paramsSchema: Record<string, string>;
}

async function generateCapability(rawText: string, lastError: string | null): Promise<GeneratedCapability> {
  const prompt = `Write a single Node.js ES module implementing a capability for a small
business's WhatsApp/chat assistant.

Contract (follow exactly):
- Default export: an async function (params, ctx) => result
- ctx.get(path), ctx.set(path, data), ctx.update(path, data), ctx.add(collectionPath, data), ctx.list(collectionPath)
  read/write this user's own private data store. Paths are short relative
  names like "orders" or "orders/123" — not full Firestore paths.
- ctx.recall(query) returns the 5 most relevant past messages/orders for a
  natural-language query — use it whenever the request depends on prior
  context (e.g. "what did I order last time", "who's my usual supplier").
- No imports, no require() — only plain JavaScript and the ctx methods above.
- Return a plain string answering the request, or a small JSON-serializable object.

Task: """${rawText}"""
${lastError ? `\nThe previous attempt failed with this error — fix it:\n${lastError}\n` : ""}
Respond in exactly this format, nothing else:
PARAMS_SCHEMA: <one-line JSON object mapping each parameter this function's \`params\` argument expects to a
short type/description, e.g. {"grams":"number"}. Use {} if it takes none.>
CODE:
<the module code — no markdown fences, no commentary>`;

  const raw = await generateText(prompt);
  return parseGeneratedCapability(raw);
}

function parseGeneratedCapability(raw: string): GeneratedCapability {
  const match = raw.match(/PARAMS_SCHEMA:\s*(\{.*?\})\s*\n+CODE:\s*([\s\S]*)/);
  if (!match) {
    // Model didn't follow the format — treat the whole response as code and
    // assume no declared params rather than failing the attempt outright.
    return { code: stripFences(raw), paramsSchema: {} };
  }
  const [, schemaText, codeText] = match;
  let paramsSchema: Record<string, string> = {};
  try {
    paramsSchema = JSON.parse(schemaText);
  } catch {
    console.warn("[creator] could not parse PARAMS_SCHEMA, defaulting to {}:", schemaText);
  }
  return { code: stripFences(codeText), paramsSchema };
}
