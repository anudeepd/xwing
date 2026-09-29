// Build X-wing's frontend: Vite (React + the PostCSS chain that runs Tailwind)
// produces the entries, then this script fingerprints them the way app.py's
// `asset()` expects.
//
// The Python app owns the HTML, so Vite runs without an index.html: the entries
// are the three React roots plus the stylesheet the Jinja templates link. The
// emitted JS keeps Vite's own hashed names, because its chunk graph references
// them; only the CSS is renamed here, after the bundled font URLs inside it have
// been rewritten.
//
// Run with: node build-frontend.mjs

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { createHash } from "crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const frontendDir = resolve(projectRoot, "xwing/frontend");
const staticDir = resolve(projectRoot, "xwing/static");
const outDir = resolve(staticDir, "assets");

const hash8 = (data) => createHash("sha256").update(data).digest("hex").slice(0, 8);

rmSync(outDir, { recursive: true, force: true });

// Vite empties the output directory itself; keeping the rm above means a failed
// build cannot leave yesterday's hashed entries behind next to new ones.
execFileSync(process.execPath, [resolve(projectRoot, "xwing/frontend/node_modules/vite/bin/vite.js"), "build", "--config", resolve(frontendDir, "vite.config.ts")], {
  cwd: frontendDir,
  stdio: "inherit",
});

// Fonts live in the source tree under static/fonts. They are referenced from CSS
// by absolute URL, so Vite leaves them alone: copy each one to a
// content-addressed name under assets/fonts and rewrite the built CSS below.
const fontDir = resolve(staticDir, "fonts");
const outFontDir = resolve(outDir, "fonts");
mkdirSync(outFontDir, { recursive: true });
const fontMap = new Map();
for (const name of readdirSync(fontDir)) {
  if (!name.endsWith(".woff2") && !name.endsWith(".woff")) continue;
  const bytes = readFileSync(resolve(fontDir, name));
  const stem = name.replace(/\.(woff2?)$/, "");
  const ext = name.endsWith(".woff2") ? "woff2" : "woff";
  const hashed = `${stem}-${hash8(bytes)}.${ext}`;
  copyFileSync(resolve(fontDir, name), resolve(outFontDir, hashed));
  fontMap.set(`/static/fonts/${name}`, `/static/assets/fonts/${hashed}`);
}

// The editor bundle is prebuilt and committed under static/, not produced above.
const codemirrorBytes = readFileSync(resolve(staticDir, "codemirror-bundle.js"));
const codemirrorHashed = `codemirror-bundle-${hash8(codemirrorBytes)}.js`;
copyFileSync(resolve(staticDir, "codemirror-bundle.js"), resolve(outDir, codemirrorHashed));

/** Vite's own manifest names the emitted file for each input. */
const viteManifest = JSON.parse(readFileSync(resolve(outDir, ".vite/manifest.json"), "utf8"));
const entryFile = (source) => {
  const record = viteManifest[source];
  if (!record?.file) throw new Error(`Vite manifest has no entry for ${source}`);
  return record.file;
};

// Logical name to emitted file, which is what `asset()` in app.py resolves.
const manifest = {
  "app.js": entryFile("src/app.tsx"),
  "editor.js": entryFile("src/editor.tsx"),
  "admin.js": entryFile("src/admin.tsx"),
  "codemirror-bundle.js": codemirrorHashed,
};

// Fonts: expose the content-addressed names so templates can preload the
// faces each page needs instead of discovering them after the CSS parses. The
// value keeps its `fonts/` directory: `asset()` only prefixes
// `/static/assets/`, so a bare file name would resolve one directory too high
// and every preload would 404.
for (const [from, to] of fontMap) {
  manifest[`fonts/${from.split("/").pop()}`] = to.replace("/static/assets/", "");
}

// Stylesheets: rewrite the font URLs, then name each file after its final
// bytes, so a font change moves the stylesheet's cache key with it.
const CSS_ENTRIES = [
  { input: "style", key: "style.css", stem: "style" },
];
for (const name of readdirSync(outDir)) {
  if (!name.endsWith(".css")) continue;
  const logical = CSS_ENTRIES.find(entry => name.startsWith(`${entry.input}-`));
  if (!logical) continue;
  const { key, stem } = logical;
  let text = readFileSync(resolve(outDir, name), "utf8");
  for (const [from, to] of fontMap) {
    if (text.includes(from)) text = text.split(from).join(to);
  }
  const hashed = `${stem}-${hash8(text)}.css`;
  writeFileSync(resolve(outDir, hashed), text);
  rmSync(resolve(outDir, name));
  manifest[key] = hashed;
}

for (const target of ["app.js", "editor.js", "admin.js", "style.css"]) {
  if (!manifest[target]) throw new Error(`Build produced no file for ${target}`);
}

// Vite's manifest is an input to this script, not something the app serves.
rmSync(resolve(outDir, ".vite"), { recursive: true, force: true });
if (existsSync(resolve(outDir, "manifest.json"))) rmSync(resolve(outDir, "manifest.json"));

const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(sorted, null, 2)}\n`);

console.log("manifest:", sorted);
