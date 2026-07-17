import { RecaptchaVerifier, signInWithPhoneNumber, type ConfirmationResult } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "../firebaseClient";
import { setAssistantJid } from "../config";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

let confirmationResult: ConfirmationResult | null = null;

const verifier = new RecaptchaVerifier(auth, "recaptcha-container", { size: "normal" });

$("send-code").addEventListener("click", async () => {
  const phone = ($("phone") as HTMLInputElement).value.trim();
  try {
    confirmationResult = await signInWithPhoneNumber(auth, phone, verifier);
    $("login-form").style.display = "none";
    $("code-form").style.display = "block";
  } catch (err) {
    $("status").textContent = `Error: ${(err as Error).message}`;
  }
});

$("confirm-code").addEventListener("click", async () => {
  const code = ($("code") as HTMLInputElement).value.trim();
  if (!confirmationResult) return;
  try {
    await confirmationResult.confirm(code);
    $("status").textContent = "Signed in.";
    $("auth-section").style.display = "none";
    $("assistant-section").style.display = "block";
  } catch (err) {
    $("status").textContent = `Error: ${(err as Error).message}`;
  }
});

/** Persists the assistant jid both locally (chrome.storage, read by
 * background.ts to route incoming messages) and server-side (users/{uid},
 * read by dispatch.ts's notifyUser to know where to send suggestions/FYIs). */
async function saveAssistantJid(jid: string) {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    $("assistant-status").textContent = "Not signed in.";
    return;
  }
  await setAssistantJid(jid);
  await setDoc(doc(db, `users/${uid}`), { assistantJid: jid }, { merge: true });
  $("assistant-status").textContent = `Assistant chat set to ${jid}.`;
}

$("use-self-chat").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("web.whatsapp.com")) {
    $("assistant-status").textContent = "Open web.whatsapp.com in this tab first.";
    return;
  }
  chrome.tabs.sendMessage(tab.id, { kind: "get_self_jid" }, async (response) => {
    if (!response?.ok || !response.jid) {
      $("assistant-status").textContent = `Error: ${response?.error ?? "could not detect self-chat jid"}`;
      return;
    }
    await saveAssistantJid(response.jid);
  });
});

$("set-manual-jid").addEventListener("click", () => {
  const jid = ($("manual-jid") as HTMLInputElement).value.trim();
  if (!jid) return;
  saveAssistantJid(jid);
});

/** Offline-testing export: ask this tab's content script to scrape visible
 * history, then trigger a download. See scripts/train-from-dump.ts and
 * scripts/simulate.ts for what to do with the resulting file. */
$("dump-conversation").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("web.whatsapp.com")) {
    $("dump-status").textContent = "Open web.whatsapp.com in this tab first.";
    return;
  }

  $("dump-status").textContent = "Dumping...";
  chrome.tabs.sendMessage(tab.id, { kind: "dump_conversation" }, (response) => {
    if (!response?.ok) {
      $("dump-status").textContent = `Error: ${response?.error ?? "no response from page"}`;
      return;
    }

    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), messages: response.messages }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mudbot-conversation-dump-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    $("dump-status").textContent = `Dumped ${response.messages.length} messages.`;
  });
});

auth.onAuthStateChanged((user) => {
  if (user) {
    $("auth-section").style.display = "none";
    $("assistant-section").style.display = "block";
    $("dump-section").style.display = "block";
  }
});
