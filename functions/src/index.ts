import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { z } from "genkit";
import cors from "cors";

initializeApp();

// Co-located with the Firestore database (also asia-south1, see README) to
// keep function-to-Firestore calls in-region. Applies to every v2 function
// exported below unless a function overrides it individually.
setGlobalOptions({ region: "asia-south1" });

import { requireUid, UnauthorizedError } from "./auth";
import { ingestCore, instructCore } from "./core";

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

// Firebase phone-auth's reCAPTCHA can't run inside a Manifest V3 extension page
// (no remote scripts allowed), so login happens on the hosted GitHub Pages login
// page instead. That page is a different origin from the extension, so its
// Firebase Auth session doesn't carry over automatically — this endpoint is the
// handoff: it verifies the hosted page's ID token and mints a custom token the
// extension can sign in with directly, giving it its own independent,
// self-refreshing session from then on. Needs real CORS (unlike /ingest and
// /instruct, which are only ever called from the extension's own privileged
// context via host_permissions, not a normal web page).
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
