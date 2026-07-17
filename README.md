# Mudbot v2.0

A WhatsApp assistant for a small business owner (e.g. a bakery run over WhatsApp). It
passively learns from real conversations and, on top of that, drafts messages, posts
to groups, and turns customer orders into spreadsheet rows — either when explicitly
told to, or on its own once a pattern has earned enough trust. This README covers
setup; architecture rationale (why everything is an MCP tool call, how pattern
confidence works) lives in code comments near the relevant modules — start at
`functions/src/core.ts` and `functions/src/policy/patterns.ts`.

## Architecture at a glance

- **Client**: a Chrome extension (Manifest V3) driving a **single WhatsApp Web
  session** on the owner's real business number. One chat within that same
  session — by default WhatsApp's own "Message Yourself" self-chat — is marked as
  the assistant channel for instructions/confirmations; everything else observed
  in the session is ordinary business traffic. This deliberately avoids needing a
  second WhatsApp account (and its own device-limit budget) just to talk to the
  assistant. Firebase Auth (phone) gates who's who.
- **Server**: Firebase Cloud Functions running Genkit flows (`synthesize` →
  `determineAction`) against Gemini/Vertex AI, with Firestore's native vector
  search as the per-user memory store.
- **Actions**: everything real-world — Sheets/Calendar, WhatsApp sends, scheduled
  reminders — is an MCP tool call, served by three small MCP servers
  (`mcp-workspace-server`, `mcp-whatsapp-server`, `mcp-scheduler-server`). These are
  server-side services (Cloud Run in production) — a Sheets edit happens entirely
  on the server via the Sheets API, never on anyone's laptop. The one exception is
  `mcp-whatsapp-server`, which never touches WhatsApp itself either: it queues a
  Firestore command the extension executes, since only the extension holds the
  live WhatsApp session.
- **Learning**: every passive message is classified for actionable shape; the
  first time a shape is seen nothing happens until the owner explicitly instructs
  on it once, which creates a learned pattern. Confidence per pattern (gated by a
  per-tool risk tier) governs whether future occurrences are suggested or
  auto-acted with just an FYI.

## Repo layout

```
functions/              Firebase Cloud Functions: Genkit orchestration (the core)
mcp-workspace-server/   MCP server: Sheets / Calendar (sync tools)
mcp-whatsapp-server/    MCP server: WhatsApp send (async, extension-bridge)
mcp-scheduler-server/   MCP server: scheduled reminders (Cloud Scheduler)
extension/              Chrome extension (Manifest V3): client
scripts/                Local CLI tools: customer review + offline testing
firestore.rules / firestore.indexes.json   Per-uid isolation + vector index
```

## Prerequisites

- Node 22, npm 11+
- A Firebase project (Blaze plan — Cloud Functions 2nd gen + outbound network
  access to Vertex AI require it) with **Firestore (Native mode)**, **Authentication
  → Phone** provider, and the **Vertex AI API** enabled
- The `firebase` CLI (`npm i -g firebase-tools`), logged in (`firebase login`)
- Google Cloud auth for local runs of `functions`/`scripts` against real
  Vertex AI/Firestore: `gcloud auth application-default login`

## Setup

Pure configuration — nothing here starts a server or ships anything anywhere.

### 1. Install dependencies

```
npm install
```

This is an npm-workspaces monorepo — one install at the root covers every package
(`functions`, the three `mcp-*-server`s, `extension`, `scripts`).

### 2. Point the repo at your Firebase project

Edit `.firebaserc` and replace `mudbot-v2` with your actual project id.

### 3. Configure environment variables

```
cp functions/.env.example functions/.env
```

Fill in:
- `GEMINI_MODEL_ID` — confirm this against the current Vertex AI model garden;
  the default in `.env.example` may drift from what's actually available.
- `MCP_WORKSPACE_URL`, `MCP_WHATSAPP_URL`, `MCP_SCHEDULER_URL` — where those
  three servers are reachable. Point these at Cloud Run URLs for a real
  deployment, or `localhost` ports for Local Testing (below).

The `mcp-scheduler-server` additionally needs `GCP_PROJECT`, `SCHEDULER_LOCATION`,
and `INSTRUCT_FUNCTION_URL` (the `/instruct` endpoint it POSTs back to when a
reminder fires) — set these in its own environment wherever it runs.

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
`users/{uid}/memories.embedding` (768 dims, matching `text-embedding-004`),
defined in `firestore.indexes.json`.

Deploy each `mcp-*-server` to Cloud Run independently (they're plain
Express/Node services — `gcloud run deploy` from each package directory after
`npm run build`), then update `functions/.env` (or the deployed function's
environment config) with their Cloud Run URLs. `mcp-workspace-server` also needs a
connected Google OAuth token per user before `sheet_update`/`calendar_event` will
work — see the `TODO` in `mcp-workspace-server/src/googleAuth.ts` (Secret Manager
wiring isn't implemented yet, only stubbed).

### B. Browser extension

```
npm run build --workspace extension
```

Before building, fill in `extension/src/firebaseClient.ts` with your Firebase web
app config (Firebase console → Project settings → your apps — register a Web app
there first if one doesn't exist yet), and point `extension/src/config.ts`'s
`API_BASE_URL` at your deployed functions.

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked**
→ select `extension/dist`.

Open `web.whatsapp.com` in a tab and log in as usual — just the one session, on
the business number. Sign into the extension popup with phone auth, then use the
popup's assistant-chat picker: **"Use Message Yourself (recommended)"** to default
to WhatsApp's own self-chat as the instruction channel, or paste a specific jid
manually if you'd rather use a different chat.

**Known gap**: the actual DOM scraping/sending logic in
`extension/src/whatsappAdapter.ts` is stubbed out (see "Known gaps" below) —
everything up to that point (message routing, auth, the command queue) is wired
and ready for it.

## Local Testing

Runs the exact same server-side deployment as above, just on your machine instead
of Cloud Run/Firebase — for developing and testing before you deploy anything real.

### Run the MCP servers locally

```
npm run build --workspace mcp-workspace-server  && npm run start --workspace mcp-workspace-server
npm run build --workspace mcp-whatsapp-server    && npm run start --workspace mcp-whatsapp-server
npm run build --workspace mcp-scheduler-server   && npm run start --workspace mcp-scheduler-server
```

They default to ports 4001/4002/4003 (override with `PORT`) — matching the
`localhost` defaults in `functions/.env.example`.

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

Builds on the Local Testing setup above (MCP servers + emulator running), but skips
needing a live WhatsApp session entirely — useful once the DOM adapter is filled
in, or for testing the server-side logic against a manually-crafted dump:

1. **Dump a conversation**: extension popup → "Dump conversation" → downloads
   `mudbot-conversation-dump-*.json`.
2. **Replay it**: `npm run train-from-dump -- <uid> path/to/dump.json` — runs
   every message through the real `ingestCore` pipeline and prints what happened
   (memory stored, pattern matched, decision made) per message.
3. **Play out new scenarios interactively**: `npm run simulate -- <uid>` — type as
   a customer or as the owner, see the decision made and who any resulting
   WhatsApp message would go to (owner vs. customer/group).
4. **Review a customer end-to-end**: `npm run review-customer -- <uid>` — prints
   recent events, learned-pattern confidence, and any stuck pending commands.

All of the above talk to Firestore directly via the Admin SDK — set
`FIRESTORE_EMULATOR_HOST=localhost:8080` first if you want them to run against the
emulator instead of your real project. LLM/embedding calls always hit real
Vertex AI regardless (that part isn't mocked).

## Known gaps (tracked as TODOs in code, not hidden)

- `extension/src/whatsappAdapter.ts` — real WhatsApp Web DOM selectors
- `mcp-workspace-server/src/googleAuth.ts` — Secret Manager token fetch for
  per-user Google Workspace OAuth
- Interactive "reply YES/STOP to confirm" parsing on the assistant chat —
  `extension/src/background.ts` currently executes queued commands immediately
  rather than waiting for a chat reply; flagged inline where this needs revisiting
