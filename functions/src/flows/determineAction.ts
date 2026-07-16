import { z } from "genkit";
import { ai, synthesisModel } from "../genkit";
import { ActionDecisionSchema, SynthesisSchema } from "../types/domain";
import { describeAvailableTools } from "../mcp/client";

export const determineActionFlow = ai.defineFlow(
  {
    name: "determineAction",
    inputSchema: z.object({
      uid: z.string(),
      rawText: z.string(),
      synthesis: SynthesisSchema,
      resolutionNotes: z
        .string()
        .optional()
        .describe("Free-text notes on how mentioned entities/resources resolved, or that they didn't"),
    }),
    outputSchema: ActionDecisionSchema,
  },
  async ({ rawText, synthesis, resolutionNotes }) => {
    const toolManifest = await describeAvailableTools();

    const { output } = await ai.generate({
      model: synthesisModel,
      output: { schema: ActionDecisionSchema },
      prompt: `You decide what, if anything, should happen next for a small business
owner's WhatsApp assistant, based on a synthesized message.

Available tools (choose one by exact name, or none of them):
${toolManifest}

Synthesized message:
${JSON.stringify(synthesis, null, 2)}

Original message:
"""
${rawText}
"""

Entity/resource resolution notes:
${resolutionNotes ?? "(none needed)"}

Rules:
- If a tool clearly fits and all required entities/resources resolved, respond with
  kind "tool_call", the exact toolName, and toolParams built from the synthesis.
- If a tool would fit but a required entity or resource is unresolved or ambiguous
  (see resolution notes), respond with kind "clarify" and ask exactly one question.
- If nothing in the tool list fits this message at all, respond with kind
  "unsupported" and explain briefly why.
- If this message needs no action, just memory, respond with kind "none".
- Always include a one-line "reasoning" and, for tool_call/clarify decisions tied to
  a recognizable recurring shape of message (e.g. "customer sends an order"), a
  short stable "patternId" slug (e.g. "order_to_sheet") so this exact kind of
  decision can be tracked as a learned pattern over time.`,
    });

    if (!output) throw new Error("determineAction: model returned no structured output");
    return output;
  }
);
