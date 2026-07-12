"use strict";

import { createDialogController } from "./app-core.js";
import { createAuthSession } from "./shared.js";

const FILE_PATH = document.body.dataset.filePath || "/";
const FILE_EXT = document.body.dataset.fileExt || "";
const CAN_WRITE = document.body.dataset.canWrite === "true";
const CSP_STYLE_NONCE = document.body.dataset.cspStyleNonce || "";
const CONTENT = document.getElementById("editor-content")?.value || "";
const AUTH_REDIRECT_DELAY_MS = 1500;
const AUTH_IDLE_GRACE_MS = 1000;
const AUTH_IDLE_TIMEOUT_SECONDS = parseInt(document.body.dataset.authIdleTimeout, 10) || 0;
const AUTH_ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"];
const auth = createAuthSession({
  redirectDelayMs: AUTH_REDIRECT_DELAY_MS,
  idleTimeoutSeconds: AUTH_IDLE_TIMEOUT_SECONDS,
  idleGraceMs: AUTH_IDLE_GRACE_MS,
  activityEvents: AUTH_ACTIVITY_EVENTS,
});
const authFetch = auth.authFetch;
const dialogs = createDialogController();
const backLink = document.getElementById("editor-back-link");
const logoutForm = document.getElementById("logout-form");

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
let allowNavigation = false;
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

async function confirmDiscardChanges() {
  if (!dirty) return true;
  return await dialogs.confirm(
    "Discard unsaved changes?",
    "This file has unsaved edits. Leave without saving?",
    "Discard changes",
  );
}

async function leaveEditor(href) {
  if (!href) return;
  if (!await confirmDiscardChanges()) return;
  allowNavigation = true;
  window.location.assign(href);
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
    allowNavigation = false;
    setStatus("saved", "saved");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => setStatus("", ""), 3000);
  } catch (e) {
    if (auth.isRedirecting()) return;
    setStatus("error", "save failed: " + e.message);
  }
}

document.getElementById("save-btn").addEventListener("click", save);

backLink?.addEventListener("click", event => {
  event.preventDefault();
  leaveEditor(backLink.href);
});

logoutForm?.addEventListener("submit", async event => {
  if (!dirty) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!await confirmDiscardChanges()) return;
  allowNavigation = true;
  logoutForm.submit();
}, true);

auth.wireLogoutForm();
auth.wireAuthIdleTimer();

// Ctrl+S / Cmd+S
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
  if (
    e.key === "Escape" &&
    !e.defaultPrevented &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    backLink
  ) {
    e.preventDefault();
    leaveEditor(backLink.href);
  }
});

// ── Unsaved changes guard ──────────────────────────────────────────────────────
window.addEventListener("beforeunload", e => {
  if (dirty && !allowNavigation && !auth.isRedirecting()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
