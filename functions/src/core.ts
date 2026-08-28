import { getFirestore } from "firebase-admin/firestore";
import { synthesizeFlow } from "./flows/synthesize";
import { storeMemory } from "./memory/firestoreRetriever";
import { resolveContact, resolveGroup } from "./resolve/entities";
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
 * Passive stream: every message in the business WhatsApp session (other than the
 * owner's own assistant chat) is stored as memory and classified for actionable
 * shape. Acting on any of this — the capability-synthesis loop that decides
 * whether an existing capability applies or a new one needs to be built — isn't
 * wired up yet; for now this just stores memory and logs the synthesis.
 */
export async function ingestCore(uid: string, input: IngestInput) {
  const { rawText, sourceJid, direction } = input;
  const memoryId = await storeMemory(uid, { text: rawText, kind: "chat", sourceJid, direction });
  const synthesis = await synthesizeFlow({ uid, rawText });
  await logEvent(uid, { trigger: "passive", rawText, synthesis });
  return { status: "stored_only" as const, memoryId };
}

/**
 * Explicit instruction (the owner's assistant chat, or extension UI). Entity
 * resolution runs so `resolutionNotes` is ready for whatever picks this up next;
 * capability matching/synthesis and actually acting on it aren't wired up yet.
 */
export async function instructCore(uid: string, input: InstructInput) {
  const { rawText } = input;
  const synthesis = await synthesizeFlow({ uid, rawText });
  const resolutionNotes = await buildResolutionNotes(uid, rawText);
  await logEvent(uid, { trigger: "explicit", rawText, synthesis });
  return { status: "stored_only" as const, synthesis, resolutionNotes };
}
