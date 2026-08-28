#!/usr/bin/env ts-node
/**
 * Offline testing: replay a conversation dump (from the extension's popup
 * chat picker, which can span many conversations at once) through the real
 * ingestCore pipeline — the exact same code the deployed /ingest endpoint
 * runs — and print what happened at each message: memory stored, synthesis
 * produced. Replay order is global chronological order across ALL dumped
 * chats, not conversation-by-conversation, since memory is per-owner, not
 * per-contact — that's the order the live system would actually have seen
 * these messages in.
 *
 * Needs: a Gemini API-reachable environment (real LLM/embedding calls, not
 * mocked), and FIRESTORE_EMULATOR_HOST set if testing against the emulator
 * rather than a real project. See functions/.env.example.
 *
 * Usage:
 *   npm run start --workspace scripts -- seed-conversation <uid> <dump.json>
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(__dirname, "../../functions/.env") });

import { readFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";

initializeApp();

// Imported after dotenv/initializeApp so genkit.ts picks up the env vars it
// reads at module-load time.
import { ingestCore } from "../../functions/src/core";

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

async function main() {
  const [uid, dumpPath] = process.argv.slice(2);
  if (!uid || !dumpPath) {
    console.error("usage: seed-conversation <uid> <dump.json>");
    process.exit(1);
  }

  const { chats, messages } = JSON.parse(readFileSync(dumpPath, "utf8")) as {
    chats?: DumpedChat[];
    messages: DumpedMessage[];
  };
  const ordered = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (chats) {
    console.log(`Chats in this dump: ${chats.map((c) => `${c.displayName} (${c.messageCount})`).join(", ")}`);
  }
  console.log(`Replaying ${ordered.length} messages across ${chats?.length ?? "an unknown number of"} chats for uid=${uid}, in global chronological order...\n`);

  for (const [i, msg] of ordered.entries()) {
    console.log(`--- [${i + 1}/${ordered.length}] ${msg.direction} from ${msg.displayName} (${msg.jid}) ---`);
    console.log(`"${msg.text}"`);

    const result = await ingestCore(uid, { rawText: msg.text, sourceJid: msg.jid, direction: msg.direction });

    console.log(`  memory stored: ${result.memoryId}`);
    console.log(`  status: ${result.status}`);
    console.log("");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
