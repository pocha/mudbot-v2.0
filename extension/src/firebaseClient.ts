import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// TODO: fill in from the Firebase console (Project settings -> General -> Your apps).
// Safe to bake into the bundle: these are public client identifiers, not secrets.
const firebaseConfig = {
  apiKey: "TODO",
  authDomain: "TODO.firebaseapp.com",
  projectId: "mudbot-v2",
};

// Popup and background are the same chrome-extension:// origin, so Firebase
// Auth's default IndexedDB persistence is shared between them: signing in via
// the popup (where phone-auth reCAPTCHA can render in a real DOM) makes the
// session visible to background's own onAuthStateChanged too.
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
