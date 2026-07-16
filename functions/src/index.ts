import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { z } from "genkit";

initializeApp();

import { requireUid, UnauthorizedError } from "./auth";
import { ingestCore, instructCore, logEvent } from "./core";
import { recordPatternOutcome } from "./policy/patterns";
import type { CommandDoc } from "./types/domain";

const IngestBody = z.object({
  rawText: z.string(),
  sourceJid: z.string().optional(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
});

const InstructBody = z.object({ rawText: z.string() });

export const ingest = onRequest(async (req, res) => {
  try {
    const uid = await requireUid(req);
    const result = await ingestCore(uid, IngestBody.parse(req.body));
    res.json(result);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    console.error("ingest failed", err);
    res.status(500).json({ error: "internal error" });
  }
});

export const instruct = onRequest(async (req, res) => {
  try {
    const uid = await requireUid(req);
    const result = await instructCore(uid, InstructBody.parse(req.body));
    res.json(result);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    console.error("instruct failed", err);
    res.status(500).json({ error: "internal error" });
  }
});

/**
 * Extension-bridge completion loop: when the extension writes back the outcome
 * of a queued send_whatsapp_message command, reconcile it into that pattern's
 * confidence — this is the only place command docs are read after creation,
 * keeping the rest of the orchestration core ignorant of the extension's existence.
 */
export const onCommandUpdated = onDocumentUpdated("users/{uid}/commands/{commandId}", async (event) => {
  const before = event.data?.before.data() as CommandDoc | undefined;
  const after = event.data?.after.data() as CommandDoc | undefined;
  if (!after || before?.status === after.status) return;
  if (after.status !== "sent" && after.status !== "rejected") return;

  const { uid } = event.params;
  if (after.patternId) {
    await recordPatternOutcome(uid, after.patternId, after.status === "sent" ? "approved" : "rejected");
  }
  await logEvent(uid, {
    trigger: "explicit",
    rawText: `[command ${event.params.commandId} completion]`,
    executionResult: { status: after.status, target: after.target },
  });
});
