import { collection, doc, getDoc, addDoc } from "firebase/firestore";
import { db } from "./firebaseClient";
import { embedText } from "./gemini";

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
