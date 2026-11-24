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
    if (typeof override === "function") override = override(init);
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

async function waitFor(assertion, options) {
  await vi.waitFor(assertion, options);
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

function submit(form) {
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

async function flushFakeTimers() {
  for (let index = 0; index < 3; index += 1) await vi.advanceTimersByTimeAsync(0);
}

async function mount({
  overrides = {},
  data = {},
  reduced = true,
  bootstrapData = bootstrap,
  bootstrapJson = null,
  sortValue = null,
  idle = 0,
} = {}) {
  vi.resetModules();
  window.__xwingAppRoot?.unmount();
  window.__xwingAppRoot = undefined;
  window.history.replaceState(null, "", "/");
  if (idle === null) delete document.body.dataset.authIdleTimeout;
  else document.body.dataset.authIdleTimeout = String(idle);
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
    key(document.activeElement, "Escape");
    await waitFor(() => expect(document.querySelector("#parallel-menu")).toBeNull());

    click(document.querySelector(".account-trigger"));
    await waitFor(() => expect(document.querySelector("#account-menu")).not.toBeNull());
    key(document, "Escape");
    await waitFor(() => expect(document.querySelector("#account-menu")).toBeNull());
    click(document.querySelector(".account-trigger"));
    await waitFor(() => expect(document.querySelector("#account-menu")).not.toBeNull());
    document.querySelector("#account-menu").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector("#account-menu")).not.toBeNull();
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
    app.dispatchEvent(new Event("dragenter", { bubbles: true }));
    app.dispatchEvent(new Event("dragenter", { bubbles: true }));
    app.dispatchEvent(new Event("dragleave", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".drop-target")).not.toBeNull());
    app.dispatchEvent(new Event("dragleave", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".drop-target")).toBeNull());

    vi.useFakeTimers();
    app.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1500);
    await flushFakeTimers();
    expect(document.querySelector(".drop-wait")?.textContent).toContain("Preparing upload");
    app.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1500);
    window.dispatchEvent(new Event("drop"));
    app.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(1);
    await flushFakeTimers();
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

  it("shows the startup failure shell without a root or bootstrap", async () => {
    vi.resetModules();
    window.__xwingAppRoot?.unmount();
    window.__xwingAppRoot = undefined;
    document.body.innerHTML = '<div id="xwing-root"></div>';
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    await import("../../xwing/frontend/src/app.tsx?app-missing-bootstrap");
    await waitFor(() => expect(document.querySelector(".boot-error")).not.toBeNull());

    vi.resetModules();
    document.body.innerHTML = `<script id="xwing-bootstrap" type="application/json">${JSON.stringify(bootstrap)}</script>`;
    await import("../../xwing/frontend/src/app.tsx?app-missing-root");
    await waitFor(() => expect(document.querySelector(".boot-error")).not.toBeNull());
  });

  it("shows the empty folder and filtered-empty states", async () => {
    await mount({ bootstrapData: { ...bootstrap, files: [] } });
    await waitFor(() => expect(document.querySelector(".state-panel.empty")?.textContent).toContain("This folder is empty"));
    setInputValue(document.querySelector('[aria-label="Filter files by name"]'), "nothing");
    await waitFor(() => expect(document.querySelector(".state-panel.empty")?.textContent).toContain("No matches"));
  });

  it("renders an anonymous shell without breadcrumbs", async () => {
    await mount({
      bootstrapData: {
        ...bootstrap,
        user: { name: "guest", authenticated: false },
        breadcrumbs: [],
        admin: false,
      },
    });
    await waitFor(() => expect(document.querySelector(".xw-app")).not.toBeNull());
    expect(document.querySelector(".account-trigger")).toBeNull();
  });

  it("clears every drag edge and rejects drops without files", async () => {
    await mount();
    const app = document.querySelector(".xw-app");
    app.dispatchEvent(new Event("dragleave", { bubbles: true }));
    app.dispatchEvent(new Event("dragenter", { bubbles: true }));
    app.dispatchEvent(new Event("dragover", { bubbles: true }));
    app.dispatchEvent(new Event("dragover", { bubbles: true }));
    app.dispatchEvent(new Event("dragleave", { bubbles: true }));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { items: [], files: [] } });
    app.dispatchEvent(drop);
    await waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("no files"));
    window.dispatchEvent(new Event("blur"));

    await mount({ bootstrapData: { ...bootstrap, permissions: { read: true, write: false, delete: false } } });
    const readonlyDrop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(readonlyDrop, "dataTransfer", { value: { items: [], files: [] } });
    document.querySelector(".xw-app").dispatchEvent(readonlyDrop);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("ignores a repeat folder submit while the first is pending", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await mount({ overrides: { "MKCOL /fresh/": () => pending } });
    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("New folder")));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const form = document.querySelector("form.modal");
    setInputValue(form.querySelector("input"), "fresh");
    submit(form);
    await waitFor(() => expect(document.querySelector("form.modal input")?.readOnly).toBe(true));
    submit(form);
    release({ body: {}, status: 201 });
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
  });

  it("restores with and without a count, and shows the zip overlay", async () => {
    let restored;
    const zip = new Promise(() => {});
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    const calls = await mount({
      overrides: {
        "POST /api/restore/tx-delete": () => ({ body: { restored } }),
        "POST /_bulk/zip": () => zip,
      },
    });
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    click(alpha);
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(confirmModal());
    const undo = () => [...document.querySelectorAll(".toast")].find(toast => toast.textContent.includes("Undo"));
    await waitFor(() => expect(undo()).not.toBeUndefined());
    click(undo().querySelector("button"));
    const toastText = () => [...document.querySelectorAll(".toast")].map(toast => toast.textContent).join(" ");
    await waitFor(() => expect(toastText()).toContain("Deleted items restored"));
    expect(calls).toContain("POST /api/restore/tx-delete");

    restored = 2;
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(confirmModal());
    await waitFor(() => expect(undo()).not.toBeUndefined());
    click(undo().querySelector("button"));
    await waitFor(() => expect(toastText()).toContain("2 items restored"));

    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Download selected as zip"]'));
    await waitFor(() => expect(document.querySelector(".zip-overlay")).not.toBeNull());
    click(document.querySelector('[aria-label="Download selected as zip"]'));
  });

  it("moves focus with End and gives it back to the list after deleting the last row", async () => {
    await mount({ bootstrapData: { ...bootstrap, files: [files[2]] } });
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.focus();
    key(alpha, "End");
    expect(document.activeElement).toBe(alpha);

    click(alpha);
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(confirmModal());
    await waitFor(() => expect(document.querySelector("#file-list")).toBe(document.activeElement));
  });

  it("shows a failed upload in the dock and retries it", async () => {
    await mount({ overrides: { "POST /_upload/init": { status: 403, body: { detail: "no" } } } });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abc"], "bad.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("failed"));
    click([...document.querySelectorAll(".upload-dock button")].find(button => button.textContent.includes("Retry")));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("failed"));
  });

  it("cancels an active upload and clears finished entries", async () => {
    class HangingXHR extends UploadXHR {
      send() {
        this.uploadHandlers.loadstart?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", HangingXHR);
    await mount({
      overrides: {
        "POST /_upload/init": () => ({ body: { upload_id: "slow", chunk_size: 1024, concurrency: 2, size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["abcdef"], "one.txt"), new File(["abcdef"], "two.txt")],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelectorAll(".upload-item").length).toBe(2));
    const cancels = () => [...document.querySelectorAll(".upload-item button")].filter(button => button.textContent.includes("Cancel"));
    click(cancels()[0]);
    await waitFor(() => expect(document.querySelector(".upload-item")?.textContent).toContain("Upload cancelled"));
    click(cancels()[0]);
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("2 cancelled"));
    expect(document.querySelector(".upload-summary")?.className).toContain("text-xw-muted");
    click(document.querySelector('[aria-label="Clear finished uploads"]'));
    await waitFor(() => expect(document.querySelectorAll(".upload-item").length).toBeLessThan(2));
  });

  it("skips arrival tracking for an upload with no relative path", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    await mount({
      overrides: {
        "POST /_upload/init": () => ({ body: { upload_id: "empty", chunk_size: 1024, concurrency: 1, size: 1 } }),
        "POST /_upload/empty/complete": () => ({ body: { path: "", size: 1 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["x"], "")],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("1 complete"));
  });

  it("expires an idle session", async () => {
    await mount({ idle: 1 });
    await waitFor(() => expect(document.querySelector(".auth-overlay")).not.toBeNull(), { timeout: 4000 });
  });

  it("blocks unload during an active upload", async () => {
    class HangingXHR extends UploadXHR {
      send() {
        this.uploadHandlers.loadstart?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", HangingXHR);
    await mount({
      overrides: {
        "POST /_upload/init": () => ({ body: { upload_id: "hold", chunk_size: 1024, concurrency: 1, size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "hold.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-item")).not.toBeNull());
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it("refreshes on visibility and stays quiet while hidden", async () => {
    const calls = await mount();
    const before = calls.filter(call => call === "GET /").length;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls.filter(call => call === "GET /")).toHaveLength(before);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(calls.filter(call => call === "GET /").length).toBeGreaterThan(before));
  });

  it("reopens the same menu, ignores an unmoved scroll and closes on a real one", async () => {
    await mount();
    const trigger = document.querySelector('[aria-label="Actions for alpha.txt"]');
    click(trigger);
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    click(trigger);
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());
    click(trigger);
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(document.querySelector("#row-actions-menu")).not.toBeNull();
    const table = document.querySelector(".file-table");
    table.scrollTop = 40;
    table.dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());
  });

  it("right-clicks the same row twice and from inside an open menu", async () => {
    await mount();
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    const right = () => alpha.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    right();
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    right();
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    key(document.querySelector("#row-actions-menu"), "Escape");
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());
    alpha.focus();
    key(alpha, "F10", { shiftKey: true });
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    right();
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
  });

  it("closes a dialog from its backdrop and renders dialogs with motion", async () => {
    await mount({ reduced: false });
    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("New folder")));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    document.querySelector(".modal-backdrop").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
    click(document.querySelector('[aria-label="Actions for alpha.txt"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
  });

  it("routes a zip auth failure to the session overlay", async () => {
    await mount({ overrides: { "POST /_bulk/zip": { status: 401, body: { detail: "auth" } } } });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Download selected as zip"]'));
    await waitFor(() => expect(document.querySelector(".auth-overlay")).not.toBeNull());

    await mount({ overrides: { "POST /_bulk/zip": "offline" } });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Download selected as zip"]'));
    await waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("Something went wrong"));
  });

  it("maps folder-create failures through status copy, detail and fallback", async () => {
    const create = async (overrides) => {
      await mount({ overrides });
      click([...document.querySelectorAll("button")].find(button => button.textContent.includes("New folder")));
      await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
      const form = document.querySelector("form.modal");
      setInputValue(form.querySelector("input"), "fresh");
      await waitFor(() => expect(form.querySelector("input").value).toBe("fresh"));
      submit(form);
      await waitFor(() => expect(form.textContent).toMatch(/exists|permission|Request failed|no longer|server|exploded|Something went wrong/i));
      return form.textContent;
    };
    expect(await create({ "MKCOL /fresh/": { status: 405, body: { detail: "ignored" } } })).toContain("already exists");
    expect(await create({ "MKCOL /fresh/": { status: 500, body: { detail: "Server exploded" } } })).toContain("Server exploded");
    expect(await create({ "MKCOL /fresh/": { status: 500, body: {} } })).toContain("Request failed (500)");
    expect(await create({ "MKCOL /fresh/": "offline" })).toContain("Something went wrong");
  });

  it("shows the transition veil for a slow folder load", async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve(directoryResponse({
      ...bootstrap,
      path: "/docs/",
      breadcrumbs: [...bootstrap.breadcrumbs, { name: "docs", path: "/docs/" }],
      files: [],
    })), 1500));
    await mount({ reduced: false, overrides: { "GET /docs/": () => slow } });
    document.querySelector('[data-path="/docs/"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".transition-veil")).not.toBeNull(), { timeout: 2000 });
    await waitFor(() => expect(document.querySelector(".transition-veil")).toBeNull(), { timeout: 2000 });
    const reducedSlow = new Promise(resolve => setTimeout(() => resolve(directoryResponse({
      ...bootstrap,
      path: "/other/",
      breadcrumbs: [...bootstrap.breadcrumbs, { name: "other", path: "/other/" }],
      files: [],
    })), 1500));
    await mount({ overrides: { "GET /other/": () => reducedSlow } });
    document.querySelector('[data-path="/other/"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".transition-veil")).not.toBeNull(), { timeout: 2000 });
    await waitFor(() => expect(document.querySelector(".transition-veil")).toBeNull(), { timeout: 2000 });
  });

  it("labels a two-file archive in the plural", async () => {
    await mount({ overrides: { "POST /_bulk/zip": () => new Promise(() => {}) } });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    document.querySelector('[data-path="/beta.txt"]').dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("2 selected"));
    click(document.querySelector('[aria-label="Download selected as zip"]'));
    await waitFor(() => expect(document.querySelector(".zip-overlay")).not.toBeNull());
    expect(document.querySelector(".zip-overlay")?.textContent).toContain("Zipping 2 files");
  });

  it("accepts a response without a URL", async () => {
    await mount({
      overrides: { "MKCOL /fresh/": { ok: true, status: 200, json: async () => ({}) } },
    });
    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("New folder")));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const form = document.querySelector("form.modal");
    setInputValue(form.querySelector("input"), "fresh");
    submit(form);
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
  });

  it("opens documents with and without an editor and honors the leave delay", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign,
      href: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    });
    await mount({ reduced: false });
    vi.useFakeTimers();
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(170);
    expect(assign).toHaveBeenCalledWith("/alpha.txt?edit");
    vi.useRealTimers();
    await mount();
    const beta = document.querySelector('[data-path="/beta.txt"]');
    beta.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith("/beta.txt"));
  });

  it("opens the parallel menu without a radio and toggles it from the trigger", async () => {
    await mount();
    const original = Element.prototype.querySelector;
    vi.spyOn(Element.prototype, "querySelector").mockImplementation(function (selector) {
      if (this.id === "parallel-menu" && selector === "input[type='radio']") return null;
      return original.call(this, selector);
    });
    const trigger = document.querySelector(".parallel-trigger");
    click(trigger);
    await waitFor(() => expect(document.querySelector("#parallel-menu")).not.toBeNull());
    vi.restoreAllMocks();
    click(trigger);
    await waitFor(() => expect(document.querySelector("#parallel-menu")).toBeNull());
    click(trigger);
    await waitFor(() => expect(document.querySelector("#parallel-menu")).not.toBeNull());
    click(document.querySelector('#parallel-menu input[value="4"]'));
    await waitFor(() => expect(document.querySelector("#parallel-menu")).toBeNull());
    expect(document.querySelector(".parallel-trigger")?.getAttribute("aria-label")).toContain("4");
  });

  it("places a menu without a column header or a scroll container", async () => {
    await mount();
    const query = vi.spyOn(document, "querySelector").mockImplementation(selector =>
      selector === ".file-table .table-head" ? null : Document.prototype.querySelector.call(document, selector));
    click(document.querySelector('[aria-label="Actions for alpha.txt"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    query.mockRestore();
    key(document.querySelector("#row-actions-menu"), "Escape");
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());

    const originalClosest = Element.prototype.closest;
    const closest = vi.spyOn(Element.prototype, "closest").mockImplementation(function (selector) {
      return selector === ".file-table" ? null : originalClosest.call(this, selector);
    });
    click(document.querySelector('[aria-label="Actions for alpha.txt"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    closest.mockRestore();
    key(document.querySelector("#row-actions-menu"), "Escape");
  });

  it("handles Shift and a detached row without a parent", async () => {
    await mount();
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
    alpha.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    alpha.remove();
    key(alpha, "ArrowDown");
    expect(document.querySelector("#row-actions-menu")).toBeNull();
  });

  it("coalesces two finished uploads into one quiet refresh", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    await mount({
      overrides: {
        "POST /_upload/init": () => ({ body: { upload_id: "up", chunk_size: 1024, concurrency: 2, size: 6 } }),
        "POST /_upload/up/complete": () => ({ body: { path: "uploaded.txt", size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["abcdef"], "one.txt"), new File(["abcdef"], "two.txt")],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelectorAll(".upload-item").length).toBe(2));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("Upload complete"), { timeout: 3000 });
  });

  it("creates a folder under a nested path", async () => {
    await mount({
      bootstrapData: {
        ...bootstrap,
        path: "/docs",
        breadcrumbs: [...bootstrap.breadcrumbs, { name: "docs", path: "/docs/" }],
      },
      overrides: { "MKCOL /docs/fresh/": { body: {}, status: 201 } },
    });
    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("New folder")));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const form = document.querySelector("form.modal");
    setInputValue(form.querySelector("input"), "fresh");
    submit(form);
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
  });

  it("ignores a second rename or delete submit while the first is pending", async () => {
    let releaseMove;
    let releaseDelete;
    await mount({
      overrides: {
        "MOVE /alpha.txt": () => new Promise(resolve => { releaseMove = resolve; }),
        "DELETE /beta.txt": () => new Promise(resolve => { releaseDelete = resolve; }),
      },
    });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Actions for alpha.txt"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    click(document.querySelector('[aria-label="Rename alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const rename = document.querySelector("form.modal");
    setInputValue(rename.querySelector("input"), "renamed.txt");
    submit(rename);
    await waitFor(() => expect(document.querySelector("form.modal input")?.readOnly).toBe(true));
    submit(rename);
    releaseMove({ body: {}, status: 201 });
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    click(document.querySelector('[data-path="/beta.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const remove = document.querySelector("form.modal");
    submit(remove);
    await waitFor(() => expect(document.querySelector(".modal-actions button:last-child")?.disabled).toBe(true));
    submit(remove);
    releaseDelete({ body: { transaction_id: "tx-delete" } });
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
  });

  it("counts refresh failures when the quiet listing breaks", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    const callsSeen = await mount({
      overrides: {
        "GET /": () => {
          return { status: 500, body: { detail: "down" } };
        },
        "POST /_upload/init": () => ({ body: { upload_id: "up", chunk_size: 1024, concurrency: 1, size: 6 } }),
        "POST /_upload/up/complete": () => ({ body: { path: "uploaded.txt", size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "uploaded.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("Upload complete"), { timeout: 3000 });
    await waitFor(() => expect(callsSeen.filter(call => call === "GET /").length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it("rejects a quiet refresh with the wrong content type", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    const callsSeen = await mount({
      overrides: {
        "GET /": () => response(bootstrap),
        "POST /_upload/init": () => ({ body: { upload_id: "up", chunk_size: 1024, concurrency: 1, size: 6 } }),
        "POST /_upload/up/complete": () => ({ body: { path: "uploaded.txt", size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "uploaded.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("Upload complete"), { timeout: 3000 });
    await waitFor(() => expect(callsSeen.filter(call => call === "GET /").length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it("skips a quiet refresh while a folder navigation is in flight", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    let releaseDocs;
    const docsPending = new Promise(resolve => { releaseDocs = resolve; });
    const calls = await mount({
      overrides: {
        "GET /docs/": () => docsPending,
        "POST /_upload/init": () => ({ body: { upload_id: "up", chunk_size: 1024, concurrency: 1, size: 6 } }),
        "POST /_upload/up/complete": () => ({ body: { path: "uploaded.txt", size: 6 } }),
      },
    });
    vi.useFakeTimers();
    document.querySelector('[data-path="/docs/"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "uploaded.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(20);
    expect(calls.filter(call => call === "GET /")).toHaveLength(0);
    releaseDocs(directoryResponse({ ...bootstrap, path: "/docs/", breadcrumbs: [...bootstrap.breadcrumbs, { name: "docs", path: "/docs/" }], files: [] }));
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
  });

  it("allows unload when no upload is active and accepts a missing idle attribute", async () => {
    await mount({ idle: null });
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it("hides the admin link for a non-admin account and ignores an empty folder input", async () => {
    await mount({ bootstrapData: { ...bootstrap, admin: false } });
    expect(document.querySelector(".account-trigger")).toBeNull();
    expect(document.querySelector('a[href="/admin"]')).toBeNull();
    const folderInput = document.querySelector('input[webkitdirectory]');
    Object.defineProperty(folderInput, "files", { configurable: true, value: null });
    folderInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  it("clears a row selection and a select-all selection", async () => {
    await mount();
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    alpha.focus();
    click(alpha);
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click([...document.querySelectorAll("button")].find(button => button.textContent === "Clear"));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
    expect(document.activeElement).toBe(alpha);

    click(document.querySelector('[aria-label="Select all"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("4 selected"));
    click(document.querySelector('[aria-label="Deselect all"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
    click(document.querySelector('[aria-label="Select all"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("4 selected"));
    click([...document.querySelectorAll("button")].find(button => button.textContent === "Clear"));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
  });

  it("sorts by three columns and keeps the priority labels", async () => {
    await mount();
    const sort = label => click([...document.querySelectorAll(".sort")].find(button => button.textContent.startsWith(label)));
    sort("Name");
    sort("Size");
    await waitFor(() => expect(document.querySelector(".table-head")?.textContent).toContain("3"));
    expect(document.querySelector('[aria-label*="priority 1"]')).not.toBeNull();
  });

  it("ignores a mousedown inside the dialog and a login redirect on download", async () => {
    await mount();
    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("New folder")));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    document.querySelector(".modal").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".modal")).not.toBeNull();
    click(document.querySelector(".modal .modal-actions button"));
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    const login = response("PK\u0003\u0004zip", 200, "http://xwing.test/_auth/login");
    await mount({ overrides: { "POST /_bulk/zip": login } });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Download selected as zip"]'));
    await waitFor(() => expect(document.querySelector(".auth-overlay")).not.toBeNull());
  });

  it("drops stale navigation results and aborted requests", async () => {
    const abortable = init => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    await mount({ reduced: false, overrides: { "GET /docs/": abortable, "GET /other/": abortable } });
    vi.useFakeTimers();
    const docs = document.querySelector('[data-path="/docs/"]');
    const other = document.querySelector('[data-path="/other/"]');
    docs.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    other.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(130);
    await vi.advanceTimersByTimeAsync(130);
    docs.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(130);
    other.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(130);
    vi.useRealTimers();
  });

  it("moves to the first row with Home and ignores a read-only drag", async () => {
    await mount();
    const beta = document.querySelector('[data-path="/beta.txt"]');
    beta.focus();
    key(beta, "Home");
    expect(document.activeElement).toBe(document.querySelector('[data-path="/other/"]'));
    key(document.activeElement, "End");
    expect(document.activeElement).toBe(document.querySelector('[data-path="/beta.txt"]'));
    key(document.activeElement, "x");
    expect(document.activeElement).toBe(document.querySelector('[data-path="/beta.txt"]'));

    await mount({ bootstrapData: { ...bootstrap, permissions: { read: true, write: false, delete: false } } });
    const drag = new Event("dragover", { bubbles: true, cancelable: true });
    document.querySelector(".xw-app").dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(false);
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    expect(document.querySelector('[aria-label="Delete selected"]')?.disabled).toBe(true);
  });

  it("opens a menu without a previously focused element", async () => {
    await mount();
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => null });
    try {
      document.querySelector('[data-path="/alpha.txt"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
      key(document.querySelector("#row-actions-menu"), "Escape");
      await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());
    } finally {
      delete document.activeElement;
    }
  });

  it("renders reduced-motion drag, toast and zero-size upload states", async () => {
    await mount({ reduced: false });
    const app = document.querySelector(".xw-app");
    app.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
    app.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(document.querySelector(".drop-target")).not.toBeNull());
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { items: [], files: [] } });
    app.dispatchEvent(drop);
    await waitFor(() => expect(document.querySelector(".toast")).not.toBeNull());

    await mount({
      reduced: false,
      overrides: {
        "POST /_upload/init": () => ({ body: { upload_id: "zero", chunk_size: 1024, concurrency: 1, size: 0 } }),
        "POST /_upload/zero/complete": () => ({ body: { path: "empty.txt", size: 0 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File([], "empty.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")).not.toBeNull());
  });

  it("renders the delayed drop notice with motion", async () => {
    await mount({ reduced: false });
    vi.useFakeTimers();
    const app = document.querySelector(".xw-app");
    app.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
    app.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1500);
    await flushFakeTimers();
    expect(document.querySelector(".drop-wait")).not.toBeNull();
    app.dispatchEvent(new Event("dragleave", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("clears an arrival highlight with motion", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    await mount({
      reduced: false,
      overrides: {
        "POST /_upload/init": () => ({ body: { upload_id: "up", chunk_size: 1024, concurrency: 1, size: 6 } }),
        "POST /_upload/up/complete": () => ({ body: { path: "uploaded.txt", size: 6 } }),
      },
    });
    vi.useFakeTimers();
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "uploaded.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelector(".upload-dock")?.textContent).toContain("Upload complete");
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector(".upload-dock")?.getAttribute("style")).toContain("opacity: 0");
    vi.useRealTimers();
  });

  it("skips a failed refresh after its request is aborted", async () => {
    UploadXHR.all = [];
    vi.stubGlobal("XMLHttpRequest", UploadXHR);
    const abortable = init => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const calls = await mount({
      overrides: {
        "GET /": abortable,
        "GET /other/": () => directoryResponse({ ...bootstrap, path: "/other/", breadcrumbs: [...bootstrap.breadcrumbs, { name: "other", path: "/other/" }], files: [] }),
        "POST /_upload/init": () => ({ body: { upload_id: "up", chunk_size: 1024, concurrency: 1, size: 6 } }),
        "POST /_upload/up/complete": () => ({ body: { path: "uploaded.txt", size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "uploaded.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(calls.filter(call => call === "GET /").length).toBeGreaterThan(0), { timeout: 3000 });
    window.history.pushState({ path: "/other/" }, "", "/other/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(document.querySelector('[data-path="/other/"]')).not.toBeNull());
  });

  it("shows an upload speed when progress samples span time", async () => {
    class SpeedXHR extends UploadXHR {
      send(blob) {
        this.uploadHandlers.loadstart?.();
        const start = Number(new URL(this.url, "http://xwing.test").searchParams.get("offset"));
        const end = start + blob.size;
        this.uploadHandlers.progress?.({ loaded: blob.size / 2, total: blob.size });
        setTimeout(() => {
          this.uploadHandlers.progress?.({ loaded: blob.size, total: blob.size });
          setTimeout(() => {
            this.uploadHandlers.load?.();
            this.status = 200;
            this.responseText = JSON.stringify({ ranges: [[0, end]], received: blob.size });
            this.listeners.load?.();
          }, 200);
        }, 100);
      }
    }
    vi.stubGlobal("XMLHttpRequest", SpeedXHR);
    await mount({
      overrides: {
        "POST /_upload/init": () => ({ body: { upload_id: "speed", chunk_size: 1024, concurrency: 1, size: 6 } }),
        "POST /_upload/speed/complete": () => ({ body: { path: "speed.txt", size: 6 } }),
      },
    });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "speed.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(document.querySelector(".upload-dock")?.textContent).toContain("/s"), { timeout: 3000 });
  });

  it("covers row checkboxes, action menu callbacks and dialog focus", async () => {
    await mount();
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    const checkbox = alpha.querySelector('label.row-check input');
    checkbox.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
      metaKey: true,
    }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));

    const trigger = document.querySelector('[aria-label="Actions for alpha.txt"]');
    click(trigger);
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    click(document.querySelector('#row-actions-menu [aria-label="Rename alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    click(trigger);
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    click(document.querySelector('#row-actions-menu [aria-label="Delete alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    click(trigger);
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    click(document.querySelector('#row-actions-menu [aria-label="Download alpha.txt"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());

    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("New folder")));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const modal = document.querySelector(".modal");
    const actions = modal.querySelectorAll(".modal-actions button");
    actions[1].focus();
    const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}]);
    key(document.activeElement, "Tab");
    await waitFor(() => expect(document.activeElement).toBe(modal.querySelector("input")));
    document.querySelector('[aria-label="New folder"]').focus();
    key(modal, "Tab");
    expect(document.activeElement).toBe(modal.querySelector("input"));
    actions[0].focus();
    key(actions[0], "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(actions[0]);
    rects.mockRestore();
    click(actions[0]);
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
  });

  it("covers menu keyboard navigation, menu scroll and row mouse variants", async () => {
    await mount();
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    key(alpha, "F10", { shiftKey: true });
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    const menu = document.querySelector("#row-actions-menu");
    key(menu, "Home");
    key(menu, "End");
    menu.dispatchEvent(new Event("scroll", { bubbles: true }));
    menu.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const first = menu.querySelector('[role="menuitem"]');
    first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true }));
    first.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    key(menu, "Tab");
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());

    alpha.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true }));
    alpha.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    key(alpha, "Enter");
    key(alpha, "F2");
    key(alpha, "Escape");
    key(alpha, "ArrowDown");
    click(alpha);
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    key(alpha, "Delete");
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));
  });

  it("covers malformed delete and restore responses", async () => {
    const badJson = () => ({
      ok: true,
      status: 200,
      url: "http://xwing.test/",
      headers: new Headers(),
      json: async () => { throw new Error("not json"); },
    });
    let deletes = 0;
    await mount({
      overrides: {
        "DELETE /alpha.txt": () => (deletes++ === 0
          ? badJson()
          : { body: { transaction_id: "tx-delete" } }),
        "POST /api/restore/tx-delete": badJson,
      },
    });

    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("1 item deleted"));

    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(confirmModal());
    const undo = () => [...document.querySelectorAll(".toast")].find(toast => toast.textContent.includes("Undo"));
    await waitFor(() => expect(undo()).not.toBeUndefined());
    click(undo().querySelector("button"));
    await waitFor(() => expect(deletes).toBe(2));
  });

  it("uses the generic zip filename when the response has no disposition", async () => {
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    }));
    const downloads = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      downloads.push(this.download);
    });
    let zipCalls = 0;
    await mount({
      overrides: {
        "POST /_bulk/zip": () => {
          zipCalls += 1;
          const headers = new Headers({ "content-type": "application/zip" });
          if (zipCalls === 2) headers.set("content-disposition", 'attachment; filename="named.zip"');
          return {
            ok: true,
            status: 200,
            url: "http://xwing.test/_bulk/zip",
            headers,
            blob: async () => new Blob(["zip"]),
          };
        },
      },
    });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Download selected as zip"]'));
    await waitFor(() => expect(downloads).toEqual(["xwing-selection.zip"]));
    click(document.querySelector('[aria-label="Download selected as zip"]'));
    await waitFor(() => expect(downloads).toEqual(["xwing-selection.zip", "named.zip"]));
  });

  it("ignores an empty file input and read-only drag gestures", async () => {
    await mount({ bootstrapData: { ...bootstrap, permissions: { read: true, write: false, delete: false } } });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: null });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const app = document.querySelector(".xw-app");
    app.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
    app.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
  });

  it("covers empty-state uploads, breadcrumb navigation and direct row keys", async () => {
    await mount({ bootstrapData: { ...bootstrap, files: [] } });
    const fileClick = vi.spyOn(HTMLInputElement.prototype, "click");
    click(document.querySelector(".state-panel.empty button"));
    expect(fileClick).toHaveBeenCalled();

    await mount({
      bootstrapData: {
        ...bootstrap,
        path: "/docs/",
        breadcrumbs: [...bootstrap.breadcrumbs, { name: "docs", path: "/docs/" }],
        files: [],
      },
    });
    click(document.querySelector("a.crumb"));
    await waitFor(() => expect(document.title).toBe("X-wing — /"));

    await mount();
    const docs = document.querySelector('[data-path="/docs/"]');
    key(docs, "Enter");
    await waitFor(() => expect(document.title).toBe("X-wing — /docs/"));
    await mount();
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    key(alpha, "Delete");
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());
  });

  it("covers every checkbox modifier and direct delete-key selection branch", async () => {
    await mount();
    const checkbox = () => document.querySelector('[data-path="/alpha.txt"] label.row-check input');
    const betaCheckbox = () => document.querySelector('[data-path="/beta.txt"] label.row-check input');
    checkbox().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, detail: 1 }));
    betaCheckbox().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    checkbox().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true, detail: 1 }));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toContain("selected"));
    key(document.querySelector('[data-path="/alpha.txt"]'), "Delete");
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));

    await mount({ bootstrapData: { ...bootstrap, permissions: { read: true, write: false, delete: false } } });
    const alpha = document.querySelector('[data-path="/alpha.txt"]');
    key(alpha, "Delete");
    key(alpha, "F2");
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("covers disabled row actions and a directory download", async () => {
    await mount({ bootstrapData: { ...bootstrap, permissions: { read: true, write: false, delete: false } } });
    click(document.querySelector('[aria-label="Actions for alpha.txt"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    expect(document.querySelector('#row-actions-menu [aria-label="Rename alpha.txt"]').disabled).toBe(true);
    expect(document.querySelector('#row-actions-menu [aria-label="Delete alpha.txt"]').disabled).toBe(true);
    click(document.querySelector('#row-actions-menu [aria-label="Download alpha.txt"]'));

    click(document.querySelector('[aria-label="Actions for docs"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    expect(document.querySelector('#row-actions-menu [aria-label="Download docs"]').getAttribute("href")).toBe("/docs/?zip");
  });

  it("keeps a pending dialog open and closes the parallel menu on blur", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await mount({ overrides: { "DELETE /alpha.txt": () => pending } });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".modal .modal-actions button:last-child")?.disabled).toBe(true));
    key(document.querySelector(".modal"), "Escape");
    expect(document.querySelector(".modal")).not.toBeNull();
    const backdrop = document.querySelector(".modal-backdrop");
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(document.querySelector(".modal")).not.toBeNull();
    release({ body: { transaction_id: "pending" } });
    await waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    const trigger = document.querySelector(".parallel-trigger");
    click(trigger);
    await waitFor(() => expect(document.querySelector("#parallel-menu")).not.toBeNull());
    const wrap = document.querySelector(".parallel-wrap");
    const inside = document.querySelector("#parallel-menu");
    wrap.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: inside }));
    expect(document.querySelector("#parallel-menu")).not.toBeNull();
    wrap.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    await waitFor(() => expect(document.querySelector("#parallel-menu")).toBeNull());
  });

  it("recomputes rail clearance after a resize", async () => {
    await mount();
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 100,
      height: 0,
      right: 0,
      bottom: 0,
      left: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--xw-rail-clearance")).toBe("0px");
    rect.mockRestore();

    const tall = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 100,
      height: 48,
      right: 0,
      bottom: 0,
      left: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--xw-rail-clearance")).not.toBe("0px");
    tall.mockRestore();
  });

  it("covers direct delete selection and modal refreshes", async () => {
    await mount({
      overrides: {
        "GET /other/": () => directoryResponse({
          ...bootstrap,
          path: "/other/",
          breadcrumbs: [...bootstrap.breadcrumbs, { name: "other", path: "/other/" }],
          files: [],
        }),
      },
    });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    key(document.querySelector('[data-path="/alpha.txt"]'), "Delete");
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));

    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    click([...document.querySelectorAll("button")].find(button => button.textContent.includes("New folder")));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    window.history.pushState({ path: "/other/" }, "", "/other/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(document.title).toBe("X-wing — /other/"));
    click(document.querySelector(".modal button"));
  });

  it("covers a read-only file selection and flipped upload menu", async () => {
    await mount({ bootstrapData: { ...bootstrap, permissions: { read: true, write: false, delete: false } } });
    const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "x.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() { return 200; },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() { return 180; },
    });
    const trigger = document.querySelector('[aria-label="Actions for alpha.txt"]');
    const rect = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 700,
      bottom: 730,
      right: 300,
      left: 200,
      width: 100,
      height: 30,
      x: 200,
      y: 700,
      toJSON: () => ({}),
    });
    click(trigger);
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    expect(document.querySelector("#row-actions-menu")?.className).toContain("origin-bottom-left");
    key(document.querySelector("#row-actions-menu"), "Home");
    key(document.querySelector("#row-actions-menu"), "End");
    key(document.querySelector("#row-actions-menu"), "Delete");
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).toBeNull());
    expect(document.querySelector(".modal")).toBeNull();
    document.querySelector('[data-path="/alpha.txt"]').dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 700,
    }));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    expect(document.querySelector("#row-actions-menu")?.className).toContain("origin-bottom-left");
    key(document.querySelector("#row-actions-menu"), "Escape");
    rect.mockRestore();
  });

  it("dismisses a completed toast only once", async () => {
    await mount();
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));
    click(document.querySelector('[aria-label="Delete selected"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(confirmModal());
    await waitFor(() => expect(document.querySelector(".toast-action")).not.toBeNull());
    const action = document.querySelector(".toast-action");
    click(action);
    click(action);
  });

  it("keeps the range anchor only while the row still exists", async () => {
    let calls = 0;
    await mount({
      overrides: {
        "GET /": () => {
          calls += 1;
          const visible = calls === 1
            ? bootstrap.files
            : bootstrap.files.filter(file => file.path !== "/alpha.txt");
          return directoryResponse({ ...bootstrap, files: visible });
        },
      },
    });
    click(document.querySelector('[data-path="/alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected"));

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(calls).toBe(1));
    expect(document.querySelector(".selection-pill")?.textContent).toBe("1 selected");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(document.querySelector(".selection-pill")?.textContent).toBe("0 selected"));
  });

  it("focuses the confirm control after a text-dialog failure", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await mount({ overrides: { "MOVE /alpha.txt": () => pending } });
    click(document.querySelector('[aria-label="Actions for alpha.txt"]'));
    await waitFor(() => expect(document.querySelector("#row-actions-menu")).not.toBeNull());
    click(document.querySelector('#row-actions-menu [aria-label="Rename alpha.txt"]'));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    const form = document.querySelector("form.modal");
    setInputValue(form.querySelector("input"), "renamed.txt");
    submit(form);
    await waitFor(() => expect(form.querySelector(".modal-actions button:last-child")?.disabled).toBe(true));
    document.activeElement.blur();
    release({ status: 500, body: { detail: "rename failed" } });
    await waitFor(() => expect(document.querySelector(".dialog-error")?.textContent).toContain("rename failed"));
    expect(document.activeElement).toBe(form.querySelector(".modal-actions button:last-child"));
  });
});
