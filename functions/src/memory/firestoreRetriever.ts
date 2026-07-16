import { defineFirestoreRetriever } from "@genkit-ai/firebase";
import { getFirestore } from "firebase-admin/firestore";
import { ai, embedder } from "../genkit";
import type { MemoryDoc } from "../types/domain";

const TOP_K = 5;

/**
 * Vector-search retriever scoped to one user's memories subcollection.
 * Firestore vector search + the per-uid collection path is what gives
 * structural tenant isolation, independent of any application-level filtering.
 */
export function getMemoryRetriever(uid: string) {
  return defineFirestoreRetriever(ai, {
    name: `memories-${uid}`,
    firestore: getFirestore(),
    collection: `users/${uid}/memories`,
    contentField: "text",
    vectorField: "embedding",
    embedder,
    distanceMeasure: "COSINE",
  });
}

export async function retrieveRelevantMemories(uid: string, queryText: string) {
  const retriever = getMemoryRetriever(uid);
  const docs = await ai.retrieve({
    retriever,
    query: queryText,
    options: { limit: TOP_K },
  });
  return docs.map((d) => d.text);
}

export async function storeMemory(
  uid: string,
  entry: Omit<MemoryDoc, "embedding" | "createdAt">
): Promise<string> {
  const db = getFirestore();
  const { embedding } = (
    await ai.embed({ embedder, content: entry.text })
  )[0];

  const ref = await db.collection(`users/${uid}/memories`).add({
    ...entry,
    embedding,
    createdAt: new Date(),
  } satisfies MemoryDoc);
  return ref.id;
}
