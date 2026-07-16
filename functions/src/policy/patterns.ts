import { getFirestore } from "firebase-admin/firestore";
import { ai, embedder } from "../genkit";
import type { ActionPolicyDoc, PatternStage, RiskTier } from "../types/domain";

/**
 * Static per-tool risk tier -> how high the bar is before a pattern using that
 * tool is allowed to graduate to suggesting or auto-acting. Blast radius differs
 * by tool, not just by pattern, so this is declared once here rather than
 * inferred at runtime.
 */
// Keys are the fully namespaced tool ids genkitx-mcp registers, e.g.
// "workspace/sheet_update" — same strings the model echoes back as toolName.
const RISK_TIER_BY_TOOL: Record<string, RiskTier> = {
  "workspace/sheet_update": "internal-reversible",
  "workspace/calendar_event": "internal-reversible",
  "whatsapp/send_whatsapp_message": "external-irreversible",
  "workspace/send_email": "external-irreversible",
};

const RISK_TIER_CONFIG: Record<RiskTier, { suggestThreshold: number; autoActThreshold: number; minSamples: number }> = {
  "internal-reversible": { suggestThreshold: 0.5, autoActThreshold: 0.75, minSamples: 3 },
  "external-irreversible": { suggestThreshold: 0.7, autoActThreshold: 0.95, minSamples: 10 },
};

export function riskTierForTool(tool: string): RiskTier {
  return RISK_TIER_BY_TOOL[tool] ?? "external-irreversible"; // unknown tools default to the safer, harder-to-earn tier
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const MATCH_SIMILARITY_THRESHOLD = 0.85;

export async function findMatchingPattern(
  uid: string,
  triggerText: string
): Promise<{ patternId: string; policy: ActionPolicyDoc } | null> {
  const db = getFirestore();
  const [{ embedding }] = await ai.embed({ embedder, content: triggerText });
  const snap = await db.collection(`users/${uid}/actionPolicies`).get();

  let best: { patternId: string; policy: ActionPolicyDoc; score: number } | null = null;
  for (const doc of snap.docs) {
    const policy = doc.data() as ActionPolicyDoc;
    const score = cosineSimilarity(embedding, policy.triggerEmbedding);
    if (score >= MATCH_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { patternId: doc.id, policy, score };
    }
  }
  return best ? { patternId: best.patternId, policy: best.policy } : null;
}

export async function createPattern(
  uid: string,
  tool: string,
  triggerShape: string,
  paramsTemplate: Record<string, unknown>
): Promise<string> {
  const db = getFirestore();
  const [{ embedding }] = await ai.embed({ embedder, content: triggerShape });
  const riskTier = riskTierForTool(tool);
  const cfg = RISK_TIER_CONFIG[riskTier];

  const doc: ActionPolicyDoc = {
    tool,
    triggerShape,
    triggerEmbedding: embedding,
    paramsTemplate,
    approvals: 0,
    rejections: 0,
    riskTier,
    suggestThreshold: cfg.suggestThreshold,
    autoActThreshold: cfg.autoActThreshold,
    minSamples: cfg.minSamples,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const ref = await db.collection(`users/${uid}/actionPolicies`).add(doc);
  return ref.id;
}

export async function recordPatternOutcome(
  uid: string,
  patternId: string,
  outcome: "approved" | "rejected"
): Promise<void> {
  const db = getFirestore();
  const ref = db.doc(`users/${uid}/actionPolicies/${patternId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const policy = snap.data() as ActionPolicyDoc;
    tx.update(ref, {
      approvals: policy.approvals + (outcome === "approved" ? 1 : 0),
      rejections: policy.rejections + (outcome === "rejected" ? 1 : 0),
      updatedAt: new Date(),
    });
  });
}

/** Confidence is just the approval rate, gated by a minimum sample size so a
 * single lucky approval can't fast-track a pattern to auto-act. */
export function patternStage(policy: ActionPolicyDoc): PatternStage {
  const total = policy.approvals + policy.rejections;
  if (total < policy.minSamples) return total > 0 ? "suggest" : "silent";
  const confidence = policy.approvals / total;
  if (confidence >= policy.autoActThreshold) return "auto_act";
  if (confidence >= policy.suggestThreshold) return "suggest";
  return "silent";
}
