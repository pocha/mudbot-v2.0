import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");
copyFileSync("src/popup/popup.html", "dist/popup.html");
copyFileSync("src/popup/logo.png", "dist/logo.png");

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
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await esbuild.build(buildOptions);
  console.log("built extension to dist/");
}
