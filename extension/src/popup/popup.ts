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

  $("dump-status").textContent = "Loading chats...";
  chrome.tabs.sendMessage(tab.id, { kind: "list_recent_chats", limit }, (response) => {
    if (!response?.ok) {
      $("dump-status").textContent = `Error: ${response?.error ?? "no response from page"}`;
      return;
    }
    loadedChats = response.chats;
    renderChatList(loadedChats);
    $("dump-status").textContent = `Loaded ${loadedChats.length} chats — deselect anything that isn't a business conversation.`;
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

  $("dump-status").textContent = `Dumping ${selectedJids.length} chats (this can take a while)...`;
  chrome.tabs.sendMessage(tab.id, { kind: "dump_conversations", jids: selectedJids }, (response) => {
    if (!response?.ok) {
      $("dump-status").textContent = `Error: ${response?.error ?? "no response from page"}`;
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

auth.onAuthStateChanged((user) => {
  if (user) {
    $("auth-section").style.display = "none";
    $("assistant-section").style.display = "block";
    $("dump-section").style.display = "block";
  } else {
    $("auth-section").style.display = "block";
    $("assistant-section").style.display = "none";
    $("dump-section").style.display = "none";
    $("status").textContent = "Not signed in yet — click Login, then come back here.";
  }
});
