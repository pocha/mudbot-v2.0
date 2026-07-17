// TODO: point these at your deployed Cloud Functions / Cloud Run URLs.
export const API_BASE_URL = "https://us-central1-mudbot-v2.cloudfunctions.net";

const WHATSAPP_TAB_KEY = "whatsappTabId";
const ASSISTANT_JID_KEY = "assistantJid";

/** There's a single WhatsApp Web session (one business account) to track, so
 * just one tab id — set by the content script on load, read by background when
 * dispatching a queued command back into the page. */
export async function getWhatsAppTabId(): Promise<number | null> {
  const stored = await chrome.storage.local.get(WHATSAPP_TAB_KEY);
  return stored[WHATSAPP_TAB_KEY] ?? null;
}

export async function setWhatsAppTabId(tabId: number): Promise<void> {
  await chrome.storage.local.set({ [WHATSAPP_TAB_KEY]: tabId });
}

/** The one chat, within that session, treated as talking to the assistant —
 * defaults to WhatsApp's own "Message Yourself" self-chat (see the popup's
 * "Use self-chat" button), but can be reassigned to any jid. Everything else
 * observed in the session is ordinary business traffic. */
export async function getAssistantJid(): Promise<string | null> {
  const stored = await chrome.storage.local.get(ASSISTANT_JID_KEY);
  return stored[ASSISTANT_JID_KEY] ?? null;
}

export async function setAssistantJid(jid: string): Promise<void> {
  await chrome.storage.local.set({ [ASSISTANT_JID_KEY]: jid });
}
