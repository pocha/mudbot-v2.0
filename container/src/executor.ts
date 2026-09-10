import { getCapability } from "./registry";
import { runCapabilityCode } from "./runCode";
import { createCapabilityContext } from "./capabilityContext";
import { replyToCommand } from "./reply";

/**
 * Pure execution, zero LLM calls. This used to make its own call here to
 * extract params from rawText against the chosen capability's description —
 * redundant, since Decision Maker (functions/src/flows/decide.ts) already
 * has that capability's params schema in front of it at the moment it picks
 * capabilityId, and extracts params in that same call. Executor just runs
 * what's already been decided.
 */
export async function runExecutor(
  uid: string,
  commandId: string,
  capabilityId: string,
  params: Record<string, unknown>
): Promise<void> {
  const capability = await getCapability(uid, capabilityId);
  const ctx = createCapabilityContext(uid);
  const result = await runCapabilityCode(capability.code, params, ctx);
  await replyToCommand(uid, commandId, typeof result === "string" ? result : JSON.stringify(result));
}
