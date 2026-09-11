#!/usr/bin/env node
/**
 * Runs automatically after `npm install` in this package (see package.json's
 * postinstall) — this orchestrator is useless without Docker running and the
 * capability-runtime image built, whether that's a real VM deploy or a local
 * dev machine, so checking both here catches a broken setup at install time
 * instead of at the orchestrator's first dispatch attempt.
 *
 * Plain CommonJS, no build step — this needs to run standalone via `node`
 * during postinstall, before this package's own `tsc` build even happens.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

// container/ is expected to be a sibling directory — true both for a real VM
// deploy (README's setup only scp's orchestrator/ and container/) and for
// this monorepo checkout.
const CONTAINER_DIR = path.resolve(__dirname, "..", "..", "container");

// Matches orchestrator/.env.example's documented default. .env doesn't
// necessarily exist yet at postinstall time (it's filled in as a separate
// setup step, sometimes after this runs), so this can't reliably read a
// custom CONTAINER_IMAGE from it — if you use a different tag, retag or
// rebuild manually to match after this runs.
const IMAGE = "mudbot-container:latest";

try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  console.error(
    "\n[orchestrator setup] Docker doesn't seem to be running (`docker info` failed).\n" +
      "Start Docker (Docker Desktop locally, or the docker service on the VM), then re-run `npm install`.\n"
  );
  process.exit(1);
}

console.log(`[orchestrator setup] building ${IMAGE} from ${CONTAINER_DIR}...`);
try {
  execFileSync("docker", ["build", "-t", IMAGE, CONTAINER_DIR], { stdio: "inherit" });
} catch {
  console.error("\n[orchestrator setup] docker build failed — see output above.\n");
  process.exit(1);
}

console.log(`[orchestrator setup] ${IMAGE} is ready.`);
