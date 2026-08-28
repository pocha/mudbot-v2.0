/**
 * Content-script (isolated world) side of the bridge to inject.ts (MAIN
 * world). window.postMessage is the only channel between the two worlds —
 * they share the DOM/window but not JS state.
 */

const TARGET = "mudbot-inject";
const SOURCE = "mudbot-inject";

export interface RawMessage {
  id: string;
  jid: string;
  fromMe: boolean;
  body: string;
  t: number | null;
  type: string;
  author: string | null;
}

let nextRequestId = 1;
const pending = new Map<number, (data: any) => void>();
const liveMessageListeners: Array<(msg: RawMessage) => void> = [];

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== SOURCE) return;

  if (data.type === "live_message") {
    for (const listener of liveMessageListeners) listener(data.message);
    return;
  }
  if (data.requestId != null && pending.has(data.requestId)) {
    const resolve = pending.get(data.requestId)!;
    pending.delete(data.requestId);
    resolve(data);
  }
});

function ask<T = any>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`inject request "${type}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(requestId, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
    window.postMessage({ target: TARGET, type, requestId, ...payload }, window.location.origin);
  });
}

export function onLiveMessage(listener: (msg: RawMessage) => void): void {
  liveMessageListeners.push(listener);
}

export async function getRecentChatsViaStore(limit: number) {
  const { chats } = await ask<{ chats: { jid: string; displayName: string; lastMessageAt: number | null }[] }>(
    "get_recent_chats",
    { limit }
  );
  return chats;
}

export async function getChatMessagesViaStore(jid: string, pages: number) {
  const { messages } = await ask<{ messages: RawMessage[] }>("get_chat_messages", { jid, pages });
  return messages;
}

export async function getRecentMessagesViaStore(jid: string, count: number) {
  const { messages } = await ask<{ messages: RawMessage[] }>("get_recent_messages", { jid, count });
  return messages;
}
