/**
 * Runs in the page's own MAIN world (declared via manifest.json's
 * "world": "MAIN"), not the extension's isolated content-script world — this
 * is what lets it reach `window.require`, WhatsApp Web's own internal webpack
 * module loader. Adapted from the real, actively-maintained whatsapp-web.js
 * (github.com/pedroslopez/whatsapp-web.js, src/Client.js + src/util/Injected/Utils.js) —
 * specifically its use of `WAWebCollections` (Msg/Chat), `WAWebChatLoadMessages`
 * for history pagination, and the `Msg.on('add', ...)` + `isNewMsg` real-time
 * hook — not the DOM click-simulation this replaces, since that technique
 * doesn't work here (see whatsappAdapter.ts's history for why).
 *
 * Deliberately lean: plain objects, only the fields needed for testing
 * reliability (Activate Listen / Reconcile), not a full port of
 * whatsapp-web.js's Message/Chat class hierarchy.
 *
 * Talks to content-script.ts via window.postMessage — MAIN-world scripts have
 * no access to chrome.* APIs at all, so all actual storage happens on the
 * content-script side.
 */

const SOURCE = "mudbot-inject";
const TARGET = "mudbot-inject";

interface RawMessage {
  id: string;
  jid: string;
  fromMe: boolean;
  body: string;
  t: number | null;
  type: string;
  /** For group messages: the specific member who sent it (distinct from
   * `jid`, which is the group's own id) — null for 1:1 chats and outgoing
   * messages, where the chat/sender is already unambiguous. */
  author: string | null;
}

function post(msg: Record<string, unknown>): void {
  window.postMessage({ source: SOURCE, ...msg }, window.location.origin);
}

function getCollections(): { Msg: any; Chat: any } {
  return (window as any).require("WAWebCollections");
}

function serializeMessage(msg: any): RawMessage {
  return {
    id: msg?.id?._serialized ?? String(msg?.id ?? ""),
    jid: msg?.id?.remote?._serialized ?? String(msg?.id?.remote ?? ""),
    fromMe: !!msg?.id?.fromMe,
    body: msg?.body ?? "",
    t: typeof msg?.t === "number" ? msg.t : null,
    type: msg?.type ?? "unknown",
    author: msg?.author?._serialized ?? null,
  };
}

function getRecentChats(limit: number) {
  const { Chat } = getCollections();
  return Chat.getModelsArray()
    .slice()
    .sort((a: any, b: any) => (b.t ?? 0) - (a.t ?? 0))
    .slice(0, limit)
    .map((c: any) => ({
      jid: c?.id?._serialized ?? String(c?.id ?? ""),
      displayName: c.formattedTitle || c.name || c?.id?._serialized || "unknown",
      lastMessageAt: c.t ?? null,
    }));
}

/** One "page" == one loadEarlierMsgs() call, matching how WhatsApp Web's own
 * pagination works — "10 pages" means calling this up to 10 times, stopping
 * early if the chat runs out of history to load. */
async function getChatMessages(jid: string, pages: number): Promise<RawMessage[]> {
  const { Chat } = getCollections();
  const wid = (window as any).require("WAWebWidFactory").createWid(jid);
  const chat = Chat.get(wid) ?? (await Chat.find(wid));
  if (!chat) return [];

  let msgs = chat.msgs.getModelsArray().filter((m: any) => !m.isNotification);
  const loadMessages = (window as any).require("WAWebChatLoadMessages");
  for (let i = 0; i < pages; i++) {
    const loaded = await loadMessages.loadEarlierMsgs({ chat });
    if (!loaded || !loaded.length) break;
    msgs = [...loaded.filter((m: any) => !m.isNotification), ...msgs];
  }
  return msgs.map(serializeMessage);
}

let listening = false;
function onMsgAdd(msg: any) {
  if (!msg.isNewMsg) return; // loadEarlierMsgs() also fires 'add' — only forward genuinely new ones
  post({ type: "live_message", message: serializeMessage(msg) });
}

function startListening() {
  if (listening) return;
  listening = true;
  getCollections().Msg.on("add", onMsgAdd);
}

function stopListening() {
  if (!listening) return;
  listening = false;
  getCollections().Msg.off("add", onMsgAdd);
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.target !== TARGET) return;

  switch (data.type) {
    case "get_recent_chats":
      post({ type: "recent_chats", requestId: data.requestId, chats: getRecentChats(data.limit ?? 10) });
      break;
    case "get_chat_messages":
      getChatMessages(data.jid, data.pages ?? 10).then((messages) =>
        post({ type: "chat_messages", requestId: data.requestId, jid: data.jid, messages })
      );
      break;
    case "start_listening":
      startListening();
      post({ type: "listening_state", requestId: data.requestId, listening: true });
      break;
    case "stop_listening":
      stopListening();
      post({ type: "listening_state", requestId: data.requestId, listening: false });
      break;
  }
});

// window.require isn't available until WhatsApp Web's own bundle has loaded.
(function waitForWhatsAppWeb() {
  if ((window as any).require) {
    post({ type: "ready" });
  } else {
    setTimeout(waitForWhatsAppWeb, 500);
  }
})();
