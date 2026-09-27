// Build the roots for the two extra e2e servers.
//
//   .e2e-limited  a read-only folder holding one file too large for the editor
//                 to open in full. Generated rather than committed: the fixture
//                 is 34 MB and git would carry it forever.
//   .e2e-rename   the root for the tests that rename real files, kept out of
//                 e2e/fixtures because that listing is shared: other tests
//                 assert on its row order, selection counts and visual
//                 snapshots, so a file appearing in it mid-run breaks them.
//
// Both servers run this script, so every write is staged and renamed into
// place; a concurrently starting server must never read a half-written
// oversized.txt and render a torn preview.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Deletes are soft on this server, so a scratch root's trash grows run after
// run. Nothing reads it back, so start each run from empty.
for (const root of [".e2e-limited", ".e2e-rename"]) {
  rmSync(resolve(scriptDir, "..", root, ".xwing-trash"), { recursive: true, force: true });
}

const limited = resolve(scriptDir, "..", ".e2e-limited");
mkdirSync(resolve(limited, "empty"), { recursive: true });
const oversized = resolve(limited, "oversized.txt");
if (!existsSync(oversized)) {
  // One byte over the editor's full-edit limit, so the preview path is used.
  const staging = `${oversized}.${process.pid}.tmp`;
  writeFileSync(staging, Buffer.alloc(34 * 1024 * 1024, 0x61));
  renameSync(staging, oversized);
}

const renameRoot = resolve(scriptDir, "..", ".e2e-rename");
mkdirSync(renameRoot, { recursive: true });

console.log(`prepared ${limited} and ${renameRoot}`);
