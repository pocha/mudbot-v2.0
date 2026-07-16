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

export const ActionDecisionSchema = z.object({
  kind: z.enum(["tool_call", "clarify", "unsupported", "none"]),
  toolName: z.string().optional().describe("Name of the MCP tool to call, if kind is tool_call"),
  toolParams: z.record(z.any()).optional().describe("Parameters for the tool call, if kind is tool_call"),
  clarifyingQuestion: z.string().optional().describe("Question to ask the user, if kind is clarify"),
  unsupportedReason: z.string().optional().describe("Why no tool fits, if kind is unsupported"),
  patternId: z.string().optional().describe("Stable id for the learned pattern this decision matches, if any"),
  reasoning: z.string().describe("Brief internal justification for this decision"),
});
export type ActionDecision = z.infer<typeof ActionDecisionSchema>;

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
  decision?: ActionDecision;
  executionResult?: unknown;
  createdAt: TimestampLike;
}

export type RiskTier = "internal-reversible" | "external-irreversible";

export interface ActionPolicyDoc {
  tool: string;
  triggerShape: string;
  triggerEmbedding: number[];
  paramsTemplate: Record<string, unknown>;
  approvals: number;
  rejections: number;
  riskTier: RiskTier;
  suggestThreshold: number;
  autoActThreshold: number;
  minSamples: number;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

export type PatternStage = "silent" | "suggest" | "auto_act";

export interface CommandDoc {
  type: "send_whatsapp_message";
  // Which linked WhatsApp Web session should execute this: numberA (business,
  // for customer/group-facing sends) or numberB (assistant identity, for
  // notifications/confirmations/FYIs the user reads as messages from "the bot").
  executeAs: "numberA" | "numberB";
  target: { jid: string; displayName: string };
  text: string;
  status: "pending" | "confirmed" | "sent" | "rejected";
  patternId?: string;
  createdAt: TimestampLike;
  updatedAt?: TimestampLike;
}

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

export interface UserDoc {
  phone: string;
  assistantJid: string; // Number B — where suggestions/FYIs/confirm prompts are sent
  businessJid: string; // Number A — where real customer traffic and outbound actions happen
  googleOAuthTokenRef?: string; // Secret Manager pointer, set once Workspace is connected
}

export interface ResourceBindingDoc {
  label: string;
  resourceId: string;
  resourceType: string;
  createdAt: TimestampLike;
}
