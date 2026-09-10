import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

const firebaseConfig = {
  apiKey: requireEnv("FIREBASE_API_KEY"),
  authDomain: requireEnv("FIREBASE_AUTH_DOMAIN"),
  projectId: requireEnv("FIREBASE_PROJECT_ID"),
  databaseURL: requireEnv("FIREBASE_DATABASE_URL"),
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);

/** The orchestrator hands this container a token scoped to exactly one uid
 * (see the architecture writeup's request/mint/exchange split) — signing in
 * with it is what makes every Firestore/RTDB call below rules-enforced to
 * that one user, regardless of what the capability code itself does. */
export async function signIn(): Promise<void> {
  await signInWithCustomToken(auth, requireEnv("CUSTOM_TOKEN"));
}
