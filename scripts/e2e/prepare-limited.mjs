// Build the second e2e server's root: a read-only folder holding one file that
// is too large for the editor to open in full.
//
// Generated rather than committed: the fixture is 34 MB, and git would carry it
// forever.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..", ".e2e-limited");

mkdirSync(resolve(root, "empty"), { recursive: true });

const oversized = resolve(root, "oversized.txt");
if (!existsSync(oversized)) {
  // One byte over the editor's full-edit limit, so the preview path is used.
  writeFileSync(oversized, Buffer.alloc(34 * 1024 * 1024, 0x61));
}

console.log(`prepared ${root}`);
