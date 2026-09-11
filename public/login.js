import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  RecaptchaVerifier,
  signInWithPhoneNumber,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

// Committed and public on purpose: Firebase web config isn't secret (it's
// protected by security rules / App Check, not by being hidden), and GitHub
// Pages has no mechanism to inject values at deploy time the way a real build
// step would — whatever's checked in is exactly what gets served. Unlike the
// extension's gitignored firebaseConfig.ts, there's no way around that here.
const firebaseConfig = {
  apiKey: "AIzaSyCIRfi_ByJTEaZT32H7GOdr7tiLZrQpigg",
  authDomain: "watobot-v2.firebaseapp.com",
  projectId: "watobot-v2",
};

// No build step for this file, so local mode is detected at runtime instead
// of a manual toggle — this page (and index.html/chat.js) behave the same
// whether served from GitHub Pages or the Firebase Hosting emulator, based
// purely on what host they're actually loaded from.
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

const MINT_TOKEN_URL = isLocal
  ? "http://127.0.0.1:5001/watobot-v2/asia-south1/mintExtensionToken"
  : "https://asia-south1-watobot-v2.cloudfunctions.net/mintExtensionToken";

// Fixed by extension/manifest.json's pinned "key" — see README for how this
// was generated. Must match exactly or externally_connectable messaging fails.
const EXTENSION_ID = "abhnmgnjadkjoledgljhcjikppijnfhd";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
if (isLocal) {
  // Connecting to the Auth Emulator is also what disables the real reCAPTCHA
  // requirement below — phone auth against the emulator skips app
  // verification entirely, so a fixed test phone number (set up once via the
  // Emulator UI, see README) works without any real SMS/reCAPTCHA.
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
}

const $ = (id) => document.getElementById(id);

let confirmationResult = null;
const verifier = new RecaptchaVerifier(auth, "recaptcha-container", { size: "normal" });

$("send-code").addEventListener("click", async () => {
  const phone = $("phone").value.trim();
  try {
    confirmationResult = await signInWithPhoneNumber(auth, phone, verifier);
    $("login-form").classList.add("hidden");
    $("code-form").classList.remove("hidden");
  } catch (err) {
    $("status").textContent = `Error: ${err.message}`;
  }
});

$("confirm-code").addEventListener("click", async () => {
  const code = $("code").value.trim();
  if (!confirmationResult) return;
  try {
    const credential = await confirmationResult.confirm(code);
    $("status").textContent = "Signed in — handing off to the extension...";
    await handOffToExtension(credential.user);
  } catch (err) {
    $("status").textContent = `Error: ${err.message}`;
  }
});

async function handOffToExtension(user) {
  const idToken = await user.getIdToken();

  const res = await fetch(MINT_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    $("status").textContent = `Error minting extension token: ${res.status}`;
    return;
  }
  const { customToken } = await res.json();

  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    $("status").textContent =
      "Signed in, but this browser doesn't expose extension messaging — open this page in Chrome with the extension installed.";
    return;
  }

  chrome.runtime.sendMessage(EXTENSION_ID, { type: "auth-success", customToken }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      $("status").textContent =
        `Signed in, but couldn't reach the extension (${chrome.runtime.lastError?.message ?? "no response"}). ` +
        "Make sure it's installed, then reload this page and try again.";
      return;
    }
    // This page's own session (from signInWithPhoneNumber above, not the
    // custom token just handed to the extension) is what index.html's chat
    // page checks — the user is already signed in on this origin too, so
    // there's a real session to carry over.
    $("status").textContent = "Signed in! Redirecting to chat...";
    setTimeout(() => (location.href = "./index.html"), 800);
  });
}
