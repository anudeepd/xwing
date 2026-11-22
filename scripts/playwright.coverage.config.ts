import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

import baseConfig from "./playwright.config";

const executablePath = process.env.XWING_CHROMIUM_EXECUTABLE;

export default defineConfig({
  ...baseConfig,
  outputDir: path.join(tmpdir(), "xwing-playwright-results"),
  testIgnore: ["**/login-reveal.spec.ts"],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(executablePath
          ? { launchOptions: { executablePath } }
          : { channel: "chromium" }),
      },
    },
  ],
});
