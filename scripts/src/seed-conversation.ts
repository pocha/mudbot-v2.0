#!/usr/bin/env ts-node
/**
 * Local/offline testing: replay a conversation dump (from the extension's
 * popup chat picker, which can span many conversations at once) onto the
 * real `ingestQueue/{uid}` RTDB path — the same path the extension itself
 * pushes to — rather than calling `ingestCore` in-process. That means this
 * also exercises the real `onIngestQueueCreated` trigger, not just the
 * function it calls; each message is pushed and awaited (the script waits
 * for the trigger to remove the queue entry, exactly as `ingestCore` does on
 * completion) before moving to the next one, so the trigger is exercised
 * sequentially rather than flooded all at once. Replay order is global
 * chronological order across ALL dumped chats, not conversation-by-
 * conversation, since memory is per-owner, not per-contact — that's the
 * order the live system would actually have seen these messages in.
 *
 * Needs: a Gemini API-reachable environment (real LLM/embedding calls, not
 * mocked) and a running RTDB + Firestore + Functions emulator (or a real
 * project) — set FIRESTORE_EMULATOR_HOST / FIREBASE_DATABASE_EMULATOR_HOST to
 * target the emulator. See functions/.env.example and README's "Local Testing".
 *
 * Usage:
 *   npm run seed-conversation --workspace scripts -- <uid> <dump.json> [--limit N] [--force]
 *
 * --limit N   replay only the N most recent messages (default: all). Useful
 *             for a fast dev-server seed rather than replaying thousands of
 *             messages (and paying that many real embedding calls) on every
 *             restart.
 * --force     replay even if `users/{uid}/memories` already has documents —
 *             by default the script skips seeding a uid that's already been
 *             seeded, since emulator data now persists across restarts.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(__dirname, "../../functions/.env") });

import { readFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getDatabase, type Reference } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({
  databaseURL: process.env.RTDB_URL ?? "https://watobot-v2-default-rtdb.asia-southeast1.firebasedatabase.app",
});

interface DumpedMessage {
  jid: string;
  displayName: string;
  text: string;
  direction: "incoming" | "outgoing";
  timestamp: string;
}

interface DumpedChat {
  jid: string;
  displayName: string;
  messageCount: number;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let limit: number | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") limit = Number(argv[++i]);
    else if (argv[i] === "--force") force = true;
    else positional.push(argv[i]);
  }
  const [uid, dumpPath] = positional;
  return { uid, dumpPath, limit, force };
}

/** Pushes one message onto ingestQueue/{uid} and waits for the real
 * onIngestQueueCreated trigger to remove it (its completion signal) before
 * returning — keeps this sequential and gives an honest per-message result
 * instead of firing thousands of triggers at once. */
async function pushAndWait(uid: string, msg: DumpedMessage, timeoutMs = 60_000): Promise<void> {
  const entryRef: Reference = getDatabase().ref(`ingestQueue/${uid}`).push();
  await entryRef.set({ rawText: msg.text, sourceJid: msg.jid, direction: msg.direction });

  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      entryRef.off("value", listener);
      reject(new Error(`timed out waiting for ingestQueue/${uid}/${entryRef.key} to be processed`));
    }, timeoutMs);
    const listener = entryRef.on("value", (snap) => {
      if (!snap.exists()) {
        clearTimeout(timeout);
        entryRef.off("value", listener);
        resolvePromise();
      }
    });
  });
}

async function alreadySeeded(uid: string): Promise<boolean> {
  const snap = await getFirestore().collection(`users/${uid}/memories`).limit(1).get();
  return !snap.empty;
}

async function main() {
  const { uid, dumpPath, limit, force } = parseArgs(process.argv.slice(2));
  if (!uid || !dumpPath) {
    console.error("usage: seed-conversation <uid> <dump.json> [--limit N] [--force]");
    process.exit(1);
  }

  if (!force && (await alreadySeeded(uid))) {
    console.log(`uid=${uid} already has memories — skipping (pass --force to reseed anyway).`);
    return;
  }

  const { chats, messages } = JSON.parse(readFileSync(dumpPath, "utf8")) as {
    chats?: DumpedChat[];
    messages: DumpedMessage[];
  };
  const ordered = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const toReplay = limit ? ordered.slice(-limit) : ordered;

  if (chats) {
    console.log(`Chats in this dump: ${chats.map((c) => `${c.displayName} (${c.messageCount})`).join(", ")}`);
  }
  console.log(
    `Replaying ${toReplay.length}${limit ? ` (of ${ordered.length}, most recent)` : ""} messages for uid=${uid}, in global chronological order...\n`
  );

  for (const [i, msg] of toReplay.entries()) {
    console.log(`--- [${i + 1}/${toReplay.length}] ${msg.direction} from ${msg.displayName} (${msg.jid}) ---`);
    console.log(`"${msg.text}"`);
    await pushAndWait(uid, msg);
    console.log("  processed\n");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
