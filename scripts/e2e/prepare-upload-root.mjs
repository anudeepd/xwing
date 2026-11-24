// A writable, isolated root for the proxy-fault upload tests. Upload manifests
// and completed tombstones are runtime state, so every run starts clean.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..", ".e2e-upload");

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(resolve(root, "README.md"), "Upload fault-test root\n");
console.log(`prepared ${root}`);
