import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 20_000,
  expect: { timeout: 5_000, toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.01 } },
  fullyParallel: true,
  forbidOnly: true,
  // `reducedMotion` is a context option, not a top-level `use` key: spelled at
  // the top level it is ignored without a warning, and then every presence
  // animation runs — which stalls whenever the headless page stops painting
  // frames, leaving elements that should have gone.
  use: { baseURL: "http://127.0.0.1:8990", colorScheme: "dark", contextOptions: { reducedMotion: "reduce" }, trace: "retain-on-failure" },
  webServer: [
    {
      command: "uv run xwing serve --root e2e/fixtures --port 8990 --no-open --users-config e2e/users.yaml",
      url: "http://127.0.0.1:8990/",
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      // Read-only permissions and an oversized file, so the read-only and
      // truncated-preview paths get a real browser instead of a source check.
      command:
        "node e2e/prepare-roots.mjs && uv run xwing serve --root .e2e-limited --port 8991 --no-open --users-config e2e/users-readonly.yaml",
      url: "http://127.0.0.1:8991/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The admin console. It only answers behind LDAPGate, so this one runs with
      // the trusted-proxy header mode and an admin user; the specs that use it
      // send the matching `X-Forwarded-User` header.
      command:
        "uv run xwing serve --root e2e/fixtures --port 8993 --no-open --users-config e2e/users.yaml --require-auth --trusted-auth-proxy 127.0.0.1 --admin-user e2e-admin",
      url: "http://127.0.0.1:8993/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // A writable root of its own for the rename tests. They create and remove
      // real files, and e2e/fixtures is shared with the tests that assert on
      // that listing's row order, selection counts and snapshots.
      command:
        "node e2e/prepare-roots.mjs && uv run xwing serve --root .e2e-rename --port 8992 --no-open --users-config e2e/users-full.yaml",
      url: "http://127.0.0.1:8992/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
