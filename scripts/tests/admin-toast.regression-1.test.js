import { beforeEach, describe, expect, it, vi } from "vitest";

const emptyActivity = {
  events: [],
  summary: { event_count: 0, active_users: 0, by_user: [] },
};

const adminData = {
  "/api/admin/users": { users: [], default: null },
  "/api/admin/metrics": {
    configured_users: 0,
    active_users: 0,
    activity_events: 0,
    active_window_minutes: 5,
    storage: { files: 0, bytes: 0 },
    trash: { items: 0, bytes: 0 },
  },
  "/api/admin/trash": { transactions: [] },
  "/api/admin/activity": emptyActivity,
};

/** Answers the console's own requests; `purge` replaces the DELETE response. */
function fetchMock(purge) {
  return async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const url = `${window.location.origin}${path}`;
    const body =
      init?.method === "DELETE"
        ? await purge()
        : adminData[path] ?? emptyActivity;
    return { ok: true, status: 200, url, json: async () => body };
  };
}

describe("admin toast shape", () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, "", "?tab=activity");
    document.body.dataset.authIdleTimeout = "0";
    // The confirm dialog reads the reduced-motion preference before it resolves.
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.__xwingAdminRoot?.unmount();
    window.__xwingAdminRoot = undefined;
    document.body.innerHTML = `
      <div id="admin-root"></div>
      <div id="auth-overlay" hidden>
        <h2 id="auth-overlay-title"></h2>
        <p id="auth-overlay-message"></p>
      </div>
      <script id="admin-bootstrap" type="application/json">{"user":"admin","ldapConfigured":false}</script>
    `;
  });

  /** Drives the purge form, which is the shortest path to a real admin toast. */
  async function purge(handler) {
    vi.stubGlobal("fetch", fetchMock(handler));
    await import("../../xwing/frontend/src/admin.tsx?admin-toast-regression");
    await vi.waitFor(() => expect(document.querySelector("#audit-purge-form")).not.toBeNull());

    const form = document.querySelector("#audit-purge-form");
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".modal")).not.toBeNull());
    document.querySelector(".modal").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".notify-rail > .toast")).not.toBeNull());
    return document.querySelector(".notify-rail > .toast");
  }

  // The toast grid is `24px minmax(0,1fr) auto`. A message rendered without the
  // icon and timer slots lands in the 24px column and wraps one word per line.
  it("renders the purge result into every grid slot the toast template needs", async () => {
    const toast = await purge(async () => ({ deleted: 0, older_than_days: 36500 }));

    // The hook class stays first; the element also carries its styling now.
    expect([...toast.children].map(child => child.className.split(" ")[0])).toEqual([
      "toast-icon",
      "toast-message",
      "toast-timer",
    ]);
    // The kind drives the colours, so it sits after the shared utilities; the
    // hook classes are what the console and the tests select on.
    expect(toast.classList.contains("toast")).toBe(true);
    expect(toast.classList.contains("success")).toBe(true);
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.querySelector(".toast-message").textContent).toBe("Purged 0 audit events.");
    expect(toast.querySelector(".toast-timer").style.animationDuration).toBe("5200ms");
  });

  it("announces a failed purge as an alert carrying the error glyph", async () => {
    const toast = await purge(async () => {
      throw new Error("Purge failed");
    });

    expect(toast.classList.contains("toast")).toBe(true);
    expect(toast.classList.contains("error")).toBe(true);
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.querySelector(".toast-message").textContent).toBe("Purge failed");
    expect(toast.querySelector(".toast-icon svg")).not.toBeNull();
  });
});
