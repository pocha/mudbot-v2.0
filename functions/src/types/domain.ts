import { z } from "genkit";

/** A capability shortlisted by embedding similarity and handed to decideFlow —
 * deliberately light (no code, no full doc) since it's the thing that scales
 * the prompt's size with registry growth. */
export const CapabilityCandidateSchema = z.object({
  capabilityId: z.string(),
  description: z.string(),
  paramsSchema: z.record(z.string(), z.string()),
});
export type CapabilityCandidate = z.infer<typeof CapabilityCandidateSchema>;

export const DecisionSchema = z.object({
  intent: z
    .string()
    .describe(
      "Generalized, reusable description of the underlying capability this request needs — phrase it the way " +
        "you'd name a reusable function (e.g. 'Convert a weight between grams and ounces'), not as this specific " +
        "instance of the request. Used to register or match capabilities across differently-phrased requests."
    ),
  action: z
    .enum(["clarify", "execute", "create"])
    .describe(
      "'clarify' if information needed to act is missing; 'execute' if one of the candidate capabilities " +
        "already does this; 'create' if none of them do and a new capability is needed"
    ),
  clarifyQuestion: z.string().optional().describe("Set when action is 'clarify' — the question to ask the user"),
  capabilityId: z
    .string()
    .optional()
    .describe("Set when action is 'execute' — must be exactly one of the candidate capability ids provided"),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Set when action is 'execute' — parameters extracted from the user's message matching the chosen capability's param schema"),
});
export type Decision = z.infer<typeof DecisionSchema>;

// The Admin SDK happily accepts a plain JS Date on write (converting it to a
// Timestamp internally) but the read-side type is Timestamp — this union covers
// both sides so doc shapes can be reused for writes and reads.
export type TimestampLike = FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | Date;

export interface MemoryDoc {
  text: string;
  embedding: number[];
  kind: "chat" | "summary" | "order" | "learned_pattern";
  sourceJid?: string;
  direction?: "incoming" | "outgoing";
  createdAt: TimestampLike;
}

export interface EventDoc {
  uid: string;
  trigger: "passive" | "explicit";
  rawText: string;
  decision?: Decision;
  executionResult?: unknown;
  createdAt: TimestampLike;
}

/**
 * A registered capability: an identifier plus code, matched against future
 * queries by embedding similarity (same cosine-threshold approach the old,
 * now-removed pattern-confidence system used for trigger shapes). Executor
 * fetches one of these by id and runs `code`; Creator writes new ones here
 * once a build succeeds. `code` is expected to comfortably fit Firestore's
 * 1MiB document limit for anything this system should be generating —
 * Cloud Storage would be the escape hatch if that ever stops being true.
 */
export interface CapabilityDoc {
  description: string;
  descriptionEmbedding: number[];
  code: string;
  /** Expected call parameters, param name -> short type/description (e.g.
   * {"grams": "number"}) — lets decideFlow extract correct params for this
   * capability without needing to read its code. Creator produces this
   * alongside code when the capability is first built. */
  paramsSchema: Record<string, string>;
  runtime: "node";
  dependencies: string[];
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
  lastRunAt?: TimestampLike;
  runCount: number;
}

/** Job metadata pushed to the RTDB `dispatchQueue` — never message content,
 * per database.rules.json's comment on that path. `uid` is what lets the
 * orchestrator's single restricted credential route work to the right user
 * without dispatchQueue itself being uid-sharded. */
export interface DispatchJobDoc {
  uid: string;
  commandId: string; // commands/{uid}/{commandId} — where the result gets written back
  type: "execute" | "build";
  capabilityId?: string; // set when type is "execute"
  rawText: string; // the original query — Creator builds against it; Executor no longer needs it
  // (decideFlow already extracted params server-side, see `params` below)
  params?: Record<string, unknown>; // set when type is "execute" — extracted by decideFlow in the same
  // call that picked capabilityId, so Executor doesn't need its own LLM call just to parameterize a
  // capability that's already been chosen
  intent?: string; // set when type is "build" — decideFlow's generalized description, used as the
  // registered capability's description instead of rawText, so later differently-phrased requests for
  // the same capability can still match it by embedding similarity.
  createdAt: number; // RTDB has no server Timestamp type like Firestore's; epoch ms
}
