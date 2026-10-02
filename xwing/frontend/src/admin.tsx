import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal, flushSync } from "react-dom";
import * as m from "motion/react-m";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, type Transition } from "motion/react";
import { cn } from "./lib/cn";
import {
  ACCOUNT_INLINE,
  ACCOUNT_TRIGGER,
  BRAND,
  BRAND_CONTEXT,
  BRAND_NAME,
  CONTROL,
  CONTROL_ADMIN,
  CONTROL_DANGER,
  CONTROL_ICON,
  CONTROL_PRIMARY,
  CONTROL_SMALL,
  MENU_ITEM,
  POPOVER,
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

const BTN = `${CONTROL} ${CONTROL_ADMIN}`;
const BTN_PRIMARY = CONTROL_PRIMARY;
const BTN_DANGER = CONTROL_DANGER;
const BTN_SMALL = `${CONTROL} ${CONTROL_ADMIN} ${CONTROL_SMALL}`;
import { consumeHandover, createAuthSession, dismissBootCard, markHandover } from "./shared.js";
import { formatBytes, formatDate, prefersReducedMotion } from "./format";
import { useModalFocus } from "./keyboard";

type PermissionSet = { read: boolean; write: boolean; delete: boolean };
type UserRecord = { username: string; permissions: PermissionSet };
type Metrics = {
  configured_users: number;
  active_users: number;
  activity_events: number;
  active_window_minutes: number;
  storage: { files: number; bytes: number };
  trash: { items: number; bytes: number };
};
type ActivityEvent = {
  occurred_at: string;
  username: string;
  method: string;
  path: string;
  details: string | null;
  status_code: number;
  duration_ms: number;
};
type ActivitySummary = { event_count: number; active_users: number; by_user: { username: string; event_count: number }[] };
type TrashItem = { path: string; kind: string; size: number };
type TrashTransaction = {
  transaction_id: string;
  user: string;
  created: string;
  size: number;
  items: TrashItem[];
};
type AdminBootstrap = { user: string; ldapConfigured: boolean };
type ToastKind = "success" | "error";
type Toast = { id: number; kind: ToastKind; message: string };
type ConfirmRequest = { title: string; message: string; confirmText: string; resolve: (confirmed: boolean) => void };
type ActivityFilters = { username: string; since: string; scope: string };

// ── Motion ───────────────────────────────────────────────────────────────────
// The console rides the same clock the shell does: `--xw-page-in` for the page
// entrance (340ms), `--xw-surface` for a surface arriving (280ms), and
// `--xw-micro` (180ms) for everything that is interaction feedback.
const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const EXIT_EASE: [number, number, number, number] = [0.4, 0, 1, 1];
const SHELL_ENTER: Transition = { duration: 0.34, ease: EASE };
const SHELL_LEAVE: Transition = { duration: 0.17, ease: EXIT_EASE };
/**
 * A tab switch: the arriving view springs up into place. Deliberately slower than
 * interaction feedback — a whole view is arriving, and the settle is what makes
 * the switch read as deliberate instead of a flicker. The fade runs alongside it
 * and starts part-way visible, so the section never blanks out mid-switch.
 */
const VIEW_ENTER: Transition = {
  opacity: { duration: 0.34, ease: EASE },
  y: { type: "spring", stiffness: 150, damping: 20, mass: 1 },
};
/** How far the view rises from, and how visible it starts. */
const VIEW_FROM = { opacity: 0.35, y: 14 };
const TOAST_ENTER: Transition = { duration: 0.2, ease: EASE };
const TOAST_EXIT: Transition = { duration: 0.18, ease: EXIT_EASE };
const DIALOG_ENTER: Transition = { duration: 0.18, ease: EASE };
const DIALOG_EXIT: Transition = { duration: 0.16, ease: EXIT_EASE };

/** Matches the app's default toast duration, so admin feedback clears like a toast. */
const FEEDBACK_DURATION_MS = 5200;
const TAB_NAMES = ["overview", "users", "activity", "trash"];
const ACTIVITY_LIMIT = "200";
const EMPTY_PERMISSIONS: PermissionSet = { read: true, write: false, delete: false };
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "activity", label: "Activity" },
  { id: "trash", label: "Trash" },
];

const authSession = createAuthSession({
  idleTimeoutSeconds: Number(document.body.dataset.authIdleTimeout || "0"),
});

/** The open tab lives in the query string, so a console link is shareable and
 *  the back button walks the tabs. */
function tabFromLocation(): string {
  const requested = new URLSearchParams(location.search).get("tab") || "overview";
  return TAB_NAMES.includes(requested) ? requested : "overview";
}

function formField<T extends HTMLElement>(form: HTMLFormElement | null, name: string): T | null {
  const field = form?.elements.namedItem(name);
  return field instanceof HTMLElement ? (field as T) : null;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authSession.authFetch(url, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json() as { detail?: string }; message = body.detail || message; } catch { /* use status */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

const overviewAnnouncement = (metrics: Metrics): string =>
  `Overview loaded: ${count(metrics.configured_users, "user")}, ${count(metrics.activity_events, "event")}, ${count(metrics.storage.files, "file")}.`;
const usersAnnouncement = (total: number): string => `Users loaded: ${count(total, "configured user")}.`;
const activityAnnouncement = (total: number): string => `Activity loaded: ${count(total, "event")}.`;
const trashAnnouncement = (total: number): string => `Trash loaded: ${count(total, "transaction")}.`;

/** Mirrors the server's `_normalize_username` rule, so the field can explain
 *  itself before a request the server would answer with a bare 400. */
function usernameError(value: string): string | null {
  const username = value.trim();
  if (!username) return "Enter a username.";
  if (username === "*") return "A username cannot be the wildcard.";
  if (username.includes("/")) return "A username cannot contain a slash.";
  if (username.length > 128) return "A username is limited to 128 characters.";
  if ([...username].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "A username cannot contain control characters.";
  return null;
}

function readPermissions(form: HTMLFormElement | null, prefix: string): PermissionSet {
  const value = (permission: keyof PermissionSet): boolean => formField<HTMLInputElement>(form, `${prefix}-${permission}`)?.checked ?? false;
  return { read: value("read"), write: value("write"), delete: value("delete") };
}

type ActivityDetails = { summary: string | null; paths: string[] };

function activityDetails(event: ActivityEvent): ActivityDetails {
  if (!event.details) return { summary: null, paths: [] };
  try {
    const value: unknown = JSON.parse(event.details);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { summary: null, paths: [] };
    const details = value as Record<string, unknown>;
    const rawCount = Number(details.count ?? details.restored ?? details.deleted);
    const countLabel = Number.isFinite(rawCount) && rawCount > 0 ? count(rawCount, "item") : null;
    const paths = Array.isArray(details.paths)
      ? details.paths.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [];
    if (paths.length) {
      const preview = paths.slice(0, 3).join(", ");
      const remaining = paths.length - 3;
      return {
        summary: `${countLabel ? `${countLabel}: ` : ""}${preview}${remaining > 0 ? `, +${remaining} more` : ""}`,
        paths,
      };
    }
    if (countLabel) return { summary: countLabel, paths };
    if (event.method === "upload" && Number.isFinite(Number(details.bytes))) return { summary: formatBytes(Number(details.bytes)), paths };
    if (event.method === "admin_user_upsert" || event.method === "admin_user_delete") {
      return { summary: typeof details.username === "string" ? details.username : null, paths };
    }
    if (event.method === "admin_audit_purge") {
      const days = Number(details.older_than_days);
      return { summary: Number.isFinite(days) ? `Older than ${days} days` : null, paths };
    }
    return { summary: null, paths };
  } catch {
    return { summary: null, paths: [] };
  }
}

const ACTIVITY_LABELS: Record<string, string> = {
  upload: "Uploaded",
  download: "Downloaded",
  delete: "Moved to trash",
  bulk_delete: "Moved selected items to trash",
  bulk_zip: "Downloaded selected items",
  restore: "Restored",
  mkdir: "Created folder",
  copy: "Copied",
  move: "Moved",
  admin_user_upsert: "Saved user",
  admin_user_delete: "Removed user",
  admin_ldap_update: "Updated LDAPGate config",
  admin_trash_restore: "Restored from trash",
  admin_trash_delete: "Deleted from trash",
  admin_audit_purge: "Purged audit history",
};

function activityLabel(method: string): string {
  return ACTIVITY_LABELS[method] || method.replace(/^admin_/, "").replace(/_/g, " ");
}

// ── Class tokens ─────────────────────────────────────────────────────────────
// The shared sheet owns `.button`, `.table-wrap`, `.toast`, `.modal` and the
// focus ring; everything the console draws for itself lives here as utilities.
const CARD = "rounded-admin border border-solid border-admin-line bg-admin-panel shadow-lg";
const CARD_HEADING = "card-heading flex items-start justify-between gap-4 mb-4 max-[620px]:items-center";
const EYEBROW = "eyebrow mb-2 font-sans text-[11px] font-semibold leading-tight text-admin-accent";
const COUNT_BADGE = "count-badge inline-flex min-h-6 items-center rounded-full border border-solid border-admin-line-hi px-2 font-mono text-[11px] font-medium tabular-nums text-admin-muted whitespace-nowrap";
const TABLE = "w-full table-fixed border-collapse text-left text-xs";
const TABLE_BODY = "[&>tr:last-child>td]:border-b-0";
const TH = "border-0 border-b border-solid border-admin-line-hi px-3 py-3 font-sans text-[11px] font-medium uppercase whitespace-nowrap text-admin-faint";
const TD = "border-0 border-b border-solid border-admin-line px-3 py-3 tabular-nums text-admin-muted";
const CELL_STRONG = "font-medium text-admin-text";
const ROW_ACTIONS = "row-actions flex flex-wrap justify-start gap-2 opacity-100 transform-none";
// The focus ring is the shared `:focus-visible` outline (2px, offset 2px). A
// `focus:ring-2` on top of it drew a second solid band touching the outline, so
// the field showed one fat ring instead of a ring with a gap.
const FIELD = "h-9 min-h-9 w-full rounded border border-solid border-admin-line-hi bg-admin-bg px-3 py-0 font-sans text-[13px] text-admin-text focus:border-admin-accent";
const LABEL = "font-sans text-xs font-medium text-admin-muted";
const FIELD_HELP = "text-[11px] text-admin-faint";
const FILTER_FIELD = "filter-field flex min-w-0 flex-col gap-1";
const TrashPath = ({ item, first }: { item: TrashItem; first: boolean }): React.JSX.Element => (
  <div className={cn("trash-path grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 text-[11px] leading-snug text-admin-text", !first && "mt-2 border-0 border-t border-solid border-admin-line pt-2")}>
    <span className="trash-kind font-sans font-medium uppercase text-admin-faint">{item.kind}</span>
    <code className="min-w-0 break-words font-mono text-admin-text">{item.path}</code>
  </div>
);

/** Each permission keeps its own tint, so a row of badges reads at a glance. */
const PERMISSION_TINT: Record<keyof PermissionSet, string> = {
  read: "border-[#42627b] text-[#9cd5ee]",
  write: "border-[#4d704f] text-[#a9dda7]",
  delete: "border-[#765047] text-[#f0b59d]",
};
const BADGE = "inline-flex min-h-6 items-center rounded-full border border-solid px-2 font-sans text-[11px] font-medium";

function PermissionBadges({ permissions }: { permissions: PermissionSet }): React.JSX.Element {
  const granted = (["read", "write", "delete"] as const).filter(permission => permissions[permission]);
  return <span className="permission-badges flex flex-wrap gap-1">
    {granted.length
      ? granted.map(permission => <span key={permission} className={cn(`permission-badge ${permission}`, BADGE, PERMISSION_TINT[permission])}>{permission}</span>)
      : <span className={cn("permission-badge none", BADGE, "border-admin-line-hi text-admin-muted")}>none</span>}
  </span>;
}

function Logo(): React.JSX.Element {
  return <svg className="brand-mark" viewBox="0 0 200 200" role="img" aria-label="X-wing logo">
    <rect x="6" y="6" width="188" height="188" rx="36"/>
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="71,78 23,48 15,100 23,152 71,122"/><polyline points="71,78 30,100 71,122"/>
      <polygon points="129,78 177,48 185,100 177,152 129,122"/><polyline points="129,78 170,100 129,122"/>
      <path d="m71 78 15 8m-15 36 15-8m43-36-15 8m15 36-15-8"/>
      <circle cx="100" cy="100" r="20"/><circle cx="100" cy="100" r="13"/>
    </g><circle className="brand-core" cx="100" cy="100" r="4.5"/>
  </svg>;
}

const Chevron = (): React.JSX.Element => <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>;

/** Same glyphs the app's toasts use: a check for success, an alert for an error.
 *  (Errors used a trash can, which only ever meant "deleted".) */
const TOAST_ICONS: Record<ToastKind, React.JSX.Element> = {
  success: <path d="m5 12.5 4.25 4.25L19 7.5"/>,
  error: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5m0 3.5h.01"/></>,
};

/** The console's loading state shows the shape the payload will fill: a card
 *  heading, the toolbar, then rows. Static, so nothing moves while it waits. */
function LoadingCard(): React.JSX.Element {
  const bar = "skeleton-bar block h-3.5 rounded bg-admin-raised";
  // It wears the card the payload will arrive in (border, radius, 20px padding),
  // so the real heading lands where the skeleton's title was instead of 20px over.
  return <div className={cn("admin-card loading-card flex flex-col gap-3", CARD, "p-5 shadow-none")} role="status">
    <span className="sr-only">Loading admin data…</span>
    <span className={`${bar} skeleton-title h-5 w-[30%] max-w-60`}/>
    <span className="skeleton-toolbar flex gap-2">{["skeleton-bar flex-1 h-9", "skeleton-bar flex-1 h-11", "skeleton-bar flex-1 h-11"].map((classes, index) => <span key={index} className={cn(bar, classes)}/>)}</span>
    <span className="skeleton-rows flex flex-col gap-2">{[0, 1, 2, 3, 4, 5].map(index => <span key={index} className={bar}/>)}</span>
  </div>;
}

function OverviewView({ metrics }: { metrics: Metrics | null }): React.JSX.Element {
  if (!metrics) return <LoadingCard/>;
  const cards = [
    { label: "Configured users", value: String(metrics.configured_users), hint: "Explicit entries in users.yaml" },
    { label: "Active users", value: String(metrics.active_users), hint: `Seen in audit log, last ${metrics.active_window_minutes} minutes` },
    { label: "Activity", value: String(metrics.activity_events), hint: `Recorded events, last ${metrics.active_window_minutes} minutes` },
    { label: "Stored files", value: String(metrics.storage.files), hint: formatBytes(metrics.storage.bytes) },
    { label: "Recoverable trash", value: String(metrics.trash.items), hint: formatBytes(metrics.trash.bytes) },
  ];
  return <div className="metric-grid grid grid-cols-5 gap-2 mb-4 max-[980px]:grid-cols-3 max-[620px]:grid-cols-2">
    {cards.map(card => <article key={card.label} className="metric-card flex min-h-32 flex-col rounded-admin border border-solid border-admin-line bg-admin-panel p-4 shadow-lg">
      <span className="text-xs text-admin-muted">{card.label}</span>
      <strong className="mt-auto font-mono text-2xl font-semibold leading-none tabular-nums text-admin-text lg:text-3xl">{card.value}</strong>
      <small className="mt-2 text-[11px] leading-snug text-admin-faint">{card.hint}</small>
    </article>)}
  </div>;
}

type UsersViewProps = {
  users: UserRecord[];
  defaultPermissions: PermissionSet | null;
  ldapConfigured: boolean;
  formError: string | null;
  formTitle: string;
  formRef: React.RefObject<HTMLFormElement | null>;
  onSave: (form: HTMLFormElement) => void;
  onDraftChange: () => void;
  onEdit: (username: string) => void;
  onDelete: (username: string) => void;
  onClear: () => void;
};

function UsersView({ users, defaultPermissions, ldapConfigured, formError, formTitle, formRef, onSave, onDraftChange, onEdit, onDelete, onClear }: UsersViewProps): React.JSX.Element {
  const help = ldapConfigured
    ? "LDAPGate users are synchronized to ldap.allowed_users live; no restart required."
    : "Permissions apply to authenticated usernames listed in users.yaml.";
  return <div className="section-grid grid grid-cols-[minmax(0,1.4fr)_minmax(300px,.6fr)] items-start gap-4 max-[980px]:grid-cols-1">
    <article className={`admin-card ${CARD} p-5`}>
      <div className={CARD_HEADING}>
        <div><p className={EYEBROW}>DIRECTORY</p><h2 className="text-lg font-semibold leading-tight text-balance">Users</h2></div>
        <span className={COUNT_BADGE}>{users.length}</span>
      </div>
      <div className="table-wrap relative">
        <table className={cn("user-table", TABLE)}>
          <thead><tr>
            <th scope="col" className={cn(TH, "w-[28%]")}>Username</th>
            <th scope="col" className={cn(TH, "w-[42%]")}>Permissions</th>
            <th scope="col" className={cn(TH, "w-[30%]")}><span className="sr-only">Actions</span></th>
          </tr></thead>
          <tbody className={TABLE_BODY}>
            {users.length
              ? users.map(user => <tr key={user.username}>
                <td className={TD}><strong className={CELL_STRONG}>{user.username}</strong></td>
                <td className={TD}><PermissionBadges permissions={user.permissions}/></td>
                <td className={TD}><div className={cn(ROW_ACTIONS, "justify-end")}>
                  <button type="button" className={cn("button small", BTN, BTN_SMALL)} aria-label={`Edit user ${user.username}`} onClick={() => onEdit(user.username)}>Edit</button>
                  <button type="button" className={cn("button small danger", BTN, BTN_SMALL, BTN_DANGER)} aria-label={`Remove user ${user.username}`} onClick={() => onDelete(user.username)}>Remove</button>
                </div></td>
              </tr>)
              : <tr><td colSpan={3} className="empty-cell px-4 py-8 text-center text-admin-faint">No explicit users configured.</td></tr>}
          </tbody>
        </table>
      </div>
      {defaultPermissions && <div className="default-access mt-4 flex flex-wrap items-center gap-2 rounded-admin border border-dashed border-admin-line-hi bg-admin-panel p-3 text-xs text-admin-muted">
        <strong className="font-semibold text-admin-text">Wildcard default</strong>
        <PermissionBadges permissions={defaultPermissions}/>
        <span className="basis-full text-[11px] text-admin-faint">Applies to users not listed above.</span>
      </div>}
    </article>
    <article className={`admin-card form-card ${CARD} p-5`}>
      <p className={EYEBROW}>USER ENTRY</p>
      <h2 id="user-form-title" className="mb-4 text-lg font-semibold leading-tight text-balance">{formTitle}</h2>
      <form id="user-form" ref={formRef} className="flex flex-col gap-2" noValidate onSubmit={event => { event.preventDefault(); onSave(event.currentTarget); }} onInput={onDraftChange}>
        <input type="hidden" name="original-username"/>
        <label className={LABEL} htmlFor="username">Username</label>
        <input id="username" name="username" className={FIELD} required maxLength={128} autoComplete="off" spellCheck={false}
          aria-invalid={formError ? "true" : undefined}
          aria-describedby={formError ? "user-form-help user-form-error" : "user-form-help"}/>
        <p className={cn("field-help", FIELD_HELP)} id="user-form-help">{help}</p>
        <p className={`form-error m-0 rounded border border-solid border-admin-danger bg-admin-raised px-3 py-2 text-xs leading-snug break-words text-admin-danger`} id="user-form-error" aria-live="polite" hidden={!formError}>{formError || ""}</p>
        <div className="permission-grid my-2 grid grid-cols-3 gap-2 max-[620px]:grid-cols-1" role="group" aria-label="Permissions">
          {(["read", "write", "delete"] as const).map(permission => <label key={permission} className="check-label flex min-h-9 items-center gap-2 rounded border border-solid border-admin-line bg-admin-panel px-2">
            <input type="checkbox" name={`user-${permission}`} defaultChecked={EMPTY_PERMISSIONS[permission]} className="h-4 w-4 accent-xw-accent-fill"/> {permission.charAt(0).toUpperCase()}{permission.slice(1)}
          </label>)}
        </div>
        <div className="form-actions mt-2 flex flex-wrap gap-2">
          <button className={cn("button primary", BTN, BTN_PRIMARY)} type="submit">Save user</button>
          <button className={cn("button", BTN)} type="button" id="clear-user" onClick={onClear}>Clear</button>
        </div>
      </form>
    </article>
  </div>;
}

type ActivityViewProps = {
  events: ActivityEvent[];
  summary: ActivitySummary;
  filters: ActivityFilters;
  filterRef: React.RefObject<HTMLFormElement | null>;
  onFilterChange: (patch: Partial<ActivityFilters>) => void;
  onFilterSubmit: (form: HTMLFormElement) => void;
  onPurge: (form: HTMLFormElement) => void;
};

function ActivityView({ events, summary, filters, filterRef, onFilterChange, onFilterSubmit, onPurge }: ActivityViewProps): React.JSX.Element {
  // Only the select reserves room on the right (`.xw-select` carries its own
  // 32px for the chevron). Padding the date field the same way pushed the
  // calendar button 32px in from the edge, leaving a dead gap after it.
  const input = FIELD;
  return <article className={`admin-card ${CARD} p-5`}>
    <div className={CARD_HEADING}>
      <div><p className={EYEBROW}>AUDIT TRAIL</p><h2 className="text-lg font-semibold leading-tight text-balance">User activity</h2></div>
      <span className={COUNT_BADGE}>{summary.event_count}</span>
    </div>
    <div className="activity-tools flex flex-col gap-3 mb-4">
      <form id="activity-filter" ref={filterRef} className="inline-form activity-filter-form grid grid-cols-[minmax(0,1fr)_150px_minmax(130px,.75fr)_auto] items-end gap-2 mb-0 max-[620px]:grid-cols-1"
        onSubmit={event => { event.preventDefault(); onFilterSubmit(event.currentTarget); }}>
        <div className={FILTER_FIELD}>
          <label className={LABEL} htmlFor="activity-user">User</label>
          <input id="activity-user" name="username" className={input} placeholder="All users" autoComplete="off" spellCheck={false} value={filters.username} onChange={event => onFilterChange({ username: event.target.value })}/>
        </div>
        <div className={FILTER_FIELD}>
          <label className={LABEL} htmlFor="activity-since">Since</label>
          <input id="activity-since" name="since" type="date" className={input} autoComplete="off" value={filters.since} onChange={event => onFilterChange({ since: event.target.value })}/>
        </div>
        <div className={FILTER_FIELD}>
          <label className={LABEL} htmlFor="activity-scope">Show</label>
          <select id="activity-scope" name="scope" className={cn(input, "xw-select")} value={filters.scope} onChange={event => onFilterChange({ scope: event.target.value })}>
            <option value="file">File activity</option>
            <option value="all">All events</option>
            <option value="admin">Administration</option>
          </select>
        </div>
        <button className={cn("button", BTN)} type="submit">Refresh</button>
      </form>
      <form id="audit-purge-form" className="inline-form purge-form grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-6 gap-y-3 mb-0 border-0 border-t border-solid border-admin-line pt-4 max-[620px]:grid-cols-1 max-[620px]:gap-x-0"
        onSubmit={event => { event.preventDefault(); onPurge(event.currentTarget); }}>
        <div className="purge-copy min-w-0">
          <p className="purge-title m-0 font-sans text-[13px] font-medium text-admin-text">Purge audit history</p>
          <p id="audit-purge-help" className="m-0 mt-1 font-sans text-[11px] leading-normal text-admin-faint text-pretty">Deletes matching events permanently. Files, users and the trash are untouched.</p>
        </div>
        <div className="purge-controls flex flex-wrap items-end justify-end gap-2 max-[620px]:justify-start">
          <div className={FILTER_FIELD}>
            <label className={LABEL} htmlFor="audit-retention">Older than</label>
            <div className="input-with-unit flex min-w-0 items-center gap-2">
              <input id="audit-retention" name="older_than_days" type="number" min={1} max={36500} defaultValue={90} required inputMode="numeric" autoComplete="off"
                aria-describedby="audit-retention-unit" className={cn(FIELD, "w-24 min-w-0 flex-none")}/>
              <span className="unit-label inline-flex items-center whitespace-nowrap font-sans text-[11px] text-admin-faint" id="audit-retention-unit">days</span>
            </div>
          </div>
          <button className={cn("button danger", BTN, BTN_DANGER)} type="submit" aria-describedby="audit-purge-help">Purge history</button>
        </div>
      </form>
    </div>
    <div className="table-wrap relative activity-table">
      <table className={cn(TABLE, "max-[620px]:min-w-[640px]")}>
        <thead><tr>
          <th scope="col" className={cn(TH, "w-[16%]")}>Time</th>
          <th scope="col" className={cn(TH, "w-[12%]")}>User</th>
          <th scope="col" className={cn(TH, "w-[18%]")}>Action</th>
          <th scope="col" className={cn(TH, "w-[44%]")}>Path</th>
          <th scope="col" className={cn(TH, "w-[10%]")}>Status</th>
        </tr></thead>
        <tbody className={TABLE_BODY}>
          {events.length
            ? events.map((event, index) => <ActivityRow key={`${event.occurred_at}-${event.path}-${index}`} event={event}/>)
            : <tr><td colSpan={5} className="empty-cell px-4 py-8 text-center text-admin-faint">No activity matches filter.</td></tr>}
        </tbody>
      </table>
    </div>
  </article>;
}

function ActivityRow({ event }: { event: ActivityEvent }): React.JSX.Element {
  const detail = activityDetails(event);
  return <tr className="[content-visibility:auto] [contain-intrinsic-size:auto_41px]">
    <td className={TD}>{formatDate(event.occurred_at)}</td>
    <td className={TD}><strong className={CELL_STRONG}>{event.username}</strong></td>
    <td className={TD}>
      <span className="activity-action block">{activityLabel(event.method)}</span>
      {detail.paths.length
        ? <details className="activity-detail-list mt-1 block font-mono text-[11px] leading-tight text-admin-faint">
          <summary className="cursor-pointer break-words marker:text-admin-accent">{detail.summary || count(detail.paths.length, "selected item")}</summary>
          <ul className="max-h-44 list-none overflow-y-auto border-0 border-l border-solid border-admin-line py-0 pr-2 pl-5">{detail.paths.map(path => <li key={path} className="mt-1 first:mt-0"><code className="break-words text-admin-text">{path}</code></li>)}</ul>
        </details>
        : detail.summary ? <small className="activity-detail mt-1 block font-mono text-[11px] leading-tight text-admin-faint">{detail.summary}</small> : null}
    </td>
    <td className={cn(TD, "path-cell break-words whitespace-normal")} title={event.path}><code className="font-mono text-[11px] leading-snug break-words text-admin-text">{event.path}</code></td>
    <td className={TD}><span className={cn("status-code font-mono text-[11px] font-semibold tabular-nums", event.status_code >= 400 ? "bad text-admin-danger" : "good text-admin-good")}>{event.status_code}</span></td>
  </tr>;
}

type TrashViewProps = {
  trash: TrashTransaction[];
  selected: Set<string>;
  allSelected: boolean;
  onToggle: (transactionId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onRestore: (transactionId: string) => void;
  onDelete: (transactionId: string) => void;
  onRestoreSelected: () => void;
  onEmpty: () => void;
  onRefresh: () => void;
};

function TrashView({ trash, selected, allSelected, onToggle, onToggleAll, onRestore, onDelete, onRestoreSelected, onEmpty, onRefresh }: TrashViewProps): React.JSX.Element {
  const hasTrash = trash.length > 0;
  const selectedCount = selected.size;
  return <article className={`admin-card ${CARD} p-5`}>
    <div className={cn(CARD_HEADING, "max-[620px]:block")}>
      <div><p className={EYEBROW}>RECOVERY</p><h2 className="text-lg font-semibold leading-tight text-balance">Recoverable trash</h2></div>
      <div className={cn(ROW_ACTIONS, "trash-card-actions max-[620px]:mt-4")}>
        <button type="button" className={cn("button primary", BTN, BTN_PRIMARY)} id="restore-selected-trash" disabled={selectedCount === 0} onClick={onRestoreSelected}>Restore selected{selectedCount ? ` (${selectedCount})` : ""}</button>
        <button type="button" className={cn("button danger", BTN, BTN_DANGER)} id="empty-trash" disabled={!hasTrash} onClick={onEmpty}>Empty trash</button>
        {/* Always present: it used to appear only once the trash had items, so
            the two buttons before it slid 85px sideways each time that flipped. */}
        <button type="button" className={cn("button", BTN)} onClick={onRefresh}>Refresh</button>
      </div>
    </div>
    <p className={cn("field-help trash-help mb-4", FIELD_HELP)}>Select deleted transactions to restore in bulk. Deleted items stay here until restored or permanently removed.</p>
    <div className="table-wrap relative">
      <table className={cn("trash-table", TABLE, hasTrash && "max-[620px]:min-w-[680px]")}>
        <thead><tr>
          <th scope="col" className={cn(TH, "trash-select-cell w-[5%] p-0 text-center")}>
            <label className="trash-select-target grid min-h-9 min-w-9 cursor-pointer place-items-center">
              <input ref={node => { if (node) node.indeterminate = selectedCount > 0 && !allSelected; }} type="checkbox" id="select-all-trash" aria-label="Select all trash transactions" checked={allSelected} disabled={!hasTrash} onChange={event => onToggleAll(event.target.checked)} className="m-0 h-4 w-4 accent-xw-accent-fill"/>
            </label>
          </th>
          <th scope="col" className={cn(TH, "w-[14%]")}>Deleted by</th>
          <th scope="col" className={cn(TH, "w-[35%]")}>Items</th>
          <th scope="col" className={cn(TH, "w-[15%]")}>Deleted</th>
          <th scope="col" className={cn(TH, "w-[10%]")}>Size</th>
          <th scope="col" className={cn(TH, "w-[21%]")}><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody className={TABLE_BODY}>
          {trash.map(transaction => <tr key={transaction.transaction_id}>
            <td className="trash-select-cell border-0 border-b border-solid border-admin-line p-0 text-center">
              <label className="trash-select-target grid min-h-9 min-w-9 cursor-pointer place-items-center">
                <input type="checkbox" data-select-trash={transaction.transaction_id} className="m-0 h-4 w-4 accent-xw-accent-fill"
                  aria-label={`Select trash transaction for ${transaction.items.map(item => item.path).join(", ")}`}
                  checked={selected.has(transaction.transaction_id)} onChange={event => onToggle(transaction.transaction_id, event.target.checked)}/>
              </label>
            </td>
            <td className={TD}><strong className={CELL_STRONG}>{transaction.user}</strong></td>
            <td className={cn(TD, "trash-items max-w-none")}>
              {transaction.items.map((item, index) => <TrashPath key={`${item.path}-${index}`} item={item} first={index === 0}/>)}
            </td>
            <td className={TD}>{formatDate(transaction.created)}</td>
            <td className={TD}>{formatBytes(transaction.size)}</td>
            <td className={TD}><div className={cn(ROW_ACTIONS, "justify-end whitespace-nowrap")}>
              <button type="button" className={cn("button small", BTN, BTN_SMALL)} aria-label="Restore deleted items" onClick={() => onRestore(transaction.transaction_id)}>Restore</button>
              <button type="button" className={cn("button small danger", BTN, BTN_SMALL, BTN_DANGER)} aria-label="Permanently delete items" onClick={() => onDelete(transaction.transaction_id)}>Delete permanently</button>
            </div></td>
          </tr>)}
          {!hasTrash && <tr><td colSpan={6} className="empty-cell px-4 py-8 text-center text-admin-faint max-[620px]:text-left">
            <span>Trash is empty. Deleted items stay recoverable here until restored or purged.</span>
          </td></tr>}
        </tbody>
      </table>
    </div>
  </article>;
}

/** The console reports the value the server rejected, so the dialog names the
 *  target rather than asking "are you sure?". The initial focus is Cancel: a
 *  second Enter after the one that opened it must not destroy anything. */
function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: (confirmed: boolean) => void }): React.JSX.Element {
  const backdropRef = useModalFocus<HTMLDivElement>(() => onClose(false));
  // A dialog arrives and leaves with the same pair of motions the file browser's
  // dialogs use: the backdrop fades, the card rises and settles. It used to start
  // fully visible (`initial={false}`) and only animate on the way out.
  return <m.div ref={backdropRef} className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: DIALOG_ENTER }} exit={{ opacity: 0, transition: DIALOG_EXIT }}>
    <m.form className="modal" initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1, transition: DIALOG_ENTER }} exit={{ opacity: 0, y: 7, scale: 0.98, transition: DIALOG_EXIT }}
      role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title" aria-describedby="admin-dialog-description"
      onSubmit={event => { event.preventDefault(); onClose(true); }}>
      <h2 id="admin-dialog-title">{request.title}</h2>
      <p id="admin-dialog-description">{request.message}</p>
      <div className="modal-actions">
        <button type="button" className={cn("button", BTN)} data-autofocus="" onClick={() => onClose(false)}>Cancel</button>
        <button type="submit" className={cn("button danger", BTN, BTN_DANGER)}>{request.confirmText}</button>
      </div>
    </m.form>
  </m.div>;
}

function AccountMenu({ user, open, onToggle, onLeave }: { user: string; open: boolean; onToggle: () => void; onLeave: (event: React.MouseEvent<HTMLElement>) => void }): React.JSX.Element {
  const controlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!controlRef.current?.contains(event.target as Node)) onToggle();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onToggle]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onToggle();
      controlRef.current?.querySelector<HTMLElement>(".account-trigger")?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onToggle]);
  return <div className="account relative" id="account-control" ref={controlRef}>
    <button className={ACCOUNT_TRIGGER} type="button" aria-expanded={open} aria-controls={open ? "account-menu" : undefined} onClick={onToggle}><span>{user}</span><Chevron/></button>
    {open && <div id="account-menu" className={cn(POPOVER, "account-menu min-w-[152px]")} role="group" aria-label="Workspace navigation">
      <a className={MENU_ITEM} href="/" data-leave="/" onClick={onLeave}>Files</a>
      <a className={cn(MENU_ITEM, "active bg-xw-hover text-xw-text")} href="/admin" aria-current="page">Admin panel</a>
    </div>}
  </div>;
}

function AdminApp({ bootstrap }: { bootstrap: AdminBootstrap }): React.JSX.Element {
  const [tab, setTab] = useState(tabFromLocation);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [defaultPermissions, setDefaultPermissions] = useState<PermissionSet | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [activitySummary, setActivitySummary] = useState<ActivitySummary>({ event_count: 0, active_users: 0, by_user: [] });
  const [trash, setTrash] = useState<TrashTransaction[]>([]);
  const [selectedTrash, setSelectedTrash] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<ActivityFilters>({ username: "", since: "", scope: "file" });
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [dialog, setDialog] = useState<ConfirmRequest | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Arriving from the file browser or the editor: no cold-load card, and the
  // entrance matches the 170ms the other side spent leaving.
  const [handover] = useState(() => consumeHandover());
  const [userFormError, setUserFormError] = useState<string | null>(null);
  const [userFormTitle, setUserFormTitle] = useState("Add or update user");

  const tabRef = useRef(tab);
  // The view animates when the tab changes, never when data lands: every payload
  // is already on screen, so animating on arrival hid content that was visible
  // and faded it back in (a flash on every refresh, save and restore).
  const viewEntered = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const toastId = useRef(0);
  const userFormRef = useRef<HTMLFormElement>(null);
  const filterRef = useRef<HTMLFormElement>(null);

  useEffect(() => { tabRef.current = tab; }, [tab]);

  // ── Feedback ───────────────────────────────────────────────────────────────
  const showToast = useCallback((kind: ToastKind, message: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastId.current += 1;
    setToast({ id: toastId.current, kind, message });
    // Errors stay until the next message replaces them, the way the app's rail
    // does; a success clears itself after the same 5200ms the app uses.
    if (kind === "success") toastTimer.current = window.setTimeout(() => { toastTimer.current = null; setToast(null); }, FEEDBACK_DURATION_MS);
  }, []);

  const showError = useCallback((error: unknown) => {
    showToast("error", error instanceof Error ? error.message : "Something went wrong");
  }, [showToast]);

  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); }, []);

  const confirmAction = useCallback((title: string, message: string, confirmText = "Confirm"): Promise<boolean> =>
    new Promise<boolean>(resolve => setDialog({ title, message, confirmText, resolve })), []);

  const closeDialog = useCallback((request: ConfirmRequest, confirmed: boolean) => {
    request.resolve(confirmed);
    setDialog(null);
  }, []);

  // ── Data ───────────────────────────────────────────────────────────────────

  const loadUsers = useCallback(async (): Promise<void> => {
    try {
      const result = await api<{ users: UserRecord[]; default: PermissionSet | null }>("/api/admin/users");
      setUsers(result.users);
      setDefaultPermissions(result.default);
      setStatus(usersAnnouncement(result.users.length));
    } catch (error) { showError(error); }
  }, [showError]);

  const loadMetrics = useCallback(async (): Promise<void> => {
    try {
      const result = await api<Metrics>("/api/admin/metrics");
      setMetrics(result);
      setStatus(overviewAnnouncement(result));
    } catch (error) { showError(error); }
  }, [showError]);

  const loadTrash = useCallback(async (): Promise<void> => {
    try {
      const result = await api<{ transactions: TrashTransaction[] }>("/api/admin/trash", { cache: "no-store" });
      setTrash(result.transactions);
      setSelectedTrash(current => new Set([...current].filter(id => result.transactions.some(transaction => transaction.transaction_id === id))));
      setStatus(trashAnnouncement(result.transactions.length));
    } catch (error) { showError(error); }
  }, [showError]);

  const loadActivity = useCallback(async (form?: HTMLFormElement): Promise<void> => {
    const username = formField<HTMLInputElement>(form ?? null, "username")?.value;
    const since = formField<HTMLInputElement>(form ?? null, "since")?.value;
    const scope = formField<HTMLSelectElement>(form ?? null, "scope")?.value;
    // A refresh from the form keeps the filter it was submitted with; a plain
    // reload (after a purge) goes back to the unfiltered view.
    const next: ActivityFilters = form
      ? { username: username || "", since: since || "", scope: scope || "file" }
      : { username: "", since: "", scope: "file" };
    try {
      const params = new URLSearchParams({ limit: ACTIVITY_LIMIT });
      if (next.username) params.set("username", next.username);
      if (next.since) params.set("since", `${next.since}T00:00:00+00:00`);
      params.set("scope", next.scope);
      const result = await api<{ events: ActivityEvent[]; summary: ActivitySummary }>(`/api/admin/activity?${params}`);
      setEvents(result.events);
      setActivitySummary(result.summary);
      setFilters(next);
      setStatus(activityAnnouncement(result.events.length));
    } catch (error) { showError(error); }
  }, [showError]);

  const loadActiveTab = useCallback((next: string): void => {
    if (next === "users") void loadUsers();
    else if (next === "activity") void loadActivity();
    else if (next === "trash") void loadTrash();
    else void loadMetrics();
  }, [loadActivity, loadMetrics, loadTrash, loadUsers]);

  /** The console paints its shell straight away, the way the editor hydrates
   *  from its bootstrap, and lets the payload fill it. Waiting for four fetches
   *  first left the console on a blank boot card for the slowest request. */
  useEffect(() => {
    dismissBootCard(document, window, handover);
    const cleanupIdle = authSession.wireAuthIdleTimer();
    authSession.wireLogoutForm();
    void (async () => {
      try {
        const [userResult, metricsResult, trashResult, activityResult] = await Promise.all([
          api<{ users: UserRecord[]; default: PermissionSet | null }>("/api/admin/users"),
          api<Metrics>("/api/admin/metrics"),
          api<{ transactions: TrashTransaction[] }>("/api/admin/trash"),
          api<{ events: ActivityEvent[]; summary: ActivitySummary }>(`/api/admin/activity?limit=${ACTIVITY_LIMIT}`),
        ]);
        setUsers(userResult.users);
        setDefaultPermissions(userResult.default);
        setMetrics(metricsResult);
        setTrash(trashResult.transactions);
        setEvents(activityResult.events);
        setActivitySummary(activityResult.summary);
        setLoaded(true);
        // The fill is part of the page entrance, not a tab switch, so it does
        // not animate: the shell's own entrance is the one motion this load gets.
        const current = tabRef.current;
        setStatus(
          current === "users" ? usersAnnouncement(userResult.users.length)
            : current === "activity" ? activityAnnouncement(activityResult.events.length)
              : current === "trash" ? trashAnnouncement(trashResult.transactions.length)
                : overviewAnnouncement(metricsResult),
        );
      } catch (error) {
        setFatal(error instanceof Error ? error.message : "Request failed");
      }
    })();
    return cleanupIdle;
  }, []);

  // The view's one animation: the section arrives when the tab changes (it is
  // keyed by the tab below). The first paint is covered by the shell's entrance.
  useEffect(() => { viewEntered.current = true; }, []);

  useEffect(() => {
    const onPopState = (): void => {
      const next = tabFromLocation();
      if (next === tabRef.current) return;
      setTab(next);
      loadActiveTab(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadActiveTab]);

  // ── Navigation ─────────────────────────────────────────────────────────────
  // SPA links keep real hrefs: a modifier-click or middle-click must reach
  // the browser instead of the in-app path, so a new tab still works.
  const spaClick = (event: React.MouseEvent): boolean => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return false;
    event.preventDefault();
    return true;
  };
  const selectTab = useCallback((event: React.MouseEvent<HTMLAnchorElement>, next: string): void => {
    if (!spaClick(event)) return;
    if (next === tabRef.current) return;
    history.pushState(null, "", `?tab=${next}`);
    // The new section animates in on its own: it is keyed by the tab.
    setTab(next);
    loadActiveTab(next);
  }, [loadActiveTab]);

  /** Fade the console out, then hand over to the file browser. */
  const leaveTo = useCallback((event: React.MouseEvent<HTMLElement>, href: string): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (leaving) return;
    markHandover();
    setLeaving(true);
    window.setTimeout(() => location.assign(href), prefersReducedMotion() ? 0 : 170);
  }, [leaving]);

  const onAccountToggle = useCallback(() => setAccountOpen(open => !open), []);

  // ── User form ──────────────────────────────────────────────────────────────
  /** The user form reports its own failures: the field it describes is three
   *  lines above the save button, not in the corner of the screen. */
  const saveUser = useCallback(async (form: HTMLFormElement): Promise<void> => {
    const usernameField = formField<HTMLInputElement>(form, "username");
    if (!usernameField) return;
    const invalid = usernameError(usernameField.value);
    if (invalid) {
      // The message and the field it describes land in the same turn the submit
      // does: a rejected value never waits for a render to explain itself.
      flushSync(() => setUserFormError(invalid));
      usernameField.focus();
      return;
    }
    setUserFormError(null);
    try {
      const username = usernameField.value;
      const originalUsername = formField<HTMLInputElement>(form, "original-username")?.value || null;
      const result = await api<{ restart_required: boolean }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, original_username: originalUsername, permissions: readPermissions(form, "user") }),
      });
      await loadUsers();
      showToast("success", result.restart_required
        ? `Saved ${username}. Restart X-wing to apply LDAP access changes.`
        : `Saved ${username}. Access updated live.`);
    } catch (error) {
      setUserFormError(error instanceof Error ? error.message : "The user could not be saved.");
      usernameField.focus();
    }
  }, [loadUsers, showToast]);

  const editUser = useCallback((username: string) => {
    const form = userFormRef.current;
    const user = users.find(item => item.username === username);
    if (!user || !form) return;
    const usernameField = formField<HTMLInputElement>(form, "username");
    if (usernameField) usernameField.value = user.username;
    const originalField = formField<HTMLInputElement>(form, "original-username");
    if (originalField) originalField.value = user.username;
    for (const permission of ["read", "write", "delete"] as const) {
      const field = formField<HTMLInputElement>(form, `user-${permission}`);
      if (field) field.checked = user.permissions[permission];
    }
    setUserFormTitle(`Edit ${username}`);
    setUserFormError(null);
    usernameField?.focus();
  }, [users]);

  const clearUserForm = useCallback(() => {
    userFormRef.current?.reset();
    setUserFormError(null);
    setUserFormTitle("Add or update user");
  }, []);

  const deleteUser = useCallback(async (username: string): Promise<void> => {
    try {
      const result = await api<{ restart_required: boolean }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" });
      await loadUsers();
      showToast("success", result.restart_required
        ? `Deleted ${username}. Restart X-wing to apply LDAP access changes.`
        : `Deleted ${username}. Access updated live.`);
    } catch (error) { showError(error); }
  }, [loadUsers, showError, showToast]);

  // ── Trash ──────────────────────────────────────────────────────────────────
  const restoreTrash = useCallback(async (transactionId: string): Promise<void> => {
    try {
      const result = await api<{ restored: number }>(`/api/admin/trash/${encodeURIComponent(transactionId)}/restore`, { method: "POST" });
      await loadTrash();
      showToast("success", `${count(result.restored, "item")} restored.`);
    } catch (error) { showError(error); }
  }, [loadTrash, showError, showToast]);

  const deleteTrash = useCallback(async (transactionId: string): Promise<void> => {
    try {
      const result = await api<{ deleted: number }>(`/api/admin/trash/${encodeURIComponent(transactionId)}`, { method: "DELETE" });
      await loadTrash();
      showToast("success", `${count(result.deleted, "trash item")} permanently deleted.`);
    } catch (error) { showError(error); }
  }, [loadTrash, showError, showToast]);

  const restoreSelectedTrash = useCallback(async (): Promise<void> => {
    try {
      const result = await api<{ restored: number }>("/api/admin/trash/restore", { method: "POST", body: JSON.stringify({ transaction_ids: [...selectedTrash] }) });
      setSelectedTrash(new Set());
      await loadTrash();
      showToast("success", `${count(result.restored, "item")} restored.`);
    } catch (error) { showError(error); }
  }, [loadTrash, selectedTrash, showError, showToast]);

  const emptyTrash = useCallback(async (): Promise<void> => {
    try {
      const result = await api<{ deleted: number }>("/api/admin/trash", { method: "DELETE" });
      await loadTrash();
      showToast("success", `${count(result.deleted, "trash item")} permanently deleted.`);
    } catch (error) { showError(error); }
  }, [loadTrash, showError, showToast]);

  const toggleTrash = useCallback((transactionId: string, checked: boolean) => {
    setSelectedTrash(current => {
      const next = new Set(current);
      if (checked) next.add(transactionId);
      else next.delete(transactionId);
      return next;
    });
  }, []);

  const toggleAllTrash = useCallback((checked: boolean) => {
    setSelectedTrash(checked ? new Set(trash.map(transaction => transaction.transaction_id)) : new Set());
  }, [trash]);

  // ── Confirmed actions ──────────────────────────────────────────────────────
  const confirmPurge = useCallback(async (form: HTMLFormElement): Promise<void> => {
    if (!await confirmAction("Purge audit history?", "Matching audit events will be permanently deleted.", "Purge history")) return;
    try {
      const days = formField<HTMLInputElement>(form, "older_than_days")?.value ?? "";
      const result = await api<{ deleted: number; older_than_days: number }>(`/api/admin/activity?older_than_days=${encodeURIComponent(days)}`, { method: "DELETE" });
      await loadActivity();
      showToast("success", `Purged ${count(result.deleted, "audit event")}.`);
    } catch (error) { showError(error); }
  }, [confirmAction, loadActivity, showError, showToast]);

  const confirmDeleteUser = useCallback(async (username: string): Promise<void> => {
    if (!await confirmAction(`Remove ${username}?`, "This removes users.yaml permissions and LDAP access.", "Remove user")) return;
    await deleteUser(username);
  }, [confirmAction, deleteUser]);

  const confirmDeleteTrash = useCallback(async (transactionId: string): Promise<void> => {
    if (!await confirmAction("Delete trash permanently?", "Selected deleted items cannot be restored after this action.", "Delete permanently")) return;
    await deleteTrash(transactionId);
  }, [confirmAction, deleteTrash]);

  const confirmRestoreSelected = useCallback(async (): Promise<void> => {
    const selectedTransactions = trash.filter(transaction => selectedTrash.has(transaction.transaction_id));
    const items = selectedTransactions.reduce((total, transaction) => total + transaction.items.length, 0);
    if (!await confirmAction(`Restore ${count(selectedTransactions.length, "selected transaction")}?`, `Restore ${count(items, "deleted item")} now.`, "Restore selected")) return;
    await restoreSelectedTrash();
  }, [confirmAction, restoreSelectedTrash, selectedTrash, trash]);

  const confirmEmptyTrash = useCallback(async (): Promise<void> => {
    const items = trash.reduce((total, transaction) => total + transaction.items.length, 0);
    if (!await confirmAction("Empty trash permanently?", `Permanently delete ${count(items, "trashed item")}.`, "Empty trash")) return;
    await emptyTrash();
  }, [confirmAction, emptyTrash, trash]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const allSelected = trash.length > 0 && trash.every(transaction => selectedTrash.has(transaction.transaction_id));

  if (fatal) return <div className="admin-fatal flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center text-admin-muted" role="alert">
    <strong className="text-xl text-admin-text">Admin console unavailable</strong>
    <span>{fatal}</span>
    <a className={`button ${BTN} mt-2`} href="/">Return to files</a>
  </div>;

  return <m.div className={cn("admin-shell h-dvh overflow-y-auto [scrollbar-gutter:stable]", dialog && "modal-open")} initial={{ opacity: 0, y: 6 }} animate={leaving ? { opacity: 0, y: -5 } : { opacity: 1, y: 0 }} transition={leaving ? SHELL_LEAVE : handover ? { duration: 0.17, ease: EASE } : SHELL_ENTER}>
    <header className={cn("topbar admin-topbar", TOPBAR)}>
      <a className={BRAND} href="/" aria-label="X-wing ADMIN, home" data-leave="/" onClick={event => leaveTo(event, "/")}><Logo/><span className={BRAND_NAME}>X-wing</span><small className={BRAND_CONTEXT}>ADMIN</small></a>
      <div className={ACCOUNT_INLINE}>
        <AccountMenu user={bootstrap.user} open={accountOpen} onToggle={onAccountToggle} onLeave={event => leaveTo(event, "/")}/>
        <form id="logout-form" className="m-0" method="post" action="/_auth/logout"><button className={SIGNOUT} type="submit">Sign out</button></form>
      </div>
    </header>
    <main id="admin-main" className="admin-main mx-auto w-full max-w-[1320px] px-4 py-6 pb-16 md:px-12 md:py-14">
      <div className="admin-heading mb-6 flex items-end justify-between gap-6 max-[620px]:block">
        <div>
          <p className={EYEBROW}>CONTROL PLANE</p>
          <h1 className="text-2xl font-bold leading-tight text-balance lg:text-4xl">Workspace administration</h1>
          <p className="lede mt-2 max-w-[620px] text-sm leading-relaxed text-pretty text-admin-muted">Manage user access, activity, and recoverable storage.</p>
        </div>
      </div>
      <nav className="admin-tabs mb-5 flex gap-1 overflow-x-auto border-0 border-b border-solid border-admin-line" aria-label="Admin sections">
        {TABS.map(entry => <a key={entry.id}
          className={cn("admin-tab inline-flex min-h-11 items-center border-b-2 border-solid px-4 font-sans text-xs font-medium whitespace-nowrap no-underline transition-colors duration-micro",
            // The strip scrolls (`overflow-x:auto` clips y as well), so the focus
            // ring sits inside the link instead of being cut off above and below.
            "focus-visible:outline-offset-[-2px]",
            entry.id === tab ? "active border-b-admin-accent text-admin-accent-hi" : "border-b-transparent text-admin-muted hover:bg-admin-raised hover:text-admin-text")}
          href={`?tab=${entry.id}`}
          aria-current={entry.id === tab ? "page" : undefined}
          onClick={event => selectTab(event, entry.id)}>{entry.label}</a>)}
      </nav>
      <m.section id="admin-view" key={tab} className="admin-view min-h-72" initial={viewEntered.current ? VIEW_FROM : false} animate={{ opacity: 1, y: 0 }} transition={VIEW_ENTER}>
        {!loaded ? <LoadingCard/>
          : tab === "users" ? <UsersView users={users} defaultPermissions={defaultPermissions} ldapConfigured={bootstrap.ldapConfigured} formError={userFormError} formTitle={userFormTitle} formRef={userFormRef} onSave={form => void saveUser(form)} onDraftChange={() => { if (userFormError) setUserFormError(null); }} onEdit={editUser} onDelete={username => void confirmDeleteUser(username)} onClear={clearUserForm}/>
            : tab === "activity" ? <ActivityView events={events} summary={activitySummary} filters={filters} filterRef={filterRef} onFilterChange={patch => setFilters(current => ({ ...current, ...patch }))} onFilterSubmit={form => void loadActivity(form)} onPurge={form => void confirmPurge(form)}/>
              : tab === "trash" ? <TrashView trash={trash} selected={selectedTrash} allSelected={allSelected} onToggle={toggleTrash} onToggleAll={toggleAllTrash} onRestore={id => void restoreTrash(id)} onDelete={id => void confirmDeleteTrash(id)} onRestoreSelected={() => void confirmRestoreSelected()} onEmpty={() => void confirmEmptyTrash()} onRefresh={() => void loadTrash()}/>
                : <OverviewView metrics={metrics}/>}
      </m.section>
      <p id="admin-status" className="sr-only" role="status">{status}</p>
    </main>
    <div className={RAIL}>
      {/* popLayout: the toast that is leaving is lifted out of the column at once, so
          the one arriving takes its place instead of shoving it up by its height. */}
      <AnimatePresence initial={false} mode="popLayout">
        {toast && <m.div key={toast.id} className={cn(TOAST, toast.kind, "w-[min(420px,calc(100vw-56px))]", toast.kind === "error" ? TOAST_ERROR : TOAST_SUCCESS)} role={toast.kind === "error" ? "alert" : "status"} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: TOAST_ENTER }} exit={{ opacity: 0, y: 6, transition: TOAST_EXIT }}>
          <span className={TOAST_ICON}><svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{TOAST_ICONS[toast.kind]}</svg></span>
          <span className={TOAST_MESSAGE}>{toast.message}</span>
          {/* A success clears itself and counts down; an error stays until it is
              replaced or dismissed, so it carries a button instead of a timer bar. */}
          {toast.kind === "error"
            ? <button type="button" className={CONTROL_ICON} aria-label="Dismiss" onClick={() => setToast(null)}><svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
            : <span className={TOAST_TIMER} aria-hidden="true" style={{ animationDuration: `${FEEDBACK_DURATION_MS}ms` }}/>}
        </m.div>}
      </AnimatePresence>
    </div>
    {createPortal(
      <AnimatePresence initial={false}>
        {dialog && <ConfirmDialog key="admin-confirm" request={dialog} onClose={confirmed => closeDialog(dialog, confirmed)}/>}
      </AnimatePresence>,
      document.body,
    )}
  </m.div>;
}

const bootstrapNode = document.getElementById("admin-bootstrap");
const adminRoot = document.getElementById("admin-root");
declare global {
  interface Window {
    /** The live console root, so a second mount replaces the first instead of
     *  stacking another React tree on the same container. The jsdom suites
     *  reset `document.body` between cases and unmount through this handle. */
    __xwingAdminRoot?: ReturnType<typeof createRoot>;
  }
}
if (bootstrapNode?.textContent && adminRoot) {
  window.__xwingAdminRoot?.unmount();
  const root = createRoot(adminRoot);
  window.__xwingAdminRoot = root;
  root.render(
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <AdminApp bootstrap={JSON.parse(bootstrapNode.textContent) as AdminBootstrap}/>
      </MotionConfig>
    </LazyMotion>,
  );
}
