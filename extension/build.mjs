import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");
copyFileSync("src/popup/popup.html", "dist/popup.html");
copyFileSync("src/popup/logo.png", "dist/logo.png");

// esbuild doesn't set process.env.NODE_ENV inside the bundle by default (this
// is browser code, there's no real process object) — `define` substitutes it
// as a literal at build time instead, so src/config.ts can check it exactly
// like every Node-side package does, rather than a separately hand-edited
// boolean. `npm run build --workspace extension` (default) is production;
// `NODE_ENV=development npm run build --workspace extension` builds the
// local-emulator variant — see README's "Local Testing".
const nodeEnv = process.env.NODE_ENV ?? "production";

const buildOptions = {
  entryPoints: {
    background: "src/background.ts",
    "content-script": "src/content-script.ts",
    inject: "src/inject.ts",
    popup: "src/popup/popup.ts",
  },
  bundle: true,
  outdir: "dist",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await esbuild.build(buildOptions);
  console.log("built extension to dist/");
}
