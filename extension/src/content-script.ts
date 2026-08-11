import { createWhatsAppAdapter, type ChatSummary, type DumpedMessage } from "./whatsappAdapter";
import {
  onLiveMessage,
  getRecentChatsViaStore,
  getChatMessagesViaStore,
  startListeningViaStore,
  stopListeningViaStore,
  type RawMessage,
} from "./storeBridge";

const adapter = createWhatsAppAdapter();

// ---- Store-based reliability test: Activate Listen / Reconcile ----
// Captured messages are kept in chrome.storage.local (inject.ts, running in
// the page's MAIN world, has no access to chrome.* APIs at all — this is the
// only place that can persist them). Deliberately a flat array behind one
// key, not a real schema — this is a testing tool, not the production path.
const CAPTURED_KEY = "mudbot_captured_messages";

async function storeCapturedMessage(message: RawMessage) {
  const stored = await chrome.storage.local.get(CAPTURED_KEY);
  const list: RawMessage[] = stored[CAPTURED_KEY] ?? [];
  if (list.some((m) => m.id === message.id)) return; // dedupe
  list.push(message);
  await chrome.storage.local.set({ [CAPTURED_KEY]: list });
}

onLiveMessage((msg) => {
  void storeCapturedMessage(msg);
});

/** Ground truth (getChatMessagesViaStore, a real history fetch) vs. what
 * Activate Listen actually captured live, for the most recently active
 * `chatCount` chats — answers "is the live listener actually reliable?"
 * empirically instead of trusting Chrome's background-tab policies in theory. */
async function reconcile(chatCount: number, pages: number) {
  const chats = await getRecentChatsViaStore(chatCount);
  const stored = await chrome.storage.local.get(CAPTURED_KEY);
  const captured: RawMessage[] = stored[CAPTURED_KEY] ?? [];
  const capturedIds = new Set(captured.map((m) => m.id));

  const perChat: { jid: string; displayName: string; groundTruth: number; missed: number }[] = [];
  let totalMissed = 0;
  for (const chat of chats) {
    const messages = await getChatMessagesViaStore(chat.jid, pages);
    const missed = messages.filter((m) => !capturedIds.has(m.id)).length;
    perChat.push({ jid: chat.jid, displayName: chat.displayName, groundTruth: messages.length, missed });
    totalMissed += missed;
  }
  return { perChat, totalMissed };
}

// ---- Store-based chat list / history dump — now the real implementation
// behind the popup's existing "Load recent chats" / "Dump selected" picker,
// confirmed working (real jids, real text, correct fromMe) against a live
// dump. Replaces the old DOM click-simulation path in whatsappAdapter.ts,
// which never reliably registered clicks — see that file's history. ----

const HISTORY_PAGES = 10; // one "page" == one loadEarlierMsgs() call in inject.ts

function toChatSummary(chat: { jid: string; displayName: string; lastMessageAt: number | null }): ChatSummary {
  return {
    jid: chat.jid,
    displayName: chat.displayName,
    lastMessageAt: chat.lastMessageAt != null ? new Date(chat.lastMessageAt * 1000).toISOString() : "",
  };
}

/** For group messages, `author` (a specific member's id) is the real sender —
 * `jid` alone is just the group. For 1:1 chats / outgoing messages there's no
 * author, so the chat's own display name already unambiguously identifies
 * who's talking. */
function toDumpedMessage(m: RawMessage, chatDisplayName: string): DumpedMessage {
  return {
    jid: m.jid,
    displayName: m.fromMe ? "You" : (m.author ?? chatDisplayName),
    text: m.body,
    direction: m.fromMe ? "outgoing" : "incoming",
    timestamp: m.t != null ? new Date(m.t * 1000).toISOString() : new Date().toISOString(),
  };
}

// A single WhatsApp Web session (the business account) is all there is to
// track — register this tab so background knows where to dispatch queued
// commands, and forward every observed message for background to route
// (assistant chat -> instruction, anything else -> passive ingest).
chrome.runtime.sendMessage({ kind: "register_tab" });

adapter.observe((msg) => {
  chrome.runtime.sendMessage({
    kind: "whatsapp_message",
    jid: msg.jid,
    displayName: msg.displayName,
    rawText: msg.text,
    direction: msg.direction,
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Background dispatches queued commands here once it's decided (per pattern
  // stage / confirm policy) that something should actually be sent.
  if (message.kind === "execute_send") {
    adapter
      .sendMessage(message.target.jid, message.text)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  // Triggered when the popup opens its chat picker — offline-testing input.
  if (message.kind === "list_recent_chats") {
    getRecentChatsViaStore(message.limit)
      .then((chats) => sendResponse({ ok: true, chats: chats.map(toChatSummary) }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Triggered from the popup's "Dump selected" button, with the {jid,
  // displayName} pairs the owner left checked in the picker (the popup
  // already has these from list_recent_chats, above) — see
  // scripts/train-from-dump.ts.
  if (message.kind === "dump_conversations") {
    (async () => {
      const results: DumpedMessage[] = [];
      for (const chat of message.chats as { jid: string; displayName: string }[]) {
        const chatMessages = await getChatMessagesViaStore(chat.jid, HISTORY_PAGES);
        results.push(...chatMessages.map((m) => toDumpedMessage(m, chat.displayName)));
      }
      return results;
    })()
      .then((messages) => sendResponse({ ok: true, messages }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Triggered from the popup's "Use self-chat as assistant" button.
  if (message.kind === "get_self_jid") {
    adapter
      .getSelfJid()
      .then((jid) => sendResponse({ ok: true, jid }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Store-based reliability test (see above): "Activate Listen" toggle and
  // "Reconcile" button in the popup.
  if (message.kind === "activate_listen") {
    startListeningViaStore()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.kind === "deactivate_listen") {
    stopListeningViaStore()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.kind === "reconcile") {
    reconcile(message.chatCount ?? 10, message.pages ?? 10)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
