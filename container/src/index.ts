import { signIn, replyToCommand } from "./firebaseClient";
import { runExecutor } from "./executor";
import { runCreator } from "./creator";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

async function main() {
  await signIn();

  const uid = requireEnv("UID");
  const commandId = requireEnv("COMMAND_ID");
  const jobType = requireEnv("JOB_TYPE");

  try {
    if (jobType === "execute") {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(process.env.PARAMS ?? "{}");
      } catch {
        console.warn("[container] could not parse PARAMS, running with {}:", process.env.PARAMS);
      }
      await runExecutor(uid, commandId, requireEnv("CAPABILITY_ID"), params);
    } else if (jobType === "build") {
      await runCreator(uid, commandId, requireEnv("RAW_TEXT"), process.env.INTENT);
    } else {
      throw new Error(`unknown JOB_TYPE: ${jobType}`);
    }
  } catch (err) {
    console.error("[container] job failed:", err);
    await replyToCommand(uid, commandId, "Something went wrong on my end — flagging this for the owner.").catch(() => {
      /* best-effort — if even the failure reply can't be written, there's nothing left to do but exit non-zero */
    });
    process.exitCode = 1;
  }

  // The Firestore/RTDB client SDKs hold persistent connections open
  // (WebSocket/long-polling) that keep the event loop alive indefinitely —
  // confirmed live: a run that fully succeeded (reply written, capability
  // registered) still never returned control to `docker run`. An explicit
  // exit is required, not optional, for a one-shot job like this.
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("[container] fatal (before/outside job handling):", err);
  process.exit(1);
});
