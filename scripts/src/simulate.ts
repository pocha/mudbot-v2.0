#!/usr/bin/env ts-node
/**
 * Offline testing, step 3: interactive REPL to play out scenarios without a
 * live WhatsApp session. You type as either a customer (goes through the
 * passive ingestCore path, on a jid you make up) or the owner giving an
 * instruction (goes through instructCore). After each turn it prints:
 *   - the decision made (kind, tool, reasoning)
 *   - any WhatsApp message that would go out and WHO it's addressed to —
 *     "owner" (assistant chat, Number B) or "customer/group" (Number A) —
 *     inferred from the executeAs/target on whatever `commands` doc(s) got
 *     created during this turn, since notifyUser() and real sends both go
 *     through the same send_whatsapp_message tool. No special-casing needed.
 *   - any non-WhatsApp tool call result (e.g. a sheet_update)
 *   - whether a memory entry was written (only the customer/passive path does)
 *
 * Needs the same setup as train-from-dump.ts: MCP servers running locally,
 * real Vertex AI access, FIRESTORE_EMULATOR_HOST if using the emulator.
 *
 * Usage:
 *   npm run start --workspace scripts -- simulate <uid>
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(__dirname, "../../functions/.env") });

import * as readline from "node:readline/promises";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp();

import { ingestCore, instructCore } from "../../functions/src/core";
import type { CommandDoc } from "../../functions/src/types/domain";

async function reportNewCommands(uid: string, since: Date) {
  const db = getFirestore();
  const snap = await db.collection(`users/${uid}/commands`).where("createdAt", ">=", since).get();
  if (snap.empty) {
    console.log("  (no WhatsApp message sent this turn)");
    return;
  }
  for (const doc of snap.docs) {
    const c = doc.data() as CommandDoc;
    const to = c.executeAs === "numberB" ? "owner" : "customer/group";
    console.log(`  -> {to: "${to}", target: "${c.target.displayName}", message: "${c.text}"}`);
  }
}

async function main() {
  const uid = process.argv[2];
  if (!uid) {
    console.error("usage: simulate <uid>");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Simulating for uid=${uid}. Type "exit" to quit.\n`);

  while (true) {
    const speaker = (await rl.question("speaker (customer/owner): ")).trim().toLowerCase();
    if (speaker === "exit" || speaker === "quit") break;
    if (speaker !== "customer" && speaker !== "owner") {
      console.log('  please type "customer" or "owner"');
      continue;
    }

    const message = await rl.question("message: ");
    const turnStart = new Date();

    if (speaker === "customer") {
      const jid = (await rl.question("customer jid (e.g. 15550001111@s.whatsapp.net): ")).trim();
      const result = await ingestCore(uid, { rawText: message, sourceJid: jid, direction: "incoming" });
      console.log(`\n  memory stored: ${result.memoryId}`);
      console.log(`  status: ${result.status}${"patternId" in result && result.patternId ? ` (pattern ${result.patternId})` : ""}`);
      if ("decision" in result && result.decision) {
        console.log(`  decision: ${result.decision.kind}${result.decision.toolName ? ` -> ${result.decision.toolName}` : ""} — ${result.decision.reasoning}`);
      }
      await reportNewCommands(uid, turnStart);
    } else {
      const result = await instructCore(uid, { rawText: message });
      console.log(`\n  decision: ${result.decision.kind}${result.decision.toolName ? ` -> ${result.decision.toolName}` : ""} — ${result.decision.reasoning}`);
      if (result.executionResult) console.log(`  tool result: ${JSON.stringify(result.executionResult)}`);
      await reportNewCommands(uid, turnStart);
    }

    console.log("");
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
