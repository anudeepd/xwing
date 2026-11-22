import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAstAsync } from "vite";
import { convert } from "ast-v8-to-istanbul";
import coverage from "istanbul-lib-coverage";
import report from "istanbul-lib-report";
import reports from "istanbul-reports";

const { createCoverageMap } = coverage;
const { createContext } = report;

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsRoot, "..");
const repoRoot = path.resolve(scriptsRoot, "..", "..");
const assetsRoot = path.join(repoRoot, "xwing", "static", "assets");
const rawRoot = path.join(projectRoot, "coverage-e2e", "raw");
const output = path.join(projectRoot, "coverage-e2e", "lcov.info");

if (!existsSync(rawRoot)) {
  throw new Error(`Playwright coverage was not collected: ${rawRoot}`);
}

const coverageMap = createCoverageMap({});
for (const name of readdirSync(rawRoot)) {
  if (!name.endsWith(".json")) continue;
  const entries = JSON.parse(readFileSync(path.join(rawRoot, name), "utf8"));
  for (const entry of entries) {
    const basename = path.basename(new URL(entry.url).pathname);
    const jsPath = path.join(assetsRoot, basename);
    const mapPath = `${jsPath}.map`;
    if (!existsSync(jsPath) || !existsSync(mapPath)) continue;
    const code = readFileSync(jsPath, "utf8");
    const sourceMap = JSON.parse(readFileSync(mapPath, "utf8"));
    const data = await convert({
      ast: parseAstAsync(code),
      code,
      wrapperLength: 0,
      coverage: {
        scriptId: basename,
        url: pathToFileURL(jsPath).href,
        functions: entry.functions,
      },
      sourceMap,
    });
    coverageMap.merge(data);
  }
}

mkdirSync(path.dirname(output), { recursive: true });
const context = createContext({ dir: path.dirname(output), coverageMap });
reports.create("lcovonly", { file: path.basename(output) }).execute(context);

const blocks = readFileSync(output, "utf8").split("end_of_record");
const kept = [];
for (const block of blocks) {
  const match = block.match(/^SF:(.+)$/m);
  if (!match) continue;
  const file = match[1].trim().replace(/^(\.\.\/)+/, "");
  if (!file.startsWith("xwing/frontend/src/")) continue;
  kept.push(block.replace(/^SF:.+$/m, `SF:${file}`));
}
writeFileSync(output, kept.map(block => `${block.trimEnd()}\nend_of_record\n`).join(""));
writeFileSync(`${output}.json`, JSON.stringify(coverageMap.toJSON()));
