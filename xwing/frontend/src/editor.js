"use strict";

const FILE_PATH = document.body.dataset.filePath || "/";
const FILE_EXT = document.body.dataset.fileExt || "";
const CAN_WRITE = document.body.dataset.canWrite === "true";
const CSP_STYLE_NONCE = document.body.dataset.cspStyleNonce || "";
const CONTENT = document.getElementById("editor-content")?.value || "";
const AUTH_REDIRECT_DELAY_MS = 1500;
const AUTH_IDLE_GRACE_MS = 1000;
const AUTH_IDLE_TIMEOUT_SECONDS = parseInt(document.body.dataset.authIdleTimeout, 10) || 0;
const AUTH_ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"];
let authRedirecting = false;

// ── Language detection ─────────────────────────────────────────────────────────
const { EditorView, EditorState, basicSetup, keymap, indentWithTab, oneDark, langs } = window.CM;

function detectLang(ext) {
  const map = {
    py:         langs.python,
    js:         () => langs.javascript(),
    jsx:        () => langs.javascript({ jsx: true }),
    ts:         () => langs.javascript({ typescript: true }),
    tsx:        () => langs.javascript({ jsx: true, typescript: true }),
    html:       langs.html,
    htm:        langs.html,
    css:        langs.css,
    scss:       langs.css,
    less:       langs.css,
    json:       langs.json,
    yaml:       langs.yaml,
    yml:        langs.yaml,
    md:         langs.markdown,
    markdown:   langs.markdown,
    xml:        langs.xml,
    svg:        langs.xml,
    sql:        langs.sql,
    sh:         langs.shell,
    bash:       langs.shell,
    zsh:        langs.shell,
    fish:       langs.shell,
    toml:       langs.toml,
    dockerfile: langs.dockerfile,
    nginx:      langs.nginx,
  };
  const factory = map[ext];
  if (!factory) return [];
  try { return [factory()]; } catch { return []; }
}

// ── Editor setup ───────────────────────────────────────────────────────────────
const langExtension = detectLang(FILE_EXT);
let savedContent = CONTENT;
let dirty = false;
const writeExtensions = CAN_WRITE
  ? []
  : [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
    ];

const view = new EditorView({
  state: EditorState.create({
    doc: CONTENT,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      oneDark,
      ...(CSP_STYLE_NONCE ? [EditorView.cspNonce.of(CSP_STYLE_NONCE)] : []),
      ...langExtension,
      ...writeExtensions,
      EditorView.lineWrapping,
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          dirty = update.state.doc.toString() !== savedContent;
        }
      }),
    ],
  }),
  parent: document.getElementById("editor-wrap"),
});

// ── Save ───────────────────────────────────────────────────────────────────────
const saveStatus = document.getElementById("save-status");
let saveTimer = null;

function setStatus(cls, msg) {
  saveStatus.className = "save-status " + cls;
  saveStatus.textContent = msg;
}

function currentAuthRedirectTarget() {
  return `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;
}

function loginUrlForCurrentPage() {
  return `/_auth/login?redirect=${encodeURIComponent(currentAuthRedirectTarget())}`;
}

function isLoginResponseUrl(url) {
  if (!url) return false;
  try {
    return new URL(url, window.location.href).pathname === "/_auth/login";
  } catch {
    return false;
  }
}

function redirectToLogin() {
  if (authRedirecting) return;
  authRedirecting = true;
  showAuthOverlay("Session expired", "Your session has ended. Redirecting to sign in...");
  window.setTimeout(() => window.location.assign(loginUrlForCurrentPage()), AUTH_REDIRECT_DELAY_MS);
}

function showAuthOverlay(title, message) {
  const overlay = document.getElementById("auth-overlay");
  if (!overlay) return;
  const titleEl = document.getElementById("auth-overlay-title");
  const messageEl = document.getElementById("auth-overlay-message");
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  overlay.hidden = false;
}

function wireLogoutForm() {
  const form = document.getElementById("logout-form");
  if (!form) return;
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (authRedirecting) return;
    authRedirecting = true;
    showAuthOverlay("Signing out", "Ending your session...");
    window.setTimeout(() => form.submit(), AUTH_REDIRECT_DELAY_MS);
  });
}

wireLogoutForm();

function wireAuthIdleTimer() {
  if (AUTH_IDLE_TIMEOUT_SECONDS <= 0) return;
  const timeoutMs = AUTH_IDLE_TIMEOUT_SECONDS * 1000 + AUTH_IDLE_GRACE_MS;
  let timer = null;
  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(redirectToLogin, timeoutMs);
  };
  for (const eventName of AUTH_ACTIVITY_EVENTS) {
    window.addEventListener(eventName, schedule, { passive: true });
  }
  schedule();
}

wireAuthIdleTimer();

async function authFetch(input, init) {
  const res = await fetch(input, init);
  if (res.status === 401 || isLoginResponseUrl(res.url)) {
    redirectToLogin();
    throw new Error("authentication required");
  }
  return res;
}

async function save() {
  if (!CAN_WRITE) {
    setStatus("error", "read-only");
    return;
  }
  setStatus("saving", "saving…");
  const content = view.state.doc.toString();
  try {
    const res = await authFetch(FILE_PATH, {
      method: "PUT",
      body: content,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    if (!res.ok) throw new Error(res.status);
    savedContent = content;
    dirty = false;
    setStatus("saved", "saved");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => setStatus("", ""), 3000);
  } catch (e) {
    if (authRedirecting) return;
    setStatus("error", "save failed: " + e.message);
  }
}

document.getElementById("save-btn").addEventListener("click", save);

// Ctrl+S / Cmd+S
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
});

// ── Unsaved changes guard ──────────────────────────────────────────────────────
window.addEventListener("beforeunload", e => {
  if (dirty && !authRedirecting) {
    e.preventDefault();
    e.returnValue = "";
  }
});
