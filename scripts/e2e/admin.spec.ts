import { expect, test } from "@playwright/test";

/**
 * The admin console only answers behind LDAPGate, so these specs run against the
 * trusted-proxy server on 8993 and identify themselves the way a proxy would.
 * Everything here is read-only against the shared fixtures: the purge uses a
 * retention no event can fall outside, and the form check is refused client side
 * before a request is made.
 */
test.use({
  baseURL: "http://127.0.0.1:8993",
  extraHTTPHeaders: { "X-Forwarded-User": "e2e-admin" },
});

test("the console mounts and is painted, not merely present", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Workspace administration" })).toBeVisible();
  // `motion/react-m` components stay at their initial state without a
  // `LazyMotion` provider, which renders a mounted surface at opacity 0.
  await expect(page.locator(".admin-shell")).toHaveCSS("opacity", "1");
  await expect(page.locator(".metric-card").first()).toBeVisible();
});

// The console's controls are `button` plus a set of utilities. That set is built
// from a template literal, and a brace mistake there turns every class into
// "[object Object]": the hooks still resolve, the DOM still passes, and the
// buttons quietly fall back to the user-agent grey.
test("console controls are styled, not just present", async ({ page }) => {
  await page.goto("/admin?tab=users");
  const save = page.getByRole("button", { name: "Save user" });
  await expect(save).toHaveCSS("background-color", "rgb(124, 58, 237)");
  await expect(save).toHaveCSS("border-radius", "6px");
  await expect(save).not.toHaveClass(/\[object/);

  const clear = page.getByRole("button", { name: "Clear" });
  await expect(clear).toHaveCSS("background-color", "rgb(18, 24, 39)");
});

test("every tab loads, announces one line and owns its URL", async ({ page }) => {
  await page.goto("/admin?tab=overview");
  await expect(page.locator("#admin-status")).toHaveText(/Overview loaded:/);

  await page.getByRole("link", { name: "Users" }).click();
  await expect(page).toHaveURL(/\?tab=users$/);
  await expect(page.locator(".admin-tab.active")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#admin-status")).toHaveText(/Users loaded:/);

  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.locator("#admin-status")).toHaveText(/Activity loaded: \d+ events?\./);
  await expect(page.locator(".activity-table")).toBeVisible();

  await page.getByRole("link", { name: "Trash" }).click();
  await expect(page.locator("#admin-status")).toHaveText(/Trash loaded: \d+ transactions?\./);

  await page.goBack();
  await expect(page).toHaveURL(/\?tab=activity$/);
  await expect(page.locator(".admin-tab.active")).toHaveText("Activity");
});

test("the console opens from the file browser without a loading card", async ({ page }) => {
  await page.goto("/");
  await page.locator(".account-trigger").click();
  await page.getByRole("link", { name: "Admin panel" }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator(".admin-shell")).toBeVisible();
  // The handover marker keeps the cold-load card off the arriving console.
  expect(await page.locator(".boot-loading").count()).toBe(0);
});

test("a destructive confirmation opens on Cancel", async ({ page }) => {
  await page.goto("/admin?tab=activity");
  // A retention no event can fall outside, so the purge deletes nothing: this is
  // about which control the dialog hands focus to.
  // The retention field is labelled "Older than" inside the "Purge audit
  // history" section, so the destructive action is not the field's label.
  await page.getByLabel("Older than").fill("36500");
  await page.getByRole("button", { name: "Purge history" }).click();

  const dialog = page.getByRole("dialog", { name: "Purge audit history?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Purge history" })).toBeFocused();
});

test("the user form explains a rejected name on the field", async ({ page }) => {
  await page.goto("/admin?tab=users");
  const username = page.getByLabel("Username", { exact: true });
  await username.fill("alice/bob");
  await page.getByRole("button", { name: "Save user" }).click();

  const error = page.locator("#user-form-error");
  await expect(error).toBeVisible();
  await expect(error).toHaveText("A username cannot contain a slash.");
  await expect(username).toHaveAttribute("aria-invalid", "true");
  await expect(username).toHaveAttribute("aria-describedby", "user-form-help user-form-error");
  await expect(username).toBeFocused();
});

// The activity filter padded its fields on the right for a select's chevron, which
// the date field does not have: the calendar button sat 32px in from the edge with
// a dead gap after it.
test("the date filter keeps its calendar button at the edge of the field", async ({ page }) => {
  await page.goto("/admin?tab=activity");
  const since = page.getByLabel("Since");
  await expect(since).toHaveCSS("padding-right", "12px");
  await expect(since).toHaveCSS("padding-left", "12px");
  // The select still reserves its chevron's room.
  await expect(page.getByLabel("Show")).toHaveCSS("padding-right", "32px");
});

// The account wrapper was not positioned, so its menu was pinned to the viewport
// edge and sat on top of the Sign out button instead of under its own trigger.
test("the account menu opens under its trigger and clear of Sign out", async ({ page }) => {
  await page.goto("/admin");
  await page.locator(".account-trigger").click();
  const [trigger, menu, signOut] = await Promise.all([
    page.locator(".account-trigger").boundingBox(),
    page.locator("#account-menu").boundingBox(),
    page.getByRole("button", { name: "Sign out" }).boundingBox(),
  ]);
  expect(trigger && menu && signOut).toBeTruthy();
  expect(Math.round(menu!.x + menu!.width)).toBe(Math.round(trigger!.x + trigger!.width));
  expect(menu!.y).toBeGreaterThanOrEqual(trigger!.y + trigger!.height);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(signOut!.x);
});

// An error toast has no countdown to match a timer that is not running: it stays
// until it is replaced or dismissed, and says so with a button instead of a bar.
test("an error toast stays until it is dismissed", async ({ page }) => {
  await page.route(/\/api\/admin\/activity\?older_than_days=/, route =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Purge failed" }) }));
  await page.goto("/admin?tab=activity");
  await page.getByRole("button", { name: "Purge history" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Purge history" }).click();

  const toast = page.getByRole("alert").filter({ hasText: "Purge failed" });
  await expect(toast).toBeVisible();
  await expect(toast.locator(".toast-timer")).toHaveCount(0);
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast).toHaveCount(0);
});

// The sign-out overlay's action is `hidden` until a session actually expires.
// A `display` utility on the button outranked the `hidden` attribute and showed an
// empty violet bar under "Signing out".
test("the sign-out overlay does not show its Sign in now button", async ({ page }) => {
  await page.route("**/_auth/logout", route => route.fulfill({ status: 204 }));
  await page.goto("/admin");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#auth-overlay")).toBeVisible();
  await expect(page.locator("#auth-overlay-action")).toBeHidden();
});
