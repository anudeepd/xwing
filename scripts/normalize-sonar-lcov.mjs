import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsRoot, "..");
const reportPath = path.join(scriptsRoot, "coverage", "lcov.info");

if (!existsSync(reportPath)) {
  throw new Error(`Vitest coverage report not found: ${reportPath}`);
}

const report = readFileSync(reportPath, "utf8").replace(/^SF:(.*)$/gm, (_line, sourcePath) => {
  const normalized = path.normalize(sourcePath);
  const candidates = path.isAbsolute(normalized)
    ? [normalized]
    : [path.resolve(repoRoot, normalized), path.resolve(scriptsRoot, normalized)];
  const absolutePath = candidates.find((candidate) => existsSync(candidate));

  if (!absolutePath) {
    throw new Error(`LCOV source does not resolve to a repository file: ${sourcePath}`);
  }

  const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");

  if (relativePath.startsWith("../") || relativePath === "..") {
    throw new Error(`LCOV source is outside the repository: ${sourcePath}`);
  }

  return `SF:${relativePath}`;
});

writeFileSync(reportPath, report);
