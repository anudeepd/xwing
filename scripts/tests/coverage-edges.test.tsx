import { act, createElement } from "../../xwing/frontend/node_modules/react";
import { createRoot } from "../../xwing/frontend/node_modules/react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthOverlay } from "../../xwing/frontend/src/auth-overlay";
import { trapFocus } from "../../xwing/frontend/src/focus-trap";
import { escapeHtml, formatBytes, formatDate, prefersReducedMotion } from "../../xwing/frontend/src/format";
import { nearestSurvivor, selectionRange } from "../../xwing/frontend/src/selection";
import {
  AUTH_ACTIVITY_EVENT,
  beginAuthRedirect,
  consumeHandover,
  createAuthSession,
  currentAuthRedirectTarget,
  dismissBootCard,
  isLoginResponseUrl,
  loginUrlForCurrentPage,
  markHandover,
  noteAuthActivity,
  redirectToLoginNow,
  resetAuthActivityForTests,
  startAuthActivityHeartbeat,
  startAuthIdleTimer,
} from "../../xwing/frontend/src/shared.js";
import { nextSort, normalizeSortPreference, sortFiles } from "../../xwing/frontend/src/sort";
import { Tooltip } from "../../xwing/frontend/src/tooltip";
import { encodePath, parseBootstrap } from "../../xwing/frontend/src/types";
import type { XwingBootstrapV1, XwingFile } from "../../xwing/frontend/src/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bootstrap: XwingBootstrapV1 = {
  version: 1,
  path: "/",
  breadcrumbs: [{ name: "Home", path: "/" }],
  user: { name: "alice", authenticated: true },
  permissions: { read: true, write: true, delete: true },
  files: [],
  upload: { chunkSize: 1024, parallelDefault: 4 },
};

const file = (
  name: string,
  options: Partial<XwingFile> = {},
): XwingFile => ({
  name,
  path: `/${name}`,
  kind: "file",
  size: 1,
  modified: "2026-01-01",
  editable: true,
  ...options,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("shared value formatting", () => {
  it("formats bytes across every unit boundary and keeps whole bytes integral", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
  });

  it("formats a date and escapes markup", () => {
    expect(formatDate("2026-08-01T12:00:00Z")).toMatch(/2026/);
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("reads the reduced-motion preference from the media query", () => {
    window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(true);
    window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("directory response parsing", () => {
  it("accepts a complete response", () => {
    expect(parseBootstrap(bootstrap)).toBe(bootstrap);
  });

  it("rejects every malformed top-level shape", () => {
    expect(() => parseBootstrap(null)).toThrow("Unsupported");
    expect(() => parseBootstrap([])).toThrow("Unsupported");
    expect(() => parseBootstrap({ ...bootstrap, version: 2 })).toThrow("Unsupported");
    expect(() => parseBootstrap({ ...bootstrap, path: 1 })).toThrow("Unsupported");
    expect(() => parseBootstrap({ ...bootstrap, breadcrumbs: null })).toThrow("Invalid X-wing directory response");
    expect(() => parseBootstrap({ ...bootstrap, files: null })).toThrow("Invalid X-wing directory response");
    expect(() => parseBootstrap({ ...bootstrap, user: null })).toThrow("Invalid X-wing directory response");
    expect(() => parseBootstrap({ ...bootstrap, permissions: null })).toThrow("Invalid X-wing directory response");
    expect(() => parseBootstrap({ ...bootstrap, upload: null })).toThrow("Invalid X-wing directory response");
  });

  it("rejects malformed file entries", () => {
    expect(() => parseBootstrap({ ...bootstrap, files: [null] })).toThrow("Invalid file entry");
    expect(() => parseBootstrap({ ...bootstrap, files: [{ ...file("a"), name: 1 }] })).toThrow("Invalid file entry");
    expect(() => parseBootstrap({ ...bootstrap, files: [{ ...file("a"), path: 1 }] })).toThrow("Invalid file entry");
    expect(() => parseBootstrap({ ...bootstrap, files: [{ ...file("a"), kind: "link" }] })).toThrow("Invalid file entry");
    expect(() => parseBootstrap({ ...bootstrap, files: [{ ...file("a"), editable: "yes" }] })).toThrow("Invalid file entry");
  });

  it("encodes path segments while preserving a directory slash", () => {
    expect(encodePath("/")).toBe("/");
    expect(encodePath("")).toBe("/");
    expect(encodePath("/a b/")).toBe("/a%20b/");
    expect(encodePath("/a%20b/%23")).toBe("/a%20b/%23");
    expect(encodePath("a/b")).toBe("/a/b");
  });
});

describe("sort and selection edges", () => {
  it("normalizes mixed legacy, invalid and empty preferences", () => {
    expect(normalizeSortPreference("name")).toEqual([{ key: "modified", direction: "desc" }]);
    expect(normalizeSortPreference([null, 1, { key: "name" }, { key: "name", direction: "up" }])).toEqual([
      { key: "modified", direction: "desc" },
    ]);
    expect(normalizeSortPreference({ key: "mtime", dir: "asc" })).toEqual([
      { key: "modified", direction: "asc" },
    ]);
  });

  it("keeps at least one sort and removes a descending column", () => {
    expect(nextSort([], "name")).toEqual([{ key: "name", direction: "asc" }]);
    expect(nextSort([{ key: "name", direction: "desc" }], "name")).toEqual([
      { key: "name", direction: "asc" },
    ]);
    expect(nextSort([{ key: "modified", direction: "desc" }], "size")).toEqual([
      { key: "modified", direction: "desc" },
      { key: "size", direction: "asc" },
    ]);
  });

  it("sorts directories first, then every supported key in both directions", () => {
    const directory = file("dir", { kind: "directory", size: null, modified: null });
    const small = file("small", { size: 1, modified: "2026-01-01" });
    const large = file("large", { size: 2, modified: "2026-02-01" });
    expect(sortFiles([large, small, directory], [{ key: "name", direction: "asc" }]).map(item => item.name)).toEqual([
      "dir",
      "large",
      "small",
    ]);
    expect(sortFiles([large, small], [{ key: "size", direction: "desc" }]).map(item => item.name)).toEqual([
      "large",
      "small",
    ]);
    expect(sortFiles([large, small], [{ key: "modified", direction: "asc" }]).map(item => item.name)).toEqual([
      "small",
      "large",
    ]);
    expect(sortFiles([large, small], [{ key: "size", direction: "asc" }]).map(item => item.name)).toEqual([
      "small",
      "large",
    ]);
    expect(sortFiles(
      [file("same", { size: null }), file("other", { size: null })],
      [{ key: "size", direction: "desc" }],
    ).map(item => item.name)).toEqual(["other", "same"]);
  });

  it("returns the target or nothing when a range has no anchor", () => {
    const files = [{ path: "/a" }, { path: "/b" }];
    expect(selectionRange(files, null, 1)).toEqual(["/b"]);
    expect(selectionRange(files, null, 9)).toEqual([]);
    expect(selectionRange(files, "/a", 9)).toEqual(["/a", "/b"]);
    expect(nearestSurvivor(files, [])).toBeNull();
    expect(nearestSurvivor(files, ["/a", "/b"])).toBeNull();
  });
});

describe("modal focus trap", () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function () {
      return [{ width: 10, height: 10 } as DOMRect] as unknown as DOMRectList;
    });
  });

  it("moves focus inside, wraps Tab in both directions and restores the opener", () => {
    document.body.innerHTML = `
      <button id="opener">Open</button>
      <div id="root">
        <button id="first">First</button>
        <button id="auto" data-autofocus>Auto</button>
        <a id="last" href="#last">Last</a>
      </div>
    `;
    const opener = document.getElementById("opener")!;
    const root = document.getElementById("root")!;
    const first = document.getElementById("first")!;
    const auto = document.getElementById("auto")!;
    const last = document.getElementById("last")!;
    const onEscape = vi.fn();
    opener.focus();

    const teardown = trapFocus(root, { onEscape });
    expect(document.activeElement).toBe(auto);

    last.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    root.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    first.focus();
    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    root.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    root.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(onEscape).toHaveBeenCalledOnce();

    teardown();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps focus contained for an empty modal and honors shouldRestore", () => {
    document.body.innerHTML = `
      <button id="opener">Open</button>
      <div id="root"><button disabled>Disabled</button></div>
    `;
    const opener = document.getElementById("opener")!;
    const root = document.getElementById("root")!;
    opener.focus();
    const shouldRestore = vi.fn(() => false);
    const teardown = trapFocus(root, { shouldRestore });

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    root.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    (document.activeElement as HTMLElement | null)?.blur();
    teardown();
    expect(shouldRestore).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(opener);
  });
});

describe("shared session and handover helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles auth activity and keeps heartbeat activity current", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetAuthActivityForTests();
    const dispatch = vi.spyOn(window, "dispatchEvent");
    noteAuthActivity(window);
    noteAuthActivity(window);
    expect(dispatch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1001);
    const stop = startAuthActivityHeartbeat(window, 1000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(dispatch).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not install an idle timer when the timeout is disabled", () => {
    const add = vi.spyOn(window, "addEventListener");
    const cleanup = startAuthIdleTimer({ idleTimeoutSeconds: 0, onExpire: vi.fn() });
    cleanup();
    expect(add).not.toHaveBeenCalled();
  });

  it("expires once, ignores later input and can be cleaned up", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const cleanup = startAuthIdleTimer({
      idleTimeoutSeconds: 1,
      idleGraceMs: 10,
      onExpire,
      activityEvents: ["keydown"],
    });
    vi.advanceTimersByTime(1010);
    expect(onExpire).toHaveBeenCalledOnce();
    window.dispatchEvent(new KeyboardEvent("keydown"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onExpire).toHaveBeenCalledOnce();
    cleanup();
  });

  it("extends the deadline on activity and detects an overdue page wake", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    startAuthIdleTimer({
      idleTimeoutSeconds: 1,
      idleGraceMs: 0,
      onExpire,
      activityEvents: ["keydown"],
    });
    vi.advanceTimersByTime(900);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    vi.advanceTimersByTime(900);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("pageshow"));
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("expires on the first event that arrives after the deadline", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    startAuthIdleTimer({
      idleTimeoutSeconds: 1,
      idleGraceMs: 0,
      onExpire,
      activityEvents: ["keydown"],
    });
    vi.setSystemTime(Date.now() + 5000);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("dismisses a missing or immediate boot card", () => {
    dismissBootCard(document, window);
    document.body.innerHTML = `<div role="region" aria-label="Loading"><div class="boot-loading">One</div></div>`;
    dismissBootCard(document, window, true);
    expect(document.querySelector('[role="region"]')).toBeNull();

    document.body.innerHTML = `<div class="boot-loading">Two</div>`;
    dismissBootCard(document, window, true);
    expect(document.querySelector(".boot-loading")).toBeNull();
  });

  it("lets a normal boot card fade before removing its region or itself", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div role="region" aria-label="Loading"><div class="boot-loading">One</div></div>`;
    dismissBootCard(document, window);
    expect(document.querySelector(".boot-loading")?.classList.contains("out")).toBe(true);
    vi.advanceTimersByTime(240);
    expect(document.querySelector('[role="region"]')).toBeNull();

    document.body.innerHTML = `<div class="boot-loading">Two</div>`;
    dismissBootCard(document, window);
    vi.advanceTimersByTime(240);
    expect(document.querySelector(".boot-loading")).toBeNull();
  });

  it("survives denied session storage and builds login targets", () => {
    const denied = {
      sessionStorage: {
        setItem: () => { throw new Error("denied"); },
        getItem: () => { throw new Error("denied"); },
      },
    };
    expect(() => markHandover(denied as unknown as Window)).not.toThrow();
    expect(consumeHandover(denied as unknown as Window)).toBe(false);
    expect(currentAuthRedirectTarget({ pathname: "", search: "?q", hash: "#x" } as Location)).toBe("/?q#x");
    expect(loginUrlForCurrentPage({ pathname: "/a b", search: "?q=1", hash: "#x" } as Location)).toBe(
      "/_auth/login?redirect=%2Fa%20b%3Fq%3D1%23x",
    );
    expect(isLoginResponseUrl("")).toBe(false);
    expect(isLoginResponseUrl("http://[")).toBe(false);
    expect(isLoginResponseUrl("https://xwing.test/_auth/login?x=1")).toBe(true);

    const assign = vi.fn();
    redirectToLoginNow({
      location: { pathname: "/private", search: "?q=1", hash: "", href: "", assign },
    } as unknown as Window);
    expect(assign).toHaveBeenCalledWith("/_auth/login?redirect=%2Fprivate%3Fq%3D1");
  });

  it("shows the DOM overlay for an auth challenge and only redirects once", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="auth-overlay" hidden>
        <h2 id="auth-overlay-title"></h2>
        <p id="auth-overlay-message"></p>
        <button id="auth-overlay-action"></button>
      </div>
    `;
    const assign = vi.fn();
    const windowRef = {
      location: { pathname: "/private", search: "", hash: "", href: "", assign },
      setTimeout: vi.fn((callback: () => void) => { callback(); return 1; }),
      clearTimeout: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    const session = createAuthSession({
      windowRef: windowRef as unknown as Window,
      fetchRef: vi.fn(async () => ({ status: 401, url: "" })) as unknown as typeof fetch,
    });
    await expect(session.authFetch("/private")).rejects.toThrow("authentication required");
    expect(document.getElementById("auth-overlay")?.hidden).toBe(false);
    expect(document.getElementById("auth-overlay-title")?.textContent).toBe("Session expired");
    expect(assign).toHaveBeenCalledTimes(1);
    document.getElementById("auth-overlay-action")!.click();
    expect(assign).toHaveBeenCalledTimes(2);
    session.redirectToLogin();
    expect(assign).toHaveBeenCalledTimes(2);
    expect(session.isRedirecting()).toBe(true);
  });

  it("wires logout once and exposes a no-op overlay path", () => {
    document.body.innerHTML = `
      <form id="logout-form"></form>
      <div id="auth-overlay" hidden><button id="auth-overlay-action"></button></div>
    `;
    const form = document.getElementById("logout-form") as HTMLFormElement;
    const submit = vi.fn();
    form.submit = submit;
    const windowRef = {
      location: { pathname: "/", search: "", hash: "", href: "", assign: vi.fn() },
      setTimeout: vi.fn((callback: () => void) => { callback(); return 1; }),
      clearTimeout: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    const session = createAuthSession({ windowRef: windowRef as unknown as Window });
    session.wireLogoutForm();
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(submit).toHaveBeenCalledOnce();
    expect(document.getElementById("auth-overlay")?.hidden).toBe(false);
    expect(document.getElementById("auth-overlay-action")?.hidden).toBe(true);

    document.body.innerHTML = "";
    const empty = createAuthSession({ windowRef: windowRef as unknown as Window });
    expect(() => empty.wireLogoutForm()).not.toThrow();
    empty.showAuthOverlay({ title: "x", message: "y", action: "" });
    expect(empty.isRedirecting()).toBe(false);
  });

  it("dispatches the React redirect event once", () => {
    vi.useFakeTimers();
    const dispatch = vi.spyOn(window, "dispatchEvent");
    beginAuthRedirect(1);
    beginAuthRedirect(1);
    expect(dispatch.mock.calls.filter(([event]) => event.type === "xwing:auth-redirect")).toHaveLength(1);
  });
});

describe("tooltip and auth overlay", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  });

  it("positions a top and bottom hint, follows the viewport and dismisses with Escape", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async (side: "top" | "bottom") => {
      await act(async () => {
        root.render(createElement(Tooltip, { label: "Hint", side }, createElement("button", null, "Open")));
      });
    };
    await render("top");
    const anchor = container.querySelector(".inline-flex") as HTMLElement;
    anchor.getBoundingClientRect = () => ({ left: 100, top: 100, width: 20, height: 20, right: 120, bottom: 120, x: 100, y: 100, toJSON() {} });
    const button = container.querySelector("button")!;
    await act(async () => button.focus());
    const tip = document.querySelector<HTMLElement>("[role=tooltip]")!;
    Object.defineProperty(tip, "offsetWidth", { configurable: true, value: 40 });
    Object.defineProperty(tip, "offsetHeight", { configurable: true, value: 18 });
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector("[role=tooltip]")).toBeNull();

    button.blur();
    await render("bottom");
    const bottomAnchor = container.querySelector(".inline-flex") as HTMLElement;
    bottomAnchor.getBoundingClientRect = () => ({ left: 100, top: 100, width: 20, height: 20, right: 120, bottom: 120, x: 100, y: 100, toJSON() {} });
    await act(async () => container.querySelector("button")!.focus());
    expect(document.querySelector("[role=tooltip]")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("renders the expired action and the logout message without an action", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(AuthOverlay, { kind: "expired" })));
    expect(container.textContent).toContain("Session expired");
    expect(container.querySelector("button")?.textContent).toBe("Sign in now");

    await act(async () => root.render(createElement(AuthOverlay, { kind: "logout" })));
    expect(container.textContent).toContain("Signing out");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  });
});
