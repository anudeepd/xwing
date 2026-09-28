import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation } from "motion/react";
import * as m from "motion/react-m";
import { escapeHtml, formatBytes, formatDate, prefersReducedMotion } from "./format";
import { AuthOverlay } from "./auth-overlay";
const BTN = `${CONTROL} ${CONTROL_FILE} ${CONTROL_COMPACT}`;
const BTN_PRIMARY = `${CONTROL_PRIMARY} ${CONTROL_PRIMARY_COMPACT}`;
const BTN_DANGER = CONTROL_DANGER;
const BTN_GHOST = CONTROL_GHOST;
import { cn } from "./lib/cn";
import {
  ACCOUNT_INLINE,
  BRAND,
  BRAND_CONTEXT,
  BRAND_NAME,
  CONTROL,
  CONTROL_COMPACT,
  CONTROL_DANGER,
  CONTROL_FILE,
  CONTROL_ICON,
  CONTROL_ICON_ROW,
  CONTROL_GHOST,
  CONTROL_PRIMARY,
  CONTROL_PRIMARY_COMPACT,
  MENU_ITEM,
  RAIL,
  SIGNOUT,
  TOAST,
  TOAST_ERROR,
  TOAST_ICON,
  TOAST_MESSAGE,
  TOAST_SUCCESS,
  TOAST_TIMER,
  TOPBAR,
} from "./ui";

import { useModalFocus } from "./keyboard";
import { nearestSurvivor, selectionRange } from "./selection";
import { nextSort, normalizeSortPreference, sortFiles } from "./sort";
import type { SortEntry, SortKey } from "./sort";
import { permissionNotice } from "./permissions";
import { renameDestination } from "./rename";
import { DIRECTORY_MEDIA_TYPE, encodePath, parseBootstrap } from "./types";
import type { Parallelism, XwingBootstrapV1, XwingFile } from "./types";
import { collectDroppedEntries } from "./drop-entries";
import { AUTH_OVERLAY_COPY, AUTH_REDIRECT_EVENT, beginAuthRedirect, consumeHandover, dismissBootCard, markHandover } from "./shared.js";
import { UploadManager } from "./upload-manager";
import { uploadItemLabel, uploadSummary, uploadSummaryKind } from "./upload-summary";

interface Toast {
  id: number;
  message: string;
  kind: "success" | "error" | "deleted" | "restored";
  duration: number;
  action?: { label: string; run: () => void };
}
type Dialog =
  | { kind: "mkdir"; value: string; error?: string | undefined }
  | { kind: "delete"; paths: string[]; pending: boolean; error?: string | undefined }
  | { kind: "rename"; path: string; name: string; value: string; pending: boolean; error?: string | undefined }
  | null;

type DropWaitState = "preparing" | "delayed" | null;

/**
 * Where keyboard focus should land once the listing it targets is on screen.
 * Queued rather than applied immediately: focusing straight after a state
 * update races React's commit, so the query runs against the previous
 * directory's rows and focus lands on a node that is about to be replaced.
 */
type PendingFocus =
  | { kind: "path"; path: string | null; fallbackToFirst: boolean }
  | { kind: "name"; name: string };

const uploadManager = new UploadManager();
const PARALLEL_VALUES: Parallelism[] = [1, 2, 4, 8];
const AUTH_REDIRECT_DELAY_MS = 1500;
const SORT_STORAGE_VERSION = "v2";
const DRAG_OVERLAY_STALE_MS = 1500;
const DROP_DELAYED_MS = 15000;
/** How often the open folder is re-read so external changes show up on their own. */
const AUTO_REFRESH_MS = 15000;
/** How many consecutive background refreshes may fail before the statusbar says so. */
const REFRESH_FAILURE_NOTICE = 3;
const DELETE_KEYS: Record<string, true> = { Delete: true, Backspace: true };
/** The sort button inside a header cell is `height:100%`, so its cell must have a definite height. */
const SORT_CELL: React.CSSProperties = { height: "100%" };
/** ARIA requires columnheader cells inside a row; `display:contents` keeps that wrapper out of the CSS grid so the header cells still lay out as direct grid children of `.table-head`. */
const ROW_CONTENTS: React.CSSProperties = { display: "contents" };

function sortStorageKey(user: string): string {
  return `xwing.sort.${SORT_STORAGE_VERSION}.${user}`;
}

/** The server calls the root crumb "Home"; the UI shows it as "workspace". */
function crumbLabel(name: string): string {
  return name === "Home" || !name ? "workspace" : name;
}

/** Duration for a presence element. Reduced motion keeps the state change and
 *  drops the wait, which is what the previous CSS-and-timer choreography did. */
function presenceDuration(reduced: boolean, seconds = 0.18): number {
  return reduced ? 0 : seconds;
}

function TransitionVeil({ active, label }: { active: boolean; label: string }): React.JSX.Element | null {
  const reduced = prefersReducedMotion();
  return <AnimatePresence>
    {active && <m.div key="veil" className="transition-veil fixed inset-0 z-rail flex items-center justify-center pointer-events-none bg-[rgba(8,11,18,.6)]" role="status" aria-label={label}
      initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: presenceDuration(reduced) }}>
      <m.div className="transition-veil-pill flex items-center gap-2 px-3 py-1 border border-solid border-xw-line rounded-full bg-[rgba(13,17,27,.9)] text-xw-muted text-[11px] font-semibold shadow-[0_8px_24px_rgba(0,0,0,.3)]" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}>
        <span className="transition-veil-spinner w-3 h-3 flex-none border-2 border-solid border-xw-line border-t-xw-accent-hi rounded-full animate-[xw-spin_.8s_linear_infinite]" aria-hidden="true"/><span>{label}</span>
      </m.div>
    </m.div>}
  </AnimatePresence>;
}

function Logo(): React.JSX.Element {
  return <svg className="brand-mark" viewBox="0 0 200 200" aria-label="X-wing logo">
    <rect x="6" y="6" width="188" height="188" rx="36" />
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="71,78 23,48 15,100 23,152 71,122" /><polyline points="71,78 30,100 71,122" />
      <polygon points="129,78 177,48 185,100 177,152 129,122" /><polyline points="129,78 170,100 129,122" />
      <path d="m71 78 15 8m-15 36 15-8m43-36-15 8m15 36-15-8" />
      <circle cx="100" cy="100" r="20" /><circle cx="100" cy="100" r="13" />
    </g><circle className="brand-core" cx="100" cy="100" r="4.5" />
  </svg>;
}


function Icon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, React.ReactNode> = {
    upload: <g transform="translate(0 .5)"><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v4h16v-4"/></g>,
    folderUpload: <g transform="translate(0 -1.5)"><path d="M3 7h7l2 2h9v11H3z"/><path d="M12 16v-5m0 0-2 2m2-2 2 2"/></g>,
    folderAdd: <g transform="translate(0 -1.5)"><path d="M3 7h7l2 2h9v11H3z"/><path d="M12 12v5m-2.5-2.5h5"/></g>,
    folder: <path d="M3 7h7l2 2h9v11H3z"/>,
    file: <><path d="M6 2h9l4 4v16H6z"/><path d="M15 2v5h5"/></>,
    download: <><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M4 19h16"/></>,
    rename: <><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7"/><path d="M10 11v5m4-5v5"/></>,
    check: <path d="m5 12.5 4.25 4.25L19 7.5"/>, chevron: <path d="m7 10 5 5 5-5"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>, retry: <path d="M20 11a8 8 0 1 0-2 5.3M20 4v7h-7"/>,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function readBootstrap(): XwingBootstrapV1 {
  const node = document.getElementById("xwing-bootstrap");
  if (!node?.textContent) throw new Error("X-wing bootstrap data is missing");
  return parseBootstrap(JSON.parse(node.textContent));
}

function useOutsideClose(ref: React.RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [close, ref]);
}

/** Cheap identity for a listing, so a background refresh only re-renders on a real change. */
function listingFingerprint(directory: XwingBootstrapV1): string {
  return directory.files.map(file => `${file.path}\u0000${file.kind}\u0000${file.size}\u0000${file.modified}`).join("\u0001");
}

function App({ initial }: { initial: XwingBootstrapV1 }): React.JSX.Element {
  const reduced = prefersReducedMotion();
  const [directory, setDirectory] = useState(initial);
  const [directoryState, setDirectoryState] = useState<"ready" | "loading" | "error">("ready");
  const [directoryError, setDirectoryError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<SortEntry[]>(() => readSort(initial.user.name));
  // The filter lives in the URL, so a filtered listing is shareable and the
  // back button restores it along with the folder.
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const [refreshFailures, setRefreshFailures] = useState(0);
  const [parallelOpen, setParallelOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [zipPending, setZipPending] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dropWaitState, setDropWaitState] = useState<DropWaitState>(null);
  const [arrivingNames, setArrivingNames] = useState<Set<string>>(() => new Set());
  const [pageLeaving, setPageLeaving] = useState(false);
  // Arriving from another panel: the shell is the whole show, so the boot card
  // stays out of it and the entrance matches the 170ms the other side left on.
  const [handover] = useState(() => consumeHandover());
  const [authOverlay, setAuthOverlay] = useState<keyof typeof AUTH_OVERLAY_COPY | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const parallelRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // The rail is an overlay, so how far a focused row must stay clear of the
  // bottom edge is its measured height, not a constant. Publish it as
  // --xw-rail-clearance for .file-row's scroll-margin-block-end.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const apply = (): void => {
      const rect = rail.getBoundingClientRect();
      const clearance = rect.height ? Math.ceil(window.innerHeight - rect.top + 8) : 0;
      document.documentElement.style.setProperty("--xw-rail-clearance", `${clearance}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(rail);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
      document.documentElement.style.removeProperty("--xw-rail-clearance");
    };
  }, []);
  const parallelMenu = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);
  const dragOverlayTimer = useRef<number | null>(null);
  const dropDelayTimer = useRef<number | null>(null);
  const completedUploads = useRef(new Set<string>());
  const pendingArrivalNames = useRef(new Set<string>());
  const autoRefreshTimer = useRef<number | null>(null);
  const arrivalTimer = useRef<number | null>(null);
  const currentDirectory = useRef(directory.path);
  const pendingFocus = useRef<PendingFocus | null>(null);
  currentDirectory.current = directory.path;
  const navigationInFlight = useRef(false);
  // True while the user is mid-action; auto refresh must never fight that work.
  const paneBusy = dialog !== null
    || dragging
    || dropWaitState !== null
    || zipPending > 0
    || authOverlay !== null
    || uploadManager.hasActive();
  // Kept in a ref so the poll interval is not re-created on every upload tick.
  const backgroundBusy = useRef(paneBusy);
  useEffect(() => { backgroundBusy.current = paneBusy; });
  const upload = useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot);

  /** Close the parallel-uploads popover; focus returns to its trigger when the
   *  close came from the keyboard or from choosing an option. */
  const closeParallel = (restoreFocus = false): void => {
    setParallelOpen(false);
    if (restoreFocus) parallelRef.current?.querySelector<HTMLElement>(".parallel-trigger")?.focus();
  };

  useOutsideClose(parallelRef, () => setParallelOpen(false));
  useOutsideClose(accountRef, () => setAccountOpen(false));

  // Focus moves into the popover as it opens, so Escape is handled by the
  // popover's own key path instead of the file row that opened it.
  useEffect(() => {
    if (!parallelOpen) return;
    const menu = parallelMenu.current;
    if (!menu) return;
    (menu.querySelector<HTMLInputElement>("input[type='radio']") ?? menu).focus();
  }, [parallelOpen]);

  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || document.querySelector("[aria-modal='true']")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Escape and Delete belong to the field the user is typing in, not to the
      // file list.
      const typing = Boolean(target?.matches("input, textarea, select")) || Boolean(target?.isContentEditable);
      if (event.key === "Escape" && accountOpen) {
        event.preventDefault();
        setAccountOpen(false);
        accountRef.current?.querySelector<HTMLElement>(".account-trigger")?.focus();
      } else if (event.key === "Escape" && parallelOpen) {
        event.preventDefault();
        closeParallel(true);
      } else if (event.key === "Escape" && selected.size && !typing) {
        event.preventDefault();
        setSelected(new Set());
        setLastSelected(null);
      } else if (DELETE_KEYS[event.key] && selected.size && directory.permissions.delete && !parallelOpen && !typing) {
        event.preventDefault();
        setDialog({ kind: "delete", paths: [...selected], pending: false });
      }
    };
    document.addEventListener("keydown", handleGlobalKey);
    return () => document.removeEventListener("keydown", handleGlobalKey);
  }, [accountOpen, closeParallel, directory.permissions.delete, parallelOpen, selected]);

  const addToast = (message: string, kind: Toast["kind"] = "success", action?: Toast["action"], duration = 5200): void => {
    const id = Date.now() + Math.random();
    const toast: Toast = action ? { id, message, kind, action, duration } : { id, message, kind, duration };
    setToasts(current => [...current.slice(-2), toast]);
  };

  const dismissToast = (id: number): void => setToasts(current => current.filter(item => item.id !== id));

  /** Leave for another document. `handover` marks a move between the app's own
   *  panels (the editor, the console), which the destination reads so it skips
   *  its cold-load card. */
  const openDocument = (href: string, handoverTo: boolean = false): void => {
    if (pageLeaving) return;
    if (handoverTo) markHandover();
    setPageLeaving(true);
    window.setTimeout(() => location.assign(href), prefersReducedMotion() ? 0 : 170);
  };

  const navigate = async (path: string, historyMode: "push" | "replace" | "none" = "push"): Promise<void> => {
    const id = ++requestId.current;
    abort.current?.abort();
    navigationInFlight.current = true;
    const animate = historyMode === "push" && !prefersReducedMotion();
    try {
      if (animate) {
        setPageLeaving(true);
        await new Promise(resolve => window.setTimeout(resolve, 170));
        if (id !== requestId.current) return;
      } else setPageLeaving(false);
      const controller = new AbortController();
      abort.current = controller;
      setDirectoryState("loading");
      setDirectoryError("");
      try {
        const target = encodePath(path);
        const response = await authFetch(target, {
          headers: { Accept: DIRECTORY_MEDIA_TYPE }, signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseError(response));
        if (!response.headers.get("content-type")?.includes(DIRECTORY_MEDIA_TYPE)) throw new Error("The server returned an unexpected response");
        const next = parseBootstrap(await response.json());
        if (id !== requestId.current) return;
        setDirectory(next);
        setSelected(new Set());
        setLastSelected(null);
        setDirectoryState("ready");
        document.title = `X-wing — ${next.path}`;
        const url = encodePath(next.path === "/" ? "/" : `${next.path}/`);
        if (historyMode === "push") history.pushState({ path: next.path }, "", url);
        if (historyMode === "replace") history.replaceState({ path: next.path }, "", url);
        // A folder URL carries no filter: the query belongs to the listing the
        // user was filtering, not to the folder they just opened.
        if (historyMode !== "none") setQuery("");
        if (animate) setPageLeaving(false);
        pendingFocus.current = { kind: "path", path: null, fallbackToFirst: true };
      } catch (error) {
        if (controller.signal.aborted) return;
        setDirectoryState("error");
        setDirectoryError(errorMessage(error));
        if (animate) setPageLeaving(false);
      }
    } finally {
      if (id === requestId.current) navigationInFlight.current = false;
    }
  };

  useEffect(() => {
    history.replaceState({ path: initial.path }, "", location.href);
    const onPop = (): void => {
      // The URL is the filter's source of truth, so back/forward restore it.
      setQuery(new URLSearchParams(location.search).get("q") ?? "");
      void navigate(location.pathname, "none");
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (uploadManager.hasActive()) event.preventDefault();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => { window.removeEventListener("popstate", onPop); window.removeEventListener("beforeunload", onBeforeUnload); };
  }, []);

  // The shell is on screen, so the boot card can fade out under it.
  useEffect(() => {
    dismissBootCard(document, window, handover);
    document.documentElement.removeAttribute("data-arriving");
  }, []);

  useEffect(() => {
    const onAuthRedirect = (): void => setAuthOverlay("expired");
    window.addEventListener(AUTH_REDIRECT_EVENT, onAuthRedirect);
    return () => window.removeEventListener(AUTH_REDIRECT_EVENT, onAuthRedirect);
  }, []);

  useEffect(() => {
    const seconds = Number.parseInt(document.body.dataset.authIdleTimeout || "0", 10);
    if (!seconds) return;
    let deadline = Date.now() + seconds * 1000;
    let timer = window.setTimeout(expire, seconds * 1000);
    function expire(): void {
      if (Date.now() < deadline) { timer = window.setTimeout(expire, deadline - Date.now()); return; }
      beginAuthRedirect();
    }
    function activity(): void { deadline = Date.now() + seconds * 1000; window.clearTimeout(timer); timer = window.setTimeout(expire, seconds * 1000); }
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach(name => window.addEventListener(name, activity, { passive: true }));
    return () => { window.clearTimeout(timer); events.forEach(name => window.removeEventListener(name, activity)); };
  }, []);

  // Filtering runs over the already-sorted list, so a filter never changes the
  // order the user chose.
  const files = useMemo(() => {
    const sorted = sortFiles(directory.files, sort);
    const needle = query.trim().toLowerCase();
    return needle ? sorted.filter(file => file.name.toLowerCase().includes(needle)) : sorted;
  }, [directory.files, query, sort]);

  /** The filter is mirrored into `?q=` so the state is shareable and restorable. */
  const updateQuery = (value: string): void => {
    setQuery(value);
    const url = new URL(location.href);
    if (value) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    // replace, not push: typing must not fill the back button with keystrokes.
    history.replaceState(history.state, "", url);
  };

  const updateSort = (key: SortKey): void => {
    setSort(current => {
      const next = nextSort(current, key);
      try { localStorage.setItem(sortStorageKey(directory.user.name), JSON.stringify(next)); }
      catch { /* Storage can be unavailable (private mode); the sort still applies now. */ }
      return next;
    });
  };

  const toggleSelection = (file: XwingFile, index: number, gesture: { range: boolean; additive: boolean }): void => {
    setSelected(current => {
      if (!gesture.range && !gesture.additive) {
        return current.size === 1 && current.has(file.path) ? new Set() : new Set([file.path]);
      }
      const next = new Set(current);
      const shouldSelect = !current.has(file.path);
      if (gesture.range) {
        for (const path of selectionRange(files, lastSelected, index)) {
          if (shouldSelect) next.add(path);
          else next.delete(path);
        }
      } else if (shouldSelect) next.add(file.path);
      else next.delete(file.path);
      return next;
    });
    setLastSelected(file.path);
  };

  const refresh = (): Promise<void> => navigate(directory.path, "none");

  // Re-read the open folder without disturbing the view: no loading veil, no
  // selection reset, no error surface, and no re-render when nothing changed.
  const refreshListing = useCallback(async (): Promise<void> => {
    if (navigationInFlight.current) return;
    const path = currentDirectory.current;
    const id = ++requestId.current;
    const controller = new AbortController();
    abort.current = controller;
    try {
      const response = await authFetch(encodePath(path), {
        headers: { Accept: DIRECTORY_MEDIA_TYPE }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      if (!response.headers.get("content-type")?.includes(DIRECTORY_MEDIA_TYPE)) throw new Error("The server returned an unexpected response");
      const next = parseBootstrap(await response.json());
      if (id !== requestId.current || currentDirectory.current !== path) return;
      setDirectory(previous => listingFingerprint(previous) === listingFingerprint(next) ? previous : next);
      // Entries can vanish while the user is looking at them; keep the
      // selection and range anchor pointing at rows that still exist.
      setSelected(current => {
        const present = new Set(next.files.map(file => file.path));
        const kept = [...current].filter(selectedPath => present.has(selectedPath));
        return kept.length === current.size ? current : new Set(kept);
      });
      setLastSelected(current => (current && next.files.some(file => file.path === current)) ? current : null);
      setRefreshFailures(0);
    } catch {
      // Keep the last listing rather than interrupting the view with an error,
      // but stop pretending the view is current once the failures pile up.
      if (!controller.signal.aborted && id === requestId.current) setRefreshFailures(count => count + 1);
    }
  }, []);

  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState !== "visible" || backgroundBusy.current) return;
      void refreshListing();
    };
    const timer = window.setInterval(tick, AUTO_REFRESH_MS);
    // Returning to the tab should show the current state, not wait out the interval.
    const onVisibilityChange = (): void => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshListing]);

  useEffect(() => {
    const newlyCompleted = upload.items.filter(item => item.status === "completed" && !completedUploads.current.has(item.id));
    for (const item of newlyCompleted) completedUploads.current.add(item.id);

    const relevant = newlyCompleted.filter(item => item.destination === directory.path);
    if (!relevant.length) return;

    for (const item of relevant) {
      const topLevelName = item.relativePath.split("/").find(Boolean);
      if (topLevelName) pendingArrivalNames.current.add(topLevelName);
    }
    if (autoRefreshTimer.current !== null) window.clearTimeout(autoRefreshTimer.current);
    const refreshPath = directory.path;
    autoRefreshTimer.current = window.setTimeout(() => {
      autoRefreshTimer.current = null;
      if (currentDirectory.current !== refreshPath) {
        pendingArrivalNames.current.clear();
        return;
      }
      const names = new Set(pendingArrivalNames.current);
      pendingArrivalNames.current.clear();
      setArrivingNames(names);
      void navigate(refreshPath, "none").finally(() => {
        if (arrivalTimer.current !== null) window.clearTimeout(arrivalTimer.current);
        arrivalTimer.current = window.setTimeout(
          () => setArrivingNames(new Set()),
          prefersReducedMotion() ? 0 : 700,
        );
      });
    }, prefersReducedMotion() ? 0 : 140);
  }, [directory.path, upload.items]);

  useEffect(() => () => {
    if (autoRefreshTimer.current !== null) window.clearTimeout(autoRefreshTimer.current);
    if (arrivalTimer.current !== null) window.clearTimeout(arrivalTimer.current);
  }, []);

  const createFolder = async (): Promise<void> => {
    if (!dialog || dialog.kind !== "mkdir") return;
    const value = dialog.value.trim();
    if (!value || value.includes("/")) { setDialog({ ...dialog, error: "Enter one valid folder name." }); return; }
    const target = `${directory.path === "/" ? "" : directory.path}/${encodeURIComponent(value)}/`;
    let response: Response;
    try { response = await authFetch(target, { method: "MKCOL" }); }
    catch (error) { setDialog({ ...dialog, error: errorMessage(error) }); return; }
    if (!response.ok) { setDialog({ ...dialog, error: await responseError(response) }); return; }
    setDialog(null); addToast(`Created ${value}`); await refresh();
  };

  // Rename is a same-directory WebDAV MOVE: the name changes, the location does
  // not. Overwrite is refused (F) so renaming onto an existing name reports a
  // conflict instead of silently replacing the other item.
  const renamePath = async (): Promise<void> => {
    if (!dialog || dialog.kind !== "rename" || dialog.pending) return;
    const value = dialog.value.trim();
    if (!value || value.includes("/")) { setDialog({ ...dialog, error: "Enter one valid name." }); return; }
    if (value === dialog.name) { setDialog(null); return; }
    const destination = renameDestination(dialog.path, value);
    setDialog({ ...dialog, pending: true, error: undefined });
    let response: Response;
    try { response = await authFetch(dialog.path, { method: "MOVE", headers: { Destination: destination, Overwrite: "F" } }); }
    catch (error) { setDialog({ ...dialog, pending: false, error: errorMessage(error) }); return; }
    if (!response.ok) { setDialog({ ...dialog, pending: false, error: await responseError(response) }); return; }
    setDialog(null); addToast(`Renamed to ${value}`, "success");
    await refresh();
    pendingFocus.current = { kind: "name", name: value };
  };

  const deletePaths = async (): Promise<void> => {
    if (!dialog || dialog.kind !== "delete") return;
    const focusAfterDelete = nearestSurvivor(files, dialog.paths);
    setDialog({ ...dialog, pending: true, error: undefined });
    let response: Response;
    try {
      response = dialog.paths.length === 1
        ? await authFetch(dialog.paths[0]!, { method: "DELETE" })
        : await authFetch("/_bulk/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: dialog.paths }) });
    } catch (error) {
      setDialog({ ...dialog, pending: false, error: errorMessage(error) });
      return;
    }
    if (!response.ok) { setDialog({ ...dialog, pending: false, error: await responseError(response) }); return; }
    const data = await response.json().catch(() => ({})) as { transaction_id?: string };
    setDialog(null); setSelected(new Set());
    addToast(`${dialog.paths.length} item${dialog.paths.length === 1 ? "" : "s"} deleted`, "deleted", data.transaction_id ? {
      label: "Undo", run: () => void restore(data.transaction_id!),
    } : undefined, 15000);
    await refresh();
    pendingFocus.current = { kind: "path", path: focusAfterDelete, fallbackToFirst: false };
  };

  const restore = async (transaction: string): Promise<void> => {
    const response = await authFetch(`/api/restore/${transaction}`, { method: "POST" });
    if (!response.ok) addToast(await responseError(response), "error");
    else {
      const data = await response.json().catch(() => ({})) as { restored?: number };
      const count = data.restored ?? 0;
      addToast(count ? `${count} item${count === 1 ? "" : "s"} restored` : "Deleted items restored", "restored", undefined, 15000);
      await refresh();
    }
  };

  const downloadSelected = async (): Promise<void> => {
    // One archive at a time: the pending count is the button's label, not a
    // queue, so a second request would clear the first one's overlay.
    if (zipPending > 0) return;
    const paths = [...selected];
    // The server builds the archive on demand, so a large selection leaves the
    // toolbar waiting for a while; say so instead of looking inert.
    setZipPending(paths.length);
    try {
      const response = await authFetch("/_bulk/zip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths, base: directory.path }) });
      if (!response.ok) { addToast(await responseError(response), "error"); return; }
      downloadBlob(await response.blob(), contentDispositionFilename(response.headers.get("content-disposition")) || "xwing-selection.zip");
    } finally {
      setZipPending(0);
    }
  };

  const clearDropFeedback = useCallback((): void => {
    if (dragOverlayTimer.current !== null) {
      window.clearTimeout(dragOverlayTimer.current);
      dragOverlayTimer.current = null;
    }
    if (dropDelayTimer.current !== null) {
      window.clearTimeout(dropDelayTimer.current);
      dropDelayTimer.current = null;
    }
    dragDepth.current = 0;
    setDragging(false);
    setDropWaitState(null);
  }, []);

  const refreshDropFeedback = useCallback((): void => {
    setDragging(true);
    setDropWaitState(null);
    if (dragOverlayTimer.current !== null) window.clearTimeout(dragOverlayTimer.current);
    if (dropDelayTimer.current !== null) {
      window.clearTimeout(dropDelayTimer.current);
      dropDelayTimer.current = null;
    }
    dragOverlayTimer.current = window.setTimeout(() => {
      dragOverlayTimer.current = null;
      setDragging(false);
      setDropWaitState("preparing");
      dropDelayTimer.current = window.setTimeout(() => {
        dropDelayTimer.current = null;
        setDropWaitState("delayed");
      }, DROP_DELAYED_MS);
    }, DRAG_OVERLAY_STALE_MS);
  }, []);

  useEffect(() => {
    const clearWhenHidden = (): void => {
      if (document.hidden) clearDropFeedback();
    };
    window.addEventListener("drop", clearDropFeedback);
    window.addEventListener("dragend", clearDropFeedback);
    window.addEventListener("blur", clearDropFeedback);
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () => {
      window.removeEventListener("drop", clearDropFeedback);
      window.removeEventListener("dragend", clearDropFeedback);
      window.removeEventListener("blur", clearDropFeedback);
      document.removeEventListener("visibilitychange", clearWhenHidden);
      if (dragOverlayTimer.current !== null) window.clearTimeout(dragOverlayTimer.current);
      if (dropDelayTimer.current !== null) window.clearTimeout(dropDelayTimer.current);
    };
  }, [clearDropFeedback]);

  const queueFiles = (list: FileList | File[]): void => {
    if (!directory.permissions.write || !list.length) return;
    uploadManager.add(Array.from(list), directory.path, directory.upload.chunkSize);
  };

  /**
   * Dropping a folder hands us the folder itself, not its contents, so the
   * drop is walked before anything is queued. `collectDroppedEntries` reads
   * `dataTransfer.items` synchronously for that reason.
   */
  const queueDrop = async (dataTransfer: DataTransfer | null): Promise<void> => {
    if (!directory.permissions.write) return;
    const { entries, skipped } = await collectDroppedEntries(dataTransfer);
    if (entries.length === 0) {
      addToast(
        skipped > 0
          ? "Nothing could be read from that drop. Use the upload button instead."
          : "That drop contained no files. Drag files or a folder, or use the upload button.",
        "error",
      );
      return;
    }
    uploadManager.add(entries, directory.path, directory.upload.chunkSize);
  };

  const transitioning = directoryState === "loading" || pageLeaving;
  // One notice names every capability this account is missing, and every control
  // policy disables points at it: a dimmed control is never the only signal.
  // `permissionNotice` returns null only when write and delete are both granted,
  // which is also the only case where no control is disabled by policy, so the
  // hint can never reference a notice that is not on the page.
  const notice = permissionNotice(directory.permissions);
  const policyHint = notice ? "permission-notice" : undefined;
  // Served here, after the commit, so the rows belong to the listing the request
  // was made for. An auto-refresh re-enters this effect with nothing queued and
  // leaves the user's focus alone.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || directoryState !== "ready") return;
    pendingFocus.current = null;
    const rows = [...document.querySelectorAll<HTMLElement>(".file-row")];
    const target = pending.kind === "name"
      ? rows.find(row => row.querySelector(".filename")?.getAttribute("title") === pending.name)
      : (rows.find(row => row.dataset.path === pending.path) ?? (pending.fallbackToFirst ? rows[0] : null));
    (target ?? document.getElementById("file-list"))?.focus();
  }, [directory, directoryState]);
  // The empty state is an invitation or an orientation, so it follows the same
  // capability rule as the notice: a delete-only account is not read-only.
  const emptyStateHint = directory.permissions.write
    ? "Upload files or create a folder to get started."
    : directory.permissions.delete
      ? "You don't have permission to add files here."
      : "You have read-only access here.";

  return <m.div className="xw-app h-full grid grid-rows-[52px_minmax(0,1fr)] isolate bg-xw-bg max-[640px]:grid-rows-[48px_minmax(0,1fr)]"
    initial={reduced ? false : { opacity: 0, y: 6 }}
    animate={pageLeaving ? { opacity: 0, y: -5 } : { opacity: 1, y: 0 }}
    transition={pageLeaving
        ? { duration: presenceDuration(reduced, 0.17), ease: "easeIn" }
        : { duration: presenceDuration(reduced, handover ? 0.17 : 0.34), ease: [0.16, 1, 0.3, 1] }}
    onDragEnter={event => { event.preventDefault(); if (!directory.permissions.write) return; dragDepth.current += 1; refreshDropFeedback(); }}
    onDragOver={event => { if (!directory.permissions.write) return; event.preventDefault(); refreshDropFeedback(); }}
    onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) clearDropFeedback(); }}
    onDrop={event => { event.preventDefault(); clearDropFeedback(); void queueDrop(event.dataTransfer); }}>
    <TransitionVeil active={transitioning} label="Switching" />
    <a className="skip-link fixed top-2.5 left-2.5 z-modal -translate-y-[160%] min-h-8 border border-solid border-xw-accent-border rounded-md bg-xw-panel text-xw-text px-3 py-2 text-xs no-underline transition-transform duration-[120ms] focus-visible:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c4b5fd] max-[640px]:[&>span]:hidden" href="#file-list">Skip to files</a>
    {/* The browser's view heading. The visible label is the breadcrumb, which
        cannot itself become a heading without breaking the crumb row's layout. */}
    <h1 className="sr-only">{crumbLabel(directory.breadcrumbs[directory.breadcrumbs.length - 1]?.name ?? "")}</h1>
    <header className={cn("topbar", TOPBAR)}>
      <a className={BRAND} href="/" aria-label="X-wing FILES, home" onClick={event => { event.preventDefault(); openDocument("/", true); }}><Logo/><span className={BRAND_NAME}>X-wing</span><small className={BRAND_CONTEXT}>FILES</small></a>
      {directory.user.authenticated ? <div className={ACCOUNT_INLINE}>{directory.admin ? <div className="account relative" ref={accountRef}>
        <button className="account-trigger h-8 min-h-8 flex items-center gap-2 px-2 border border-solid border-transparent rounded-md bg-transparent text-[#aeb6c5] text-xs hover:border-xw-line-hi hover:bg-xw-raised hover:text-xw-text aria-expanded:border-xw-line-hi aria-expanded:bg-xw-raised aria-expanded:text-xw-text max-[640px]:[&>span]:hidden" type="button" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen(value => !value)}>
          <span>{directory.user.name}</span><Icon name="chevron"/>
        </button>
        {accountOpen && <div className="popover account-menu absolute right-0 top-[38px] z-popover min-w-[152px] p-1 border border-solid border-[#3b465c] rounded-[7px] bg-[#111827] shadow-[0_18px_45px_rgba(0,0,0,.46)] origin-top-right animate-[xw-surface-in_var(--xw-surface)_var(--xw-ease)]" role="menu" aria-label="Workspace navigation">
          <a className={cn(MENU_ITEM, "active bg-xw-hover text-xw-text")} href="/" role="menuitem" aria-current="page">Files</a>
          <a className={MENU_ITEM} href="/admin" role="menuitem" onClick={event => { event.preventDefault(); openDocument("/admin", true); }}>Admin panel</a>
        </div>}
      </div> : <span>{directory.user.name}</span>}<form id="logout-form" className="m-0" method="post" action="/_auth/logout" onSubmit={event => { event.preventDefault(); setAuthOverlay("logout"); const form = event.currentTarget; window.setTimeout(() => form.submit(), AUTH_REDIRECT_DELAY_MS); }}><button className={SIGNOUT} type="submit">Sign out</button></form></div> : <span className="anonymous-label px-2 text-[#a0a9b9] text-xs font-medium">anonymous</span>}
    </header>

    <main className={`workspace relative min-h-0 grid grid-rows-[auto_auto_minmax(0,1fr)] p-4 gap-3 max-w-none m-0 max-[640px]:p-2 max-[640px]:gap-2 ${dragging ? "dragging" : ""}`}>
      <section className="location flex items-center justify-between min-w-0" aria-label="Current location">
        <nav className="crumbs flex items-center gap-1 min-w-0 text-xw-muted text-xs font-mono leading-[normal]" aria-label="Breadcrumb">{directory.breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.path}>
          {index > 0 && <span className="slash text-[#444f63]">/</span>}
          {index === directory.breadcrumbs.length - 1 ? <span className="crumb current text-[#aab3c2] no-underline rounded-[4px] px-1 py-0.5 whitespace-nowrap max-w-[260px] overflow-hidden text-ellipsis text-xw-text font-semibold">{crumbLabel(crumb.name)}</span> : <a className="crumb text-[#aab3c2] no-underline rounded-[4px] px-1 py-0.5 whitespace-nowrap max-w-[260px] overflow-hidden text-ellipsis hover:bg-xw-hover hover:text-xw-text" href={crumb.path} onClick={event => { event.preventDefault(); void navigate(crumb.path); }}>{crumbLabel(crumb.name)}</a>}
        </React.Fragment>)}</nav>
        <div className="location-meta flex gap-3 text-xw-faint text-[11px] font-mono leading-[normal] tabular-nums max-[900px]:hidden"><span>{query.trim() ? `${files.length} of ${directory.files.length} items` : `${directory.files.length} items`}</span></div>
      </section>

      <div className="workspace-controls min-w-0 flex flex-col gap-3">
      {notice && <div id="permission-notice" className="readonly-notice m-0 px-3 py-2 border border-solid border-[#544829] rounded-lg bg-[#211d14] text-[#e6c77f] text-xs" role="status">{notice}</div>}
      <section className="actionbar min-h-11 flex items-center justify-between gap-3 p-1 border border-solid border-xw-line rounded bg-xw-panel max-[640px]:overflow-x-auto max-[640px]:gap-1" aria-label="File actions" aria-describedby={policyHint}>
        <div className="toolbar-group flex items-center gap-2 min-w-0">
          <button className={cn("button", BTN, BTN_PRIMARY)} disabled={!directory.permissions.write} aria-describedby={policyHint} onClick={() => fileInput.current?.click()}><Icon name="upload"/><span className="label">Upload files</span></button>
          <button className={cn("button hide-tablet max-[900px]:hidden", BTN)} aria-label="Upload folder" disabled={!directory.permissions.write} aria-describedby={policyHint} onClick={() => folderInput.current?.click()}><Icon name="folderUpload"/><span className="label">Upload folder</span></button>
          <button className={cn("button", BTN)} aria-label="New folder" disabled={!directory.permissions.write} aria-describedby={policyHint} onClick={() => setDialog({ kind: "mkdir", value: "" })}><Icon name="folderAdd"/><span className="label">New folder</span></button>
          <input ref={fileInput} type="file" multiple hidden onChange={event => { if (event.target.files) { clearDropFeedback(); queueFiles(event.target.files); } event.currentTarget.value = ""; }}/>
          <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)} onChange={event => { if (event.target.files) { clearDropFeedback(); queueFiles(event.target.files); } event.currentTarget.value = ""; }}/>
        </div>
        <div className={`toolbar-group selection-actions flex items-center gap-2 min-w-0 opacity-0 pointer-events-none translate-y-[3px] transition-[opacity,transform] duration-micro ease-xw max-[640px]:absolute max-[640px]:left-1.5 max-[640px]:right-1.5 max-[640px]:bg-xw-panel max-[640px]:z-base ${selected.size ? "visible opacity-100 pointer-events-auto translate-y-0" : ""}`} aria-hidden={!selected.size}>
          <span className="selection-pill h-7 min-h-7 inline-flex items-center gap-2 px-3 rounded-full border border-solid border-xw-accent-border bg-xw-accent-lo text-xw-accent-hi text-[11px] font-semibold tabular-nums max-[900px]:hidden max-[640px]:flex"><i/>{selected.size} selected</span>
          <button className={cn("button", BTN)} aria-label="Download selected as zip" disabled={!selected.size || zipPending > 0} aria-busy={zipPending > 0} onClick={() => void downloadSelected()}><Icon name="download"/><span className="label">Download zip</span></button>
          <button className={cn("button danger", BTN, BTN_DANGER)} aria-label="Delete selected" disabled={!selected.size || !directory.permissions.delete} aria-describedby={!directory.permissions.delete ? policyHint : undefined} onClick={() => setDialog({ kind: "delete", paths: [...selected], pending: false })}><Icon name="trash"/><span className="label">Delete</span></button>
          <button className={cn("button ghost", BTN, BTN_GHOST)} disabled={!selected.size} onClick={() => { const focusPath = lastSelected ?? selected.values().next().value ?? null; setSelected(new Set()); setLastSelected(null); focusFileRow(focusPath); }}>Clear</button>
        </div>
        <div className="toolbar-group toolbar-end flex items-center gap-2 min-w-0 ml-auto">
          <input className="filter-input w-[132px] h-[31px] min-h-[31px] px-3 border border-solid border-xw-line-hi rounded-md bg-xw-raised text-xw-text text-xs appearance-none placeholder:text-xw-faint max-[640px]:w-[112px] max-[640px]:px-2 max-[640px]:text-base" type="search" aria-label="Filter files by name" placeholder="Filter files" value={query} onChange={event => updateQuery(event.target.value)}/>
          <div className="parallel-wrap relative" ref={parallelRef}>
            <button className="parallel-trigger w-[126px] h-[31px] min-h-[31px] grid grid-cols-[1fr_auto] items-center gap-2 pl-3 pr-2 border border-solid border-xw-line-hi rounded-md bg-xw-raised hover:border-xw-accent-border hover:bg-[#171d2e] aria-expanded:border-xw-accent-border aria-expanded:bg-[#171d2e] [&[aria-expanded=true]>.ui-icon]:rotate-180 max-[640px]:w-[76px]" aria-label={`Parallel uploads: ${upload.parallel}`} aria-haspopup="dialog" aria-expanded={parallelOpen} onClick={() => parallelOpen ? closeParallel(true) : setParallelOpen(true)}>
              <span className="parallel-copy flex items-baseline justify-between gap-2 font-sans [&>span]:text-[#7f8a9e] [&>span]:text-[11px] [&>span]:font-medium [&>span]:uppercase [&>span]:max-[640px]:hidden [&>strong]:text-[#eef0f5] [&>strong]:text-xs [&>strong]:font-medium [&>strong]:font-mono"><span>Parallel</span><strong>{upload.parallel}</strong></span><Icon name="chevron"/>
            </button>
            {parallelOpen && <div ref={parallelMenu} className="popover parallel-menu absolute right-0 top-[36px] z-popover min-w-[184px] p-1 border border-solid border-[#3b465c] rounded-[7px] bg-[#111827] shadow-[0_18px_45px_rgba(0,0,0,.46)] origin-top-right animate-[xw-surface-in_var(--xw-surface)_var(--xw-ease)]" role="dialog" aria-label="Concurrent uploads" tabIndex={-1}>
              <div className="menu-title px-2 pt-1 pb-2 text-[#788499] text-[11px] font-medium uppercase">Concurrent uploads</div>
              <div role="radiogroup">{PARALLEL_VALUES.map(value => <label className={cn("parallel-option min-h-[34px] flex items-center justify-between px-2 rounded-[5px] text-[#b9c1ce] cursor-pointer text-[11px] hover:bg-xw-hover [&>input]:absolute [&>input]:opacity-0 [&>span]:flex [&>span]:items-baseline [&>span]:gap-2 [&>strong]:min-w-3 [&>strong]:text-[#eef0f5] [&>small]:text-[#8792a5] [&>small]:text-[11px]", upload.parallel === value && "selected bg-xw-accent-lo text-xw-accent-hi")} key={value}>
                <input type="radio" name="parallel" value={value} checked={upload.parallel === value} onChange={() => { uploadManager.setParallel(value); closeParallel(true); }}/>
                <span><strong>{value}</strong><small>at a time</small></span>{upload.parallel === value && <Icon name="check"/>}
              </label>)}</div>
            </div>}
          </div>
        </div>
      </section>
      </div>

      <section className="file-surface relative min-h-0 grid grid-rows-[minmax(0,1fr)_30px] border border-solid border-xw-line rounded overflow-hidden bg-xw-panel" aria-label="Files and folders" aria-busy={directoryState === "loading"} onKeyDown={event => {
        if ((event.target as Element).closest(".file-row")) return;
        if (DELETE_KEYS[event.key] && directory.permissions.delete && selected.size) { event.preventDefault(); setDialog({ kind: "delete", paths: [...selected], pending: false }); }
        else if (event.key === "Escape" && selected.size) { event.preventDefault(); setSelected(new Set()); setLastSelected(null); }
      }}>
        <div className="file-table grid grid-rows-[36px_minmax(0,1fr)] min-h-0 overflow-auto [scrollbar-gutter:stable]" role="table" aria-label="Files" aria-rowcount={files.length + 1} aria-describedby={policyHint}>
        <div className={cn("table-head sticky top-0 z-raise border-0 border-b border-solid border-xw-line bg-[#0b101a] text-xw-faint text-[11px] font-medium font-mono uppercase items-stretch", "grid grid-cols-[38px_34px_minmax(240px,1fr)_112px_168px_92px] px-2 max-[900px]:grid-cols-[38px_34px_minmax(180px,1fr)_90px_120px_92px] max-[640px]:grid-cols-[38px_30px_minmax(120px,1fr)_64px_56px]")} role="rowgroup"><span role="row" style={ROW_CONTENTS}><label className="select-all h-full grid place-items-center bg-transparent border-0 cursor-pointer" role="columnheader"><SelectionCheckbox label={selected.size === files.length ? "Deselect all" : "Select all"} checked={files.length > 0 && selected.size === files.length} indeterminate={selected.size > 0 && selected.size < files.length} onToggle={() => { setSelected(selected.size === files.length ? new Set() : new Set(files.map(file => file.path))); setLastSelected(null); }}/></label><span role="columnheader"/>{(["name", "size", "modified"] as SortKey[]).map(key => { const index = sort.findIndex(entry => entry.key === key); const entry = sort[index]; const label = key === "modified" ? "Modified" : key[0]!.toUpperCase() + key.slice(1); return <span key={key} className={cn("sort-cell flex", key === "modified" && "max-[640px]:hidden")} role="columnheader" aria-sort={entry ? (entry.direction === "asc" ? "ascending" : "descending") : "none"} style={SORT_CELL}><button className={cn("sort h-full w-full flex items-center gap-1 bg-transparent text-inherit text-left uppercase hover:text-[#aab5c9]", key === "modified" && "date max-[640px]:hidden", entry && "active")} aria-label={`${label}, ${entry ? `${entry.direction === "asc" ? "ascending" : "descending"}, priority ${index + 1}` : "not sorted"}`} onClick={() => updateSort(key)}>{label} {entry && <span>{entry.direction === "asc" ? "▲" : "▼"}{sort.length > 1 ? index + 1 : ""}</span>}</button></span>; })}<span role="columnheader"/></span></div>
        <div id="file-list" className="file-list min-h-0 transition-[opacity,transform] duration-150 ease-in-out" role="rowgroup" tabIndex={-1}>
          {directoryState === "error" && <div className="state-panel h-full min-h-[220px] flex flex-col items-center justify-center gap-2 text-xw-muted text-pretty"><strong>Couldn’t open this folder</strong><span>{directoryError}</span><button className={cn("button", BTN)} onClick={() => void refresh()}>Retry</button></div>}
          {!files.length && directoryState !== "error" && <div className="state-panel empty h-full min-h-[220px] flex flex-col items-center justify-center gap-2 text-xw-muted text-pretty"><span className="empty-icon w-[46px] h-[46px] grid place-items-center border border-solid border-xw-line rounded-[10px] bg-xw-raised text-[#d8b963] [&_.ui-icon]:w-[22px] [&_.ui-icon]:h-[22px]"><Icon name="folder"/></span><strong>{query.trim() ? "No matches" : "This folder is empty"}</strong><span>{query.trim() ? `Nothing here matches “${query.trim()}”.` : emptyStateHint}</span>{directory.permissions.write && !query.trim() && <button className={cn("button", BTN, BTN_PRIMARY)} onClick={() => fileInput.current?.click()}><Icon name="upload"/><span className="label">Upload files</span></button>}</div>}
          {files.map((file, index) => <FileRow key={file.path} file={file} index={index} selected={selected.has(file.path)} loading={directoryState === "loading"} arriving={arrivingNames.has(file.name)} permissions={directory.permissions} policyHint={policyHint} onSelect={(gesture) => toggleSelection(file, index, gesture)} onOpen={() => file.kind === "directory" ? void navigate(file.path) : openDocument(`${file.path}${file.editable ? "?edit" : ""}`, file.editable)} onRename={() => { if (directory.permissions.write && directory.permissions.delete) setDialog({ kind: "rename", path: file.path, name: file.name, value: file.name, pending: false }); }} onDelete={() => setDialog({ kind: "delete", paths: [file.path], pending: false })} onDeleteKey={() => { if (directory.permissions.delete) setDialog({ kind: "delete", paths: selected.size ? [...selected] : [file.path], pending: false }); }} onClear={() => { setSelected(new Set()); setLastSelected(null); }}/>) }
          {/* Space the rail's height, so the last rows can scroll clear of it. */}
          <div className="rail-clearance h-[var(--xw-rail-clearance,0)]" aria-hidden="true"/>
        </div>
        </div>
        <div className="statusbar flex items-center justify-end px-3 border-0 border-t border-solid border-xw-line bg-[#0b101a] text-xw-faint text-[11px] font-mono leading-[normal] tabular-nums max-[640px]:justify-center max-[640px]:[&>span]:hidden"><span className="drop-hint text-[#7f779c]">Drop files anywhere to upload</span>{refreshFailures >= REFRESH_FAILURE_NOTICE && <span role="status">Couldn't refresh — retrying</span>}</div>
      </section>
      <AnimatePresence initial={false}>{dragging && <m.div key="drop-target" className="drop-target absolute inset-3 max-[640px]:inset-2 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-xw-accent-border rounded-[10px] bg-[rgba(16,14,31,.94)] text-xw-accent-hi pointer-events-none z-drag"
      initial={reduced ? false : { opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.985 }} transition={{ duration: presenceDuration(reduced) }}
      role="status" aria-live="polite"><span className="drop-target-icon w-11 h-11 grid place-items-center mb-1 border border-solid border-xw-accent-border rounded-full bg-[#241d42] [&_.ui-icon]:w-[22px] [&_.ui-icon]:h-[22px]"><Icon name="upload"/></span><strong className="text-base font-semibold text-[#eeeaff]">Drop files here</strong><span className="text-[#9188b4] text-[11px]">Upload to {directory.path}</span></m.div>}</AnimatePresence>
      {/* One rail for every transient message: the drag-wait bar, the toast
          stack and the upload dock. They stack instead of overlapping, and each
          one carries its own status/alert role so a message is announced
          exactly once. */}
      <div className={RAIL} ref={railRef}>
        <AnimatePresence initial={false}>{dropWaitState && <m.div key="drop-wait" className={cn("drop-wait w-[min(420px,calc(100vw-56px))] min-h-[42px] flex items-center gap-2 px-2 py-1 border border-solid rounded-[7px] bg-[rgba(20,24,39,.97)] shadow-[0_12px_32px_rgba(0,0,0,.38)] text-[11px]", dropWaitState === "delayed" ? "delayed border-[#6b5b38] text-[#e4c986]" : "border-xw-accent-border text-[#c9c2ef]")}
          initial={reduced ? false : { opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 1 } : { opacity: 0, y: 7, scale: 0.98 }} transition={{ duration: presenceDuration(reduced) }}>
          {dropWaitState === "preparing"
            ? <span className="drop-wait-spinner w-[14px] h-[14px] flex-none border-2 border-solid border-xw-accent-border border-t-xw-accent-hi rounded-full animate-[xw-spin_.8s_linear_infinite]" aria-hidden="true"/>
            : <span className="drop-wait-icon w-5 h-5 grid place-items-center flex-none [&_.ui-icon]:w-4 [&_.ui-icon]:h-4" aria-hidden="true"><Icon name="upload"/></span>}
          <span className="min-w-0 flex-1 font-semibold" role="status" aria-live="polite">{dropWaitState === "preparing" ? "Preparing upload…" : "Upload hasn't started yet."}</span>
          {dropWaitState === "delayed" && <button className={cn("button", BTN)} type="button" onClick={() => fileInput.current?.click()}>Choose files</button>}
          <button className={CONTROL_ICON} type="button" aria-label="Dismiss upload status" onClick={clearDropFeedback}><Icon name="close"/></button>
        </m.div>}</AnimatePresence>
        <div className="toast-stack static flex flex-col items-stretch gap-2 w-[min(420px,calc(100vw-56px))] pointer-events-auto"><AnimatePresence initial={false}>{toasts.map(toast => <ToastView key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)}/>)}</AnimatePresence></div>
        <AnimatePresence initial={false}><UploadDock key="dock" snapshot={upload}/></AnimatePresence>
      </div>
      {zipPending > 0 && <div className="zip-overlay fixed inset-0 z-popover flex items-center justify-center p-4 bg-[rgba(2,6,23,.72)] animate-[zip-overlay-in_150ms_ease-out]" role="status" aria-live="polite"><div className="zip-overlay-card flex items-center gap-3 w-[min(100%,384px)] p-5 border border-solid border-xw-line-hi rounded-lg bg-[rgba(15,23,42,.96)] shadow-[0_24px_70px_rgba(0,0,0,.45)]"><span className="zip-spinner w-7 h-7 flex-none border-[3px] border-solid border-[rgba(124,58,237,.25)] border-t-xw-accent rounded-full animate-[zip-spin_.8s_linear_infinite]" aria-hidden="true"/><span className="zip-overlay-text font-sans text-sm font-semibold text-[#f8fafc]">Zipping {zipPending} file{zipPending === 1 ? "" : "s"}…</span></div></div>}
    </main>
    <AnimatePresence initial={false}>{dialog && <DialogView key="dialog" dialog={dialog} setDialog={setDialog} onMkdir={() => void createFolder()} onRename={() => void renamePath()} onDelete={() => void deletePaths()}/>}</AnimatePresence> 
    {authOverlay && <AuthOverlay kind={authOverlay}/>}
  </m.div>;
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }): React.JSX.Element {
  const reduced = prefersReducedMotion();
  const dismissing = useRef(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Timer expiry and the action button both route through here, so a toast can
  // only start dismissing once. The exit itself belongs to AnimatePresence.
  const dismiss = useCallback((): void => {
    if (dismissing.current) return;
    dismissing.current = true;
    onDismissRef.current();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(dismiss, toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.duration, dismiss]);

  const icon = toast.kind === "deleted" || toast.kind === "error" ? "trash" : "check";
  return <m.div className={cn(TOAST, toast.kind, toast.kind === "error" || toast.kind === "deleted" ? TOAST_ERROR : TOAST_SUCCESS)} role={toast.kind === "error" ? "alert" : "status"} layout
    initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? { opacity: 1 } : { opacity: 0, y: 6 }} transition={{ duration: presenceDuration(reduced) }}>
    <span className={TOAST_ICON}><Icon name={icon}/></span>
    <span className={TOAST_MESSAGE}>{toast.message}</span>
    {toast.action && <button className="toast-action flex-none h-7 min-h-7 min-w-7 px-2 py-1 border border-solid border-[rgba(124,58,237,.58)] rounded-md bg-xw-accent-lo text-[#ddd6fe] cursor-pointer text-[11px] font-medium leading-none uppercase hover:border-xw-accent-border hover:bg-[rgba(124,58,237,.26)] focus-visible:border-xw-accent-border focus-visible:bg-[rgba(124,58,237,.26)] focus-visible:outline-none" onClick={() => { dismiss(); toast.action?.run(); }}>{toast.action.label}</button>}
    <span className={TOAST_TIMER} aria-hidden="true" style={{ animationDuration: `${toast.duration}ms` }}/>
  </m.div>;
}

function FileRow({ file, index, selected, loading, arriving, permissions, policyHint, onSelect, onOpen, onRename, onDelete, onDeleteKey, onClear }: { file: XwingFile; index: number; selected: boolean; loading: boolean; arriving: boolean; permissions: XwingBootstrapV1["permissions"]; policyHint: string | undefined; onSelect: (gesture: { range: boolean; additive: boolean }) => void; onOpen: () => void; onRename: () => void; onDelete: () => void; onDeleteKey: () => void; onClear: () => void }): React.JSX.Element {
  // Rename is a move, so the server demands both write and delete; delete only
  // needs delete. Either control, when policy disables it, points at the
  // permission notice instead of relying on the dimmed style alone.
  const canRename = permissions.write && permissions.delete;
  const moveFocus = (row: HTMLElement, direction: "next" | "previous" | "first" | "last"): void => {
    const rows = [...(row.parentElement?.querySelectorAll<HTMLElement>(".file-row") ?? [])];
    const current = rows.indexOf(row);
    const target = direction === "first" ? rows[0] : direction === "last" ? rows[rows.length - 1] : rows[current + (direction === "next" ? 1 : -1)];
    target?.focus();
  };
  return <div className={cn("file-row items-center", "grid grid-cols-[38px_34px_minmax(240px,1fr)_112px_168px_92px] px-2 max-[900px]:grid-cols-[38px_34px_minmax(180px,1fr)_90px_120px_92px] max-[640px]:grid-cols-[38px_30px_minmax(120px,1fr)_64px_56px]", "relative min-h-[42px] border-0 border-b border-solid border-[#1c2433] group cursor-pointer select-none transition-[background-color,opacity,box-shadow] duration-micro ease-xw hover:bg-xw-hover [scroll-margin-block:48px_var(--xw-rail-clearance,110px)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-[#7062b3]", selected && "selected bg-[#1c1732] shadow-[inset_3px_0_var(--xw-accent)] hover:bg-[#211a3a]", loading && "muted opacity-[.58]", arriving && "arriving animate-[xw-row-arrive_420ms_var(--xw-ease)]")} role="row" aria-rowindex={index + 2} aria-label={`${file.name}, ${file.kind}`} aria-selected={selected} data-path={file.path} tabIndex={0}
    onMouseDown={event => { if (event.shiftKey && !(event.target as Element).closest(".row-actions")) event.preventDefault(); }}
    onDragStart={event => event.preventDefault()}
    onClick={event => { if ((event.target as Element).closest(".row-actions")) return; window.getSelection()?.removeAllRanges(); onSelect({ range: event.shiftKey, additive: event.metaKey || event.ctrlKey }); event.currentTarget.focus(); }}
    onDoubleClick={event => { if (!(event.target as Element).closest(".row-actions")) onOpen(); }}
    onKeyDown={event => {
      const rowOwnsKey = event.target === event.currentTarget;
      if (!rowOwnsKey && event.key !== "Delete" && event.key !== "Escape") return;
      if (event.key === " ") { event.preventDefault(); onSelect({ range: event.shiftKey, additive: !event.shiftKey }); }
      else if (event.key === "Enter") { event.preventDefault(); onOpen(); }
      else if (event.key === "Delete") { event.preventDefault(); onDeleteKey(); }
      else if (event.key === "F2") { event.preventDefault(); onRename(); }
      else if (event.key === "Escape") { event.preventDefault(); onClear(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(event.currentTarget, "next"); }
      else if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.currentTarget, "previous"); }
      else if (event.key === "Home") { event.preventDefault(); moveFocus(event.currentTarget, "first"); }
      else if (event.key === "End") { event.preventDefault(); moveFocus(event.currentTarget, "last"); }
    }}>
    <label className="row-check h-full grid place-items-center bg-transparent border-0 cursor-pointer" role="cell"><SelectionCheckbox rowControl label={`${selected ? "Deselect" : "Select"} ${file.name}`} checked={selected} onToggle={event => onSelect({ range: event.shiftKey, additive: event.metaKey || event.ctrlKey || !event.shiftKey })}/></label>
    <span className={cn("file-icon w-6 h-6 rounded-[5px] grid place-items-center text-[#9ba6ba]", file.kind === "directory" ? "directory text-[#d8b963] bg-[#241f15]" : "file text-xw-accent bg-[#19162b]")} role="cell"><Icon name={file.kind === "directory" ? "folder" : "file"}/></span>
    <span className={cn("filename min-w-0 text-xs font-mono whitespace-nowrap overflow-hidden text-ellipsis no-underline", file.kind === "directory" ? "directory text-[#ece1b6]" : "text-[#dfe4ec]")} role="cell" title={file.name}>{file.name}{file.kind === "directory" ? "/" : ""}</span>
    <span className="cell text-[#818da2] text-[11px] font-mono leading-[normal] tabular-nums" role="cell">{file.size === null ? "—" : formatBytes(file.size)}</span>
    <span className="cell date text-[#818da2] text-[11px] font-mono leading-[normal] tabular-nums max-[640px]:hidden" role="cell">{file.modified ? formatDate(file.modified) : "—"}</span>
    <span className={cn("row-actions", "flex justify-end gap-0.5 opacity-0 translate-x-[5px] transition-[opacity,transform] duration-micro ease-xw group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0 max-[640px]:opacity-100 max-[640px]:translate-x-0 [@media(hover:none)]:opacity-100 [@media(hover:none)]:translate-x-0")} role="cell"><button className={cn(CONTROL_ICON, CONTROL_ICON_ROW)} aria-label={`Rename ${file.name}`} disabled={!canRename} aria-describedby={!canRename ? policyHint : undefined} onClick={onRename}><Icon name="rename"/></button><a className={cn(CONTROL_ICON, CONTROL_ICON_ROW)} href={file.kind === "directory" ? `${file.path}?zip` : file.path} download aria-label={`Download ${file.name}`}><Icon name="download"/></a><button className={cn(CONTROL_ICON, CONTROL_ICON_ROW, "danger-icon hover:text-xw-danger max-[640px]:hidden")} aria-label={`Delete ${file.name}`} disabled={!permissions.delete} aria-describedby={!permissions.delete ? policyHint : undefined} onClick={onDelete}><Icon name="trash"/></button></span>
  </div>;
}

function SelectionCheckbox({ label, checked, indeterminate = false, rowControl = false, onToggle }: { label: string; checked: boolean; indeterminate?: boolean; rowControl?: boolean; onToggle: (event: React.MouseEvent<HTMLInputElement>) => void }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} className="w-[15px] h-[15px] m-auto cursor-pointer accent-xw-accent-fill [color-scheme:dark] selection-checkbox" type="checkbox" aria-label={label} checked={checked} onChange={() => undefined} onClick={event => { event.stopPropagation(); onToggle(event); if (rowControl && event.detail > 0) event.currentTarget.closest<HTMLElement>(".file-row")?.focus(); }}/>;
}

/** Focus a row now. Only for actions that leave the listing untouched; anything
 *  that changes the listing queues a `PendingFocus` instead, so the rows it
 *  queries are the ones the user is looking at. */
function focusFileRow(path: string | null, fallbackToFirst = false): void {
  window.requestAnimationFrame(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".file-row")];
    (rows.find(row => row.dataset.path === path) ?? (fallbackToFirst ? rows[0] : null) ?? document.getElementById("file-list"))?.focus();
  });
}

function UploadDock({ snapshot }: { snapshot: ReturnType<UploadManager["getSnapshot"]> }): React.JSX.Element | null {
  const reduced = prefersReducedMotion();
  useEffect(() => {
    const hasCompleted = snapshot.items.some(item => item.status === "completed");
    const hasActive = snapshot.items.some(item => ["queued", "preparing", "uploading", "retrying"].includes(item.status));
    if (!hasCompleted || hasActive) return;

    // The exit belongs to the AnimatePresence around this dock, so the timer
    // only has to clear the successful items.
    const waitTimer = window.setTimeout(() => uploadManager.dismissSuccessful(), 4000);
    return () => window.clearTimeout(waitTimer);
  }, [snapshot.items]);

  if (!snapshot.items.length) return null;
  const dismissible = snapshot.items.some(item => item.status === "completed" || item.status === "cancelled");
  return <m.aside className="upload-dock w-[360px] max-[900px]:w-[330px] max-[640px]:w-auto max-h-[min(520px,70vh)] flex flex-col border border-solid border-[#3b465c] rounded-lg bg-[rgba(15,20,32,.97)] shadow-[0_24px_70px_rgba(0,0,0,.5)] backdrop-blur-[18px] overflow-hidden z-raise"
    initial={reduced ? false : { opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 1 } : { opacity: 0, y: 9, scale: 0.98 }} transition={{ duration: presenceDuration(reduced) }}
    aria-label="Uploads"><div className="upload-header min-h-12 flex items-center justify-between pl-3 pr-2 border-0 border-b border-solid border-xw-line [&>div]:flex [&>div]:items-baseline [&>div]:gap-2 [&_strong]:font-semibold"><div><strong>Uploads</strong><span className={cn("upload-summary text-[11px] tabular-nums", uploadSummaryKind(snapshot) === "active" ? "text-xw-accent-hi" : uploadSummaryKind(snapshot) === "complete" ? "text-xw-success" : uploadSummaryKind(snapshot) === "error" ? "text-[#ff9ba3]" : "text-xw-muted")}>{uploadSummary(snapshot)}</span></div><button className={CONTROL_ICON} aria-label="Clear finished uploads" disabled={!dismissible} onClick={() => uploadManager.dismissCompleted()}><Icon name="close"/></button></div>
    <div className="upload-items overflow-auto">{snapshot.items.map(item => { const percent = item.size ? Math.round(item.uploaded / item.size * 100) : 0; return <m.div className={cn("upload-item p-3 border-0 border-b border-solid border-[#1d2534] last:border-b-0", item.status)} key={item.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} role="group" aria-label={`${item.relativePath}, ${uploadItemLabel(item)}`}><div className="upload-line flex justify-between gap-3 text-[11px] font-mono [&>span]:whitespace-nowrap [&>span]:overflow-hidden [&>span]:text-ellipsis"><span title={item.relativePath}>{item.relativePath}</span><strong>{item.status === "completed" ? "Done" : `${percent}%`}</strong></div><div className={cn("progress-track h-1 my-2 mb-1 bg-[#273148] rounded-[3px] overflow-hidden [&>span]:block [&>span]:h-full [&>span]:origin-left [&>span]:transition-transform [&>span]:duration-micro", item.status === "completed" ? "[&>span]:bg-xw-success" : item.status === "failed" ? "[&>span]:bg-xw-danger" : item.status === "cancelled" ? "[&>span]:bg-xw-muted" : "[&>span]:bg-xw-accent")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${item.relativePath} upload progress`}><span style={{ transform: `scaleX(${percent / 100})` }}/></div><div className="upload-meta flex justify-between gap-2 text-xw-faint text-[11px] tabular-nums [&>span:first-child]:overflow-hidden [&>span:first-child]:text-ellipsis [&>span:first-child]:whitespace-nowrap [&_button]:border-0 [&_button]:bg-transparent [&_button]:text-xw-accent-hi [&_button]:cursor-pointer [&_button]:text-[11px] [&_button]:font-medium [&_button]:flex [&_button]:items-center [&_button]:gap-1"><span>{uploadItemLabel(item)}{item.status === "uploading" && item.speed > 0 ? ` · ${formatBytes(item.speed)}/s` : ""}</span><span>{item.status === "failed" || item.status === "cancelled" ? <button onClick={() => uploadManager.retry(item.id)}><Icon name="retry"/> Retry</button> : item.status !== "completed" ? <button onClick={() => uploadManager.cancel(item.id)}>Cancel</button> : null}</span></div></m.div>; })}</div>
  </m.aside>;
}

function DialogView({ dialog, setDialog, onMkdir, onRename, onDelete }: { dialog: Exclude<Dialog, null>; setDialog: (value: Dialog) => void; onMkdir: () => void; onRename: () => void; onDelete: () => void }): React.JSX.Element {
  const kind = dialog.kind;
  // mkdir and rename are the same shape: one labelled name field and a primary
  // confirm. Delete is the destructive variant.
  const textDialog = kind === "mkdir" || kind === "rename";
  const reduced = prefersReducedMotion();
  const pending = "pending" in dialog && dialog.pending;
  // Presence belongs to the AnimatePresence around this component: closing only
  // clears the dialog, and the exit runs while it is still mounted.
  const close = (): void => {
    if (pending) return;
    setDialog(null);
  };
  const modalRef = useModalFocus<HTMLDivElement>(close, !pending);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pending && modalRef.current && !modalRef.current.contains(document.activeElement)) confirmRef.current?.focus();
  }, [pending, modalRef]);
  const title = kind === "mkdir" ? "New folder" : kind === "rename" ? `Rename ${dialog.name}` : `Delete ${dialog.paths.length} item${dialog.paths.length === 1 ? "" : "s"}?`;
  const description = kind === "mkdir" ? "Create a folder in the current directory." : kind === "rename" ? "Enter a new name. The item stays in this folder." : "The items will move to X-wing’s recoverable trash.";
  const submitLabel = pending ? (kind === "rename" ? "Renaming…" : "Deleting…") : kind === "mkdir" ? "Create folder" : kind === "rename" ? "Rename" : "Delete";
  return <m.div ref={modalRef} className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}
    initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: presenceDuration(reduced) }}>
    <m.form className="modal" initial={reduced ? false : { opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 1 } : { opacity: 0, y: 7, scale: 0.98 }} transition={{ duration: presenceDuration(reduced) }} role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description" onSubmit={event => { event.preventDefault(); if (kind === "mkdir") onMkdir(); else if (kind === "rename") onRename(); else onDelete(); }}>
    <h2 id="dialog-title">{title}</h2>
    <p id="dialog-description">{description}</p>
    {"value" in dialog && <label>{kind === "mkdir" ? "Folder name" : "New name"}<input data-autofocus value={dialog.value} aria-invalid={dialog.error ? "true" : undefined} aria-describedby={dialog.error ? "dialog-error" : undefined} onChange={event => setDialog({ ...dialog, value: event.target.value, error: undefined })}/></label>}
    {dialog.error && <div id="dialog-error" className="dialog-error" role="alert">{dialog.error}</div>}
    <div className="modal-actions"><button type="button" className={cn("button", BTN)} disabled={pending} onClick={close}>Cancel</button><button ref={confirmRef} data-autofocus={textDialog ? undefined : "true"} className={cn("button", BTN, textDialog ? BTN_PRIMARY : BTN_DANGER)} disabled={pending}>{submitLabel}</button></div>
    </m.form></m.div>;
}

async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401 || new URL(response.url || location.href, location.href).pathname === "/_auth/login") {
    beginAuthRedirect();
    throw new Error("authentication required");
  }
  return response;
}

function readSort(user: string): SortEntry[] {
  try {
    return normalizeSortPreference(JSON.parse(localStorage.getItem(sortStorageKey(user)) || "null") as unknown);
  } catch { return normalizeSortPreference(null); }
}

/**
 * User-facing copy for the statuses the file browser can actually hit; the
 * server's raw status code is never shown. Anything unmapped falls back to the
 * server's own detail message.
 */
const STATUS_COPY: Record<number, string> = {
  405: "A folder or file with that name already exists.",
  403: "You don't have permission for that.",
  404: "That file or folder no longer exists.",
  409: "That name is already taken.",
  412: "That name is already taken.",
  413: "That file is too large.",
  507: "Not enough space on the server.",
};
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong"; }
async function responseError(response: Response): Promise<string> {
  const mapped = STATUS_COPY[response.status];
  try {
    const body = await response.json() as { detail?: string };
    return mapped ?? (body.detail || `Request failed (${response.status})`);
  } catch { return mapped ?? `Request failed (${response.status})`; }
}
function downloadBlob(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function contentDispositionFilename(header: string | null): string | null { const match = header?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i); return match?.[1] ? decodeURIComponent(match[1]) : null; }

try {
  const root = document.getElementById("xwing-root");
  if (!root) throw new Error("X-wing root is missing");
  createRoot(root).render(
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <App initial={readBootstrap()}/>
      </MotionConfig>
    </LazyMotion>,
  );
} catch (error) {
  const root = document.getElementById("xwing-root") || document.body;
  dismissBootCard();
  root.innerHTML = `<div class="boot-error h-full flex flex-col items-center justify-center gap-2 bg-xw-bg text-xw-muted font-sans [&_strong]:text-xw-text [&_button]:mt-2 [&_button]:px-3 [&_button]:py-2 [&_button]:border [&_button]:border-solid [&_button]:border-xw-line-hi [&_button]:rounded-md [&_button]:bg-xw-raised [&_button]:text-xw-text"><strong>X-wing couldn’t start</strong><span>${escapeHtml(errorMessage(error))}</span><button onclick="location.reload()">Reload</button></div>`;
}
