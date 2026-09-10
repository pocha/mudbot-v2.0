import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CapabilityContext } from "./capabilityContext";

// TypeScript transpiles a plain `import()` call down to `require()` under
// `module: commonjs` (confirmed live: the failure was a require()-style
// MODULE_NOT_FOUND, "Require stack" and all) — and require() can neither
// parse a file:// URL nor load an .mjs file synchronously. Wrapping it in
// `new Function` hides the call from TS's static transform entirely, so this
// is a genuine native runtime import() — the standard workaround for this
// well-known TS+CJS+dynamic-import interop gap.
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ default?: unknown }>;

/**
 * Runs generated capability code in this same process — the container/VM
 * boundary plus the scoped Firebase session is the isolation here, not a
 * further per-execution sandbox (see the architecture writeup's discussion
 * of why containers, not namespaces, do the isolating). Known consequence
 * worth stating plainly: a bug in generated code has the same process
 * memory access as this entrypoint, including its env vars — acceptable
 * because this container is already scoped to exactly one user, but a real
 * limitation if that scope were ever meant to protect against something
 * inside its own boundary.
 *
 * Written under this app's own directory tree (not the OS tmpdir) so Node's
 * module resolution can still find node_modules if generated code ignores
 * the "no imports" instruction and tries one anyway — built-ins still work,
 * anything from npm fails with a clear, feedback-able error instead of a
 * confusing one.
 */
export async function runCapabilityCode(
  code: string,
  params: Record<string, unknown>,
  ctx: CapabilityContext
): Promise<unknown> {
  const dir = join(__dirname, "..", "tmp", `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const file = join(dir, "capability.mjs");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(file, code, "utf8");
    const mod = await dynamicImport(pathToFileURL(file).href);
    if (typeof mod.default !== "function") {
      throw new Error("capability code must have a default export function: (params, ctx) => result");
    }
    const fn = mod.default as (p: Record<string, unknown>, c: CapabilityContext) => Promise<unknown>;
    return await fn(params, ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
