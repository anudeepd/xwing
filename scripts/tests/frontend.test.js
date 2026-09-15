import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { createAuthSession, loginUrlForCurrentPage } from "../../xwing/frontend/src/shared.js";

describe("shared auth helpers", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="auth-overlay" hidden>
        <h2 id="auth-overlay-title"></h2>
        <p id="auth-overlay-message"></p>
      </div>
    `;
  });

  it("builds a login redirect for the current page", () => {
    const url = loginUrlForCurrentPage({
      pathname: "/folder/file.txt",
      search: "?edit",
      hash: "#line-4",
    });

    expect(url).toBe("/_auth/login?redirect=%2Ffolder%2Ffile.txt%3Fedit%23line-4");
  });

  it("shows the auth overlay and redirects on auth challenges", async () => {
    const assign = vi.fn();
    const session = createAuthSession({
      documentRef: document,
      fetchRef: vi.fn(async () => ({ status: 401, url: "http://xwing.local/private" })),
      windowRef: {
        location: {
          pathname: "/private",
          search: "",
          hash: "",
          href: "http://xwing.local/private",
          assign,
        },
        setTimeout: fn => fn(),
        clearTimeout: vi.fn(),
        addEventListener: vi.fn(),
      },
    });

    await expect(session.authFetch("/private")).rejects.toThrow("authentication required");
    expect(document.getElementById("auth-overlay").hidden).toBe(false);
    expect(document.getElementById("auth-overlay-title").textContent).toBe("Session expired");
    expect(assign).toHaveBeenCalledWith("/_auth/login?redirect=%2Fprivate");
  });

  it("expires instead of resetting when background timer delivery is delayed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createAuthSession({
      documentRef: document,
      windowRef: window,
      idleTimeoutSeconds: 2,
      redirectDelayMs: 10_000,
    });

    const cleanup = session.wireAuthIdleTimer();
    vi.setSystemTime(3_001);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A" }));

    expect(session.isRedirecting()).toBe(true);
    cleanup();
    vi.useRealTimers();
  });

  it("checks an overdue auth deadline as soon as the page regains focus", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createAuthSession({
      documentRef: document,
      windowRef: window,
      idleTimeoutSeconds: 2,
      redirectDelayMs: 10_000,
    });

    const cleanup = session.wireAuthIdleTimer();
    vi.setSystemTime(3_001);
    window.dispatchEvent(new Event("focus"));

    expect(session.isRedirecting()).toBe(true);
    cleanup();
    vi.useRealTimers();
  });
});

describe("responsive file browser styles", () => {
  it("wraps every toolbar group on narrow viewports", () => {
    const stylesheet = readFileSync("../xwing/frontend/src/style.css", "utf8");

    expect(stylesheet).toContain("@media (max-width: 700px)");
    expect(stylesheet).toContain(`.toolbar-primary,
  .toolbar-selection,
  .toolbar-meta {
    flex: 1 1 100%;
    flex-wrap: wrap;
  }`);
  });
});
