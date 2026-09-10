import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { onRequest } from "firebase-functions/v2/https";
import { onValueCreated } from "firebase-functions/v2/database";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { z } from "genkit";
import cors from "cors";

// Realtime Database isn't in the default region (this project's instance is
// asia-southeast1, Firestore/Functions are asia-south1 — RTDB's regions are a
// much smaller set than Firestore's and asia-south1 isn't one of them) — the
// Admin SDK needs the real instance URL explicitly or it silently tries the
// default one and hangs.
initializeApp({
  databaseURL: process.env.RTDB_URL ?? "https://watobot-v2-default-rtdb.asia-southeast1.firebasedatabase.app",
});

// Co-located with the Firestore database (also asia-south1, see README) to
// keep function-to-Firestore calls in-region. Applies to every v2 function
// exported below unless a function overrides it individually.
setGlobalOptions({ region: "asia-south1" });

import { requireUid, UnauthorizedError } from "./auth";
import { ingestCore, decisionMakerCore } from "./core";

/**
 * WhatsApp's passive stream. The extension pushes directly onto this RTDB
 * path with its own uid-scoped session (see database.rules.json) — no HTTP
 * endpoint involved. Every message here is ordinary business traffic; there's
 * no instruct/capability path on WhatsApp (see README).
 */
// Eventarc-based RTDB triggers aren't available in asia-south1 yet (a
// separate limitation from RTDB's own, smaller set of supported regions) —
// these two triggers run in asia-southeast1 instead, co-located with the
// actual RTDB instance, overriding the global asia-south1 default that the
// HTTPS functions below still use (matching Firestore).
const RTDB_TRIGGER_OPTS = { region: "asia-southeast1", instance: "watobot-v2-default-rtdb" } as const;

export const onIngestQueueCreated = onValueCreated({ ref: "ingestQueue/{uid}/{pushId}", ...RTDB_TRIGGER_OPTS }, async (event) => {
  const { uid } = event.params;
  const value = event.data.val() as { rawText?: string; sourceJid?: string; direction?: "incoming" | "outgoing" } | null;
  if (!value?.rawText) {
    console.warn(`[onIngestQueueCreated] uid=${uid}: missing rawText, dropping`);
    await event.data.ref.remove();
    return;
  }
  try {
    await ingestCore(uid, { rawText: value.rawText, sourceJid: value.sourceJid, direction: value.direction });
  } finally {
    await event.data.ref.remove();
  }
});

/**
 * The web chat page's entry point — every query here is answerable-or-
 * buildable (see decisionMakerCore). Writes its own reply back onto this same
 * node rather than a separate path, so the client's listener on commandId
 * sees it.
 */
export const onCommandCreated = onValueCreated({ ref: "commands/{uid}/{commandId}", ...RTDB_TRIGGER_OPTS }, async (event) => {
  const { uid, commandId } = event.params;
  const value = event.data.val() as { rawText?: string } | null;
  if (!value?.rawText) {
    console.warn(`[onCommandCreated] uid=${uid} commandId=${commandId}: missing rawText, ignoring`);
    return;
  }
  await decisionMakerCore(uid, { rawText: value.rawText, commandId });
});

// Firebase phone-auth's reCAPTCHA can't run inside a Manifest V3 extension page
// (no remote scripts allowed), so login happens on the hosted GitHub Pages login
// page instead. That page is a different origin from the extension, so its
// Firebase Auth session doesn't carry over automatically — this endpoint is the
// handoff: it verifies the hosted page's ID token and mints a custom token the
// extension can sign in with directly, giving it its own independent,
// self-refreshing session from then on.
const allowedOrigin = cors({ origin: "https://pocha.fyi" });

export const mintExtensionToken = onRequest((req, res) => {
  allowedOrigin(req, res, async () => {
    try {
      const uid = await requireUid(req);
      const customToken = await getAuth().createCustomToken(uid);
      res.json({ customToken });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        res.status(401).json({ error: err.message });
        return;
      }
      console.error("mintExtensionToken failed", err);
      res.status(500).json({ error: "internal error" });
    }
  });
});

const MintContainerTokenBody = z.object({ uid: z.string() });

/**
 * Called by the VM orchestrator (never by a container or a browser) to get a
 * token scoped to exactly one uid before starting that user's container, or
 * to bootstrap its own "orchestrator-service" session for the dispatchQueue
 * listener. Gated by a shared secret rather than a Firebase ID token, since
 * the orchestrator isn't a signed-in Firebase user itself — see the "Still
 * open" note on this in the architecture writeup about tightening this to a
 * real service-account identity once past pilot stage.
 */
export const mintContainerToken = onRequest(async (req, res) => {
  try {
    const sharedKey = req.headers["x-orchestrator-key"];
    if (!process.env.ORCHESTRATOR_SHARED_KEY || sharedKey !== process.env.ORCHESTRATOR_SHARED_KEY) {
      res.status(401).json({ error: "missing or invalid x-orchestrator-key" });
      return;
    }
    const { uid } = MintContainerTokenBody.parse(req.body);
    const customToken = await getAuth().createCustomToken(uid);
    res.json({ customToken });
  } catch (err) {
    console.error("mintContainerToken failed", err);
    res.status(500).json({ error: "internal error" });
  }
});
