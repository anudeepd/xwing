import { beforeEach, describe, expect, it, vi } from "vitest";

const alice = { username: "alice", permissions: { read: true, write: false, delete: false } };

function routeMock({ save } = {}) {
  const calls = [];
  const mock = vi.fn(async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method || "GET";
    calls.push(`${method} ${path}`);
    const body = async () => ({ users: [alice], default: null });
    if (method === "POST" && path === "/api/admin/users") {
      const result = await save(JSON.parse(String(init?.body)));
      if (result.error) return { ok: false, status: 400, url: `${window.location.origin}${path}`, json: async () => ({ detail: result.error }) };
      return { ok: true, status: 200, url: `${window.location.origin}${path}`, json: async () => ({ restart_required: false, users: [alice, result.user] }) };
    }
    const payload = path === "/api/admin/users"
      ? { users: [alice], default: null }
      : path === "/api/admin/trash"
        ? { transactions: [] }
        : path === "/api/admin/metrics"
          ? { configured_users: 1, active_users: 1, activity_events: 0, active_window_minutes: 5, storage: { files: 1, bytes: 3 }, trash: { items: 0, bytes: 0 } }
          : { events: [], summary: { event_count: 0, active_users: 0, by_user: [] } };
    void body;
    return { ok: true, status: 200, url: `${window.location.origin}${path}`, json: async () => payload };
  });
  return { mock, calls };
}

describe("admin user form errors", () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, "", "?tab=users");
    document.body.dataset.authIdleTimeout = "0";
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

  async function mount({ save } = {}) {
    const { mock, calls } = routeMock({ save });
    vi.stubGlobal("fetch", mock);
    await import("../../xwing/frontend/src/admin.tsx?admin-user-form-regression");
    await vi.waitFor(() => expect(document.querySelector("#user-form")).not.toBeNull());
    return calls;
  }

  function submit(username) {
    const form = document.querySelector("#user-form");
    form.elements.namedItem("username").value = username;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    return { form, error: document.querySelector("#user-form-error"), input: document.querySelector("#username") };
  }

  // The field is three lines above the save button; the corner toast was the
  // only surface for a rejection the server answers with a bare 400.
  it("explains a rejected username on the field and skips the request", async () => {
    const calls = await mount({ save: async () => ({ user: alice }) });
    const { error, input } = submit("   ");

    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Enter a username.");
    expect(error.getAttribute("aria-live")).toBe("polite");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("user-form-help user-form-error");
    expect(document.activeElement).toBe(input);
    expect(calls.filter(call => call.startsWith("POST"))).toHaveLength(0);
  });

  it("rejects a slash before the request is sent", async () => {
    const calls = await mount({ save: async () => ({ user: alice }) });
    const { error } = submit("alice/bob");

    expect(error.textContent).toBe("A username cannot contain a slash.");
    expect(calls.filter(call => call.startsWith("POST"))).toHaveLength(0);
  });

  it("shows a server rejection inline instead of only in the toast", async () => {
    await mount({ save: async () => ({ error: "Invalid username" }) });
    const { error, input } = submit("Acme\\alice.");

    await vi.waitFor(() => expect(error.textContent).toBe("Invalid username"));
    expect(error.hidden).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("saves a valid username and clears the message", async () => {
    const calls = await mount({ save: async () => ({ user: { username: "bob", permissions: { read: true, write: false, delete: false } } }) });
    const { error, input, form } = submit("bob");

    await vi.waitFor(() => expect(calls.some(call => call === "POST /api/admin/users")).toBe(true));
    expect(error.hidden).toBe(true);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.getAttribute("aria-describedby")).toBe("user-form-help");

    // A rejected value clears its message as soon as the next keystroke arrives.
    form.dispatchEvent(new Event("input", { bubbles: true }));
    expect(error.hidden).toBe(true);
  });
});
