#!/usr/bin/env ts-node
/**
 * Local, notebook-style review tool for a single customer (uid). Not a hosted
 * dashboard — run this from your machine when you want to check on a pilot
 * customer or debug a specific complaint. See the plan's Observability section.
 *
 * Usage:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 npm run start --workspace scripts -- <uid>
 *   npm run start --workspace scripts -- <uid>   # against the real project, via ADC
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

initializeApp();

function fmtTime(ts: unknown): string {
  if (ts instanceof Timestamp) return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return String(ts);
}

async function main() {
  const uid = process.argv[2];
  if (!uid) {
    console.error("usage: review-customer <uid>");
    process.exit(1);
  }

  const db = getFirestore();

  console.log(`\n=== Events (most recent 20) — uid=${uid} ===`);
  const events = await db
    .collection(`users/${uid}/events`)
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  for (const doc of events.docs.reverse()) {
    const e = doc.data();
    const decisionSummary = e.decision ? `${e.decision.kind}${e.decision.toolName ? ` -> ${e.decision.toolName}` : ""}` : "(none)";
    console.log(`[${fmtTime(e.createdAt)}] (${e.trigger}) "${String(e.rawText).slice(0, 60)}" — decision: ${decisionSummary}`);
  }

  console.log(`\n=== Learned patterns (actionPolicies) ===`);
  const policies = await db.collection(`users/${uid}/actionPolicies`).get();
  for (const doc of policies.docs) {
    const p = doc.data();
    const total = p.approvals + p.rejections;
    const confidence = total > 0 ? (p.approvals / total).toFixed(2) : "n/a";
    const stage = total < p.minSamples ? (total > 0 ? "suggest" : "silent") : confidence !== "n/a" && Number(confidence) >= p.autoActThreshold ? "auto_act" : Number(confidence) >= p.suggestThreshold ? "suggest" : "silent";
    console.log(
      `- ${doc.id}: tool=${p.tool} riskTier=${p.riskTier} approvals=${p.approvals} rejections=${p.rejections} confidence=${confidence} stage=${stage}`
    );
  }

  console.log(`\n=== Pending commands (extension-bridge queue) ===`);
  const pending = await db.collection(`users/${uid}/commands`).where("status", "==", "pending").get();
  if (pending.empty) console.log("(none pending)");
  for (const doc of pending.docs) {
    const c = doc.data();
    const ageMs = Date.now() - (c.createdAt instanceof Timestamp ? c.createdAt.toMillis() : new Date(c.createdAt).getTime());
    console.log(`- ${doc.id}: to ${c.target?.displayName} via ${c.executeAs}, pending for ${Math.round(ageMs / 60000)} min`);
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
