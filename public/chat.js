import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithCustomToken,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getDatabase,
  connectDatabaseEmulator,
  ref,
  push,
  onValue,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js";

// See login.js for why this is runtime-detected rather than a build-time
// toggle — no build step exists for anything under public/.
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

const firebaseConfig = {
  apiKey: "AIzaSyCIRfi_ByJTEaZT32H7GOdr7tiLZrQpigg",
  authDomain: "watobot-v2.firebaseapp.com",
  projectId: "watobot-v2",
  // Realtime Database's regions are a much smaller set than Firestore's —
  // this project's instance isn't at the default *.firebaseio.com form. Not
  // used at all in local mode (connectDatabaseEmulator below redirects every
  // call regardless of what's here), only kept accurate for the real path.
  databaseURL: "https://watobot-v2-default-rtdb.asia-southeast1.firebasedatabase.app",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
if (isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectDatabaseEmulator(db, "127.0.0.1", 9000);
}

const $ = (id) => document.getElementById(id);
const log = $("log");
const form = $("send-form");
const input = $("message");

function addBubble(text, { fromUser }) {
  const bubble = document.createElement("div");
  bubble.className = fromUser
    ? "self-end max-w-[85%] bg-primary-container text-on-primary-container rounded-xl px-4 py-2"
    : "self-start max-w-[85%] bg-surface-container-low text-on-surface rounded-xl px-4 py-2";
  bubble.textContent = text;
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

// `npm start` (local dev) writes a signed-in token for a fixed test uid to
// local-test-token.json once the emulators are up (see
// scripts/src/local-dev.ts) — trying that first, and awaiting it before the
// onAuthStateChanged listener below attaches, means the real login flow
// never has a moment to redirect you away first. Not present (no local
// npm start, or the real login page) — this just resolves false and the
// normal flow below runs exactly as it does in production.
async function tryLocalAutoLogin() {
  if (!isLocal) return false;
  try {
    const res = await fetch("./local-test-token.json", { cache: "no-store" });
    if (!res.ok) return false;
    const { customToken } = await res.json();
    await signInWithCustomToken(auth, customToken);
    return true;
  } catch {
    return false;
  }
}

tryLocalAutoLogin().then(() => {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      location.href = "./login.html";
      return;
    }
    form.classList.remove("hidden");
    $("status").textContent = "";

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const rawText = input.value.trim();
      if (!rawText) return;
      input.value = "";
      void sendCommand(user.uid, rawText);
    });
  });
});

async function sendCommand(uid, rawText) {
  addBubble(rawText, { fromUser: true });
  const waiting = addBubble("...", { fromUser: false });

  const commandRef = await push(ref(db, `commands/${uid}`), { rawText });

  // Same node gets {reply, repliedAt} written back onto it by Decision Maker
  // (clarify) or by Executor/Creator once the VM's done (execute/build) — see
  // functions/src/rtdb.ts's replyToCommand and README's architecture notes.
  const unsubscribe = onValue(commandRef, (snapshot) => {
    const value = snapshot.val();
    if (value?.reply) {
      waiting.textContent = value.reply;
      unsubscribe();
    }
  });
}
