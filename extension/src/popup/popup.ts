import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "../firebaseClient";
import { setAssistantJid, HOSTED_LOGIN_URL } from "../config";
import type { ChatSummary } from "../whatsappAdapter";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** Phone-auth's reCAPTCHA can't run inside this popup (MV3 blocks remote
 * scripts in extension pages) — the actual verification happens on the hosted
 * login page, which hands a signed-in session back to background.ts via
 * externally_connectable messaging. This button just opens that page. */
$("open-login").addEventListener("click", () => {
  chrome.tabs.create({ url: HOSTED_LOGIN_URL });
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

/** Offline-testing export: WhatsApp has no "pick chats to back up" feature, so
 * this is how the owner narrows a scrape down to just business conversations —
 * load the N most recent chats, deselect anything that isn't one, dump the rest.
 * See scripts/train-from-dump.ts and scripts/simulate.ts for what to do with
 * the resulting file. */
let loadedChats: ChatSummary[] = [];

async function activeWhatsAppTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("web.whatsapp.com")) return null;
  return tab;
}

function renderChatList(chats: ChatSummary[]) {
  const container = $("chat-list");
  container.innerHTML = "";
  for (const chat of chats) {
    const row = document.createElement("label");
    row.className = "chat-row";
    row.innerHTML = `
      <input type="checkbox" checked data-jid="${chat.jid}" />
      <span class="name" title="${chat.displayName}">${chat.displayName}</span>
      <span class="jid">${chat.jid}</span>
    `;
    container.appendChild(row);
  }
}

$("load-chats").addEventListener("click", async () => {
  const tab = await activeWhatsAppTab();
  if (!tab?.id) {
    $("dump-status").textContent = "Open web.whatsapp.com in this tab first.";
    return;
  }
  const limit = Number(($("chat-limit") as HTMLInputElement).value) || 50;

  $("load-chats-status").textContent = "Loading chats...";
  chrome.tabs.sendMessage(tab.id, { kind: "list_recent_chats", limit }, (response) => {
    if (!response?.ok) {
      $("load-chats-status").textContent = `Error: ${response?.error ?? "could not load data. Make sure web.whatsapp.com is open. If already open, navigate to tab & refresh it."}`;
      return;
    }
    loadedChats = response.chats;
    renderChatList(loadedChats);
    $("load-chats-status").textContent = `Loaded ${loadedChats.length} chats — deselect anything that isn't a business conversation.`;
  });
});

function checkboxes(): HTMLInputElement[] {
  return Array.from($("chat-list").querySelectorAll('input[type="checkbox"]'));
}

$("select-all-chats").addEventListener("click", () => checkboxes().forEach((cb) => (cb.checked = true)));
$("select-none-chats").addEventListener("click", () => checkboxes().forEach((cb) => (cb.checked = false)));

$("dump-selected").addEventListener("click", async () => {
  const tab = await activeWhatsAppTab();
  if (!tab?.id) {
    $("dump-status").textContent = "Open web.whatsapp.com in this tab first.";
    return;
  }

  const selectedJids = checkboxes()
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.jid!);
  if (selectedJids.length === 0) {
    $("dump-status").textContent = "Select at least one chat first.";
    return;
  }
  const selectedChats = loadedChats.filter((c) => selectedJids.includes(c.jid));

  $("dump-status").textContent = `Dumping ${selectedJids.length} chats (this can take a while)...`;
  chrome.tabs.sendMessage(tab.id, { kind: "dump_conversations", chats: selectedChats }, (response) => {
    if (!response?.ok) {
      $("dump-status").textContent = `Error: ${response?.error ?? "could not load data. Make sure web.whatsapp.com is open. If already open, navigate to tab & refresh it."}`;
      return;
    }

    const messages = response.messages as { jid: string }[];
    const chats = loadedChats
      .filter((c) => selectedJids.includes(c.jid))
      .map((c) => ({ ...c, messageCount: messages.filter((m) => m.jid === c.jid).length }));

    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), chats, messages }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mudbot-conversation-dump-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    $("dump-status").textContent = `Dumped ${messages.length} messages across ${chats.length} chats.`;
  });
});

/** Store-based reliability test (see content-script.ts / inject.ts). The
 * popup doesn't track the true listening state across reopens — it's just a
 * remote control; re-clicking "Activate" when already active is a harmless
 * no-op on the page side. */
let isListening = false;

$("toggle-listen").addEventListener("click", async () => {
  const tab = await activeWhatsAppTab();
  if (!tab?.id) {
    $("listen-status").textContent = "Open web.whatsapp.com in this tab first.";
    return;
  }
  const kind = isListening ? "deactivate_listen" : "activate_listen";
  chrome.tabs.sendMessage(tab.id, { kind }, (response) => {
    if (!response?.ok) {
      $("listen-status").textContent = `Error: ${response?.error ?? "could not load data. Make sure web.whatsapp.com is open. If already open, navigate to tab & refresh it."}`;
      return;
    }
    isListening = !isListening;
    $("toggle-listen").textContent = isListening ? "Deactivate Listen" : "Activate Listen";
    $("listen-status").textContent = isListening
      ? "Listening — captured messages are being stored locally."
      : "Stopped.";
  });
});

$("reconcile").addEventListener("click", async () => {
  const tab = await activeWhatsAppTab();
  if (!tab?.id) {
    $("reconcile-status").textContent = "Open web.whatsapp.com in this tab first.";
    return;
  }
  $("reconcile-status").textContent = "Reconciling (this fetches real history, can take a bit)...";
  chrome.tabs.sendMessage(tab.id, { kind: "reconcile", chatCount: 10, pages: 10 }, (response) => {
    if (!response?.ok) {
      $("reconcile-status").textContent = `Error: ${response?.error ?? "could not load data. Make sure web.whatsapp.com is open. If already open, navigate to tab & refresh it."}`;
      return;
    }
    const { perChat, totalMissed } = response.result as {
      perChat: { displayName: string; groundTruth: number; missed: number }[];
      totalMissed: number;
    };
    const lines = perChat.map((c) => `${c.displayName}: ${c.missed}/${c.groundTruth} missed`);
    $("reconcile-status").textContent = `Total missed: ${totalMissed}\n${lines.join("\n")}`;
  });
});

/** Testing tools (offline dump, reliability test) don't call the backend at
 * all — they're pure WhatsApp-Store reads written to a local file or
 * chrome.storage.local — so they work whether or not the user is signed in.
 * Only the assistant jid picker actually needs an authenticated uid. */
($("cb-offline-dump") as HTMLInputElement).addEventListener("change", (e) => {
  $("offline-dump-ui").style.display = (e.target as HTMLInputElement).checked ? "block" : "none";
});
($("cb-reliability-test") as HTMLInputElement).addEventListener("change", (e) => {
  $("reliability-test-ui").style.display = (e.target as HTMLInputElement).checked ? "block" : "none";
});

auth.onAuthStateChanged((user) => {
  if (user) {
    $("auth-section").style.display = "none";
    $("assistant-section").style.display = "block";
  } else {
    $("auth-section").style.display = "block";
    $("assistant-section").style.display = "none";
    $("status").textContent = "Not signed in yet — click Login, then come back here.";
  }
});
