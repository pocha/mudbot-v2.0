// TODO: point these at your deployed Cloud Functions / Cloud Run URLs.
export const API_BASE_URL = "https://asia-south1-watobot-v2.cloudfunctions.net";

// The hosted login page (see public/), opened by the popup's Login button when
// no one's signed in yet — phone-auth's reCAPTCHA can't run inside the
// extension itself (see README's Known gaps).
export const HOSTED_LOGIN_URL = "https://pocha.fyi/";

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
