import { collection, doc, onSnapshot, query, updateDoc, where } from "firebase/firestore";
import { signInWithCustomToken } from "firebase/auth";
import { auth, db } from "./firebaseClient";
import { API_BASE_URL, getAssistantJid, getWhatsAppTabId, setWhatsAppTabId } from "./config";
import type { CommandDoc } from "./commandTypes";

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
    setWhatsAppTabId(sender.tab.id);
    // Backstop against Chrome's Memory Saver / general tab discarding under
    // memory pressure — without this, a long-idle background tab can be
    // killed and silently take the live listener with it.
    chrome.tabs.update(sender.tab.id, { autoDiscardable: false });
    return;
  }

  if (message.kind === "whatsapp_message") {
    (async () => {
      const assistantJid = await getAssistantJid();
      // The one chat marked as "the assistant" is where the owner gives
      // instructions; every other chat in this same session is ordinary
      // business traffic and gets passively ingested regardless of direction.
      if (assistantJid && message.jid === assistantJid && message.direction === "incoming") {
        await apiFetch("/instruct", { rawText: message.rawText });
      } else {
        await apiFetch("/ingest", { rawText: message.rawText, sourceJid: message.jid, direction: message.direction });
      }
    })();
  }
});

/**
 * Extension-bridge execution: watches this user's pending commands and
 * dispatches each to the one registered WhatsApp tab — there's only one
 * session, so the only thing that varies per command is which chat it targets
 * (the assistant chat vs. a real customer/group jid), not which tab executes it.
 *
 * NOTE (scaffold simplification): this sends immediately on "pending" rather
 * than waiting for a YES/STOP reply in the assistant chat first. Wiring the
 * interactive confirm-via-WhatsApp-reply step is a follow-up once the real DOM
 * adapter exists to parse those replies.
 */
function watchCommands(uid: string) {
  const q = query(collection(db, `users/${uid}/commands`), where("status", "==", "pending"));
  onSnapshot(q, (snap) => {
    snap.docChanges().forEach(async (change) => {
      if (change.type !== "added") return;
      const command = change.doc.data() as CommandDoc;
      const tabId = await getWhatsAppTabId();
      if (tabId == null) {
        console.warn("[mudbot-v2.0] no WhatsApp tab registered yet, command stays pending");
        return;
      }
      chrome.tabs.sendMessage(
        tabId,
        { kind: "execute_send", target: command.target, text: command.text },
        async (response) => {
          await updateDoc(doc(db, `users/${uid}/commands/${change.doc.id}`), {
            status: response?.ok ? "sent" : "rejected",
            updatedAt: new Date(),
          });
        }
      );
    });
  });
}

auth.onAuthStateChanged((user) => {
  if (user) watchCommands(user.uid);
});
