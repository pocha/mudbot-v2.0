# Mudbot v2.0

A self-evolving WhatsApp/web chatbot. Full writeup and open questions:
**[Capability Runtime](https://claude.ai/code/artifact/2d45d984-7f21-4d46-8980-497e7a532cf5)**.

![Capability runtime architecture: WhatsApp and the web chat page push into Realtime Database queues; a Cloud Function trigger writes durable memory and conversation records to Firestore and dispatches capability jobs; a VM orchestrator listens for jobs and starts per-user Docker containers, which read/write Firestore through their own scoped session and write replies back to Realtime Database.](docs/capability-runtime.svg)

This README is setup/run only.

## Repo layout

```
functions/              Firebase Cloud Functions: Genkit orchestration (the core)
extension/              Chrome extension (Manifest V3): WhatsApp client
public/                 Hosted login page (GitHub Pages)
scripts/                Local CLI: offline testing against a conversation dump
firestore.rules / firestore.indexes.json   Per-uid isolation + vector index
```

## Prerequisites

- Node 22, npm 11+
- A Firebase project (Blaze plan — Cloud Functions 2nd gen require it) with
  **Firestore (Native mode)** and **Authentication → Phone** provider enabled
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/)
  (Gemini Developer API, not Vertex — this is what has a free tier). Can be
  from any GCP project, doesn't need to be the same one as your Firebase project.
- **Firestore's location must be chosen when the database is first created** —
  this repo targets `asia-south1`, and unlike Functions there's no config file
  or redeploy that changes it afterward. If Firestore already exists in a
  different region: delete and recreate it (fine for a fresh project —
  `gcloud firestore databases delete --database='(default)'`, then `gcloud
  firestore databases create --location=asia-south1`), or export/import if you
  have real data to keep.
- Your login page's actual serving domain (`pocha.fyi` — a custom domain
  mapped to GitHub Pages via CNAME) added under **Authentication → Settings →
  Authorized domains**.
- The `firebase` CLI (`npm i -g firebase-tools`), logged in (`firebase login`)
- Google Cloud auth for local runs of `functions`/`scripts` against real
  Firestore: `gcloud auth application-default login`

## Setup

### 1. Install dependencies

```
npm install
```

npm-workspaces monorepo — one install at the root covers every package
(`functions`, `extension`, `scripts`).

### 2. Point the repo at your Firebase project

Edit `.firebaserc` and replace `watobot-v2` with your actual project id.

### 3. Configure environment variables

```
cp functions/.env.example functions/.env
```

Fill in:
- `GEMINI_API_KEY` — your Google AI Studio key (see Prerequisites).
- `GEMINI_MODEL_ID` — confirm against the current Gemini Developer API model
  list; the default in `.env.example` may drift from what's actually available.

## Deployment

Server-side and the browser extension deploy separately, on different schedules.

### A. Server-side

```
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only functions
```

The first command also provisions the vector index on
`users/{uid}/memories.embedding` (768 dims, matching `text-embedding-005`),
defined in `firestore.indexes.json`. Functions deploy to `asia-south1`, set
via `setGlobalOptions` in `functions/src/index.ts`.

### B. Browser extension

```
npm run build --workspace extension
```

Before building, copy `extension/src/firebaseConfig.example.ts` to
`extension/src/firebaseConfig.ts` (gitignored) and fill in your Firebase web
app config (Firebase console → Project settings → your apps — register a Web
app there first if one doesn't exist). Also point `extension/src/config.ts`'s
`API_BASE_URL` at your deployed functions.

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load
unpacked** → select `extension/dist`.

Open `web.whatsapp.com` in a tab and log in as usual. In the extension popup,
click **Login** (opens the hosted login page from part C below — deploy that
first) and complete phone verification there.

### C. Login page (GitHub Pages)

One-time setup:
1. In the repo's GitHub settings: **Settings → Pages → Source: GitHub
   Actions**. `.github/workflows/deploy-pages.yml` deploys `public/`
   automatically on every push to `main` that touches that folder (or trigger
   manually via the Actions tab).
2. Confirm `public/login.js`'s `firebaseConfig`, `MINT_TOKEN_URL` (your
   deployed `mintExtensionToken` function URL), and `EXTENSION_ID` match your
   actual values — this file **is** committed and public (GitHub Pages has no
   secret-injection step).
3. Add your Pages domain to Firebase's Authorized domains (see Prerequisites).
4. If serving from a custom domain (this repo uses `pocha.fyi`, via a `CNAME`
   file in `public/`), make sure **Settings → Pages → Enforce HTTPS** is
   checked once the certificate finishes provisioning — phone-auth/reCAPTCHA
   need a secure context.

`HOSTED_LOGIN_URL` in `extension/src/config.ts`, `extension/manifest.json`'s
`externally_connectable`, and the CORS origin in
`functions/src/index.ts`'s `mintExtensionToken` all have to agree on this
domain — update all three together if it ever changes.

Regenerate the extension's signing key only if you want a different stable
extension id:
```
openssl genrsa -out extension/your-key.pem 2048
openssl rsa -in extension/your-key.pem -pubout -outform DER | openssl base64 -A
```
Paste that output into `manifest.json`'s `"key"` field, recompute the matching
extension id (SHA-256 of the DER public key bytes, first 32 hex chars mapped
to `a`–`p`), and update `EXTENSION_ID` in `public/login.js` to match.

## Local Testing

Runs the same server-side deployment on your machine instead of Firebase.

```
npm run emulators
```

Starts the Firestore + Functions emulators (`firebase.json`) so `/ingest` and
`/instruct` are callable locally, with `functions/lib` rebuilt via the
`predeploy` hook. If also testing the extension against this, point its
`API_BASE_URL` (`extension/src/config.ts`) at the emulator's local URL, and set
`FIRESTORE_EMULATOR_HOST` in any local script's environment to hit the same
emulated Firestore.

## Offline Testing (no live WhatsApp session needed)

Builds on Local Testing above (emulator running):

1. **Dump conversations**: extension popup → "Load recent chats" (shows the N
   most recently active chats, configurable, default 50) → deselect anything
   that isn't a business conversation → "Dump selected" → downloads
   `mudbot-conversation-dump-*.json`.
2. **Replay it**: `npm run seed-conversation -- <uid> path/to/dump.json` — runs
   every message through the real `ingestCore` pipeline, in true chronological
   order across all dumped chats, and prints what happened (memory stored,
   synthesis produced) per message.

Talks to Firestore directly via the Admin SDK — set
`FIRESTORE_EMULATOR_HOST=localhost:8080` first to run against the emulator
instead of your real project. LLM/embedding calls always hit the real Gemini
API regardless (not mocked).
