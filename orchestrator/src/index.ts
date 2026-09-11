import { config } from "dotenv";
import { resolve } from "node:path";

// NODE_ENV=development is what `npm start` (repo root) sets before starting
// this process — the single source of truth for "local mode" that everything
// downstream (below, and container/src/firebaseClient.ts once NODE_ENV is
// forwarded into the container's own env) keys off. .env.local is layered on
// top of .env (not instead of it) — override:true lets its few local-only
// fields (MINT_TOKEN_URL etc.) take precedence, while secrets that don't
// need a different value locally (FIREBASE_API_KEY, ORCHESTRATOR_SHARED_KEY,
// GEMINI_API_KEY) still come from the real, gitignored .env. This mirrors
// Cloud Functions' own .env.local convention (see functions/.env.example).
const IS_DEV = process.env.NODE_ENV === "development";
config({ path: resolve(__dirname, "../.env") });
if (IS_DEV) config({ path: resolve(__dirname, "../.env.local"), override: true });

import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCustomToken } from "firebase/auth";
import { getDatabase, connectDatabaseEmulator, ref, onChildAdded, remove, type DatabaseReference } from "firebase/database";
import { isContainerRunning, startContainer, dispatchToContainer, checkDockerReady } from "./containerManager";

/**
 * The VM orchestrator: purely mechanical, no LLM calls of its own (see the
 * architecture writeup). It never holds a Firestore/RTDB admin credential —
 * it signs in as the fixed "orchestrator-service" uid (scoped by
 * database.rules.json to read-only on dispatchQueue) and, per job, requests a
 * token scoped to that job's user before dispatching to a container.
 * Everything this process does is outbound: mintContainerToken (HTTPS) and
 * Firebase's own SDKs — no inbound port is ever opened here.
 *
 * Containers are created once per user and reused across jobs via
 * `docker exec` (containerManager.ts) rather than a fresh `docker run --rm`
 * per job — closes the latency gap an earlier version had (every job paying
 * full container cold-start cost even back-to-back from the same user).
 * Known gap, called out rather than hidden: containers are never stopped
 * once started — no idle-timeout/health-check yet.
 */

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
const MINT_TOKEN_URL = requireEnv("MINT_TOKEN_URL");
const ORCHESTRATOR_SHARED_KEY = requireEnv("ORCHESTRATOR_SHARED_KEY");
const CONTAINER_IMAGE = requireEnv("CONTAINER_IMAGE");
const GEMINI_API_KEY = requireEnv("GEMINI_API_KEY");

// This process runs directly on the host, so it reaches the emulators at
// FIREBASE_EMULATOR_HOST (127.0.0.1 in practice, from .env.local). The
// container it dispatches to runs inside Docker, where "localhost"/127.0.0.1
// means the container itself — CONTAINER_FIREBASE_EMULATOR_HOST is the
// separate value (host.docker.internal on Docker Desktop) forwarded into
// that container's own env instead. See container/src/firebaseClient.ts.
const FIREBASE_EMULATOR_HOST = IS_DEV ? requireEnv("FIREBASE_EMULATOR_HOST") : "";
const CONTAINER_FIREBASE_EMULATOR_HOST = IS_DEV ? requireEnv("CONTAINER_FIREBASE_EMULATOR_HOST") : "";

interface DispatchJob {
  uid: string;
  commandId: string;
  type: "execute" | "build";
  capabilityId?: string;
  rawText: string;
  params?: Record<string, unknown>;
  intent?: string;
  createdAt: number;
}

/** The only thing that actually mints a token — this process just asks. See
 * the architecture writeup's note on the request/mint/exchange split. */
async function mintTokenFor(uid: string): Promise<string> {
  const res = await fetch(MINT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-orchestrator-key": ORCHESTRATOR_SHARED_KEY },
    body: JSON.stringify({ uid }),
  });
  if (!res.ok) throw new Error(`mintContainerToken(${uid}) failed: ${res.status} ${await res.text()}`);
  const { customToken } = (await res.json()) as { customToken: string };
  return customToken;
}

export async function dispatchJob(job: DispatchJob, customToken: string): Promise<void> {
  const env: Record<string, string> = {
    CUSTOM_TOKEN: customToken,
    UID: job.uid,
    COMMAND_ID: job.commandId,
    JOB_TYPE: job.type,
    FIREBASE_API_KEY: firebaseConfig.apiKey,
    FIREBASE_AUTH_DOMAIN: firebaseConfig.authDomain,
    FIREBASE_PROJECT_ID: firebaseConfig.projectId,
    FIREBASE_DATABASE_URL: firebaseConfig.databaseURL,
    // Executor no longer calls an LLM at all (Decision Maker already
    // extracted params before dispatch) — only Creator needs this key, but
    // passing it unconditionally is simpler and no less safe than the
    // orchestrator already holding it.
    GEMINI_API_KEY,
  };
  if (IS_DEV) {
    env.NODE_ENV = "development";
    env.FIREBASE_EMULATOR_HOST = CONTAINER_FIREBASE_EMULATOR_HOST;
  }
  if (job.type === "execute") {
    env.CAPABILITY_ID = job.capabilityId!;
    env.PARAMS = JSON.stringify(job.params ?? {});
  } else {
    env.RAW_TEXT = job.rawText;
    if (job.intent) env.INTENT = job.intent;
  }

  if (!(await isContainerRunning(job.uid))) {
    console.log(`[orchestrator] no container running for uid=${job.uid}, starting one`);
    await startContainer(job.uid, CONTAINER_IMAGE);
  }

  console.log(`[orchestrator] dispatching to container for uid=${job.uid} type=${job.type} commandId=${job.commandId}`);
  try {
    await dispatchToContainer(job.uid, env);
    console.log(`[orchestrator] container job for commandId=${job.commandId} finished`);
  } catch (err) {
    console.error(`[orchestrator] container job for commandId=${job.commandId} failed:`, (err as Error).message);
  }
}

/** The per-job unit of work triggered by a dispatchQueue child appearing —
 * pulled out of the onChildAdded callback so it's testable without wiring up
 * a real RTDB listener. Removes the job before dispatching (see the
 * at-most-once comment above `onChildAdded` below) and swallows any error so
 * one bad job never kills the listener. */
export async function processJob(job: DispatchJob, jobRef: DatabaseReference): Promise<void> {
  await remove(jobRef);
  try {
    const token = await mintTokenFor(job.uid);
    await dispatchJob(job, token);
  } catch (err) {
    console.error(`[orchestrator] failed to dispatch job for uid=${job.uid}:`, (err as Error).message);
  }
}

async function main() {
  await checkDockerReady(CONTAINER_IMAGE);
  console.log(`[orchestrator] Docker is ready (${CONTAINER_IMAGE} present).`);

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);

  if (IS_DEV) {
    connectAuthEmulator(auth, `http://${FIREBASE_EMULATOR_HOST}:9099`, { disableWarnings: true });
    connectDatabaseEmulator(db, FIREBASE_EMULATOR_HOST, 9000);
    console.log(`[orchestrator] using local emulators at ${FIREBASE_EMULATOR_HOST}`);
  }

  const bootstrapToken = await mintTokenFor("orchestrator-service");
  await signInWithCustomToken(auth, bootstrapToken);
  console.log("[orchestrator] signed in as orchestrator-service, watching dispatchQueue");

  const dispatchQueueRef = ref(db, "dispatchQueue");

  // child_added replays every existing child on first attach, not just new
  // ones from here on — dispatchQueue has to be actively cleared as jobs are
  // picked up, or every orchestrator restart would reprocess every job ever
  // dispatched. Removed right when picked up (before the container even
  // starts) rather than after it finishes, matching the at-most-once
  // semantics the Firestore triggers already use (RETRY_POLICY_DO_NOT_RETRY)
  // — a crash mid-run drops the job rather than silently double-running it.
  const unsubscribe = onChildAdded(dispatchQueueRef, async (snapshot) => {
    const job = snapshot.val() as DispatchJob | null;
    if (!job) return;
    await processJob(job, snapshot.ref);
  });

  process.on("SIGINT", () => {
    unsubscribe();
    process.exit(0);
  });
}

// Guarded so importing this module (as index.test.ts does) doesn't trigger a
// real sign-in/listener — only running it directly (`node lib/index.js`) does.
if (require.main === module) {
  main().catch((err) => {
    console.error("[orchestrator] fatal:", err);
    process.exit(1);
  });
}
