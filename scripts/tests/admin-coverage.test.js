import { beforeEach, describe, expect, it, vi } from "vitest";

const alice = { username: "alice", permissions: { read: true, write: false, delete: false } };
const bob = { username: "bob", permissions: { read: true, write: true, delete: true } };
const transactions = [
  {
    transaction_id: "tx-one",
    user: "alice",
    created: "2026-08-01T12:00:00+00:00",
    size: 12,
    items: [{ path: "/one.txt", kind: "file", size: 12 }],
  },
  {
    transaction_id: "tx-two",
    user: "bob",
    created: "2026-08-01T12:01:00+00:00",
    size: 24,
    items: [
      { path: "/two.txt", kind: "file", size: 12 },
      { path: "/folder", kind: "directory", size: 12 },
    ],
  },
];

function json(body, status = 200, url = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  };
}

function installFetch(overrides = {}) {
  const calls = [];
  const fetchMock = vi.fn(async (input, init = {}) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const search = new URL(String(input), window.location.origin).search;
    const method = init.method || "GET";
    const key = `${method} ${path}${search}`;
    calls.push(key);
    let override = overrides[key] ?? overrides[`${method} ${path}`];
    if (typeof override === "function") override = override();
    if (override) {
      if (override instanceof Error || typeof override === "string") throw override;
      return json(override.body ?? override, override.status ?? 200, `${window.location.origin}${path}`);
    }
    if (method === "POST" && path === "/api/admin/users") return json({ restart_required: false });
    if (method === "DELETE" && path.startsWith("/api/admin/users/")) return json({ restart_required: true });
    if (method === "POST" && path === "/api/admin/trash/restore") return json({ restored: 2 });
    if (method === "DELETE" && path === "/api/admin/trash") return json({ deleted: 5 });
    if (method === "POST" && path.endsWith("/restore")) return json({ restored: 1 });
    if (method === "DELETE" && path.startsWith("/api/admin/trash/")) return json({ deleted: 2 });
    if (method === "DELETE" && path === "/api/admin/activity") return json({ deleted: 3, older_than_days: 90 });
    if (path === "/api/admin/users") return json({ users: [alice, bob], default: { read: true, write: false, delete: false } });
    if (path === "/api/admin/metrics") {
      return json({
        configured_users: 2,
        active_users: 1,
        activity_events: 6,
        active_window_minutes: 5,
        storage: { files: 2, bytes: 36 },
        trash: { items: 3, bytes: 36 },
      });
    }
    if (path === "/api/admin/trash") return json({ transactions });
    if (path === "/api/admin/activity") {
      return json({
        events: activityEvents,
        summary: { event_count: activityEvents.length, active_users: 2, by_user: [{ username: "alice", event_count: 6 }] },
      });
    }
    return json({ detail: `Unhandled ${key}` }, 500, `${window.location.origin}${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const activityEvents = [
  {
    occurred_at: "2026-08-01T12:06:00+00:00",
    username: "alice",
    method: "upload",
    path: "/one.txt",
    details: JSON.stringify({ bytes: 2048 }),
    status_code: 200,
    duration_ms: 1,
  },
  {
    occurred_at: "2026-08-01T12:05:00+00:00",
    username: "alice",
    method: "admin_user_upsert",
    path: "/api/admin/users",
    details: JSON.stringify({ username: "carol" }),
    status_code: 200,
    duration_ms: 1,
  },
  {
    occurred_at: "2026-08-01T12:04:00+00:00",
    username: "alice",
    method: "admin_audit_purge",
    path: "/api/admin/activity",
    details: JSON.stringify({ older_than_days: 30 }),
    status_code: 200,
    duration_ms: 1,
  },
  {
    occurred_at: "2026-08-01T12:03:00+00:00",
    username: "alice",
    method: "move",
    path: "/moved.txt",
    details: JSON.stringify({}),
    status_code: 200,
    duration_ms: 1,
  },
  {
    occurred_at: "2026-08-01T12:02:00+00:00",
    username: "alice",
    method: "delete",
    path: "/deleted.txt",
    details: "{not-json",
    status_code: 500,
    duration_ms: 1,
  },
  {
    occurred_at: "2026-08-01T12:01:00+00:00",
    username: "alice",
    method: "restore",
    path: "/restore",
    details: JSON.stringify({ count: 2 }),
    status_code: 200,
    duration_ms: 1,
  },
];

function mount(tab = "overview", { ldapConfigured = false, overrides = {} } = {}) {
  vi.resetModules();
  window.history.replaceState(null, "", `?tab=${tab}`);
  document.body.dataset.authIdleTimeout = "0";
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.__xwingAdminRoot?.unmount();
  window.__xwingAdminRoot = undefined;
  document.body.innerHTML = `
    <div id="admin-root"></div>
    <div id="auth-overlay" hidden>
      <h2 id="auth-overlay-title"></h2>
      <p id="auth-overlay-message"></p>
      <button id="auth-overlay-action"></button>
    </div>
    <form id="logout-form"></form>
    <script id="admin-bootstrap" type="application/json">${JSON.stringify({ user: "admin", ldapConfigured })}</script>
  `;
  const calls = installFetch(overrides);
  return import("../../xwing/frontend/src/admin.tsx?admin-coverage").then(async () => {
    await vi.waitFor(() => expect(document.querySelector("#admin-view, .admin-fatal")).not.toBeNull());
    return calls;
  });
}

function submit(form) {
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

function click(element) {
  element.click();
}

async function confirmDialog(label = "") {
  await vi.waitFor(() => expect(document.querySelector(".modal"), label).not.toBeNull());
  return document.querySelector(".modal");
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin coverage edges", () => {
  it("explains every activity detail shape", async () => {
    await mount("activity");
    await vi.waitFor(() => expect(document.querySelectorAll(".activity-action")).toHaveLength(6));
    const rows = [...document.querySelectorAll(".activity-action")];
    expect(rows.map(row => row.textContent)).toEqual([
      "Uploaded",
      "Saved user",
      "Purged audit history",
      "Moved",
      "Moved to trash",
      "Restored",
    ]);
    expect(document.querySelector(".activity-table")?.textContent).toContain("2.0 KB");
    expect(document.querySelector(".activity-table")?.textContent).toContain("carol");
    expect(document.querySelector(".activity-table")?.textContent).toContain("Older than 30 days");
    expect(document.querySelector(".activity-table")?.textContent).toContain("2 items");
  });

  it("edits, clears and removes users", async () => {
    await mount("users");
    await vi.waitFor(() => expect(document.querySelector("#user-form")).not.toBeNull());

    click(document.querySelector('[aria-label="Edit user alice"]'));
    await vi.waitFor(() => expect(document.querySelector("#user-form-title")?.textContent).toBe("Edit alice"));
    expect(document.querySelector("#username").value).toBe("alice");
    expect(document.querySelector('[name="original-username"]').value).toBe("alice");
    expect(document.querySelector('[name="user-read"]').checked).toBe(true);

    click(document.querySelector("#clear-user"));
    await vi.waitFor(() => expect(document.querySelector("#user-form-title")?.textContent).toBe("Add or update user"));

    click(document.querySelector('[aria-label="Remove user bob"]'));
    click((await confirmDialog("restore cancel")).querySelector("button"));
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    click(document.querySelector('[aria-label="Remove user bob"]'));
    submit(await confirmDialog("restore confirm"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("Restart X-wing"));
  });

  it("validates every username failure and uses missing permission fields as false", async () => {
    await mount("users");
    await vi.waitFor(() => expect(document.querySelector("#user-form")).not.toBeNull());
    const form = document.querySelector("#user-form");
    const username = document.querySelector("#username");
    const error = document.querySelector("#user-form-error");
    const cases = [
      ["*", "wildcard"],
      ["x".repeat(129), "128 characters"],
      ["bad\u0001name", "control characters"],
    ];
    for (const [value, expected] of cases) {
      username.value = value;
      submit(form);
      expect(error.textContent).toContain(expected);
    }

    username.value = "valid";
    document.querySelector('[name="user-write"]').remove();
    submit(form);
    await vi.waitFor(() => expect(document.querySelector(".toast")).not.toBeNull());
  });

  it("handles each trash action, cancel branches and bulk selection", async () => {
    await mount("trash");
    await vi.waitFor(() => expect(document.querySelectorAll("[data-select-trash]")).toHaveLength(2));

    click(document.querySelector('[data-select-trash="tx-one"]'));
    await vi.waitFor(() => expect(document.querySelector("#restore-selected-trash")?.textContent).toContain("(1)"));
    click(document.querySelector('[data-select-trash="tx-one"]'));
    await vi.waitFor(() => expect(document.querySelector("#restore-selected-trash")?.textContent).not.toContain("("));
    click(document.querySelector('[data-select-trash="tx-one"]'));
    await vi.waitFor(() => expect(document.querySelector("#restore-selected-trash")?.textContent).toContain("(1)"));
    click(document.querySelector("#select-all-trash"));
    await vi.waitFor(() => expect(document.querySelector("#restore-selected-trash")?.textContent).toContain("(2)"));
    click(document.querySelector("#select-all-trash"));
    await vi.waitFor(() => expect(document.querySelector("#restore-selected-trash")?.textContent).not.toContain("("));

    click(document.querySelector('[aria-label="Restore deleted items"]'));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("restored"));

    click(document.querySelector('[aria-label="Permanently delete items"]'));
    click((await confirmDialog("delete cancel")).querySelector("button"));
    await vi.waitFor(() => expect(document.querySelector(".modal")).toBeNull());
    click(document.querySelector('[aria-label="Permanently delete items"]'));
    submit(await confirmDialog("delete confirm"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("permanently deleted"));

    click(document.querySelector('[data-select-trash="tx-one"]'));
    click(document.querySelector("#restore-selected-trash"));
    click((await confirmDialog("bulk restore cancel")).querySelector("button"));
    await vi.waitFor(() => expect(document.querySelector(".modal")).toBeNull());
    click(document.querySelector("#restore-selected-trash"));
    submit(await confirmDialog("bulk restore confirm"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("restored"));

    click(document.querySelector("#empty-trash"));
    click((await confirmDialog("empty cancel")).querySelector("button"));
    await vi.waitFor(() => expect(document.querySelector(".modal")).toBeNull());
    click(document.querySelector("#empty-trash"));
    submit(await confirmDialog("empty confirm"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("permanently deleted"));

    click(document.querySelector(".trash-card-actions button:last-child"));
    await vi.waitFor(() => expect(document.querySelector(".toast")).not.toBeNull());
  });

  it("reports failed user and trash actions", async () => {
    await mount("users", {
      overrides: {
        "DELETE /api/admin/users/bob": new Error("delete user failed"),
      },
    });
    await vi.waitFor(() => expect(document.querySelector("#user-form")).not.toBeNull());
    click(document.querySelector('[aria-label="Remove user bob"]'));
    submit(await confirmDialog("failed user delete"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("delete user failed"));

    await mount("trash", {
      overrides: {
        "POST /api/admin/trash/tx-one/restore": new Error("restore failed"),
        "DELETE /api/admin/trash/tx-one": new Error("delete failed"),
        "POST /api/admin/trash/restore": new Error("bulk restore failed"),
        "DELETE /api/admin/trash": new Error("empty failed"),
      },
    });
    await vi.waitFor(() => expect(document.querySelectorAll("[data-select-trash]")).toHaveLength(2));

    click(document.querySelector('[aria-label="Restore deleted items"]'));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("restore failed"));
    click(document.querySelector('[aria-label="Permanently delete items"]'));
    submit(await confirmDialog("failed trash delete"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("delete failed"));

    click(document.querySelector('[data-select-trash="tx-one"]'));
    click(document.querySelector("#restore-selected-trash"));
    submit(await confirmDialog("failed bulk restore"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("bulk restore failed"));

    click(document.querySelector("#empty-trash"));
    submit(await confirmDialog("failed empty"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("empty failed"));
  });

  it("reports failed refreshes from each data loader", async () => {
    let userCalls = 0;
    let trashCalls = 0;
    let activityCalls = 0;
    await mount("overview", {
      overrides: {
        "GET /api/admin/users": () => {
          userCalls += 1;
          return userCalls > 1 ? new Error("users refresh failed") : undefined;
        },
        "GET /api/admin/trash": () => {
          trashCalls += 1;
          return trashCalls > 1 ? new Error("trash refresh failed") : undefined;
        },
        "GET /api/admin/activity": () => {
          activityCalls += 1;
          return activityCalls > 1 ? new Error("activity refresh failed") : undefined;
        },
      },
    });

    click([...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Users"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("users refresh failed"));
    click([...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Trash"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("trash refresh failed"));
    click([...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Activity"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("activity refresh failed"));
    click([...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Overview"));
    await vi.waitFor(() => expect(document.querySelector(".metric-card")).not.toBeNull());
  });

  it("submits and clears activity filters and purges from both form states", async () => {
    await mount("activity");
    await vi.waitFor(() => expect(document.querySelector("#activity-filter")).not.toBeNull());
    const form = document.querySelector("#activity-filter");
    const setInput = (selector, value) => {
      const input = form.querySelector(selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setInput("#activity-user", "alice");
    setInput("#activity-since", "2026-08-01");
    form.querySelector("#activity-scope").value = "all";
    form.querySelector("#activity-scope").dispatchEvent(new Event("change", { bubbles: true }));
    submit(form);
    await vi.waitFor(() => expect(document.querySelector("#admin-status")?.textContent).toContain("Activity loaded"));

    const purge = document.querySelector("#audit-purge-form");
    purge.querySelector("#audit-retention").remove();
    submit(purge);
    submit(await confirmDialog());
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("Purged"));
  });

  it("navigates tabs, responds to history and closes the account menu", async () => {
    await mount("overview");
    const usersTab = [...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Users");
    click(usersTab);
    await vi.waitFor(() => expect(document.querySelector("#user-form")).not.toBeNull());
    click(usersTab);
    usersTab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(usersTab.hasAttribute("aria-current")).toBe(true);
    click([...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Activity"));
    await vi.waitFor(() => expect(document.querySelector(".activity-table")).not.toBeNull());
    click([...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Trash"));
    await vi.waitFor(() => expect(document.querySelector(".trash-table")).not.toBeNull());

    window.history.replaceState(null, "", "?tab=users");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => expect(document.querySelector("#user-form")).not.toBeNull());
    window.dispatchEvent(new PopStateEvent("popstate"));

    const account = document.querySelector(".account-trigger");
    click(account);
    await vi.waitFor(() => expect(document.querySelector("#account-menu")).not.toBeNull());
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("#account-menu")).toBeNull());
    click(account);
    await vi.waitFor(() => expect(document.querySelector("#account-menu")).not.toBeNull());
    click(document.querySelector('#account-menu a[href="/"]'));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector("#account-menu")).toBeNull());
    expect(document.activeElement).toBe(account);
  });

  it("renders fatal errors and reports refresh failures", async () => {
    vi.stubGlobal("location", {
      ...window.location,
      assign: vi.fn(),
      href: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    });
    await mount("users", { overrides: { "GET /api/admin/users": new Error("Boom") } });
    expect(document.body.textContent).toContain("Admin console unavailable");
    expect(document.body.textContent).toContain("Boom");

    let metricsCalls = 0;
    await mount("overview", {
      overrides: {
        "GET /api/admin/metrics": () => {
          metricsCalls += 1;
          return metricsCalls > 1 ? new Error("Metrics down") : undefined;
        },
      },
    });
    click([...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Trash"));
    await vi.waitFor(() => expect(document.querySelector(".trash-table")).not.toBeNull());
    click([...document.querySelectorAll(".admin-tab")].find(node => node.textContent === "Overview"));
    await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("Metrics down"));
    click(document.querySelector('.toast button[aria-label="Dismiss"]'));
    await vi.waitFor(() => expect(document.querySelector(".toast")).toBeNull());

    click(document.querySelector(".brand"));
    document.querySelector(".brand").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  });
});
