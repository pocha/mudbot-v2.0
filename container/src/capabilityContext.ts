import { collection, doc, getDoc, setDoc, updateDoc, addDoc, getDocs } from "firebase/firestore";
import { db } from "./firebaseClient";
import { embedText } from "./ai";
import { RECALL_TOP_K } from "./config";

interface MemoryDoc {
  text: string;
  embedding: number[];
}

// ctx.recall() runs plain cosine similarity client-side (RECALL_TOP_K, see
// config.ts) rather than a server-side vector query — this Firestore client
// SDK's vector search support (the Pipelines API) is still new/unstable, so
// this mirrors what functions/src/capabilities/registry.ts already does
// server-side. Fine at the scale one small business accumulates; revisit if
// that stops being true.
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * What generated capability code actually gets to touch — not the raw
 * Firestore SDK. Two reasons: (1) paths are relative short names ("orders",
 * "orders/123"), not full Firestore paths, so generated code has no way to
 * even attempt reaching outside its own user's data — belt-and-suspenders on
 * top of Security Rules already enforcing that at the token level; (2) it
 * keeps the "capability contract" small enough for an LLM to reliably target
 * without needing to import/wire up the SDK itself inside a dynamically
 * loaded module (which has its own problems — see runCode.ts).
 *
 * Anchored at users/{uid}/store/data/... — a fixed 4-segment prefix, chosen
 * so that appending a caller's own even/odd-segment path lines up correctly
 * with Firestore's doc-vs-collection path parity, and so generated writes
 * can never collide with reserved collections (memories, capabilities,
 * events) that live directly under users/{uid}.
 */
export interface CapabilityContext {
  uid: string;
  get(path: string): Promise<Record<string, unknown> | null>;
  set(path: string, data: Record<string, unknown>): Promise<void>;
  update(path: string, data: Record<string, unknown>): Promise<void>;
  add(collectionPath: string, data: Record<string, unknown>): Promise<string>;
  list(collectionPath: string): Promise<Record<string, unknown>[]>;
  /** Semantic search over this user's own conversation/order history — most
   * requests a capability handles ("what did I order last time", "who's my
   * usual supplier for X") depend on past interactions, not just the current
   * message, so this is on the contract every generated capability sees. */
  recall(query: string): Promise<string[]>;
}

export function createCapabilityContext(uid: string): CapabilityContext {
  const scoped = (path: string) => `users/${uid}/store/data/${path}`;
  return {
    uid,
    async get(path) {
      const snap = await getDoc(doc(db, scoped(path)));
      return snap.exists() ? snap.data() : null;
    },
    async set(path, data) {
      await setDoc(doc(db, scoped(path)), data, { merge: true });
    },
    async update(path, data) {
      await updateDoc(doc(db, scoped(path)), data);
    },
    async add(collectionPath, data) {
      const ref = await addDoc(collection(db, scoped(collectionPath)), data);
      return ref.id;
    },
    async list(collectionPath) {
      const snap = await getDocs(collection(db, scoped(collectionPath)));
      return snap.docs.map((d) => d.data());
    },
    async recall(query) {
      const [queryEmbedding, snap] = await Promise.all([
        embedText(query),
        getDocs(collection(db, `users/${uid}/memories`)),
      ]);
      const scored = snap.docs
        .map((d) => d.data() as MemoryDoc)
        .map((memory) => ({ text: memory.text, score: cosineSimilarity(queryEmbedding, memory.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, RECALL_TOP_K);
      return scored.map((m) => m.text);
    },
  };
}
