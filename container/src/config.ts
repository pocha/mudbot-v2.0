/**
 * Tunable parameters for the container's Executor/Creator runtime. Pulled
 * into one place because these are the values most likely to need
 * adjusting independently of the Cloud Functions side.
 */

/** How many past memories a running capability's ctx.recall() call returns
 * (container/src/capabilityContext.ts). */
export const RECALL_TOP_K = 5;

/** Bounded generate-and-retry cap for Creator — see creator.ts for why this
 * stays a small fixed number rather than open-ended exploration. */
export const CREATOR_MAX_ATTEMPTS = 3;

/** Embedding output dimension — must match functions/src/config.ts's
 * EMBEDDING_DIMENSION and firestore.indexes.json's vectorConfig.dimension
 * exactly. These three are one coupled value: this container writes and
 * reads vectors from the same store Decision Maker matches against, so a
 * mismatch here breaks vector comparisons silently. */
export const EMBEDDING_DIMENSION = 768;
