import { getFirestore } from "firebase-admin/firestore";
import { callTool } from "./mcp/client";
import { riskTierForTool } from "./policy/patterns";
import type { ActionDecision, UserDoc } from "./types/domain";

async function getAssistantJid(uid: string): Promise<string> {
  const db = getFirestore();
  const user = (await db.doc(`users/${uid}`).get()).data() as UserDoc | undefined;
  if (!user?.assistantJid) throw new Error(`no assistantJid on file for uid ${uid}`);
  return user.assistantJid;
}

/** Fire-and-forget notification to the owner's assistant chat — used for
 * suggestions awaiting yes/no, and FYIs after an auto-acted pattern executes. This
 * itself goes through the same async whatsapp tool as any other WhatsApp send;
 * the only thing that distinguishes it is the target jid. */
export async function notifyUser(uid: string, text: string): Promise<void> {
  const assistantJid = await getAssistantJid(uid);
  await callTool("whatsapp/send_whatsapp_message", {
    uid,
    target: { jid: assistantJid, displayName: "assistant" },
    text,
  });
}

export interface ExecutionResult {
  executed: boolean;
  detail: string;
}

/**
 * Executes a tool_call decision. Sync tools (Sheets/Calendar/Scheduler) run and
 * return a real result immediately. `send_whatsapp_message` is async by nature —
 * calling it just queues a command; completion is reconciled later by the
 * Firestore trigger described in the plan, not returned here.
 *
 * uid and patternId are injected here rather than trusted from the model's
 * toolParams — the model must never be the thing that decides which tenant an
 * action executes for.
 */
export async function executeToolCall(uid: string, decision: ActionDecision): Promise<ExecutionResult> {
  if (decision.kind !== "tool_call" || !decision.toolName) {
    throw new Error("executeToolCall called with a non tool_call decision");
  }

  const riskTier = riskTierForTool(decision.toolName);
  const result = await callTool(decision.toolName, {
    ...(decision.toolParams ?? {}),
    uid,
    patternId: decision.patternId,
  });

  if (decision.toolName === "whatsapp/send_whatsapp_message") {
    return { executed: true, detail: "queued for extension confirmation (async)" };
  }
  return { executed: true, detail: JSON.stringify({ riskTier, result }) };
}
