/**
 * Tunable parameters for the Decision Maker / memory / capability-matching
 * pipeline. Pulled into one place because these are the values most likely
 * to need adjusting as a business's memory history and capability registry
 * grow — see functions/src/flows/decide.ts and
 * functions/src/capabilities/registry.ts for how each is used.
 */

/** How many past memories retrieveRelevantMemories pulls as context for
 * decideFlow. */
export const MEMORY_RETRIEVAL_TOP_K = 5;

/** How many capabilities get shortlisted (by embedding similarity) into
 * decideFlow's prompt, and how loose that pre-filter is allowed to be. This
 * is NOT the final match decision — decideFlow (an LLM call) makes that call
 * by actually reading descriptions/params against the request. A generous
 * threshold here just costs a few extra prompt tokens on a false positive;
 * too strict a threshold means a reusable capability never even gets shown
 * to the judge. Confirmed live that using a single hard threshold as the
 * *final* decision (the old design) was too strict — same-capability
 * requests phrased with different specificity fell either side of it
 * inconsistently. */
export const CAPABILITY_SHORTLIST_TOP_K = 8;
export const CAPABILITY_SHORTLIST_MIN_SIMILARITY = 0.6;

/** Embedding output dimension — must match container/src/config.ts's
 * EMBEDDING_DIMENSION and firestore.indexes.json's vectorConfig.dimension
 * exactly. These three are one coupled value, not three independent
 * settings: changing it here without changing the other two breaks vector
 * search silently (comparing vectors of different lengths). */
export const EMBEDDING_DIMENSION = 768;
