import { RecaptchaVerifier, signInWithPhoneNumber, type ConfirmationResult } from "firebase/auth";
import { auth } from "../firebaseClient";
import { setRoleForTab } from "../config";

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
    $("role-section").style.display = "block";
  } catch (err) {
    $("status").textContent = `Error: ${(err as Error).message}`;
  }
});

async function assignRole(role: "numberA" | "numberB") {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("web.whatsapp.com")) {
    $("role-status").textContent = "Open web.whatsapp.com in this tab first.";
    return;
  }
  await setRoleForTab(tab.id, role);
  $("role-status").textContent = `This tab is now ${role}.`;
}

$("set-number-a").addEventListener("click", () => assignRole("numberA"));
$("set-number-b").addEventListener("click", () => assignRole("numberB"));

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
    $("role-section").style.display = "block";
    $("dump-section").style.display = "block";
  }
});
