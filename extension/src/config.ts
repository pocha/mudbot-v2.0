// TODO: point these at your deployed Cloud Functions / Cloud Run URLs.
export const API_BASE_URL = "https://asia-south1-watobot-v2.cloudfunctions.net";

// The hosted login page (see public/), opened by the popup's Login button when
// no one's signed in yet — phone-auth's reCAPTCHA can't run inside the
// extension itself (see README's Known gaps).
export const HOSTED_LOGIN_URL = "https://pocha.fyi/";

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

/** The real WhatsApp jid of the dedicated assistant number — a distinct
 * identity the owner messages to give instructions, not a self-chat (a
 * message the owner sends TO this jid is an instruction; a message FROM it
 * is the assistant's own reply and is ignored, see background.ts). Set via
 * the popup's manual jid field. Everything else observed in the session is
 * ordinary business traffic. */
export async function getAssistantJid(): Promise<string | null> {
  const stored = await chrome.storage.local.get(ASSISTANT_JID_KEY);
  return stored[ASSISTANT_JID_KEY] ?? null;
}

export async function setAssistantJid(jid: string): Promise<void> {
  await chrome.storage.local.set({ [ASSISTANT_JID_KEY]: jid });
}

const LISTENING_STATE_KEY = "mudbot_is_listening";
// Wall-clock time (unix seconds, matching RawMessage.t) Activate Listen was
// last turned on — reconcile only judges messages from after this point,
// since anything older was never a live-capture candidate in the first place.
const LISTEN_ACTIVATED_AT_KEY = "mudbot_listen_activated_at";

/** Shared between content-script.ts (which owns the real listener and writes
 * this) and popup.ts (which only reads it, to restore the toggle-listen
 * button's label across popup reopens instead of always resetting to
 * "Activate Listen"). */
export async function setListeningState(listening: boolean): Promise<void> {
  const patch: Record<string, unknown> = { [LISTENING_STATE_KEY]: listening };
  if (listening) patch[LISTEN_ACTIVATED_AT_KEY] = Date.now() / 1000;
  await chrome.storage.local.set(patch);
}

export async function getListeningState(): Promise<boolean> {
  const stored = await chrome.storage.local.get(LISTENING_STATE_KEY);
  return !!stored[LISTENING_STATE_KEY];
}

export async function getListenActivatedAt(): Promise<number | null> {
  const stored = await chrome.storage.local.get(LISTEN_ACTIVATED_AT_KEY);
  return stored[LISTEN_ACTIVATED_AT_KEY] ?? null;
}
