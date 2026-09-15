import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthSession,
  currentAuthRedirectTarget,
  isLoginResponseUrl,
  loginUrlForCurrentPage,
} from "../../xwing/frontend/src/shared.js";

/** A window stand-in that records redirects and timer scheduling. */
function fakeWindow(href = "http://files.example/releases/?sort=name#top") {
  const location = { href, pathname: "", search: "", hash: "", assign: vi.fn() };
  const url = new URL(href);
  location.pathname = url.pathname;
  location.search = url.search;
  location.hash = url.hash;
  return {
    location,
    setTimeout: vi.fn((callback: () => void) => {
      callback();
      return 1 as unknown as number;
    }),
    // The module clears the timer it re-armed; a no-op here would let the
    // stale timer fire and look like an idle timeout.
    clearTimeout: ((handle: number) => globalThis.clearTimeout(handle)) as unknown as typeof clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function overlayDocument() {
  document.body.innerHTML = `
    <div id="auth-overlay" hidden>
      <h2 id="auth-overlay-title"></h2>
      <p id="auth-overlay-message"></p>
    </div>
    <form id="logout-form" method="post" action="/_auth/logout"></form>
  `;
  return document;
}

function response({ status = 200, url = "http://files.example/" } = {}) {
  return { status, url } as Response;
}

beforeEach(() => {
  overlayDocument();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("login redirect targets", () => {
  it("keeps the current path, query and fragment", () => {
    const location = fakeWindow().location;
    expect(currentAuthRedirectTarget(location)).toBe("/releases/?sort=name#top");
    expect(loginUrlForCurrentPage(location)).toBe(
      "/_auth/login?redirect=%2Freleases%2F%3Fsort%3Dname%23top",
    );
  });

  it("recognises a response that landed on the login page", () => {
    expect(isLoginResponseUrl("http://files.example/_auth/login", "http://files.example/")).toBe(
      true,
    );
    expect(isLoginResponseUrl("http://files.example/_auth/login?redirect=%2F", "http://files.example/")).toBe(true);
    expect(isLoginResponseUrl("http://files.example/releases/", "http://files.example/")).toBe(
      false,
    );
    expect(isLoginResponseUrl(undefined, "http://files.example/")).toBe(false);
    expect(isLoginResponseUrl("not a url", "http://files.example/")).toBe(false);
  });
});

describe("authFetch", () => {
  it("returns an authorised response untouched", async () => {
    const fetchRef = vi.fn(async () => response());
    const windowRef = fakeWindow();
    const session = createAuthSession({ fetchRef, windowRef, documentRef: overlayDocument() });

    await expect(session.authFetch("/api/thing")).resolves.toMatchObject({ status: 200 });
    expect(windowRef.location.assign).not.toHaveBeenCalled();
    expect(session.isRedirecting()).toBe(false);
  });

  it("shows the expiry overlay and redirects to sign in on 401", async () => {
    const fetchRef = vi.fn(async () => response({ status: 401 }));
    const windowRef = fakeWindow();
    const session = createAuthSession({ fetchRef, windowRef, documentRef: overlayDocument() });

    await expect(session.authFetch("/api/thing")).rejects.toThrow("authentication required");

    expect(document.getElementById("auth-overlay")!.hidden).toBe(false);
    expect(document.getElementById("auth-overlay-title")!.textContent).toBe("Session expired");
    expect(windowRef.location.assign).toHaveBeenCalledWith(
      "/_auth/login?redirect=%2Freleases%2F%3Fsort%3Dname%23top",
    );
  });

  it("treats a followed login redirect as a challenge", async () => {
    const fetchRef = vi.fn(async () => response({ url: "http://files.example/_auth/login" }));
    const windowRef = fakeWindow();
    const session = createAuthSession({ fetchRef, windowRef, documentRef: overlayDocument() });

    await expect(session.authFetch("/api/thing")).rejects.toThrow("authentication required");
    expect(session.isRedirecting()).toBe(true);
  });

  it("redirects once, however many requests fail", async () => {
    const fetchRef = vi.fn(async () => response({ status: 401 }));
    const windowRef = fakeWindow();
    const session = createAuthSession({ fetchRef, windowRef, documentRef: overlayDocument() });

    await session.authFetch("/a").catch(() => undefined);
    await session.authFetch("/b").catch(() => undefined);

    expect(windowRef.location.assign).toHaveBeenCalledTimes(1);
  });
});

describe("logout form", () => {
  it("announces the sign-out before the form posts", () => {
    const windowRef = fakeWindow();
    const session = createAuthSession({ windowRef, documentRef: overlayDocument() });
    const form = document.getElementById("logout-form") as HTMLFormElement;
    const submitted = vi.fn();
    form.submit = submitted;
    session.wireLogoutForm();

    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    expect(document.getElementById("auth-overlay")!.hidden).toBe(false);
    expect(document.getElementById("auth-overlay-title")!.textContent).toBe("Signing out");
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("ignores a second submit while signing out", () => {
    const windowRef = fakeWindow();
    const session = createAuthSession({ windowRef, documentRef: overlayDocument() });
    const form = document.getElementById("logout-form") as HTMLFormElement;
    const submitted = vi.fn();
    form.submit = submitted;
    session.wireLogoutForm();

    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    expect(submitted).toHaveBeenCalledTimes(1);
  });
});

describe("idle timeout", () => {
  it("redirects once the idle window passes without activity", () => {
    vi.useFakeTimers();
    const windowRef = fakeWindow();
    const listeners = new Map<string, () => void>();
    windowRef.addEventListener = vi.fn((name: string, handler: () => void) => {
      listeners.set(name, handler);
    });
    windowRef.setTimeout = ((callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay)) as unknown as typeof windowRef.setTimeout;

    const session = createAuthSession({
      windowRef,
      documentRef: overlayDocument(),
      idleTimeoutSeconds: 5,
      idleGraceMs: 0,
    });
    session.wireAuthIdleTimer();

    vi.advanceTimersByTime(5000);

    expect(document.getElementById("auth-overlay-title")!.textContent).toBe("Session expired");
    vi.useRealTimers();
  });

  it("keeps a session alive while the user keeps interacting", () => {
    vi.useFakeTimers();
    const windowRef = fakeWindow();
    windowRef.setTimeout = ((callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay)) as unknown as typeof windowRef.setTimeout;
    const session = createAuthSession({
      windowRef,
      documentRef: overlayDocument(),
      idleTimeoutSeconds: 5,
      idleGraceMs: 0,
    });
    session.wireAuthIdleTimer();

    const activity = windowRef.addEventListener.mock.calls.find(
      call => call[0] === "keydown",
    )?.[1] as () => void;
    for (let step = 0; step < 4; step += 1) {
      vi.advanceTimersByTime(4000);
      activity();
    }

    expect(session.isRedirecting()).toBe(false);
    vi.useRealTimers();
  });
});
