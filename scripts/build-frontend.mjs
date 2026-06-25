import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { mkdirSync, rmSync } from "fs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const srcDir = resolve(projectRoot, "xwing/frontend/src");
const outDir = resolve(projectRoot, "xwing/static/assets");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(srcDir, "app.js"), resolve(srcDir, "editor.js")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  outdir: outDir,
  entryNames: "[name]",
  logLevel: "info",
});

await build({
  entryPoints: [resolve(srcDir, "style.css")],
  bundle: true,
  minify: true,
  external: ["/static/fonts/*"],
  outfile: resolve(outDir, "style.css"),
  logLevel: "info",
});
