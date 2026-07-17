import { createWhatsAppAdapter } from "./whatsappAdapter";

const adapter = createWhatsAppAdapter();

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
    adapter
      .listRecentChats(message.limit)
      .then((chats) => sendResponse({ ok: true, chats }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Triggered from the popup's "Dump selected" button, with the jids the owner
  // left checked in the picker — see scripts/train-from-dump.ts.
  if (message.kind === "dump_conversations") {
    adapter
      .dumpHistory(message.jids)
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
});
