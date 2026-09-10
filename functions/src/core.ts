import { getFirestore } from "firebase-admin/firestore";
import { decideFlow, storeMemory, shortlistCapabilities } from "./ai";
import { pushDispatchJob, replyToCommand } from "./rtdb";
import type { EventDoc } from "./types/domain";

/**
 * The actual orchestration logic, with no HTTP/express in it. The onRequest
 * handlers in index.ts are thin adapters over these two functions — and so is
 * scripts/seed-conversation.ts, so offline testing runs the exact same code
 * path that's deployed, not a reimplementation of it.
 */

export interface IngestInput {
  rawText: string;
  sourceJid?: string;
  direction?: "incoming" | "outgoing";
}

export interface DecisionMakerInput {
  rawText: string;
  commandId: string; // the commands/{uid}/{commandId} node this query arrived on
}

export async function logEvent(uid: string, entry: Omit<EventDoc, "uid" | "createdAt">) {
  await getFirestore()
    .collection(`users/${uid}/events`)
    .add({ uid, ...entry, createdAt: new Date() } satisfies EventDoc);
}

/**
 * Passive stream: every WhatsApp message in the business session is stored as
 * memory. WhatsApp has no instruct channel — every message here is ordinary
 * business traffic (see README), so there's no decision to make and
 * deliberately no LLM call on this path: an earlier version ran full
 * synthesis (classification + entity extraction) on every single inbound
 * message here, which paid a generation call per message for output nothing
 * downstream consumed. Just embed-and-store; the embedding is what lets
 * decideFlow (on the explicit path) retrieve this as context later.
 */
export async function ingestCore(uid: string, input: IngestInput) {
  const { rawText, sourceJid, direction } = input;
  const memoryId = await storeMemory(uid, { text: rawText, kind: "chat", sourceJid, direction });
  return { status: "stored_only" as const, memoryId };
}

/**
 * Explicit instruction — the web chat page's entry point (see README), not
 * WhatsApp. Every query here is answerable-or-buildable, unlike WhatsApp's
 * passive stream. One LLM call (decideFlow) does everything: retrieves
 * memory context, judges against a shortlist of this user's existing
 * capabilities (pre-narrowed by embedding similarity so prompt cost doesn't
 * scale with registry size), and either asks a clarifying question, extracts
 * params for a matched capability, or signals a new one is needed. Execute
 * and build jobs just push job metadata — actually answering happens later,
 * in the VM's Executor/Creator, which writes back onto the same
 * commands/{uid}/{commandId} node this query arrived on.
 */
export async function decisionMakerCore(uid: string, input: DecisionMakerInput) {
  const { rawText, commandId } = input;
  const candidates = await shortlistCapabilities(uid, rawText);
  const decision = await decideFlow({ uid, rawText, candidates });

  if (decision.action === "clarify") {
    const question = decision.clarifyQuestion ?? "Could you share a bit more detail?";
    await replyToCommand(uid, commandId, question);
    await logEvent(uid, { trigger: "explicit", rawText, decision });
    return { status: "clarify" as const, question };
  }

  // Guard against a hallucinated capabilityId: only trust "execute" if it
  // names one of the ids decideFlow was actually shown. Falls back to
  // "create" rather than failing outright — worst case is an unnecessary
  // rebuild, not a crash.
  const matchedCapabilityId =
    decision.action === "execute" && candidates.some((c) => c.capabilityId === decision.capabilityId)
      ? decision.capabilityId
      : undefined;

  if (matchedCapabilityId) {
    await pushDispatchJob({
      uid,
      commandId,
      type: "execute",
      capabilityId: matchedCapabilityId,
      rawText,
      params: decision.params ?? {},
      createdAt: Date.now(),
    });
    await logEvent(uid, { trigger: "explicit", rawText, decision });
    return { status: "dispatched" as const, type: "execute" as const, capabilityId: matchedCapabilityId };
  }

  await pushDispatchJob({ uid, commandId, type: "build", rawText, intent: decision.intent, createdAt: Date.now() });
  await logEvent(uid, { trigger: "explicit", rawText, decision });
  return { status: "dispatched" as const, type: "build" as const };
}
