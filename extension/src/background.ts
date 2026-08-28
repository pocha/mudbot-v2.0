import { signInWithCustomToken } from "firebase/auth";
import { auth } from "./firebaseClient";
import { API_BASE_URL } from "./config";

/**
 * Phone-auth's reCAPTCHA can't run inside an MV3 extension page, so login
 * happens on the hosted GitHub Pages login page instead (see public/login.js).
 * That page verifies the phone number, mints a Firebase custom token via the
 * mintExtensionToken Cloud Function, and sends it here via externally_connectable
 * messaging. Signing in with it gives the extension its own independent,
 * self-refreshing Firebase session — same as a normal login from then on.
 */
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message.type === "auth-success" && message.customToken) {
    signInWithCustomToken(auth, message.customToken)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }
});

// Manifest V3 service workers are not persistent — Chrome can idle-kill this
// between events. This alarm is a best-effort keep-alive, not a guarantee; see
// the plan's "Best-Effort Online Mitigations" section for why that's accepted
// rather than fought.
chrome.alarms.create("keep-alive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  /* no-op wake */
});

async function apiFetch(path: string, body: unknown) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) {
    console.warn("[mudbot-v2.0] not signed in yet — open the popup to log in");
    return;
  }
  await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.kind === "register_tab" && sender.tab?.id != null) {
    // Backstop against Chrome's Memory Saver / general tab discarding under
    // memory pressure — without this, a long-idle background tab can be
    // killed and silently take the live listener with it.
    chrome.tabs.update(sender.tab.id, { autoDiscardable: false });
    return;
  }

  if (message.kind === "whatsapp_message") {
    // WhatsApp is passive-listening only — there's no assistant chat / instruct
    // concept here anymore (that's moved to the web chat page). Every chat in
    // this session is ordinary business traffic, ingested regardless of
    // direction (both the customer's messages and the owner's own replies
    // matter as memory).
    const { jid, rawText, fromMe } = message as { jid: string; rawText: string; fromMe: boolean };
    void apiFetch("/ingest", { rawText, sourceJid: jid, direction: fromMe ? "outgoing" : "incoming" });
  }
});

