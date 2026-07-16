import { createWhatsAppAdapter } from "./whatsappAdapter";
import type { SessionRole } from "./config";

const adapter = createWhatsAppAdapter();

let role: SessionRole | null = null;

async function init() {
  role = await chrome.runtime.sendMessage({ kind: "whoAmI" });
  if (!role) {
    console.warn("[mudbot-v2.0] this tab has no role assigned yet — set it from the extension popup");
    return;
  }

  adapter.observe((msg) => {
    if (role === "numberA") {
      // Every message on the business number is passively ingested, regardless
      // of direction — the server decides what, if anything, it means.
      chrome.runtime.sendMessage({
        kind: "whatsapp_message",
        role,
        rawText: msg.text,
        sourceJid: msg.jid,
        direction: msg.direction,
      });
    } else if (role === "numberB" && msg.direction === "incoming") {
      // On the assistant number, an incoming message is the user talking to
      // the assistant — i.e. an explicit instruction.
      chrome.runtime.sendMessage({ kind: "whatsapp_instruction", rawText: msg.text });
    }
  });
}

// Background dispatches pending commands here once it's decided (per pattern
// stage / confirm policy) that this tab's session should actually send something.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.kind === "execute_send" && role) {
    adapter
      .sendMessage(message.target.jid, message.text)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  // Triggered from the popup's "Dump conversation" button — offline-testing
  // input, see scripts/train-from-dump.ts.
  if (message.kind === "dump_conversation") {
    adapter
      .dumpHistory()
      .then((messages) => sendResponse({ ok: true, messages }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

init();
