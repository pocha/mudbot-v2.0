import { z } from "genkit";
import { ai, synthesisModel } from "../genkit";
import { SynthesisSchema } from "../types/domain";
import { retrieveRelevantMemories } from "../memory/firestoreRetriever";

export const synthesizeFlow = ai.defineFlow(
  {
    name: "synthesize",
    inputSchema: z.object({ uid: z.string(), rawText: z.string() }),
    outputSchema: SynthesisSchema,
  },
  async ({ uid, rawText }) => {
    const context = await retrieveRelevantMemories(uid, rawText);

    const { output } = await ai.generate({
      model: synthesisModel,
      output: { schema: SynthesisSchema },
      prompt: `You are extracting structured data from a WhatsApp message for a small
business owner's assistant. Use the prior context only to disambiguate references
(e.g. recurring customers, past orders, tone) — do not invent facts not present in
the message or context.

Prior context (most relevant first):
${context.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none yet)"}

Message to analyze:
"""
${rawText}
"""`,
    });

    if (!output) throw new Error("synthesize: model returned no structured output");
    return output;
  }
);
