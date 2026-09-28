import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation } from "motion/react";
import * as m from "motion/react-m";
import { AuthOverlay } from "./auth-overlay";
import { cn } from "./lib/cn";
import { formatBytes, prefersReducedMotion } from "./format";
import { useModalFocus } from "./keyboard";
import { AUTH_OVERLAY_COPY, AUTH_REDIRECT_EVENT, beginAuthRedirect } from "./shared.js";
import { UploadClient, UploadError, UploadState, uploadFile } from "./upload-engine";

interface EditorBootstrap {
  path: string; directory: string; filename: string; displayPath: string;
  extension: string; content: string; truncated: boolean; totalSize: number;
  previewBytes: number;
  user: { name: string; authenticated: boolean };
  canWrite: boolean; maxChunkBytes: number; cspNonce: string; authIdleTimeout: number;
}

interface CodeMirrorView {
  state: { doc: { toString(): string } };
  focus(): void;
  destroy(): void;
}

interface CodeMirrorApi {
  EditorView: {
    new(options: unknown): CodeMirrorView;
    editable: { of(value: boolean): unknown };
    lineWrapping: unknown;
    updateListener: { of(listener: (update: { docChanged: boolean; state: CodeMirrorView["state"] }) => void): unknown };
    cspNonce: { of(value: string): unknown };
    contentAttributes: { of(value: Record<string, string>): unknown };
  };
  EditorState: { create(options: unknown): unknown; readOnly: { of(value: boolean): unknown } };
  basicSetup: unknown; keymap: { of(value: unknown[]): unknown }; indentWithTab: unknown; oneDark: unknown;
  searchPanelOpen(state: unknown): boolean;
  closeSearchPanel(view: CodeMirrorView): boolean;
  langs: Record<string, (...args: unknown[]) => unknown>;
}

declare global { interface Window { CM: CodeMirrorApi } }

const AUTH_REDIRECT_DELAY_MS = 1500;

// The editor's controls, translated from the shared `.button` rules: they are
// utilities now, so the hooks below carry them explicitly.
const BTN = "h-11 min-h-11 min-w-11 inline-flex items-center justify-center gap-2 px-3 border border-solid border-xw-line-hi rounded-md bg-xw-raised text-xw-text text-xs font-medium leading-normal no-underline whitespace-nowrap appearance-none cursor-pointer transition-[transform,border-color,background-color] duration-micro ease-xw [&:hover:not(:disabled)]:-translate-y-px [&:hover:not(:disabled)]:border-[#4b5873] [&:hover:not(:disabled)]:bg-[#172034] [&:active:not(:disabled)]:scale-[.96] disabled:opacity-[.42] disabled:cursor-not-allowed";
const BTN_PRIMARY = "border-xw-accent-border bg-xw-accent-fill text-white [&:hover:not(:disabled)]:bg-xw-accent-fill-hover [&:hover:not(:disabled)]:border-xw-accent [&:hover:not(:disabled)]:text-white";
const BTN_DANGER = "text-[#ff9ba3] border-[#67323b] bg-[#24161d] [&:hover:not(:disabled)]:border-[#a65260] [&:hover:not(:disabled)]:bg-[#421e28]";

// Saves that fit in one chunk go out as a single PUT. Larger saves go through
// the shared resumable upload engine (see `saveDocument`), which chunks at this
// size and retries only the bytes the server has not accepted yet.
const SAVE_CHUNK_BYTES = 8 * 1024 * 1024;

// The motion numbers the editor's stylesheet used to own: the 340ms page
// entrance (`xw-page-in`), the 150/170ms page-leaving pair the handover waits
// on, and the 180ms/160ms surface pair a card appears and leaves with. A
// reduced-motion user gets the same states with no travel and no delay.
const PAGE_ENTER_SECONDS = 0.34;
const LEAVING_OPACITY_SECONDS = 0.15;
const LEAVING_MOVE_SECONDS = 0.17;
const SURFACE_ENTER_SECONDS = 0.18;
const SURFACE_EXIT_SECONDS = 0.16;
const XW_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

function saveChunkBytes(boot: EditorBootstrap): number {
  const serverMax = boot.maxChunkBytes > 0 ? boot.maxChunkBytes : SAVE_CHUNK_BYTES;
  return Math.max(1, Math.min(SAVE_CHUNK_BYTES, serverMax));
}

function Logo(): React.JSX.Element {
  return <svg className="brand-mark" viewBox="0 0 200 200" aria-label="X-wing logo"><rect x="6" y="6" width="188" height="188" rx="36"/><g fill="none" strokeLinecap="round" strokeLinejoin="round"><polygon points="71,78 23,48 15,100 23,152 71,122"/><polyline points="71,78 30,100 71,122"/><polygon points="129,78 177,48 185,100 177,152 129,122"/><polyline points="129,78 170,100 129,122"/><path d="m71 78 15 8m-15 36 15-8m43-36-15 8m15 36-15-8"/><circle cx="100" cy="100" r="20"/><circle cx="100" cy="100" r="13"/></g><circle className="brand-core" cx="100" cy="100" r="4.5"/></svg>;
}

function EditorApp({ boot }: { boot: EditorBootstrap }): React.JSX.Element {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<CodeMirrorView | null>(null);
  const closingRef = useRef(false);
  const logoutForm = useRef<HTMLFormElement>(null);
  const saved = useRef(boot.content);
  const allowLeave = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [confirmLeave, setConfirmLeave] = useState<string | null>(null);
  const [authOverlay, setAuthOverlay] = useState<keyof typeof AUTH_OVERLAY_COPY | null>(null);
  const [pageLeaving, setPageLeaving] = useState(false);
  const canEdit = boot.canWrite && !boot.truncated;
  const reduceMotion = prefersReducedMotion();

  // A 401, a rejected upload or the idle timer all announce through one event,
  // so the editor shows the same overlay the file browser does.
  useEffect(() => {
    const onAuthRedirect = (): void => setAuthOverlay("expired");
    window.addEventListener(AUTH_REDIRECT_EVENT, onAuthRedirect);
    return () => window.removeEventListener(AUTH_REDIRECT_EVENT, onAuthRedirect);
  }, []);

  useEffect(() => {
    const cm = window.CM;
    const language = detectLanguage(cm, boot.extension);
    const editor = new cm.EditorView({
      state: cm.EditorState.create({ doc: boot.content, extensions: [
        cm.basicSetup, cm.keymap.of([cm.indentWithTab]), cm.oneDark,
        cm.EditorView.contentAttributes.of({ "aria-label": `${boot.filename} contents` }),
        ...(boot.cspNonce ? [cm.EditorView.cspNonce.of(boot.cspNonce)] : []),
        ...language,
        ...(!canEdit ? [cm.EditorView.editable.of(false), cm.EditorState.readOnly.of(true)] : []),
        cm.EditorView.lineWrapping,
        cm.EditorView.updateListener.of(update => { if (update.docChanged) setDirty(update.state.doc.toString() !== saved.current); }),
      ] }),
      parent: mount.current,
    });
    view.current = editor;
    editor.focus();
    return () => editor.destroy();
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty && !allowLeave.current) event.preventDefault(); };
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      if (event.key === "Escape" && !event.defaultPrevented && !window.CM.searchPanelOpen(view.current?.state)) {
        if (!confirmLeave) { event.preventDefault(); requestLeave(boot.directory); }
      }
    };
    const onKeydownCapture = (event: KeyboardEvent) => {
      const cm = window.CM;
      const editor = view.current;
      if (!editor) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && cm.searchPanelOpen(editor.state)) {
        const field = mount.current?.querySelector<HTMLInputElement>(".cm-panel.cm-search [main-field]");
        if (field) { event.preventDefault(); event.stopPropagation(); field.focus(); field.select(); }
        return;
      }
      if (event.key === "Escape" && closeSearchPanelAnimated()) { event.preventDefault(); event.stopPropagation(); }
    };
    const onCloseClickCapture = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(".cm-panel.cm-search [name=close]")) return;
      if (closeSearchPanelAnimated()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", beforeUnload); document.addEventListener("keydown", shortcut);
    document.addEventListener("keydown", onKeydownCapture, true);
    document.addEventListener("click", onCloseClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("keydown", shortcut);
      document.removeEventListener("keydown", onKeydownCapture, true);
      document.removeEventListener("click", onCloseClickCapture, true);
    };
  }, [dirty, confirmLeave]);

  function closeSearchPanelAnimated(): boolean {
    const cm = window.CM;
    const editor = view.current;
    if (!editor || closingRef.current || !cm.searchPanelOpen(editor.state)) return false;
    closingRef.current = true;
    const panel = mount.current?.querySelector(".cm-panel.cm-search");
    if (panel && !prefersReducedMotion()) {
      panel.classList.add("closing");
      window.setTimeout(() => {
        cm.closeSearchPanel(editor);
        closingRef.current = false;
      }, 160);
    } else {
      cm.closeSearchPanel(editor);
      closingRef.current = false;
    }
    return true;
  }

  useEffect(() => {
    if (!boot.authIdleTimeout) return;
    let deadline = Date.now() + boot.authIdleTimeout * 1000;
    let timer = window.setTimeout(expire, boot.authIdleTimeout * 1000);
    function expire(): void {
      if (Date.now() < deadline) { timer = window.setTimeout(expire, deadline - Date.now()); return; }
      beginAuthRedirect();
    }
    function activity(): void { deadline = Date.now() + boot.authIdleTimeout * 1000; window.clearTimeout(timer); timer = window.setTimeout(expire, boot.authIdleTimeout * 1000); }
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach(name => window.addEventListener(name, activity, { passive: true }));
    return () => { window.clearTimeout(timer); events.forEach(name => window.removeEventListener(name, activity)); };
  }, []);

  const requireAuthOk = (response: Response): void => {
    if (response.status === 401 || new URL(response.url || location.href, location.href).pathname === "/_auth/login") {
      beginAuthRedirect(); throw new Error("authentication required");
    }
  };

  /**
   * Save a large document through the shared upload engine: `init` → ranged
   * PUTs → `complete`, which replaces the file atomically. A failed request
   * retries from whatever the server already holds instead of resending the
   * whole document, and a DLP scan shows as "waiting for server" rather than a
   * killed save.
   */
  const saveDocument = async (blob: Blob): Promise<void> => {
    const client = new UploadClient({});
    await uploadFile({
      client,
      file: blob,
      filename: boot.filename,
      destDir: boot.directory,
      chunkSize: saveChunkBytes(boot),
      callbacks: {
        onProgress: (committed: number, total: number) => {
          setStatus(`Saving… ${total > 0 ? Math.round((committed / total) * 100) : 0}%`);
        },
        onState: (state: string) => {
          if (state === UploadState.PROCESSING) setStatus("Saving… waiting for server");
        },
      },
    });
  };

  const save = async (): Promise<void> => {
    if (!canEdit || !view.current) return;
    const content = view.current.state.doc.toString();
    // Blob slices are lazy views: chunking never copies the whole document,
    // unlike one giant request body that must fully buffer before sending.
    const blob = new Blob([content], { type: "text/plain; charset=utf-8" });
    const chunkSize = saveChunkBytes(boot);
    try {
      if (blob.size <= chunkSize) {
        setStatus("Saving…");
        const response = await fetch(boot.path, { method: "PUT", body: content, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        requireAuthOk(response);
        if (!response.ok) throw new Error(`Save failed (${response.status})`);
      } else {
        setStatus("Saving… 0%");
        await saveDocument(blob);
      }
      saved.current = content; setDirty(false); setStatus("Saved");
      window.setTimeout(() => setStatus(""), 2500);
    } catch (error) {
      if (error instanceof UploadError && (error.status === 401 || error.status === 403 || error.code === "BAD_RESPONSE")) {
        beginAuthRedirect();
        setStatus("Sign-in required");
        return;
      }
      setStatus(error instanceof Error ? error.message : "Save failed");
    }
  };

  const navigateAway = (href: string): void => {
    if (pageLeaving) return;
    allowLeave.current = true;
    setPageLeaving(true);
    window.setTimeout(() => location.assign(href), prefersReducedMotion() ? 0 : 170);
  };

  const requestLeave = (href: string): void => {
    if (dirty) setConfirmLeave(href); else navigateAway(href);
  };

  const leave = (): void => { if (!confirmLeave) return; allowLeave.current = true; if (confirmLeave === "__logout__") { setAuthOverlay("logout"); window.setTimeout(() => logoutForm.current?.submit(), AUTH_REDIRECT_DELAY_MS); } else navigateAway(confirmLeave); };

  return <m.div
    className={cn(
      "editor-app grid h-full grid-rows-[52px_minmax(0,1fr)] bg-xw-bg font-sans text-xw-text",
      pageLeaving && "pointer-events-none",
    )}
    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
    animate={pageLeaving ? { opacity: 0, y: -5 } : { opacity: 1, y: 0 }}
    transition={pageLeaving
      ? { opacity: { duration: reduceMotion ? 0 : LEAVING_OPACITY_SECONDS }, y: { duration: reduceMotion ? 0 : LEAVING_MOVE_SECONDS } }
      : { duration: reduceMotion ? 0 : PAGE_ENTER_SECONDS, ease: XW_EASE }}
  >
    {/* The editor's view heading; the visible file name sits in the topbar. */}
    <h1 id="editor-title" className="sr-only">{boot.filename}</h1>
    {/* `.topbar` still declares the flex display and the phone padding for both
        shells, so the editor's grid override carries the important marker until
        the file panel drops that shared rule. */}
    <header className="topbar editor-topbar !grid grid-cols-[1fr_minmax(220px,2fr)_1fr] max-[700px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[700px]:!px-3"><a className="brand flex items-center gap-2 min-h-11 text-inherit no-underline rounded-md" href="/" aria-label="X-wing EDITOR, home" onClick={event => { event.preventDefault(); requestLeave("/"); }}><Logo/><span className="max-[700px]:hidden font-sans text-[13px] font-semibold leading-none text-[#f1f3f7]">X-wing</span><small className="max-[700px]:!hidden brand-context h-[13px] inline-flex items-center -translate-y-px text-xw-faint text-[11px] font-medium leading-none">EDITOR</small></a><div className="editor-heading flex min-w-0 flex-col items-center leading-tight max-[700px]:items-start max-[700px]:pl-2"><strong className="max-w-full truncate font-mono text-xs font-medium">{boot.filename}</strong><span className="max-w-full truncate font-mono text-[11px] text-xw-faint" role="status" aria-live="polite">{status || (dirty ? "Unsaved changes" : boot.displayPath)}</span></div><div className="editor-actions flex items-center justify-end gap-1"><a className={cn("button max-[700px]:!hidden", BTN)} href={boot.path} download>Download</a><button className={cn("button primary", BTN, BTN_PRIMARY)} disabled={!canEdit || !dirty} onClick={() => void save()}>Save</button>{boot.user.authenticated ? <div className="account-inline flex items-center gap-2 text-[#aeb6c5] text-xs"><span>{boot.user.name}</span><form ref={logoutForm} id="logout-form" method="post" action="/_auth/logout" onSubmit={event => { event.preventDefault(); if (dirty) setConfirmLeave("__logout__"); else { setAuthOverlay("logout"); const form = event.currentTarget; window.setTimeout(() => form.submit(), AUTH_REDIRECT_DELAY_MS); } }}><button className="signout-button h-11 min-h-11 px-2 border border-solid border-xw-line-hi rounded-md bg-transparent text-[#aeb6c5] text-[11px] font-medium hover:border-[#67323b] hover:bg-[#24161d] hover:text-[#ff9ba3]" type="submit">Sign out</button></form></div> : <span className="anonymous-label">anonymous</span>}</div></header>
    <AnimatePresence>
      {(!boot.canWrite || boot.truncated) && <m.div
        key="notices"
        className="editor-notices absolute right-3 top-[62px] z-raise flex flex-col items-end gap-1"
        initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 7, scale: 0.98, transition: { duration: reduceMotion ? 0 : SURFACE_EXIT_SECONDS, ease: "easeIn" } }}
        transition={{ duration: reduceMotion ? 0 : SURFACE_ENTER_SECONDS, ease: XW_EASE }}
      >
        {!boot.canWrite && <div className="readonly-notice m-0 px-3 py-2 border border-solid border-[#544829] rounded-lg bg-[#211d14] text-[#e6c77f] text-xs">Read-only access. Saving changes is disabled.</div>}
        {boot.truncated && <div className="readonly-notice m-0 px-3 py-2 border border-solid border-[#544829] rounded-lg bg-[#211d14] text-[#e6c77f] text-xs">Showing first {formatBytes(boot.previewBytes)} of {formatBytes(boot.totalSize)}. File too large to edit here — use Download for the full file.</div>}
      </m.div>}
    </AnimatePresence>
    <main className="editor-body grid min-h-0 grid-cols-[45px_minmax(0,1fr)] max-[700px]:grid-cols-[38px_minmax(0,1fr)]" aria-labelledby="editor-title"><aside className="editor-rail flex flex-col items-center gap-3 border-0 border-r border-solid border-xw-line bg-[#0b1019] pt-2"><button className="editor-back h-[31px] w-[31px] cursor-pointer rounded-md border border-solid border-xw-line-hi bg-xw-raised text-xw-muted hover:bg-xw-hover hover:text-xw-text" onClick={() => requestLeave(boot.directory)} aria-label="Back to files" title="Back to files">←</button><span className="font-mono text-[11px] text-xw-faint [writing-mode:vertical-rl]">{boot.extension || "TXT"}</span></aside><div className="editor-canvas min-h-0 min-w-0 overflow-hidden" ref={mount}/></main>
    <AnimatePresence>{confirmLeave && <DiscardDialog key="discard" onCancel={() => setConfirmLeave(null)} onDiscard={leave}/>}</AnimatePresence>
    {authOverlay && <AuthOverlay kind={authOverlay}/>}
  </m.div>;
}

/**
 * The unsaved-changes dialog. Its markup is the shared `.modal-backdrop` /
 * `.modal` shell, which owns the entrance (and is shared with the file
 * browser), so only the departure is the editor's: `AnimatePresence` holds it
 * for the 160ms `xw-surface-out` the dialog used to cut short.
 */
function DiscardDialog({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }): React.JSX.Element {
  const modalRef = useModalFocus<HTMLDivElement>(onCancel);
  const reduceMotion = prefersReducedMotion();
  const exit = reduceMotion ? { duration: 0 } : { duration: SURFACE_EXIT_SECONDS, ease: "easeIn" } as const;
  return <m.div ref={modalRef} className="modal-backdrop" initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: exit }}>
    <m.div className="modal" role="dialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-description" initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0, y: 7, scale: 0.98, transition: exit }}>
      <h2 id="discard-title">Discard unsaved changes?</h2><p id="discard-description">This file has unsaved edits. Leave without saving?</p><div className="modal-actions"><button className={cn("button", BTN)} onClick={onCancel}>Keep editing</button><button data-autofocus className={cn("button danger", BTN, BTN_DANGER)} onClick={onDiscard}>Discard changes</button></div>
    </m.div>
  </m.div>;
}



function detectLanguage(cm: CodeMirrorApi, extension: string): unknown[] {
  const aliases: Record<string, string> = { py:"python",js:"javascript",jsx:"javascript",ts:"javascript",tsx:"javascript",html:"html",htm:"html",css:"css",json:"json",yaml:"yaml",yml:"yaml",md:"markdown",xml:"xml",svg:"xml",sql:"sql",sh:"shell",bash:"shell",zsh:"shell",toml:"toml",dockerfile:"dockerfile",nginx:"nginx" };
  const factory = cm.langs[aliases[extension] || extension];
  if (!factory) return [];
  try { return [factory()]; } catch { return []; }
}

const node = document.getElementById("xwing-editor-bootstrap");
const root = document.getElementById("xwing-editor-root");
if (node?.textContent && root) createRoot(root).render(
  <LazyMotion features={domAnimation} strict>
    <MotionConfig reducedMotion="user">
      <EditorApp boot={JSON.parse(node.textContent) as EditorBootstrap}/>
    </MotionConfig>
  </LazyMotion>,
);
