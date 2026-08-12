import { createWhatsAppAdapter, type ChatSummary, type DumpedMessage } from "./whatsappAdapter";
import { getListenActivatedAt, setListeningState } from "./config";
import {
  onLiveMessage,
  getRecentChatsViaStore,
  getChatMessagesViaStore,
  getRecentMessagesViaStore,
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

/** `t` is WhatsApp's own send-time for the message; `capturedAt` is our local
 * wall-clock time when onMsgAdd actually fired here. They're expected to be
 * seconds apart for genuinely real-time delivery — a large gap means the
 * message only showed up after some delay (e.g. only flushed once the tab
 * regained focus), which `t` alone can't reveal since it never changes. */
interface CapturedMessage extends RawMessage {
  capturedAt: number;
}

async function storeCapturedMessage(message: RawMessage) {
  const stored = await chrome.storage.local.get(CAPTURED_KEY);
  const list: CapturedMessage[] = stored[CAPTURED_KEY] ?? [];
  if (list.some((m) => m.id === message.id)) return; // dedupe
  list.push({ ...message, capturedAt: Date.now() / 1000 });
  await chrome.storage.local.set({ [CAPTURED_KEY]: list });
}

onLiveMessage((msg) => {
  void storeCapturedMessage(msg);
});

/** Ground truth (getRecentMessagesViaStore, a real history fetch of the last
 * `messageCount` messages, filtered to those sent after Activate Listen was
 * turned on) vs. what Activate Listen actually captured live, for the most
 * recently active `chatCount` chats — answers "is the live listener actually
 * reliable?" empirically instead of trusting Chrome's background-tab
 * policies in theory. */
async function reconcile(chatCount: number, messageCount: number) {
  const activatedAt = await getListenActivatedAt();
  if (activatedAt == null) {
    throw new Error("Activate Listen at least once before reconciling.");
  }
  const stored = await chrome.storage.local.get(CAPTURED_KEY);
  const captured: CapturedMessage[] = stored[CAPTURED_KEY] ?? [];
  const capturedById = new Map(captured.map((m) => [m.id, m]));

  const chats = await getRecentChatsViaStore(chatCount);
  let totalMissed = 0;
  let totalGroundTruth = 0;
  const lagsSeconds: number[] = [];
  for (const chat of chats) {
    const messages = (await getRecentMessagesViaStore(chat.jid, messageCount)).filter(
      (m) => m.t != null && m.t >= activatedAt
    );
    totalGroundTruth += messages.length;
    for (const m of messages) {
      const cap = capturedById.get(m.id);
      if (!cap) {
        totalMissed++;
      } else if (m.t != null) {
        lagsSeconds.push(cap.capturedAt - m.t);
      }
    }
  }
  const maxLagSeconds = lagsSeconds.length ? Math.max(...lagsSeconds) : null;
  return { totalMissed, totalGroundTruth, maxLagSeconds };
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
      .then(() => setListeningState(true))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.kind === "deactivate_listen") {
    stopListeningViaStore()
      .then(() => setListeningState(false))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.kind === "reconcile") {
    reconcile(message.chatCount ?? 10, message.messageCount ?? 10)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
