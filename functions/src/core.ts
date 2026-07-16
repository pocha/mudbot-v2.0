import { getFirestore } from "firebase-admin/firestore";
import { synthesizeFlow } from "./flows/synthesize";
import { determineActionFlow } from "./flows/determineAction";
import { storeMemory } from "./memory/firestoreRetriever";
import { resolveContact, resolveGroup } from "./resolve/entities";
import { findMatchingPattern, createPattern, patternStage } from "./policy/patterns";
import { executeToolCall, notifyUser } from "./dispatch";
import type { EventDoc } from "./types/domain";

/**
 * The actual orchestration logic, with no HTTP/express in it. The onRequest
 * handlers in index.ts are thin adapters over these two functions — and so are
 * scripts/train-from-dump.ts and scripts/simulate.ts, so offline testing runs
 * the exact same code path that's deployed, not a reimplementation of it.
 */

export interface IngestInput {
  rawText: string;
  sourceJid?: string;
  direction?: "incoming" | "outgoing";
}

export interface InstructInput {
  rawText: string;
}

export async function logEvent(uid: string, entry: Omit<EventDoc, "uid" | "createdAt">) {
  await getFirestore()
    .collection(`users/${uid}/events`)
    .add({ uid, ...entry, createdAt: new Date() } satisfies EventDoc);
}

/** Best-effort text scan for the entities/resources a decision would need, so the
 * model gets grounded resolution notes instead of guessing at IDs. Scaffold-level:
 * a real implementation would have the LLM name candidates in `synthesis.entities`
 * and resolve each one, rather than resolving the whole raw message twice. */
async function buildResolutionNotes(uid: string, rawText: string): Promise<string> {
  const [group, contact] = await Promise.all([resolveGroup(uid, rawText), resolveContact(uid, rawText)]);
  const notes: string[] = [];
  if (group.ambiguous) notes.push(`Multiple groups could match; ask which one.`);
  else if (group.match) notes.push(`Group resolved: ${group.match.displayName} (${group.match.jid}).`);
  if (contact.ambiguous) notes.push(`Multiple contacts could match; ask which one.`);
  else if (contact.match) notes.push(`Contact resolved: ${contact.match.displayName} (${contact.match.jid}).`);
  return notes.join(" ") || "No WhatsApp entities needed resolution.";
}

/**
 * Passive stream: every message from Number A is stored as memory, and classified
 * for actionable shape. A message never seen before (no matching learned pattern)
 * just sits as memory — nothing proactive happens until the user explicitly
 * instructs on it once (see instructCore). Once a pattern exists, later similar
 * messages are suggested or auto-acted depending on how much confidence it's
 * earned, gated per-tool by risk tier (see policy/patterns.ts).
 */
export async function ingestCore(uid: string, input: IngestInput) {
  const { rawText, sourceJid, direction } = input;
  const memoryId = await storeMemory(uid, { text: rawText, kind: "chat", sourceJid, direction });

  const synthesis = await synthesizeFlow({ uid, rawText });
  const matched = await findMatchingPattern(uid, rawText);

  if (!matched) {
    await logEvent(uid, { trigger: "passive", rawText, synthesis });
    return { status: "stored_only" as const, memoryId };
  }

  const stage = patternStage(matched.policy);
  if (stage === "silent") {
    await logEvent(uid, { trigger: "passive", rawText, synthesis });
    return { status: "stored_only" as const, memoryId, patternId: matched.patternId, stage };
  }

  if (stage === "suggest") {
    await notifyUser(
      uid,
      `Looks like this: "${rawText.slice(0, 120)}" matches "${matched.policy.triggerShape}". ` +
        `Want me to run ${matched.policy.tool}? Reply YES/NO.`
    );
    await logEvent(uid, {
      trigger: "passive",
      rawText,
      synthesis,
      decision: { kind: "clarify", patternId: matched.patternId, reasoning: "suggest-stage pattern match" },
    });
    return { status: "suggested" as const, memoryId, patternId: matched.patternId };
  }

  // auto_act
  const decision = await determineActionFlow({ uid, rawText, synthesis });
  let executionResult: unknown = null;
  if (decision.kind === "tool_call") {
    executionResult = await executeToolCall(uid, decision);
    await notifyUser(uid, `FYI: auto-handled "${rawText.slice(0, 80)}" via ${decision.toolName}.`);
  }
  await logEvent(uid, { trigger: "passive", rawText, synthesis, decision, executionResult });
  return { status: "auto_acted" as const, memoryId, patternId: matched.patternId, decision, executionResult };
}

/**
 * Explicit instruction (Number B chat, or extension UI). Always attempts to
 * resolve and act — this is the path that teaches the system new patterns.
 */
export async function instructCore(uid: string, input: InstructInput) {
  const { rawText } = input;
  const synthesis = await synthesizeFlow({ uid, rawText });
  const resolutionNotes = await buildResolutionNotes(uid, rawText);
  const decision = await determineActionFlow({ uid, rawText, synthesis, resolutionNotes });

  let executionResult: unknown = null;

  switch (decision.kind) {
    case "tool_call": {
      executionResult = await executeToolCall(uid, decision);
      if (decision.patternId) {
        const existing = await findMatchingPattern(uid, rawText);
        if (!existing) {
          await createPattern(uid, decision.toolName!, rawText, decision.toolParams ?? {});
        }
      }
      break;
    }
    case "clarify":
      await notifyUser(uid, decision.clarifyingQuestion ?? "Could you clarify that?");
      break;
    case "unsupported":
      await notifyUser(uid, `Sorry, I can't do that yet${decision.unsupportedReason ? `: ${decision.unsupportedReason}` : "."}`);
      break;
    case "none":
      break;
  }

  await logEvent(uid, { trigger: "explicit", rawText, synthesis, decision, executionResult });
  return { status: "handled" as const, decision, executionResult };
}
