import { execFile } from "node:child_process";
import { CONTAINER_MEMORY_LIMIT, CONTAINER_TIMEOUT_MS } from "./config";

// A manual Promise wrapper rather than util.promisify(execFile) — promisify
// relies on execFile's built-in customPromisifyArgs symbol to resolve
// {stdout, stderr} instead of just the first callback argument, which a
// mocked module in tests won't carry. This keeps behavior identical and
// predictable in both places.
function execFileAsync(
  command: string,
  args: string[],
  options: { timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Per-user container lifecycle: created once, reused across jobs via
 * `docker exec` instead of a fresh `docker run --rm` every time. Containers
 * are never stopped once started — no idle-timeout/health-check yet, called
 * out in README's "Known gaps" rather than hidden.
 */

function containerName(uid: string): string {
  return `mudbot-${uid}`;
}

export async function isContainerRunning(uid: string): Promise<boolean> {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "--filter",
    `name=^${containerName(uid)}$`,
    "--format",
    "{{.Names}}",
  ]);
  return stdout.trim() === containerName(uid);
}

export async function startContainer(uid: string, image: string): Promise<void> {
  await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    containerName(uid),
    "--memory",
    CONTAINER_MEMORY_LIMIT,
    image,
  ]);
}

export async function dispatchToContainer(uid: string, env: Record<string, string>): Promise<void> {
  const args = ["exec"];
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(containerName(uid), "node", "lib/index.js");

  await execFileAsync("docker", args, { timeout: CONTAINER_TIMEOUT_MS });
}
