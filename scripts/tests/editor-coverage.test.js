import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const baseBoot = {
  path: "/README.md",
  directory: "/",
  filename: "README.md",
  displayPath: "/README.md",
  extension: "md",
  content: "Browser regression fixture\n",
  truncated: false,
  totalSize: 27,
  previewBytes: 27,
  user: { name: "alice", authenticated: true },
  canWrite: true,
  maxChunkBytes: 8 * 1024 * 1024,
  cspNonce: "",
  authIdleTimeout: 0,
};

let view;
let updateListener;
let searchOpen;
let closeCount;

function installCodeMirror({ languageThrows = false } = {}) {
  view = null;
  updateListener = null;
  searchOpen = false;
  closeCount = 0;
  const make = () => ({});
  const cm = {
    EditorView: class {
      static editable = { of: make };
      static lineWrapping = {};
      static updateListener = {
        of: listener => {
          updateListener = listener;
          return {};
        },
      };
      static cspNonce = { of: make };
      static contentAttributes = { of: make };
      constructor(options) {
        this.state = options.state;
        view = this;
      }
      focus() {
        this.focused = true;
      }
      destroy() {
        this.destroyed = true;
      }
    },
    EditorState: {
      create: options => ({ doc: { toString: () => options.doc }, options }),
      readOnly: { of: make },
    },
    basicSetup: {},
    keymap: { of: make },
    indentWithTab: {},
    oneDark: {},
    langs: new Proxy({}, {
      get: (_target, key) => () => {
        if (languageThrows) throw new Error(`no ${String(key)} language`);
        return { language: key };
      },
    }),
    searchPanelOpen: () => searchOpen,
    closeSearchPanel: () => {
      closeCount += 1;
      searchOpen = false;
    },
  };
  window.CM = cm;
  return cm;
}

function click(element) {
  element.click();
}

async function setDoc(text) {
  view.state = { doc: { toString: () => text } };
  updateListener?.({ docChanged: true, state: view.state });
  await vi.waitFor(() => expect(document.querySelector(".button.primary")?.disabled).toBe(false));
}

async function mount(boot = {}, options = {}) {
  vi.resetModules();
  window.__xwingEditorRoot?.unmount();
  window.__xwingEditorRoot = undefined;
  document.body.innerHTML = `
    <div id="xwing-editor-root"></div>
    <div id="auth-overlay" hidden><h2 id="auth-overlay-title"></h2><p id="auth-overlay-message"></p></div>
    <script id="xwing-editor-bootstrap" type="application/json">${JSON.stringify({ ...baseBoot, ...boot })}</script>
  `;
  window.matchMedia = () => ({ matches: options.reduced ?? true, addEventListener() {}, removeEventListener() {} });
  const cm = installCodeMirror(options);
  await import("../../xwing/frontend/src/editor.tsx?editor-coverage");
  await vi.waitFor(() => expect(document.querySelector(".editor-app")).not.toBeNull());
  await vi.waitFor(() => expect(view).not.toBeNull());
  return cm;
}

class SaveXHR {
  static all = [];
  upload = {
    addEventListener: (type, handler) => {
      this.uploadHandlers ??= {};
      this.uploadHandlers[type] = handler;
    },
  };
  listeners = {};
  aborted = false;
  status = 0;
  responseText = "";
  constructor() {
    SaveXHR.all.push(this);
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

function saveFetch({ initStatus = 200, completeStatus = 200 } = {}) {
  return vi.fn(async (url, init = {}) => {
    const path = String(url);
    if (path.includes("/init")) {
      return {
        ok: initStatus >= 200 && initStatus < 300,
        status: initStatus,
        url: "http://xwing.test/_upload/init",
        json: async () => initStatus >= 300
          ? { detail: "init failed" }
          : { upload_id: "save", chunk_size: 4, concurrency: 1, size: 10 },
      };
    }
    if (path.includes("/complete")) {
      return {
        ok: completeStatus >= 200 && completeStatus < 300,
        status: completeStatus,
        url: "http://xwing.test/_upload/save/complete",
        json: async () => completeStatus >= 300
          ? { detail: "complete failed" }
          : { path: "README.md" },
      };
    }
    const status = init.status ?? 200;
    return { ok: status >= 200 && status < 300, status, url: `http://xwing.test${baseBoot.path}` };
  });
}

beforeEach(() => {
  SaveXHR.all = [];
  vi.stubGlobal("XMLHttpRequest", SaveXHR);
});

afterEach(() => {
  window.__xwingEditorRoot?.unmount();
  window.__xwingEditorRoot = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("editor coverage edges", () => {
  it("covers each line-ending and the read-only, truncated shell", async () => {
    await mount({ content: "a\r\nb\r\nc" });
    expect(view.focused).toBe(true);
    await mount({ content: "a\rb\rc", extension: "txt", canWrite: false });
    expect(document.body.textContent).toContain("Read-only access");
    expect(document.querySelector(".editor-app")?.textContent).toContain("txt");
    await mount({ content: "a\nb\nc", truncated: true, previewBytes: 1024, totalSize: 2048, cspNonce: "nonce" });
    expect(document.body.textContent).toContain("Showing first 1.0 KB of 2.0 KB");
    expect(view.state.options.extensions.length).toBeGreaterThan(0);
  });

  it("falls back when a language factory is unavailable or throws", async () => {
    await mount({ extension: "unknown" });
    await mount({ extension: "bad" }, { languageThrows: true });
    expect(document.querySelector(".editor-app")).not.toBeNull();
  });

  it("saves small documents and reports failures", async () => {
    const fetchMock = saveFetch();
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await setDoc("changed");
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Saved"));

    await setDoc("changed again");
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, url: "http://xwing.test/README.md" }));
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Save failed (500)"));

    await setDoc("auth");
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 401, url: "http://xwing.test/README.md" }));
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector(".auth-overlay")).not.toBeNull());
  });

  it("shows the non-Error save fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw "offline"; }));
    await mount();
    await setDoc("changed");
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Save failed"));
  });

  it("saves a large document through the chunked upload engine", async () => {
    const fetchMock = saveFetch();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ maxChunkBytes: 4 });
    await setDoc("abcdefghij");
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(SaveXHR.all.length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/complete"))).toBe(true));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Saved"));
  });

  it("uses the server chunk limit and reports an auth failure from a chunked save", async () => {
    const fetchMock = saveFetch({ initStatus: 403 });
    vi.stubGlobal("fetch", fetchMock);
    await mount({ maxChunkBytes: 4 });
    await setDoc("abcdefghij");
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Sign-in required"));
    expect(document.querySelector(".auth-overlay")).not.toBeNull();
  });

  it("owns the search panel, unsaved navigation and logout confirmation", async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      href: "http://xwing.test/README.md",
      pathname: "/README.md",
      search: "",
      hash: "",
      assign,
    });
    await mount({}, { reduced: false });
    const panel = document.createElement("div");
    panel.className = "cm-panel cm-search";
    panel.innerHTML = '<input main-field><button name="close"></button>';
    document.querySelector("#editor-canvas").append(panel);
    searchOpen = true;
    const field = panel.querySelector("[main-field]");
    field.focus = vi.fn();
    field.select = vi.fn();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(field.focus).toHaveBeenCalled();
    click(panel.querySelector("[name=close]"));
    expect(panel.classList.contains("closing")).toBe(true);
    vi.advanceTimersByTime(160);
    expect(closeCount).toBe(1);

    await setDoc("dirty");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button"));
    await vi.waitFor(() => expect(document.querySelector(".modal")).toBeNull());

    searchOpen = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(160);
    expect(closeCount).toBe(2);
    searchOpen = false;

    document.querySelector("#logout-form").submit = vi.fn();
    click(document.querySelector("#logout-form button"));
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal button.danger"));
    await vi.waitFor(() => expect(document.querySelector(".auth-overlay")?.textContent).toContain("Signing out"));
    vi.advanceTimersByTime(1500);
    expect(document.querySelector("#logout-form").submit).toHaveBeenCalled();
  });

  it("leaves a clean editor and reacts to auth redirects", async () => {
    document.body.innerHTML = "";
    await mount();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    window.dispatchEvent(new Event("xwing:auth-redirect"));
    await vi.waitFor(() => expect(document.querySelector(".auth-overlay")?.textContent).toContain("Session expired"));
    const prevented = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    prevented.preventDefault();
    document.dispatchEvent(prevented);
    window.__xwingEditorRoot?.unmount();
    expect(view.destroyed).toBe(true);
  });

  it("closes the search panel immediately for reduced motion or without a panel", async () => {
    await mount({}, { reduced: true });
    searchOpen = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(closeCount).toBe(1);
  });

  it("navigates a clean editor and handles missing search fields", async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      href: "http://xwing.test/README.md",
      pathname: "/README.md",
      search: "",
      hash: "",
      assign,
    });
    await mount({}, { reduced: false });
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(170);
    expect(assign).toHaveBeenCalledWith("/");

    const panel = document.createElement("div");
    panel.className = "cm-panel cm-search";
    document.querySelector("#editor-canvas").append(panel);
    searchOpen = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    click(document.querySelector("#editor-canvas"));
    expect(closeCount).toBe(0);
  });

  it("treats a login redirect as an auth failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, url: "http://xwing.test/_auth/login" })));
    await mount();
    await setDoc("changed");
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector(".auth-overlay")).not.toBeNull());
  });

  it("saves when the response has no URL and ignores a document click", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    await mount();
    await setDoc("changed");
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Saved"));
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  it("ignores saves while read-only and falls back to the default chunk size", async () => {
    vi.stubGlobal("fetch", saveFetch());
    await mount({ canWrite: false, maxChunkBytes: 0 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="status"]')?.textContent).not.toBe("Saving…");
  });

  it("uses the handover timing when leaving into the app", async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      href: "http://xwing.test/README.md",
      pathname: "/README.md",
      search: "",
      hash: "",
      assign,
    });
    sessionStorage.setItem("xw-handover", String(Date.now()));
    await mount({}, { reduced: false });
    click(document.querySelector(".brand"));
    vi.advanceTimersByTime(200);
    expect(assign).toHaveBeenCalledWith("/");
    sessionStorage.clear();
  });

  it("renders the anonymous shell with the fallback rail label", async () => {
    await mount({ extension: "", user: { name: "guest", authenticated: false } }, { reduced: false });
    expect(document.body.textContent).toContain("anonymous");
    expect(document.querySelector(".editor-rail")?.textContent).toContain("TXT");
    const brand = document.querySelector('a[aria-label="X-wing EDITOR, home"]');
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      brand.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, [key]: true }));
    }
    brand.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }));
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("treats a non-envelope upload response as an auth failure", async () => {
    class BadEnvelopeXHR extends SaveXHR {
      send() {
        this.uploadHandlers.loadstart?.();
        queueMicrotask(() => {
          this.uploadHandlers.load?.();
          this.status = 200;
          this.responseText = "not json";
          this.listeners.load?.();
        });
      }
    }
    vi.stubGlobal("XMLHttpRequest", BadEnvelopeXHR);
    vi.stubGlobal("fetch", saveFetch());
    await mount({ maxChunkBytes: 4 });
    await setDoc("abcdefghij");
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector(".auth-overlay")).not.toBeNull());
  });

  it("saves an empty document through the fallback chunk limit", async () => {
    const fetchMock = saveFetch();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ content: "", maxChunkBytes: -1 });
    await setDoc("x");
    click(document.querySelector(".button.primary"));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe("Saved"));
  });

  it("shows the static shell without editor markup", async () => {
    vi.resetModules();
    window.__xwingEditorRoot?.unmount();
    window.__xwingEditorRoot = undefined;
    document.body.innerHTML = '<div id="xwing-editor-root"></div>';
    await import("../../xwing/frontend/src/editor.tsx?editor-missing-bootstrap");
    expect(document.querySelector(".editor-app")).toBeNull();
    document.body.innerHTML = `<script id="xwing-editor-bootstrap" type="application/json">${JSON.stringify(baseBoot)}</script>`;
    await import("../../xwing/frontend/src/editor.tsx?editor-missing-root");
    expect(document.querySelector(".editor-app")).toBeNull();
  });

  it("renders the notices with motion and ignores a close click when search is closed", async () => {
    await mount({ canWrite: false, truncated: true }, { reduced: false });
    expect(document.querySelector(".editor-notices")).not.toBeNull();
    const panel = document.createElement("div");
    panel.className = "cm-panel cm-search";
    panel.innerHTML = '<button name="close"></button>';
    document.querySelector("#editor-canvas").append(panel);
    searchOpen = false;
    click(panel.querySelector("[name=close]"));
    expect(closeCount).toBe(0);
  });

  it("keeps the discard dialog when Escape is pressed again", async () => {
    await mount();
    await setDoc("dirty");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector(".modal")).not.toBeNull();
    click(document.querySelector(".modal button"));
    await vi.waitFor(() => expect(document.querySelector(".modal")).toBeNull());
  });

  it("discards changes and leaves for the folder", async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      href: "http://xwing.test/README.md",
      pathname: "/README.md",
      search: "",
      hash: "",
      assign,
    });
    await mount({}, { reduced: false });
    await setDoc("dirty");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector(".modal .button.danger"));
    vi.advanceTimersByTime(200);
    expect(assign).toHaveBeenCalledWith("/");
  });
});
