#!/usr/bin/env ts-node
/**
 * npm start (root): one command to bring up the full local dev stack —
 * Firebase emulators (Functions/Firestore/RTDB/Auth/Hosting), a small seeded
 * conversation history, and the VM orchestrator (which drives your local
 * Docker containers). The root "start" script sets NODE_ENV=development
 * before invoking this — that's the one signal every package in this repo
 * keys off for local-emulator mode (orchestrator/src/index.ts loads
 * orchestrator/.env.local instead of .env when it sees this, and forwards it
 * into the container it dispatches to), inherited automatically by every
 * child process spawned below rather than re-derived here.
 *
 * See README's "Local Testing" for the one-time setup this assumes
 * (orchestrator/.env.local filled in, a locally built container image,
 * functions/.env in place).
 *
 * The browser extension isn't started here — loading an unpacked extension
 * is inherently a manual Chrome action, documented separately in the README.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import * as admin from "firebase-admin";

const ROOT = resolve(__dirname, "../..");
const TOKEN_FILE = resolve(ROOT, "public/local-test-token.json");
const SEED_LIMIT = 30;

// --userid <uid> (npm start -- --userid my-uid) picks which uid gets both
// the seeded memory below and the chat page's automatic local sign-in —
// defaults to a fixed test uid so `npm start` with no flags still works.
function parseArgs(argv: string[]): { userid: string } {
  const idx = argv.indexOf("--userid");
  const value = idx !== -1 ? argv[idx + 1] : undefined;
  return { userid: value ?? "local-test-uid" };
}
const { userid: TEST_UID } = parseArgs(process.argv.slice(2));

const children: ChildProcess[] = [];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", env });
  children.push(child);
  return child;
}

function runAwait(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = run(cmd, args, env);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`))));
  });
}

// Separate from the NODE_ENV convention above: the Admin SDK has its own,
// native emulator-detection env vars (used by seed-conversation.ts here, and
// by the Functions emulator for its own process automatically) — this script
// has to set them explicitly for the seed subprocess it spawns.
const SEED_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000",
};

/**
 * Mints a custom token for TEST_UID against the Auth Emulator (which, unlike
 * real Firebase Auth, needs no real service-account credential to do this —
 * an emulator-only feature) and drops it where chat.js can find it. This is
 * what lets `npm start` land you straight on the chat UI signed in as
 * TEST_UID, without going through the real phone-auth flow first — that flow
 * still works too (chat.js falls back to it if this file isn't there), this
 * is purely a local-dev convenience layered on top.
 */
async function writeLocalLoginToken(uid: string): Promise<void> {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
  const app = admin.initializeApp({ projectId: "watobot-v2" });
  try {
    const customToken = await admin.auth(app).createCustomToken(uid);
    writeFileSync(TOKEN_FILE, JSON.stringify({ uid, customToken }));
    console.log(`[local-dev] chat page will auto-sign-in as uid=${uid}`);
  } finally {
    await app.delete();
  }
}

async function waitForEmulatorHub(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:4400/emulators");
      if (res.ok) return;
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for the Firebase Emulator Hub to come up");
}

function findDumpFile(): string | null {
  const match = readdirSync(ROOT).find((f) => /^mudbot-conversation-dump.*\.json$/.test(f));
  return match ? resolve(ROOT, match) : null;
}

async function seed(): Promise<void> {
  const dump = findDumpFile();
  if (!dump) {
    console.log(
      "[local-dev] no mudbot-conversation-dump*.json found in repo root — skipping seed (fine, just means an empty memory store)."
    );
    return;
  }
  console.log(`[local-dev] seeding ${TEST_UID} from ${dump} (most recent ${SEED_LIMIT} messages)...`);
  await runAwait(
    "npm",
    ["run", "seed-conversation", "--workspace", "scripts", "--", TEST_UID, dump, "--limit", String(SEED_LIMIT)],
    SEED_ENV
  );
}

function startOrchestrator(): void {
  // .env.local is already committed with working local defaults — the real
  // .env (secrets: FIREBASE_API_KEY, ORCHESTRATOR_SHARED_KEY, GEMINI_API_KEY)
  // is the one thing that's never in the repo and still needs a one-time
  // `cp orchestrator/.env.example orchestrator/.env` + fill-in.
  const envPath = resolve(ROOT, "orchestrator/.env");
  if (!existsSync(envPath)) {
    console.warn(
      "[local-dev] orchestrator/.env not found — skipping the orchestrator. " +
        "cp orchestrator/.env.example orchestrator/.env, fill it in, and restart to include it."
    );
    return;
  }

  // Docker/image readiness is orchestrator's own concern, checked at its
  // `npm install` (postinstall builds the image) and again right before it
  // starts listening (src/index.ts) — not duplicated here, since that same
  // check has to protect a real production run too, which never goes
  // through this script at all.
  console.log("[local-dev] starting orchestrator...");
  run("npm", ["run", "start", "--workspace", "orchestrator"]);
}

function shutdown(code = 0): void {
  try {
    unlinkSync(TOKEN_FILE);
  } catch {
    // wasn't there — fine, nothing to clean up
  }
  for (const child of children) child.kill("SIGINT");
  process.exit(code);
}

async function main() {
  console.log("[local-dev] starting Firebase emulators (functions, firestore, database, auth, hosting)...");
  run("firebase", [
    "emulators:start",
    "--only",
    "functions,firestore,database,auth,hosting",
    "--import=./.emulator-data",
    "--export-on-exit=./.emulator-data",
  ]);

  await waitForEmulatorHub();
  console.log("[local-dev] emulators ready.");

  await writeLocalLoginToken(TEST_UID);
  await seed();
  startOrchestrator();

  console.log(
    `[local-dev] up — chat page at http://localhost:5000 (auto-signed-in as ${TEST_UID}), Emulator UI at http://127.0.0.1:4000. Ctrl+C to stop everything.`
  );
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[local-dev] fatal:", (err as Error).message ?? err);
  shutdown(1);
});
