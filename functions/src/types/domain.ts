import { z } from "genkit";

export const SynthesisSchema = z.object({
  intent: z.string().describe("Short description of what the message is trying to do"),
  tasks: z.array(z.string()).describe("Explicit tasks/requests found in the message"),
  entities: z
    .array(z.object({ type: z.string(), value: z.string() }))
    .describe("Named entities mentioned: people, items, quantities, groups, dates, etc."),
  missingInfo: z.array(z.string()).describe("Information that would be needed to act on this but is missing"),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

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
  synthesis?: Synthesis;
  executionResult?: unknown;
  createdAt: TimestampLike;
}

// jid is the chat's display name — WhatsApp Web's DOM doesn't expose a real
// jid (confirmed by inspecting it), so the extension uses the display name as
// the identity throughout; synced from the extension's listRecentChats().
export interface ContactDoc {
  jid: string;
  displayName: string;
  updatedAt: TimestampLike;
}

export interface GroupDoc {
  jid: string;
  displayName: string;
  updatedAt: TimestampLike;
}
