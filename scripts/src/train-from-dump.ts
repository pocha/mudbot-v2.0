#!/usr/bin/env ts-node
/**
 * Offline testing, step 2: replay a conversation dump (from the extension's
 * "Dump conversation" popup button) through the real ingestCore pipeline —
 * the exact same code the deployed /ingest endpoint runs — and print what
 * happened at each message: memory stored, pattern matched (if any), decision
 * made. This is passive-stream replay only; it won't create new learned
 * patterns (those come from explicit instructions — see simulate.ts) but it
 * will match against patterns simulate.ts has already created for this uid.
 *
 * Needs: MCP_WORKSPACE_URL / MCP_WHATSAPP_URL / MCP_SCHEDULER_URL servers
 * running locally, a Vertex AI-reachable environment (real LLM/embedding
 * calls, not mocked), and FIRESTORE_EMULATOR_HOST set if testing against the
 * emulator rather than a real project. See functions/.env.example.
 *
 * Usage:
 *   npm run start --workspace scripts -- train-from-dump <uid> <dump.json>
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(__dirname, "../../functions/.env") });

import { readFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";

initializeApp();

// Imported after dotenv/initializeApp so genkit.ts and the MCP client pick up
// the env vars they read at module-load time.
import { ingestCore } from "../../functions/src/core";

interface DumpedMessage {
  jid: string;
  displayName: string;
  text: string;
  direction: "incoming" | "outgoing";
  timestamp: string;
}

async function main() {
  const [uid, dumpPath] = process.argv.slice(2);
  if (!uid || !dumpPath) {
    console.error("usage: train-from-dump <uid> <dump.json>");
    process.exit(1);
  }

  const { messages } = JSON.parse(readFileSync(dumpPath, "utf8")) as { messages: DumpedMessage[] };
  const ordered = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  console.log(`Replaying ${ordered.length} messages for uid=${uid}...\n`);

  for (const [i, msg] of ordered.entries()) {
    console.log(`--- [${i + 1}/${ordered.length}] ${msg.direction} from ${msg.displayName} (${msg.jid}) ---`);
    console.log(`"${msg.text}"`);

    const result = await ingestCore(uid, { rawText: msg.text, sourceJid: msg.jid, direction: msg.direction });

    console.log(`  memory stored: ${result.memoryId}`);
    console.log(`  status: ${result.status}${"patternId" in result && result.patternId ? ` (pattern ${result.patternId}${"stage" in result ? `, stage ${result.stage}` : ""})` : ""}`);
    if ("decision" in result && result.decision) {
      console.log(`  decision: ${result.decision.kind}${result.decision.toolName ? ` -> ${result.decision.toolName}` : ""}`);
    }
    console.log("");
  }

  console.log("Done. Run `npm run start --workspace scripts -- review-customer " + uid + "` for the full picture.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
