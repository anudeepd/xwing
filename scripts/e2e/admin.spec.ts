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
