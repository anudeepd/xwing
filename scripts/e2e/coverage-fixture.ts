import { test as base, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const enabled = process.env.XWING_E2E_COVERAGE === "1";
const outputDir = path.resolve(process.cwd(), "coverage-e2e", "raw");

export const test = base.extend({
  page: async ({ page, browserName }, use, testInfo) => {
    if (!enabled || browserName !== "chromium") {
      await use(page);
      return;
    }

    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    try {
      await use(page);
    } finally {
      try {
        const entries = await page.coverage.stopJSCoverage();
        mkdirSync(outputDir, { recursive: true });
        const id = `${testInfo.workerIndex}-${testInfo.testId}`.replace(
          /[^a-z0-9_-]/gi,
          "_",
        );
        writeFileSync(
          path.join(outputDir, `${id}.json`),
          JSON.stringify(
            entries.map(({ url, functions }) => ({ url, functions })),
          ),
        );
      } catch {
        // A failed test can close its page before the fixture stops coverage.
      }
    }
  },
});

export { expect };
