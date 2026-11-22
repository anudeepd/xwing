import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = [
  { name: "docs", path: "/docs/", kind: "directory", size: null, modified: "2026-08-01T10:00:00Z", editable: false },
  { name: "other", path: "/other/", kind: "directory", size: null, modified: "2026-08-01T10:30:00Z", editable: false },
  { name: "alpha.txt", path: "/alpha.txt", kind: "file", size: 1024, modified: "2026-08-01T11:00:00Z", editable: true },
  { name: "beta.txt", path: "/beta.txt", kind: "file", size: null, modified: null, editable: false },
];

const bootstrap = {
  version: 1,
  path: "/",
  breadcrumbs: [{ name: "Home", path: "/" }],
  user: { name: "alice", authenticated: true },
  admin: true,
  permissions: { read: true, write: true, delete: true },
  files,
  upload: { chunkSize: 1024, parallelDefault: 4 },
};

function response(body, status = 200, url = "http://xwing.test/") {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ "content-type": typeof body === "string" ? "text/plain" : "application/json" }),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    blob: async () => new Blob([typeof body === "string" ? body : JSON.stringify(body)]),
  };
}

function directoryResponse(body) {
  const value = response(body);
  value.headers = new Headers({ "content-type": "application/vnd.xwing.directory+json" });
  return value;
}

class UploadXHR {
  static all = [];
  upload = {
    addEventListener: (type, handler) => {
      this.uploadHandlers ??= {};
      this.uploadHandlers[type] = handler;
    },
  };
  listeners = {};
  aborted = false;
  constructor() {
    UploadXHR.all.push(this);
  }
  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
  removeEventListener() {}
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  abort() {
    this.aborted = true;
    queueMicrotask(() => this.listeners.abort?.());
  }
  send(blob) {
    this.uploadHandlers.loadstart?.();
    const start = Number(new URL(this.url, "http://xwing.test").searchParams.get("offset"));
    const end = start + blob.size;
    queueMicrotask(() => {
      this.uploadHandlers.progress?.({ loaded: blob.size, total: blob.size });
      this.uploadHandlers.load?.();
      this.status = 200;
      this.responseText = JSON.stringify({ ranges: [[0, end]], received: blob.size });
      this.listeners.load?.();
    });
  }
}

function installFetch(overrides = {}) {
  const calls = [];
  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input), "http://xwing.test");
    const method = init.method || "GET";
    const key = `${method} ${url.pathname}${url.search}`;
    calls.push(key);
    let override = overrides[key] ?? overrides[`${method} ${url.pathname}`];
    if (typeof override === "function") override = override();
    if (override instanceof Promise) override = await override;
    if (override) {
      if (override instanceof Error || typeof override === "string") throw override;
      if (override instanceof Response) return override;
      if (typeof override === "object" && "ok" in override) return override;
      return response(override.body ?? override, override.status ?? 200, `${url.origin}${url.pathname}`);
    }
    if (method === "GET" && (init.headers?.Accept ?? init.headers?.accept)?.includes("application/vnd.xwing.directory+json")) {
      const directoryResponse = url.pathname === "/docs/"
        ? response({ ...bootstrap, path: "/docs/", breadcrumbs: [...bootstrap.breadcrumbs, { name: "docs", path: "/docs/" }], files: [] })
        : response(bootstrap);
      directoryResponse.headers = new Headers({ "content-type": "application/vnd.xwing.directory+json" });
      return directoryResponse;
    }
    if (method === "MKCOL") return response({}, 201);
    if (method === "MOVE") return response({}, 201);
    if (method === "DELETE") return response({ transaction_id: "tx-delete" });
    if (method === "POST" && url.pathname === "/_bulk/delete") return response({ transaction_id: "tx-bulk" });
    if (method === "POST" && url.pathname.startsWith("/api/restore/")) return response({ restored: 1 });
    if (method === "POST" && url.pathname === "/_bulk/zip") return response("PK\u0003\u0004zip");
    if (method === "POST" && url.pathname === "/_auth/logout") return response("", 204);
    return response({ detail: `Unhandled ${key}` }, 500, `${url.origin}${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function waitFor(assertion) {
  await vi.waitFor(assertion);
}

function click(element) {
  element.click();
}

function key(target, key, options = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

function setInputValue(input, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function confirmModal() {
  return document.querySelectorAll(".modal .modal-actions button")[1];
}

async function mount({
  overrides = {},
  data = {},
  reduced = true,
  bootstrapData = bootstrap,
  bootstrapJson = null,
  sortValue = null,
} = {}) {
  vi.resetModules();
  window.__xwingAppRoot?.unmount();
  window.__xwingAppRoot = undefined;
  window.history.replaceState(null, "", "/");
  document.body.dataset.authIdleTimeout = "0";
  document.body.dataset.auth = data.auth ?? "";
  document.documentElement.style.cssText = "";
  document.body.innerHTML = `
    <div id="xwing-root"></div>
    <div id="auth-overlay" hidden>
      <h2 id="auth-overlay-title"></h2>
      <p id="auth-overlay-message"></p>
      <button id="auth-overlay-action"></button>
    </div>
    <form id="logout-form" method="post" action="/_auth/logout"></form>
    <script id="xwing-bootstrap" type="application/json">${bootstrapJson ?? JSON.stringify(bootstrapData)}</script>
  `;
  window.matchMedia = () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => sortValue),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = callback => {
    const handle = setTimeout(() => callback(Date.now()), 0);
    return handle;
  };
  globalThis.cancelAnimationFrame = handle => clearTimeout(handle);
  const calls = installFetch(overrides);
  await import("../../xwing/frontend/src/app.tsx?app-coverage");
  await waitFor(() => expect(document.querySelector(".xw-app")).not.toBeNull());
  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  window.__xwingAppRoot?.unmount();
  window.__xwingAppRoot = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("file browser coverage edges", () => {
  it("owns menus, filters, sorting and the account trigger", async () => {
    await mount();

    click(document.querySelector(".parallel-trigger"));
    await waitFor(() => expect(document.querySelector("#parallel-menu")).not.toBeNull());
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await waitFor(() => expect(document.querySelector("#parallel-menu")).toBeNull());
    click(document.querySelector(".parallel-trigger"));
    await waitFor(() => expect(document.querySelector("#parallel-menu")).not.toBeNull());
    key(document, "Escape");
    await waitFor(() => expect(document.querySelector("#parallel-menu")).toBeNull());

    click(document.querySelector(".account-trigger"));
    await waitFor(() => expect(document.querySelector("#account-menu")).not.toBeNull());
    key(document, "Escape");
    await waitFor(() => expect(document.querySelector("#account-menu")).toBeNull());
    click(document.querySelector(".account-trigger"));
    await waitFor(() => expect(document.querySelector("#account-menu")).not.toBeNull());
    const adminLink = document.querySelector('#account-menu a[href="/admin"]');
    adminLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    click(adminLink);
    await waitFor(() => expect(document.querySelector(".xw-app")).not.toBeNull());

    const filter = document.querySelector('[aria-label="Filter files by name"]');
    setInputValue(filter, "alp");
    await waitFor(() => expect(document.querySelector(".file-row")?.textContent).toContain("alpha.txt"));
    setInputValue(filter, "");
    await waitFor(() => expect(document.querySelectorAll(".file-row")).toHaveLength(4));

    const setItem = localStorage.setItem;
    setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    click([...document.querySelectorAll(".sort")].find(button => button.textContent.startsWith("Name")));
    await waitFor(() => expect(setItem).toHaveBeenCalled());
    click([...document.querySelectorAll(".sort")].find(button => button.textContent.startsWith("Name")));
    click([...document.querySelectorAll(".sort")].find(button => button.textContent.startsWith("Size")));
    click([...document.querySelectorAll(".sort")].find(button => button.textContent.startsWith("Modified")));

    click(document.querySelector(".xw-app .brand"));
    document.querySelector(".xw-app #logout-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".auth-overlay")?.textContent).toContain("Signing out"));
  });

  it("selects rows, handles every row key and drives the action menu", async () => {
    await mount();
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    const beta = document.querySelector('[data-path="/beta.txt"]');
    const docs = document.querySelector('[data-path="/docs/"]');
    alpha.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));

    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    beta.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("2 selected"));
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    beta.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("2 selected"));
    beta.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector(".selection-actions .button.ghost"));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));

    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    key(document.body, "Escape");
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    key(document.body, "Delete");
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    const filter = document.querySelector('[aria-label="Filter files by name"]');
    filter.focus();
    key(filter, "Delete");
    expect(document.querySelector(".modal")).toBeNull();

    alpha.focus();
    key(alpha, "ContextMenu");
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    const menu = document.querySelector("#row-actions-menu");
    key(menu, "ArrowDown");
    key(menu, "ArrowUp");
    key(menu, "Home");
    key(menu, "End");
    key(menu, "Escape");
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());

    alpha.focus();
    key(alpha, "ArrowDown");
    expect(document.activeElement).toBe(beta);
    key(beta, "ArrowUp");
    expect(document.activeElement).toBe(alpha);
    key(alpha, "End");
    expect(document.activeElement).toBe(beta);
    key(beta, "Home");
    expect(document.activeElement).toBe(document.querySelectorAll(".file-row")[0]);
    key(alpha, " ", { repeat: true });
    expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected");
    key(alpha, " ");
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    key(alpha, " ");
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
    key(alpha, "Escape");

    key(alpha, "F2");
    await waitFor(() => expect(document.querySelector(".modal")?.textContent).toContain("Rename alpha.txt"));
    key(document.querySelector(".modal input"), "Escape");
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    alpha.focus();
    alpha.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1100, clientY: 600 }));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    const table = document.querySelector(".file-table");
    table.scrollTop = 20;
    table.dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());

    alpha.focus();
    click(document.querySelector('[aria-label="Actions for alpha.txt"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    window.dispatchEvent(new Event("resize"));
    key(document.querySelector("#row-actions-menu"), "Tab");
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());

    docs.focus();
    key(docs, "Enter");
    await waitFor(() => expect(window.location.pathname).toBe("/docs/"));
    await waitFor(() => expect(document.querySelector(".file-row")).toBeNull());
    window.history.pushState({}, "", "/?q=alp");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(window.location.search).toBe("?q=alp"));
    await waitFor(() => expect(document.querySelectorAll(".file-row")).toHaveLength(1));
  });

  it("handles global and file-surface selection shortcuts", async () => {
    await mount();
    let alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    await new Promise(resolve => setTimeout(resolve, 30));
    key(document.body, "Escape");
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));

    await mount();
    alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    await new Promise(resolve => setTimeout(resolve, 30));
    key(document.body, "Delete");
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    await mount();
    alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    key(document.querySelector(".file-surface"), "Delete");
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    await mount();
    alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    key(document.querySelector(".file-surface"), "Escape");
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
  });

  it("creates, renames and deletes through every error path", async () => {
    let mkdirCalls = 0;
    let moveCalls = 0;
    let deleteCalls = 0;
    let restoreCalls = 0;
    const overrides = {
      "MKCOL /newdir/": () => {
        mkdirCalls += 1;
        if (mkdirCalls === 1) throw new Error("offline");
        if (mkdirCalls === 2) return { status: 500, body: { detail: "mkdir failed" } };
        return { status: 201, body: {} };
      },
      "MOVE /alpha.txt": () => {
        moveCalls += 1;
        if (moveCalls === 1) throw new Error("move offline");
        if (moveCalls === 2) return { status: 409, body: {} };
        return { status: 201, body: {} };
      },
      "DELETE /alpha.txt": () => {
        deleteCalls += 1;
        if (deleteCalls === 1) throw new Error("delete offline");
        if (deleteCalls === 2) return { status: 500, body: { detail: "delete failed" } };
        return { status: 200, body: { transaction_id: "tx-alpha" } };
      },
      "POST /api/restore/tx-alpha": () => {
        restoreCalls += 1;
        if (restoreCalls === 1) return { status: 500, body: { detail: "restore failed" } };
        return { status: 200, body: { restored: 1 } };
      },
      "POST /_bulk/delete": () => {
        return { status: 200, body: {} };
      },
    };
    await mount({ overrides });

    click(document.querySelector('[aria-label="New folder"]'));
    await waitFor(() => expect(document.querySelector(".modal")?.textContent).toContain("New folder"));
    let input = document.querySelector(".modal input");
    setInputValue(input, "bad/name");
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal [role=alert]")?.textContent).toBe("Enter one valid folder name."));

    setInputValue(input, "newdir");
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal [role=alert]")?.textContent).toContain("offline"));
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal [role=alert]")?.textContent).toContain("mkdir failed"));
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
    await waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("Created newdir"));

    let alpha = document.querySelector('[data-path="/alpha.txt"]');
    key(alpha, "F2");
    await waitFor(() => expect(document.querySelector(".modal")?.textContent).toContain("Rename alpha.txt"));
    input = document.querySelector(".modal input");
    setInputValue(input, "");
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal [role=alert]")?.textContent).toBe("Enter one valid name."));
    setInputValue(input, "alpha.txt");
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    key(alpha, "F2");
    await waitFor(() => expect(document.querySelector(".modal")?.textContent).toContain("Rename alpha.txt"));
    input = document.querySelector(".modal input");
    setInputValue(input, "renamed.txt");
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal [role=alert]")?.textContent).toContain("move offline"));
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal [role=alert]")?.textContent).toBe("That name is already taken."));
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")?.textContent).toContain("Delete 1 item?"));
    click(confirmModal());
    document.activeElement?.blur();
    await waitFor(() => expect(document.querySelector(".modal [role=alert]")?.textContent).toContain("delete offline"));
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal [role=alert]")?.textContent).toContain("delete failed"));
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
    const undo = document.querySelector(".toast .toast-action");
    await waitFor(() => expect(undo).not.toBeNull());
    click(undo);
    await waitFor(() => expect(
      [...document.querySelectorAll(".toast")].map(toast => toast.textContent).join(" "),
    ).toContain("restore failed"));

    alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
    await waitFor(() => expect(
      [...document.querySelectorAll(".toast")].some(toast => toast.textContent.includes("1 item deleted")),
    ).toBe(true));
    click([...document.querySelectorAll(".toast")].find(toast => toast.textContent.includes("1 item deleted"))?.querySelector(".toast-action"));
    await waitFor(() => expect(
      [...document.querySelectorAll(".toast")].some(toast => toast.textContent.includes("1 item restored")),
    ).toBe(true));

    click(document.querySelector(".selection-actions .button.ghost"));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
    click(document.querySelector('[aria-label="Select all"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("4 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")?.textContent).toContain("Delete 4 items?"));
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
    await waitFor(() => expect(
      [...document.querySelectorAll(".toast")].some(toast => toast.textContent.includes("4 items deleted")),
    ).toBe(true));
    expect([...document.querySelectorAll(".toast")].find(toast => toast.textContent.includes("4 items deleted"))?.querySelector(".toast-action")).toBeNull();
  });

  it("animates navigation, handles bad responses and retries", async () => {
    let docsCalls = 0;
    let otherCalls = 0;
    const overrides = {
      "GET /docs/": () => {
        docsCalls += 1;
        if (docsCalls === 1) {
          const bad = response({ ...bootstrap, path: "/docs/", breadcrumbs: [...bootstrap.breadcrumbs, { name: "docs", path: "/docs/" }], files: [] });
          bad.headers = new Headers({ "content-type": "application/json" });
          return bad;
        }
        const ok = response({ ...bootstrap, path: "/docs/", breadcrumbs: [...bootstrap.breadcrumbs, { name: "docs", path: "/docs/" }], files: [] });
        ok.headers = new Headers({ "content-type": "application/vnd.xwing.directory+json" });
        return ok;
      },
      "GET /other/": () => {
        otherCalls += 1;
        if (otherCalls === 1) {
          const bad = response({}, 500);
          bad.json = async () => { throw new Error("not json"); };
          return bad;
        }
        const ok = response({ ...bootstrap, path: "/other/", breadcrumbs: [...bootstrap.breadcrumbs, { name: "other", path: "/other/" }], files: [] });
        ok.headers = new Headers({ "content-type": "application/vnd.xwing.directory+json" });
        return ok;
      },
    };
    await mount({ overrides, reduced: false });
    await waitFor(() => expect(document.querySelector('[data-path="/docs/"]')).not.toBeNull());
    const docs = document.querySelector('[data-path="/docs/"]');
    docs.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".state-panel")?.textContent).toContain("unexpected response"));
    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("Retry")));
    await waitFor(() => expect(document.querySelector(".state-panel")).toBeNull());

    await mount({ overrides, reduced: false });
    await waitFor(() => expect(document.querySelector('[data-path="/other/"]')).not.toBeNull());
    const other = document.querySelector('[data-path="/other/"]');
    other.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".state-panel")?.textContent).toContain("Request failed (500)"));
    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("Retry")));
    await waitFor(() => expect(document.querySelector(".state-panel")).toBeNull());
  });

  it("drives drag feedback, drop errors and file inputs", async () => {
    await mount();
    const app = document.querySelector(".xw-app");
    const fileInput = document.querySelector('input[type="file"]:not([webkitdirectory])');
    const folderInput = document.querySelector('input[webkitdirectory]');
    const fileClick = vi.spyOn(fileInput, "click");
    const folderClick = vi.spyOn(folderInput, "click");

    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("Upload files")));
    expect(fileClick).toHaveBeenCalled();
    click(document.querySelector('[aria-label="Upload folder"]'));
    expect(folderClick).toHaveBeenCalled();

    app.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
    app.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".drop-target")).not.toBeNull());
    app.dispatchEvent(new Event("dragleave", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".drop-target")).toBeNull());

    vi.useFakeTimers();
    app.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.resolve();
    expect(document.querySelector(".drop-wait")?.textContent).toContain("Preparing upload");
    app.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1500);
    window.dispatchEvent(new Event("drop"));
    app.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(document.querySelector(".drop-wait")?.textContent).toContain("hasn't started");
    click(document.querySelector(".drop-wait .button"));
    expect(fileClick).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("drop"));
    window.dispatchEvent(new Event("dragend"));
    window.dispatchEvent(new Event("blur"));
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.useRealTimers();

    const drop = (transfer) => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      app.dispatchEvent(event);
    };
    drop({ items: [], files: [] });
    await waitFor(() => expect(
      [...document.querySelectorAll(".toast")].some(toast => toast.textContent.includes("contained no files")),
    ).toBe(true));
    drop({ items: [{ kind: "file", getAsFile: () => null }], files: [] });
    await waitFor(() => expect(
      [...document.querySelectorAll(".toast")].some(toast => toast.textContent.includes("Nothing could be read")),
    ).toBe(true));
    drop({ items: [{ kind: "file", getAsFile: () => new File(["drop"], "dropped.txt") }], files: [] });
    await waitFor(() => expect(document.querySelector(".upload-dock")).not.toBeNull());

    const file = new File(["input"], "input.txt");
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("input.txt"));
    const folderFile = new File(["folder"], "inside.txt");
    Object.defineProperty(folderFile, "webkitRelativePath", { configurable: true, value: "folder/inside.txt" });
    Object.defineProperty(folderInput, "files", { configurable: true, value: [folderFile] });
    folderInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("folder/inside.txt"));
  });

  it("refreshes in the background, prunes selections and reports repeated failures", async () => {
    let refreshCalls = 0;
    await mount({
      overrides: {
        "GET /": () => {
          refreshCalls += 1;
          if (refreshCalls === 1) {
            return directoryResponse({ ...bootstrap, files: files.filter(file => file.name !== "alpha.txt") });
          }
          throw new Error("refresh down");
        },
      },
    });
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));

    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(resolve => setTimeout(resolve, 40));
    await waitFor(() => expect(document.querySelector('[data-path="/alpha.txt"]')).toBeNull());
    expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected");
    for (let index = 0; index < 3; index += 1) {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(document.body.textContent).toContain("Couldn't refresh");
  });

  it("shows auth on a directory 401 and tolerates a bad saved sort", async () => {
    await mount({
      sortValue: "{bad",
      overrides: {
        "GET /docs/": () => ({ status: 401, body: { detail: "sign in" } }),
      },
    });
    await waitFor(() => expect(document.querySelector('[data-path="/docs/"]')).not.toBeNull());
    const docs = document.querySelector('[data-path="/docs/"]');
    docs.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".auth-overlay")).not.toBeNull());
    click(document.querySelector(".auth-overlay button"));
  });

  it("renders empty and filtered empty states", async () => {
    await mount({ bootstrapData: { ...bootstrap, files: [] } });
    expect(document.body.textContent).toContain("This folder is empty");
    expect(document.body.textContent).toContain("Upload files or create a folder");
    setInputValue(document.querySelector('[aria-label="Filter files by name"]'), "nope");
    await waitFor(() => expect(document.body.textContent).toContain("No matches"));

    await mount({
      bootstrapData: {
        ...bootstrap,
        files: [],
        permissions: { read: true, write: false, delete: false },
      },
    });
    expect(document.body.textContent).toContain("You have read-only access here.");
    await mount({
      bootstrapData: {
        ...bootstrap,
        files: [],
        permissions: { read: true, write: false, delete: true },
      },
    });
    expect(document.body.textContent).toContain("You don't have permission to add files here.");
  });

  it("downloads a zip, rejects a second request while it is pending and reports failures", async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    class UrlWithBlob extends URL {
      static createObjectURL = vi.fn(() => "blob:xwing");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", UrlWithBlob);
    await mount({
      overrides: {
        "POST /_bulk/zip": async () => {
          await held;
          const zip = response("zip");
          zip.headers = new Headers({ "content-disposition": 'attachment; filename="chosen.zip"' });
          return zip;
        },
      },
    });
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    const download = document.querySelector('[aria-label="Download selected as zip"]');
    click(download);
    await waitFor(() => expect(document.querySelector(".zip-overlay")).not.toBeNull());
    download.disabled = false;
    click(download);
    release();
    await waitFor(() => expect(document.querySelector(".zip-overlay")).toBeNull());

    await mount({
      overrides: {
        "POST /_bulk/zip": () => ({ status: 500, body: { detail: "zip failed" } }),
      },
    });
    const beta = document.querySelector('[data-path="/beta.txt"]');
    beta.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Download selected as zip"]'));
    await waitFor(() => expect([...document.querySelectorAll(".toast")].some(toast => toast.textContent.includes("zip failed"))).toBe(true));
  });

  it("refreshes the listing after a completed browser upload", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    const added = {
      name: "uploaded.txt",
      path: "/uploaded.txt",
      kind: "file",
      size: 6,
      modified: "2026-08-01T12:00:00Z",
      editable: true,
    };
    await mount({
      overrides: {
        "GET /": () => directoryResponse({ ...bootstrap, files: [...files, added] }),
        "POST /_upload/init": () => ({
          body: { upload_id: "up", chunk_size: 1024, concurrency: 1, size: 6 },
        }),
        "POST /_upload/up/complete": () => ({ body: { path: "uploaded.txt", size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    const file = new File(["abcdef"], "uploaded.txt");
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("Upload complete"));
    await waitFor(() => expect(document.querySelector('[data-path="/uploaded.txt"]')).not.toBeNull());
  });

  it("drops a stale upload refresh when the user has opened another folder", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    await mount({
      reduced: false,
      overrides: {
        "GET /other/": () => directoryResponse({
          ...bootstrap,
          path: "/other/",
          breadcrumbs: [...bootstrap.breadcrumbs, { name: "other", path: "/other/" }],
          files: [],
        }),
        "POST /_upload/init": () => ({
          body: { upload_id: "up", chunk_size: 1024, concurrency: 1, size: 6 },
        }),
        "POST /_upload/up/complete": () => ({ body: { path: "uploaded.txt", size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    const file = new File(["abcdef"], "uploaded.txt");
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("Upload complete"));
    window.history.pushState({ path: "/other/" }, "", "/other/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(window.location.pathname).toBe("/other/"));
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(document.querySelector('[data-path="/uploaded.txt"]')).toBeNull();
  });

  it("shows the startup failure shell for an invalid bootstrap", async () => {
    vi.resetModules();
    window.__xwingAppRoot?.unmount();
    document.body.innerHTML = `
      <div id="xwing-root"></div>
      <script id="xwing-bootstrap" type="application/json">{bad</script>
    `;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    await import("../../xwing/frontend/src/app.tsx?app-startup-error");
    await waitFor(() => expect(document.querySelector(".boot-error")).not.toBeNull());
    expect(document.querySelector(".boot-error")?.textContent).toContain("X-wing couldn’t start");
  });
});
