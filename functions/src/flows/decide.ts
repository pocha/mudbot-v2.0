import { z } from "genkit";
import { ai, synthesisModel } from "../genkit";
import { CapabilityCandidateSchema, DecisionSchema } from "../types/domain";
import { retrieveRelevantMemories } from "../memory/firestoreRetriever";

/**
 * The single LLM call for the explicit-query path: replaces what used to be
 * two calls (synthesize, then a separate embedding-only capability match) and
 * also absorbs the param-extraction call Executor used to make on its own —
 * decideFlow already has the winning capability's param schema in front of
 * it, so it can extract params in the same pass. Candidates are pre-narrowed
 * by embedding similarity (see capabilities/registry.ts) before reaching this
 * prompt, so cost stays roughly constant as the registry grows rather than
 * scaling with it.
 */
export const decideFlow = ai.defineFlow(
  {
    name: "decide",
    inputSchema: z.object({
      uid: z.string(),
      rawText: z.string(),
      candidates: z.array(CapabilityCandidateSchema),
    }),
    outputSchema: DecisionSchema,
  },
  async ({ uid, rawText, candidates }) => {
    const context = await retrieveRelevantMemories(uid, rawText);

    const candidateBlock = candidates.length
      ? candidates
          .map((c) => `- id: ${c.capabilityId}\n  description: ${c.description}\n  params: ${JSON.stringify(c.paramsSchema)}`)
          .join("\n")
      : "(none available)";

    const { output } = await ai.generate({
      model: synthesisModel,
      output: { schema: DecisionSchema },
      prompt: `You are the decision layer for a small business's self-building chat assistant.
Given a user's request, prior context, and the capabilities already available, decide what to do next.

Prior context (most relevant memories, most relevant first):
${context.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none yet)"}

Capabilities already available (only these — never invent a capabilityId that isn't listed here):
${candidateBlock}

User's request:
"""${rawText}"""

Decide exactly one action:
- "clarify" if information needed to act on this is missing — set clarifyQuestion.
- "execute" if one of the capabilities above already does this — set capabilityId to its exact id and
  params to the values extracted from the request matching that capability's param schema.
- "create" if none of the capabilities above do this.

Always set "intent": a generalized, reusable description of the underlying capability this request needs,
phrased the way you'd name a reusable function — not as this specific instance of the request.`,
    });

    if (!output) throw new Error("decide: model returned no structured output");
    return output;
  }
);
