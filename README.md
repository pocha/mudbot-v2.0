# Mudbot v2.0

A self-evolving WhatsApp/web chatbot. Full writeup and open questions:
**[Capability Runtime](https://claude.ai/code/artifact/2d45d984-7f21-4d46-8980-497e7a532cf5)**.

![Capability runtime architecture: WhatsApp and the web chat page push into Realtime Database queues; a Cloud Function trigger writes durable memory and conversation records to Firestore and dispatches capability jobs; a VM orchestrator listens for jobs and starts or reuses per-user Docker containers, which read/write Firestore through their own scoped session and write replies back to Realtime Database.](docs/capability-runtime.svg)

This README is setup/run only.

## Repo layout

```
functions/              Firebase Cloud Functions: Decision Maker + Genkit orchestration
extension/              Chrome extension (Manifest V3): WhatsApp client
public/                 Hosted login page (GitHub Pages)
scripts/                Local CLI: offline testing against a conversation dump
orchestrator/           VM daemon: mechanical dispatchQueue -> container runner (see part D)
container/              Docker image: Executor/Creator, run per job by the orchestrator
firestore.rules / firestore.indexes.json   Per-uid isolation + vector index
database.rules.json     Realtime Database rules — ingestQueue/commands (per-uid), dispatchQueue (orchestrator-only)
```

## Prerequisites

- Node 22, npm 11+
- A Firebase project (Blaze plan — Cloud Functions 2nd gen require it) with
  **Firestore (Native mode)**, **Realtime Database**, and **Authentication →
  Phone** provider enabled
- A Linux VM for the capability runtime (Docker containers) — 4 GB RAM is
  enough for a handful of pilot users given containers start on demand, one
  per user, and are reused across that user's jobs (see "Capability runtime
  (VM)" below — note they aren't stopped once started yet). Needs no inbound
  ports open; it only ever calls out to Firebase.
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
firebase deploy --only firestore:rules,firestore:indexes,database
firebase deploy --only functions
```

The first command also provisions the vector index on
`users/{uid}/memories.embedding` (768 dims — `gemini-embedding-001` truncated
via `outputDimensionality`, see `functions/src/genkit.ts`),
defined in `firestore.indexes.json`, and deploys `database.rules.json` for
Realtime Database. Functions deploy to `asia-south1`, set via
`setGlobalOptions` in `functions/src/index.ts`.

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

### D. Capability runtime (VM)

Two pieces: the **orchestrator** (a small Node daemon that runs directly on
the VM host) and the **container** image it launches per job (where
Executor/Creator actually run). See the
[Capability Runtime](https://claude.ai/code/artifact/2d45d984-7f21-4d46-8980-497e7a532cf5)
writeup for the design this implements — worth reading first, since the
orchestrator is deliberately mechanical (no LLM calls) and everything that
touches a user's data does it through a token scoped to exactly that user,
never a shared admin credential.

**Containers are created once per user and reused across jobs.** The
orchestrator checks whether a container for that user is already running
(`docker ps`); if not, it starts one (`docker run -d`, idle — the image's
default `CMD` just keeps it alive rather than running a job). Either way, the
actual job runs via `docker exec ... node lib/index.js` inside that
container, so a user's second query doesn't pay a fresh container's cold-start
cost on top of the LLM round trip. See `orchestrator/src/containerManager.ts`.

**1. Install Docker** (Ubuntu/Debian shown — adjust for your distro):

```
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in after this so `docker` works without sudo
```

Verify with `docker run hello-world`.

**2. Network posture** — no inbound firewall rules are needed. Every
connection this VM makes is outbound: to Firebase Realtime Database (the
orchestrator's live queue listener) and to Firebase Cloud Functions (minting
a per-user scoped token before starting that user's container). If this VM
sits behind a security group/firewall you control, outbound HTTPS (443) is
all it needs — don't open anything inbound for this.

**3. Install Node 22** (for the orchestrator daemon):

```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**4. Get the code onto the VM.** Simplest for now: `git clone` this repo (or
`scp` just the `orchestrator/` and `container/` directories — they don't
depend on `functions/`, `extension/`, or `scripts/` at runtime).

**5. (Optional, for local typecheck/tests only)** `container/`'s own image
build is self-contained (its Dockerfile does its own `npm install`/`tsc`
inside the build) — you don't need to install its dependencies on the host
at all unless you want to run `container`'s tests or get IDE type-checking
working there too: `cd container && npm install`.

**6. Configure and run the orchestrator** — this also builds the container
image for you:

```
cd orchestrator
npm install
```

`npm install` here runs a `postinstall` check (`scripts/setup-docker.js`)
that verifies Docker is running and builds `mudbot-container:latest` from the
sibling `container/` directory — it fails clearly and stops if Docker isn't
up yet, rather than silently succeeding and leaving you to discover it later
when the orchestrator can't dispatch a job. If you're using a different
`CONTAINER_IMAGE` tag, rebuild/retag manually to match after this runs (see
the script's comment for why it can't read your `.env` at this point).

```
npm run build
cp .env.example .env
```

Fill in `.env`:
- `FIREBASE_API_KEY` / `FIREBASE_AUTH_DOMAIN` / `FIREBASE_PROJECT_ID` /
  `FIREBASE_DATABASE_URL` — same web app config as
  `extension/src/firebaseConfig.ts` (Firebase console → Project settings →
  your apps). `FIREBASE_DATABASE_URL` especially: copy the real URL from
  Firebase console → Realtime Database rather than assuming the default
  `firebaseio.com` form — Realtime Database's regions are a much smaller set
  than Firestore's, so this project's instance likely isn't in the same
  region as everything else (this one is `asia-southeast1`, Firestore/
  Functions are `asia-south1`).
- `MINT_TOKEN_URL` — the deployed `mintContainerToken` function's URL
  (`firebase functions:list` after deploying functions).
- `ORCHESTRATOR_SHARED_KEY` — must exactly match `functions/.env`'s value of
  the same name (that's the shared secret `mintContainerToken` checks against
  the `x-orchestrator-key` header — see that function's comment for why it's
  a shared secret rather than a real service-account identity for now).
- `CONTAINER_IMAGE` — `mudbot-container:latest` if you built it with the tag
  above.
- `GEMINI_API_KEY` — same key as `functions/.env`; passed through into every
  container's environment (not baked into the image) so it's one place to
  rotate.

Then:

```
npm start
```

`npm start` re-checks Docker readiness itself right before it starts
listening (belt-and-suspenders with the `npm install` check above — the
daemon could be down, or the image since removed, by the time you actually
start it), so a broken Docker setup fails loudly here too rather than at the
first dispatch.

For anything beyond a one-off test, run it under a process supervisor
(`systemd`, `pm2`) so it restarts on crash/reboot — not set up by this repo.
The orchestrator holds one long-lived Firebase session (auto-refreshing) and
a live listener on `dispatchQueue`; nothing else needs to be running for it
to pick up jobs the moment the Decision Maker dispatches one.

**Known gaps** (tracked here, not hidden):
- No dependency installation for generated capabilities — `runCode.ts`
  currently tells the LLM "no imports, no require()" and only exposes the
  small `ctx.get/set/update/add/list` surface (see
  `container/src/capabilityContext.ts`). A capability that genuinely needs an
  npm package or a new external API integration isn't handled by this loop
  shape yet.
- Creator's build loop is bounded generate-and-retry (3 attempts), not real
  multi-step exploration — see the architecture writeup's discussion of when
  that's enough vs. when it isn't.
- `mintContainerToken`'s shared-secret gating is a pilot-stage stand-in for a
  real service-account identity (see its comment in `functions/src/index.ts`).
- Containers are never stopped once started — no idle-timeout or health-check
  for one that's running but wedged. Acceptable for now since Docker's own
  `--memory` limit bounds the damage per container; revisit once idle
  containers piling up (or a stuck one silently eating every job for that
  user) is an actual problem rather than a hypothetical one.

## Testing

```
npm test
```

Runs each package's (`functions`, `container`, `orchestrator`) [Vitest](https://vitest.dev)
suite — colocated `*.test.ts` files next to the source they cover, plus a
segregated `core.guards.test.ts` for edge-case/fallback behavior (e.g. Decision
Maker's guard against a hallucinated `capabilityId`) kept separate from
happy-path coverage. Everything external — Docker (`node:child_process`),
Firestore/RTDB, and Gemini calls — is mocked at the module boundary, so these
run instantly with no live Firebase project or Docker daemon needed, unlike
the manual end-to-end steps in Local/Offline Testing below. Deliberately
happy-path only for now — no emulator-backed Security Rules suite yet (would
need `@firebase/rules-unit-testing`); revisit once the project's shape settles
enough to justify that heavier infrastructure.

## Local Testing

The whole stack — Functions, Firestore, Realtime Database, Auth, the hosted
web pages, and (with a one-time setup step below) the VM orchestrator driving
your own local Docker containers — can run entirely on your machine, without
touching production Firebase or a real WhatsApp session.

**Two things are never emulated, on purpose:** WhatsApp Web itself (the
extension's content script only ever matches `web.whatsapp.com` — there's
nothing to fake there, so exercising the real ingest path still means a real
WhatsApp Web login) and every Gemini API call (no local/emulated LLM —
generate/embed calls always hit the real API and consume real quota, same
cost as production).

**How local mode is switched on:** one signal, `NODE_ENV=development`, drives every package — `npm start` (below) sets it once at the top, and everything downstream keys off it rather than a separate hand-edited flag per package:
- `functions/` needs no code change at all — Cloud Functions has this convention built in: `.env` loads always, `.env.local` loads *only* for the emulator and overrides everything, and is emulator-only by Firebase's own design (already covered by this repo's `.gitignore`).
- `orchestrator/` layers `orchestrator/.env.local` on top of `orchestrator/.env` when it sees `NODE_ENV=development` (secrets still come from `.env`; `.env.local` only overrides the handful of fields that genuinely need a different value locally), and forwards that same variable into the container it dispatches to.
- `container/` (inside Docker) checks the `NODE_ENV` orchestrator forwarded it.
- `extension/` has no env vars at runtime (it's a bundled browser extension) — `build.mjs` substitutes `NODE_ENV` as a literal via esbuild's `define` at build time instead, so `src/config.ts` can check it exactly like everywhere else.
- `public/login.js`/`chat.js` are the one exception — no build step exists for raw static files, so they detect local mode at runtime instead, by checking `location.hostname`.

### One-time setup

1. **Start Docker**, then run `npm install` at the repo root (if you haven't already, or run it again) — this cascades into `container/` and `orchestrator/` (see root `package.json`'s `postinstall`), and orchestrator's own install checks Docker and builds `mudbot-container:latest` automatically. See Deployment part D for what this is actually doing under the hood.
2. **Orchestrator's real `.env`** (required either way, local mode or not): `cp orchestrator/.env.example orchestrator/.env` and fill it in. Nothing else to do here — `orchestrator/.env.local` is already committed with working local defaults (points `MINT_TOKEN_URL` at the local Functions emulator, sets the Docker-host values) and gets layered on top of `.env` automatically whenever `NODE_ENV=development`. Only touch `.env.local` if your setup genuinely differs from its defaults (a different project id than `watobot-v2`, non-Docker-Desktop host, etc).
3. **Extension for local mode**: `NODE_ENV=development npm run build --workspace extension`, then reload it unpacked in `chrome://extensions`. (Plain `npm run build --workspace extension`, no `NODE_ENV`, is what real deploys use — same command either way, just the env var.)
4. **(Optional) a test phone number**, only if you specifically want to exercise the real login flow rather than the automatic one `npm start` sets up by default (see below): once emulators are running, open `http://127.0.0.1:4000/auth` and add a phone number with a fixed code (e.g. `+1 650-555-3434` / `123456`) — the Auth Emulator skips real reCAPTCHA/SMS entirely once a page connects to it, so this fake number is all sign-in needs. Persists across restarts, so this is genuinely one-time.

### Running it

```
npm start
# or: npm start -- --userid my-uid
```

Sets `NODE_ENV=development`, starts the Firestore + Realtime Database +
Functions + Auth + Hosting emulators (`firebase.json`), waits for them to come
up, seeds `local-test-uid` (or whatever `--userid` you passed — same uid is
used for both) with the most recent 30 messages from a
`mudbot-conversation-dump-*.json` in the repo root if one exists (skipped,
harmlessly, if not — see "Offline replay" below), then starts the orchestrator
(skipped with a warning if `orchestrator/.env` isn't set up yet, rather
than crashing). Emulator state — seeded memories,
capabilities, the Auth Emulator's test phone number — persists in a gitignored
`.emulator-data/` between runs, so restarting doesn't lose it (and re-seeding
is itself skipped once a uid already has memories, unless `--force`). Ctrl+C
stops everything together.

It also mints a signed-in session for that same uid against the Auth Emulator
and drops it at `public/local-test-token.json` (gitignored, regenerated each
run, cleaned up on Ctrl+C) — `chat.js` picks it up automatically. That means
**just opening `http://localhost:5000/` lands you straight on the chat page,
already signed in** — no login step needed for routine local testing. The
real login flow still works exactly as it does in production if you want to
test it specifically (skip the auto-login by not running `npm start`, or by
deleting that file): extension popup → **Login** → `http://localhost:5000/login.html`
against your test phone number (Optional setup step 4 above) → redirects to
the chat page the same way.

Either way, once you're on the chat page, type a message there to exercise
the full explicit-command loop (Decision Maker → dispatchQueue → orchestrator
→ your local Docker container → Executor/Creator → reply), or open real
`web.whatsapp.com` with the extension active to exercise the passive ingest
path for real.

`npm run emulators` (without the seeding/orchestrator/extension pieces) still
works on its own if you just want the raw emulator suite.

### Offline replay (no live WhatsApp session needed)

1. **Dump conversations**: extension popup → "Load recent chats" (shows the N
   most recently active chats, configurable, default 50) → deselect anything
   that isn't a business conversation → "Dump selected" → downloads
   `mudbot-conversation-dump-*.json` into your Downloads folder — move it to
   the repo root for `npm start` to pick it up automatically, or point at it
   directly:
2. **Replay it**: `npm run seed-conversation -- <uid> path/to/dump.json [--limit N] [--force]`
   — pushes each message onto the real `ingestQueue/{uid}` RTDB path (the
   same path the extension itself uses) and waits for the real
   `onIngestQueueCreated` trigger to process it before moving to the next one,
   in true chronological order across all dumped chats. `--limit N` replays
   only the N most recent messages (full replays mean N real embedding calls);
   `--force` reseeds even if that uid already has memories.

Set `FIRESTORE_EMULATOR_HOST=localhost:8080` and `FIREBASE_DATABASE_EMULATOR_HOST=localhost:9000`
first to target the emulator instead of a real project (the Admin SDK
auto-detects these; already set for you if you're running this via `npm start`'s
own seed step). LLM/embedding calls always hit the real Gemini API regardless.
