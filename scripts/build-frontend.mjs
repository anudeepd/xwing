import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve, basename } from "path";
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { createHash } from "crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const srcDir = resolve(projectRoot, "xwing/frontend/src");
const staticDir = resolve(projectRoot, "xwing/static");
const outDir = resolve(staticDir, "assets");

const hash8 = (data) => createHash("sha256").update(data).digest("hex").slice(0, 8);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [
    resolve(srcDir, "app.tsx"),
    resolve(srcDir, "editor.tsx"),
    resolve(srcDir, "admin.ts"),
  ],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  jsx: "automatic",
  nodePaths: [resolve(projectRoot, "scripts/node_modules")],
  outdir: outDir,
  // Entry bundles are fingerprinted below, after the URL rewrite: a hash taken
  // here would not cover the rewritten font and editor-payload names.
  entryNames: "[name]",
  assetNames: "fonts/[name]-[hash]",
  loader: { ".woff": "file", ".woff2": "file" },
  logLevel: "info",
});

await build({
  entryPoints: [resolve(srcDir, "style.css"), resolve(srcDir, "admin.css")],
  bundle: true,
  minify: true,
  external: ["/static/fonts/*"],
  outdir: outDir,
  entryNames: "[name]",
  assetNames: "fonts/[name]-[hash]",
  loader: { ".woff": "file", ".woff2": "file" },
  logLevel: "info",
});

// Fonts live in the source tree under static/fonts. They are referenced from CSS
// by absolute URL, so esbuild does not fingerprint them: copy each one to a
// content-addressed name under assets/fonts and rewrite the built CSS.
const fontDir = resolve(staticDir, "fonts");
const outFontDir = resolve(outDir, "fonts");
mkdirSync(outFontDir, { recursive: true });
const fontMap = new Map();
for (const name of readdirSync(fontDir)) {
  if (!name.endsWith(".woff2") && !name.endsWith(".woff")) continue;
  const bytes = readFileSync(resolve(fontDir, name));
  const stem = basename(name).replace(/\.(woff2?)$/, "");
  const ext = name.endsWith(".woff2") ? "woff2" : "woff";
  const hashed = `${stem}-${hash8(bytes)}.${ext}`;
  copyFileSync(resolve(fontDir, name), resolve(outFontDir, hashed));
  fontMap.set(`/static/fonts/${name}`, `/static/assets/fonts/${hashed}`);
}

// The editor bundle is prebuilt and committed under static/, not produced above.
{
  const bytes = readFileSync(resolve(staticDir, "codemirror-bundle.js"));
  const hashed = `codemirror-bundle-${hash8(bytes)}.js`;
  copyFileSync(resolve(staticDir, "codemirror-bundle.js"), resolve(outDir, hashed));
  fontMap.set("/static/codemirror-bundle.js", `/static/assets/${hashed}`);
}

const manifest = {};
for (const name of readdirSync(outDir).sort()) {
  const match = name.match(/^(.*)\.(js|css)$/);
  if (!match || name.startsWith("codemirror-bundle-")) continue;
  const [, stem, ext] = match;
  let text = readFileSync(resolve(outDir, name), "utf8");
  for (const [from, to] of fontMap) {
    if (text.includes(from)) text = text.split(from).join(to);
  }
  const hashed = `${stem}-${hash8(text)}.${ext}`;
  writeFileSync(resolve(outDir, hashed), text);
  rmSync(resolve(outDir, name));
  manifest[`${stem}.${ext}`] = hashed;
}

manifest["codemirror-bundle.js"] = fontMap.get("/static/codemirror-bundle.js").split("/").pop();
const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(sorted, null, 2)}\n`);

console.log("manifest:", sorted);
