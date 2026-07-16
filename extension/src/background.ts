import { collection, doc, onSnapshot, query, updateDoc, where } from "firebase/firestore";
import { auth, db } from "./firebaseClient";
import { API_BASE_URL, getRoleForTab, getTabForRole } from "./config";
import type { CommandDoc } from "./commandTypes";

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.kind === "whoAmI" && sender.tab?.id != null) {
    getRoleForTab(sender.tab.id).then(sendResponse);
    return true;
  }
  if (message.kind === "whatsapp_message") {
    apiFetch("/ingest", {
      rawText: message.rawText,
      sourceJid: message.sourceJid,
      direction: message.direction,
    });
  }
  if (message.kind === "whatsapp_instruction") {
    apiFetch("/instruct", { rawText: message.rawText });
  }
});

/**
 * Extension-bridge execution: watches this user's pending commands and dispatches
 * each to whichever tab is registered for the command's executeAs role. This is
 * the only place the extension talks to Firestore's commands collection —
 * everything upstream of this just decided *that* something should be sent.
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
      const tabId = await getTabForRole(command.executeAs);
      if (tabId == null) {
        console.warn(`[mudbot-v2.0] no tab registered for role ${command.executeAs}, command stays pending`);
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
