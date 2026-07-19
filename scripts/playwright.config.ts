import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 20_000,
  expect: { timeout: 5_000, toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.01 } },
  fullyParallel: true,
  forbidOnly: true,
  use: { baseURL: "http://127.0.0.1:8990", colorScheme: "dark", reducedMotion: "reduce", trace: "retain-on-failure" },
  webServer: {
    command: "uv run xwing serve --root e2e/fixtures --port 8990 --no-open --users-config e2e/users.yaml",
    url: "http://127.0.0.1:8990/",
    reuseExistingServer: false,
    timeout: 20_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
