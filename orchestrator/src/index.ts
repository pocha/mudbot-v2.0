import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(__dirname, "../.env") });

import { execFile } from "node:child_process";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import { getDatabase, ref, onChildAdded, remove } from "firebase/database";
import { CONTAINER_MEMORY_LIMIT, CONTAINER_TIMEOUT_MS } from "./config";

/**
 * The VM orchestrator: purely mechanical, no LLM calls of its own (see the
 * architecture writeup). It never holds a Firestore/RTDB admin credential —
 * it signs in as the fixed "orchestrator-service" uid (scoped by
 * database.rules.json to read-only on dispatchQueue) and, per job, requests a
 * token scoped to that job's user before starting a container. Everything
 * this process does is outbound: mintContainerToken (HTTPS) and Firebase's
 * own SDKs — no inbound port is ever opened here.
 *
 * V1 simplification, called out rather than hidden: containers are fully
 * ephemeral (`docker run --rm` per job), not the persistent, idle-stopped
 * per-user containers the architecture writeup describes. That's a real
 * regression against the "preserve state across builds" goal — revisit once
 * there's an actual reason to (e.g. Creator builds that need to survive
 * across multiple LLM round trips longer than one `docker run` should live).
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

function runContainer(job: DispatchJob, customToken: string): void {
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
  if (job.type === "execute") {
    env.CAPABILITY_ID = job.capabilityId!;
    env.PARAMS = JSON.stringify(job.params ?? {});
  } else {
    env.RAW_TEXT = job.rawText;
    if (job.intent) env.INTENT = job.intent;
  }

  const args = ["run", "--rm", "--memory", CONTAINER_MEMORY_LIMIT];
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(CONTAINER_IMAGE);

  console.log(`[orchestrator] starting container for uid=${job.uid} type=${job.type} commandId=${job.commandId}`);
  execFile("docker", args, { timeout: CONTAINER_TIMEOUT_MS }, (err, stdout, stderr) => {
    if (err) {
      console.error(`[orchestrator] container for commandId=${job.commandId} failed:`, err.message);
      if (stderr) console.error(stderr);
      return;
    }
    console.log(`[orchestrator] container for commandId=${job.commandId} finished`);
    if (stdout) console.log(stdout);
  });
}

async function main() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);

  const bootstrapToken = await mintTokenFor("orchestrator-service");
  await signInWithCustomToken(auth, bootstrapToken);
  console.log("[orchestrator] signed in as orchestrator-service, watching dispatchQueue");

  const db = getDatabase(app);
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
    await remove(snapshot.ref);
    try {
      const token = await mintTokenFor(job.uid);
      runContainer(job, token);
    } catch (err) {
      console.error(`[orchestrator] failed to dispatch job ${snapshot.key}:`, (err as Error).message);
    }
  });

  process.on("SIGINT", () => {
    unsubscribe();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[orchestrator] fatal:", err);
  process.exit(1);
});
