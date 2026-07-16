import { getFirestore } from "firebase-admin/firestore";
import type { ContactDoc, GroupDoc, ResourceBindingDoc } from "../types/domain";

export interface ResolutionResult<T> {
  match: T | null;
  ambiguous: boolean;
  candidates: T[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Cheap fuzzy match: normalized substring containment either direction. Good enough
 * for short display names; swap for a real fuzzy-match lib if precision suffers. */
function fuzzyScore(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.8;
  const qTokens = new Set(q.split(/\s+/));
  const cTokens = c.split(/\s+/);
  const overlap = cTokens.filter((t) => qTokens.has(t)).length;
  return overlap > 0 ? 0.5 * (overlap / Math.max(qTokens.size, cTokens.length)) : 0;
}

async function resolveByName<T extends { displayName: string }>(
  uid: string,
  collection: string,
  mentionedName: string
): Promise<ResolutionResult<T>> {
  const db = getFirestore();
  const snap = await db.collection(`users/${uid}/${collection}`).get();
  const scored = snap.docs
    .map((d) => ({ doc: d.data() as T, score: fuzzyScore(mentionedName, d.data().displayName) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { match: null, ambiguous: false, candidates: [] };
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.15) {
    return { match: null, ambiguous: true, candidates: scored.map((s) => s.doc) };
  }
  return { match: scored[0].doc, ambiguous: false, candidates: [scored[0].doc] };
}

export function resolveGroup(uid: string, mentionedName: string) {
  return resolveByName<GroupDoc>(uid, "groups", mentionedName);
}

export function resolveContact(uid: string, mentionedName: string) {
  return resolveByName<ContactDoc>(uid, "contacts", mentionedName);
}

/** Resource bindings are looked up by exact label, not fuzzy-matched, since they're
 * assigned once by the user disambiguating (e.g. "orders sheet" -> spreadsheetId). */
export async function resolveResourceBinding(
  uid: string,
  label: string
): Promise<ResourceBindingDoc | null> {
  const db = getFirestore();
  const doc = await db.doc(`users/${uid}/resourceBindings/${normalize(label)}`).get();
  return doc.exists ? (doc.data() as ResourceBindingDoc) : null;
}

export async function bindResource(
  uid: string,
  label: string,
  resourceId: string,
  resourceType: string
): Promise<void> {
  const db = getFirestore();
  await db.doc(`users/${uid}/resourceBindings/${normalize(label)}`).set({
    label: normalize(label),
    resourceId,
    resourceType,
    createdAt: new Date(),
  } satisfies ResourceBindingDoc);
}
