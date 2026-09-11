import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCustomToken } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getDatabase, connectDatabaseEmulator, ref, update } from "firebase/database";

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

// NODE_ENV=development is forwarded into this container's env by the
// orchestrator (only when the orchestrator itself is running in that mode —
// see orchestrator/src/index.ts) rather than a separate custom flag, so
// "local mode" has one consistent signal across every package. This
// container runs inside Docker, so "localhost" here means the container
// itself, not the host machine — the orchestrator forwards a
// container-specific host (host.docker.internal on Docker Desktop) into
// FIREBASE_EMULATOR_HOST for exactly this reason, distinct from its own
// 127.0.0.1.
if (process.env.NODE_ENV === "development") {
  const host = requireEnv("FIREBASE_EMULATOR_HOST");
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectDatabaseEmulator(rtdb, host, 9000);
}

/** The orchestrator hands this container a token scoped to exactly one uid
 * (see the architecture writeup's request/mint/exchange split) — signing in
 * with it is what makes every Firestore/RTDB call below rules-enforced to
 * that one user, regardless of what the capability code itself does. */
export async function signIn(): Promise<void> {
  await signInWithCustomToken(auth, requireEnv("CUSTOM_TOKEN"));
}

/** Writes onto the same commands/{uid}/{commandId} node the query arrived
 * on — the web chat page is listening there for exactly this update. */
export async function replyToCommand(uid: string, commandId: string, text: string): Promise<void> {
  await update(ref(rtdb, `commands/${uid}/${commandId}`), { reply: text, repliedAt: Date.now() });
}
