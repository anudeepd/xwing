import { beforeEach, describe, expect, it, vi } from "vitest";

const events = [
  { occurred_at: "2026-09-01T10:00:00+00:00", username: "alice", method: "download", path: "/readme.txt", details: null, status_code: 200, duration_ms: 2 },
  { occurred_at: "2026-09-01T09:59:00+00:00", username: "alice", method: "delete", path: "/old.txt", details: null, status_code: 200, duration_ms: 3 },
];

const adminData = {
  "/api/admin/users": { users: [], default: null },
  "/api/admin/metrics": {
    configured_users: 1,
    active_users: 1,
    activity_events: events.length,
    active_window_minutes: 5,
    storage: { files: 2, bytes: 10 },
    trash: { items: 0, bytes: 0 },
  },
  "/api/admin/trash": { transactions: [] },
  "/api/admin/activity": { events, summary: { event_count: events.length, active_users: 1, by_user: [{ username: "alice", event_count: events.length }] } },
};

function fetchMock() {
  return async input => {
    const path = new URL(String(input), window.location.origin).pathname;
    return {
      ok: true,
      status: 200,
      url: `${window.location.origin}${path}`,
      json: async () => adminData[path] ?? adminData["/api/admin/activity"],
    };
  };
}

describe("admin console announcements and confirm focus", () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, "", "?tab=activity");
    document.body.dataset.authIdleTimeout = "0";
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    document.body.innerHTML = `
      <div id="admin-root"></div>
      <div id="auth-overlay" hidden>
        <h2 id="auth-overlay-title"></h2>
        <p id="auth-overlay-message"></p>
      </div>
      <script id="admin-bootstrap" type="application/json">{"user":"admin","ldapConfigured":false}</script>
    `;
    vi.stubGlobal("fetch", fetchMock());
  });

  async function mount() {
    await import("../../xwing/frontend/src/admin.ts?admin-a11y-regression");
    await vi.waitFor(() => expect(document.querySelector("#audit-purge-form")).not.toBeNull());
  }

  // The view holds the audit table, so as a live region it re-read the whole
  // panel (up to 200 rows) on every tab switch and refresh.
  it("announces the loaded view from one status line instead of the whole view", async () => {
    await mount();

    expect(document.querySelector("#admin-view").getAttribute("aria-live")).toBeNull();
    const status = document.querySelector("#admin-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Activity loaded: 2 events.");
  });

  it("marks the current tab and describes the retention unit", async () => {
    await mount();

    expect(document.querySelector(".admin-tab.active").getAttribute("aria-current")).toBe("page");
    const retention = document.querySelector("#audit-retention");
    expect(retention.getAttribute("aria-describedby")).toBe("audit-retention-unit");
    expect(document.querySelector("#audit-retention-unit").textContent).toBe("days");
  });

  // Enter on the dialog's initial focus must not trigger the purge.
  it("opens the destructive confirmation on Cancel", async () => {
    await mount();

    document.querySelector("#audit-purge-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());

    expect(document.activeElement.textContent).toBe("Cancel");
    expect(document.querySelector(".modal .button.danger").dataset.autofocus).toBeUndefined();
  });
});
