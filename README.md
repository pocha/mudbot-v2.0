# Mudbot v2.0

A WhatsApp-based assistant for a small business owner (e.g. a bakery run over
WhatsApp) that's becoming a general-purpose chatbot with no fixed catalog of
pre-built actions: when it gets a query it can't already handle, it says so, works
out what it needs, asks clarifying questions, builds and installs whatever's
required, and answers — see "Where this is headed" below. This README covers
setup; architecture rationale lives in code comments near the relevant modules —
start at `functions/src/core.ts`.

## Architecture at a glance

- **Client**: a Chrome extension (Manifest V3) driving a **single WhatsApp Web
  session** on the owner's real business number. One chat within that same
  session — by default WhatsApp's own "Message Yourself" self-chat — is marked as
  the assistant channel for instructions/confirmations; everything else observed
  in the session is ordinary business traffic. This deliberately avoids needing a
  second WhatsApp account (and its own device-limit budget) just to talk to the
  assistant. Firebase Auth (phone) gates who's who — but the actual phone
  verification step happens on a **hosted login page** (`public/`, deployed to
  GitHub Pages), not inside the extension itself: Manifest V3 blocks extension
  pages from loading remote scripts, and Firebase's phone auth depends on
  loading Google's reCAPTCHA script. The hosted page verifies the phone number,
  then hands a signed-in session back to the extension (see "Login flow" below).
- **Server**: Firebase Cloud Functions running a Genkit `synthesize` flow against
  the Gemini Developer API (Google AI Studio, not Vertex — see "LLM provider"
  below), with Firestore's native vector search as the per-user memory store.
- **Actions**: being redesigned as a self-evolving capability system rather than
  a fixed catalog of pre-built tools — see "Where this is headed" below. The old
  MCP-tool-call layer (`mcp-workspace-server`, `mcp-whatsapp-server`,
  `mcp-scheduler-server`, the risk-tiered learned-pattern confidence model) has
  been removed; `ingestCore`/`instructCore` currently just store memory and log
  the synthesized message, nothing acts on it yet.
- **Respond-on-behalf-of-user** (sending a real WhatsApp message) isn't special-cased
  in the codebase at all — it's just another capability the self-evolving system
  would build for itself like anything else, so the old hardcoded send machinery
  (`CommandDoc`, `onCommandUpdated`, the extension's command-dispatch queue, the
  DOM-click `whatsappAdapter.ts`) has been removed rather than kept disabled.
  Only passive listening/ingestion is currently wired up.

### LLM provider

Uses the **Gemini Developer API** (Google AI Studio — `GEMINI_API_KEY` in
`functions/.env`), not Vertex AI: Vertex has no meaningful free tier (pay-per-use
even on a fresh project), while AI Studio does. `GEMINI_API_KEY` defaults to a
shared "house" key; the plan is to let a user plug in their own key once they
exhaust the shared free-tier quota (not implemented yet).

### Where this is headed

The new premise: this is a chatbot that can be asked anything, with no
pre-created tool for most of it. When a query has no matching capability, the
bot tells the user it needs a moment, works out what's needed (asking the user
clarifying questions where its plan has gaps), builds and installs whatever it
needs, and registers the result as a reusable capability before answering.
Production model: one Docker container/VM per user, with root, so a generated
capability can install any dependency it needs — isolation between users is a
goal but not yet a priority to enforce.

## Repo layout

```
functions/              Firebase Cloud Functions: Genkit orchestration (the core)
extension/              Chrome extension (Manifest V3): client
public/                 Hosted login page (GitHub Pages) — see "Login flow" below
scripts/                Local CLI tools: customer review + offline testing
firestore.rules / firestore.indexes.json   Per-uid isolation + vector index
```

### Login flow

Phone auth's reCAPTCHA can't run inside an MV3 extension page, so the actual
verification happens on `public/index.html` — a plain static page (no build
step, Firebase loaded via CDN) deployed to GitHub Pages, a real HTTPS origin
with none of the extension's remote-script restrictions. The full round trip:

1. Extension popup shows a **Login** button when signed out; it just opens the
   hosted page in a new tab (`extension/src/config.ts`'s `HOSTED_LOGIN_URL`).
2. The hosted page (`public/login.js`) runs the phone number + OTP flow via
   Firebase Auth directly, same as any normal website would.
3. Once signed in, it calls the `mintExtensionToken` Cloud Function with its
   Firebase ID token; that function verifies the token and mints a **custom
   token** for the same uid via the Admin SDK.
4. The page sends that custom token to the extension via `chrome.runtime.sendMessage`,
   using Chrome's `externally_connectable` (declared in `manifest.json`, scoped
   to the GitHub Pages origin) — this only works because the two ends agree on
   a fixed extension id (see below).
5. `background.ts` receives it and calls `signInWithCustomToken` — from that
   point on the extension has its own independent, self-refreshing Firebase
   session, same as any normal login.

This requires the extension's id to be **stable**, not the randomly-assigned id
Chrome gives an unpacked extension by default (which can drift). That's what
`manifest.json`'s `"key"` field pins — it's a public key (safe to commit, not a
secret), and Chrome derives a deterministic extension id from it. This repo
already has one generated; regenerate only if you want a different id:

```
openssl genrsa -out extension/your-key.pem 2048
openssl rsa -in extension/your-key.pem -pubout -outform DER | openssl base64 -A
```

Paste that output into `manifest.json`'s `"key"` field, then recompute the
matching extension id (SHA-256 of the DER public key bytes, first 32 hex chars
mapped to `a`–`p`) and update `EXTENSION_ID` in `public/login.js` to match.

## Prerequisites

- Node 22, npm 11+
- A Firebase project (Blaze plan — Cloud Functions 2nd gen require it) with
  **Firestore (Native mode)** and **Authentication → Phone** provider enabled
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/) —
  used for the free-tier default; can be from any GCP project, doesn't need to be
  the same one as your Firebase project (see "LLM provider" above)
- **Firestore's location must be chosen when the database is first created** —
  this repo targets `asia-south1`, and unlike Functions there's no config file
  or redeploy that changes it afterward. If Firestore already exists in a
  different region, your options are: delete and recreate it (fine for a fresh
  project with no real data yet — `gcloud firestore databases delete
  --database='(default)'`, then create it again in `asia-south1` via the
  console or `gcloud firestore databases create --location=asia-south1`), or
  export/import into a new database if you already have real data to keep.
- Your login page's actual serving domain (`pocha.fyi` — a custom domain mapped
  to GitHub Pages via CNAME, not the default `<username>.github.io`) added
  under **Authentication → Settings → Authorized domains** — needed for the
  hosted login page (see
  "Login flow" above)
- The `firebase` CLI (`npm i -g firebase-tools`), logged in (`firebase login`)
- Google Cloud auth for local runs of `functions`/`scripts` against real
  Firestore: `gcloud auth application-default login`

## Setup

Pure configuration — nothing here starts a server or ships anything anywhere.

### 1. Install dependencies

```
npm install
```

This is an npm-workspaces monorepo — one install at the root covers every package
(`functions`, `extension`, `scripts`).

### 2. Point the repo at your Firebase project

Edit `.firebaserc` and replace `watobot-v2` with your actual project id.

### 3. Configure environment variables

```
cp functions/.env.example functions/.env
```

Fill in:
- `GEMINI_API_KEY` — your Google AI Studio key (see Prerequisites).
- `GEMINI_MODEL_ID` — confirm this against the current Gemini Developer API
  model list; the default in `.env.example` may drift from what's actually
  available.

## Deployment

Two independent parts: the server-side pieces, and the browser extension. Both are
needed for a real end-to-end system, but they deploy separately and on different
schedules (you'll redeploy functions far more often than you rebuild the extension).

### A. Server-side

```
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only functions
```

The first command is also what provisions the vector index on
`users/{uid}/memories.embedding` (768 dims, matching `text-embedding-005`),
defined in `firestore.indexes.json`.

Functions deploy to **`asia-south1`**, set once via `setGlobalOptions` in
`functions/src/index.ts` (co-located with Firestore, also `asia-south1` — see
Prerequisites). The Gemini Developer API isn't region-pinned the way Vertex is,
so there's no matching region setting to keep in sync here.

### B. Browser extension

```
npm run build --workspace extension
```

Before building, copy `extension/src/firebaseConfig.example.ts` to
`extension/src/firebaseConfig.ts` (gitignored — keeps your real project's config
out of the public repo) and fill in your Firebase web app config (Firebase
console → Project settings → your apps — register a Web app there first if one
doesn't exist yet). Also point `extension/src/config.ts`'s `API_BASE_URL` at your
deployed functions.

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ select `extension/dist`.

Open `web.whatsapp.com` in a tab and log in as usual — just the one session, on
the business number. In the extension popup, click **Login** (opens the hosted
login page from part C below — deploy that first), complete phone verification
there, then come back to the popup: it'll now show the assistant-chat picker —
**Use "Message Yourself" (recommended)** to default to WhatsApp's own self-chat
as the instruction channel, or paste a specific jid manually if you'd rather use
a different chat.

Message routing (ingest/instruct) and auth are wired up and working; sending a
message back is not implemented at all currently — see "Where this is headed".

### C. Login page (GitHub Pages)

One-time setup:
1. In the repo's GitHub settings: **Settings → Pages → Source: GitHub Actions**.
   `.github/workflows/deploy-pages.yml` then deploys `public/` automatically on
   every push to `main` that touches that folder (or trigger it manually via
   the Actions tab).
2. Confirm `public/login.js`'s `firebaseConfig`, `MINT_TOKEN_URL` (your deployed
   `mintExtensionToken` function URL), and `EXTENSION_ID` match your actual
   values — unlike the extension's config, this file **is** committed and public
   (GitHub Pages has no secret-injection step; whatever's checked in is exactly
   what's served — see the comment in that file for why that's an acceptable
   tradeoff for Firebase web config specifically).
3. Add your Pages domain to Firebase's Authorized domains (see Prerequisites).
4. If serving from a custom domain (this repo uses `pocha.fyi`, set up via a
   `CNAME` file in `public/` and DNS pointed at GitHub Pages) rather than the
   default `<username>.github.io/<repo-name>/`, make sure **Settings → Pages
   → Enforce HTTPS** is checked once the certificate finishes provisioning.
   Phone-auth/reCAPTCHA need a secure context — an `http://` origin will not
   work reliably even once CORS/`externally_connectable` are configured for it.

Once deployed, the extension's Login button points at this page
(`HOSTED_LOGIN_URL` in `extension/src/config.ts`, currently `https://pocha.fyi/`)
— update that, `extension/manifest.json`'s `externally_connectable`, and the
CORS origin in `functions/src/index.ts`'s `mintExtensionToken` together if this
domain ever changes — all three have to agree.

## Local Testing

Runs the exact same server-side deployment as above, just on your machine instead
of Cloud Run/Firebase — for developing and testing before you deploy anything real.

### Run the Functions emulator

```
npm run emulators
```

This starts the Firestore + Functions emulators (`firebase.json`) so `/ingest` and
`/instruct` are callable locally, with `functions/lib` rebuilt via the `predeploy`
hook. If you're also testing the extension against this local setup, point its
`API_BASE_URL` (`extension/src/config.ts`) at the emulator's local URL, and set
`FIRESTORE_EMULATOR_HOST` in any local script's environment to hit the same
emulated Firestore.

## Offline Testing (no live WhatsApp session needed)

Builds on the Local Testing setup above (emulator running), but skips needing a
live WhatsApp session entirely — for testing the server-side logic against a
manually-crafted dump:

1. **Dump conversations**: extension popup → "Load recent chats" (shows the N
   most recently active chats, configurable, default 50) → deselect anything
   that isn't a business conversation → "Dump selected" → downloads
   `mudbot-conversation-dump-*.json`. WhatsApp has no "pick chats to back up"
   feature, so this picker is how you narrow a scrape down to just the
   conversations you want. The file holds a `chats` manifest plus one flat,
   globally-sortable `messages` array spanning all of them.
2. **Replay it**: `npm run seed-conversation -- <uid> path/to/dump.json` — runs
   every message through the real `ingestCore` pipeline **in true chronological
   order across all dumped chats** (not conversation-by-conversation — memory is
   per-owner, not per-contact, so that's the order the live system would
   actually have seen them in) and prints what happened (memory stored,
   synthesis produced) per message.

Talks to Firestore directly via the Admin SDK — set
`FIRESTORE_EMULATOR_HOST=localhost:8080` first if you want it to run against the
emulator instead of your real project. LLM/embedding calls always hit the real
Gemini API regardless (that part isn't mocked).

## Known gaps (tracked as TODOs in code, not hidden)

- The capability-synthesis loop itself (matching, building, executing, and
  registering capabilities — including eventually a "respond on WhatsApp"
  capability) isn't implemented yet — see "Where this is headed" above;
  `ingestCore`/`instructCore` currently only store memory and log synthesis.
