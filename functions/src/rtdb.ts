import { getDatabase } from "firebase-admin/database";
import type { DispatchJobDoc } from "./types/domain";

/** Pushes a job onto the shared dispatchQueue for the VM orchestrator's live
 * listener to pick up. Job metadata only — see database.rules.json's comment
 * on this path for why it must never carry message content. */
export async function pushDispatchJob(job: DispatchJobDoc): Promise<string> {
  const ref = await getDatabase().ref("dispatchQueue").push(job);
  if (!ref.key) throw new Error("pushDispatchJob: push() returned no key");
  return ref.key;
}

/** Writes the answer back onto the same commands/{uid}/{commandId} node the
 * query arrived on, so the web chat page's listener on that node sees it. */
export async function replyToCommand(uid: string, commandId: string, text: string): Promise<void> {
  await getDatabase().ref(`commands/${uid}/${commandId}`).update({ reply: text, repliedAt: Date.now() });
}

/** ingestQueue is a pure transient relay (the durable copy is the Firestore
 * memory entry storeMemory already wrote) — clear it once handled so it
 * doesn't grow unboundedly. commands/{uid} is left alone: it doubles as the
 * client-visible reply channel, not just a work queue — a proper durable
 * Firestore conversation archive (discussed, not yet built) would let this
 * get cleared too. */
export async function clearIngestQueueEntry(uid: string, pushId: string): Promise<void> {
  await getDatabase().ref(`ingestQueue/${uid}/${pushId}`).remove();
}
