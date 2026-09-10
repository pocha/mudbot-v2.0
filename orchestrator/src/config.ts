/**
 * Tunable parameters for container lifecycle management.
 */

/** Per-container RAM cap passed to `docker run --memory`. */
export const CONTAINER_MEMORY_LIMIT = "512m";

/** How long the orchestrator waits for a container to finish before treating
 * the job as failed. */
export const CONTAINER_TIMEOUT_MS = 5 * 60_000;
