import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { consumeHandover, createAuthSession, dismissBootCard, loginUrlForCurrentPage, markHandover } from "../../xwing/frontend/src/shared.js";

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

describe("cross-panel handover", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    document.body.innerHTML = `
      <div role="region" aria-label="Loading">
        <div class="boot-loading">Opening admin console…</div>
      </div>
    `;
  });

  it("hands the marker over exactly once", () => {
    expect(consumeHandover(window)).toBe(false);

    markHandover(window);

    expect(consumeHandover(window)).toBe(true);
    // A second read belongs to a later, unrelated document.
    expect(consumeHandover(window)).toBe(false);
  });

  it("ignores a marker old enough to be a cold load", () => {
    markHandover(window);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6_000);

    expect(consumeHandover(window)).toBe(false);
    vi.useRealTimers();
  });

  it("tears the boot card out for a handover and cross-fades it otherwise", () => {
    dismissBootCard(document, window, true);
    expect(document.querySelector(".boot-loading")).toBeNull();
    expect(document.querySelector('[role="region"][aria-label="Loading"]')).toBeNull();

    document.body.innerHTML = `
      <div role="region" aria-label="Loading">
        <div class="boot-loading">Opening X-wing…</div>
      </div>
    `;
    dismissBootCard(document, window);
    // The cold path keeps the card in the DOM and lets it fade under the shell.
    expect(document.querySelector(".boot-loading")?.classList.contains("out")).toBe(true);
    expect(document.querySelector(".boot-loading")).not.toBeNull();
  });
});

describe("responsive file browser styles", () => {
  it("keeps the live breakpoints for the file browser", () => {
    const stylesheet = readFileSync("../xwing/frontend/src/style.css", "utf8");
    const app = readFileSync("../xwing/frontend/src/app.tsx", "utf8");

    // The legacy 700px toolbar block was deleted with the rest of the dead CSS;
    // the live layout collapses at 900px and 640px and the e2e suite asserts the
    // rendered result (no horizontal overflow at 375px). The 900px collapse
    // lives in Tailwind `max-[900px]:` utilities in the markup (there is no
    // hand-written 900px block left in the stylesheet by design).
    expect(app).toContain("max-[900px]");
    expect(stylesheet).toContain("@media(max-width:640px)");
  });
});
