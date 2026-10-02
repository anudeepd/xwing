import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The writable root for the tests that create or delete real files — a server of
 * its own (see e2e/prepare-roots.mjs). `e2e/fixtures` is shared with the tests
 * that assert on its row order, selection counts and snapshots, and the chromium
 * and firefox projects run all of them at the same time, so a file appearing in
 * that listing mid-run breaks those assertions.
 */
const WRITABLE = "http://127.0.0.1:8992";

interface BootstrapFile {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number | null;
  modified: string | null;
  editable: boolean;
}

interface BootstrapPatch {
  permissions?: { read: boolean; write: boolean; delete: boolean };
  files?: BootstrapFile[];
}

/**
 * Serve the app with a patched bootstrap.
 *
 * The bootstrap is the embedded JSON the shell hydrates from, so patching it as
 * the document loads is how a state no fixture server provides gets exercised:
 * the three reachable `write`/`delete` combinations, and a listing that does not
 * change while a test is measuring it.
 */
async function gotoWithBootstrap(page: Page, patch: BootstrapPatch): Promise<void> {
  await page.route("**/*", async route => {
    const request = route.request();
    if (request.method() !== "GET" || !(request.headers()["accept"] ?? "").includes("text/html")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["content-length"];
    delete headers["content-encoding"];
    const patched = (await response.text()).replace(
      /(<script type="application\/json" id="xwing-bootstrap">)([\s\S]*?)(<\/script>)/,
      (_match, open: string, json: string, close: string) =>
        `${open}${JSON.stringify({ ...JSON.parse(json), ...patch })}${close}`,
    );
    await route.fulfill({ status: response.status(), headers, body: patched });
  });
  await page.goto("/");
}

test("daily browser workflow is keyboard-accessible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("img", { name: "X-wing logo" })).toBeVisible();
  await expect(page.getByText("X-wing", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Breadcrumb").getByText("workspace", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Parallel uploads: 4" }).click();
  const menu = page.getByRole("group", { name: "Parallel uploads" });
  await expect(menu).toBeVisible();
  await menu.getByRole("radio", { name: "8" }).click();
  await expect(page.getByRole("button", { name: "Parallel uploads: 8" })).toBeVisible();

  const readme = page.getByRole("row", { name: /^README\.md,/ });
  await page.getByRole("checkbox", { name: "Select README.md" }).click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect.poll(() => readme.evaluate(element => document.activeElement === element)).toBe(true);
  const releases = page.getByRole("row", { name: /^releases,/ });
  await releases.click({ modifiers: ["Shift"] });
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await releases.click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await releases.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog")).toContainText("Delete 2 items?");
  await page.getByRole("button", { name: "Cancel" }).click();
  await releases.focus();
  await releases.press("Escape");
  await expect(page.getByText("2 selected", { exact: true })).not.toBeVisible();
  await releases.focus();
  await releases.press("Enter");
  await expect(page).toHaveURL(/\/releases\/$/);
  await expect.poll(() => page.getByRole("row", { name: /^checksums\.txt,/ }).evaluate(element => document.activeElement === element)).toBe(true);
  await page.goBack();
  await expect(page.getByRole("row", { name: /^README\.md,/ })).toBeVisible();
});

test("file keyboard commands respect focus ownership", async ({ page }) => {
  await page.goto("/");

  const releases = page.getByRole("row", { name: /^releases,/ });
  const releaseCheckbox = page.getByRole("checkbox", { name: "Select releases" });
  const releaseActions = page.getByRole("button", { name: "Actions for releases" });
  const releaseDelete = page.getByRole("menuitem", { name: "Delete releases" });

  await releases.focus();
  await page.keyboard.press("Tab");
  await expect(releaseCheckbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(releaseCheckbox).toBeChecked();
  await expect(releaseCheckbox).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(releaseCheckbox).not.toBeChecked();

  // Row rename/download/delete live behind one Actions disclosure per row.
  await releaseActions.click();
  await releaseDelete.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete 1 item?" });
  await expect(dialog).toBeVisible();
  // The menu is a transient overlay and the dialog owns the screen, so choosing an
  // entry closes it. It used to stay mounted behind the dialog.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  // Cancelled: focus goes back to what opened the menu — here the `⋮`, not the
  // entry that was chosen, which left with the menu.
  await expect(releaseActions).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
});

test("row shortcuts and global selection escape work from natural focus", async ({ page }) => {
  await page.goto("/");

  const releases = page.getByRole("row", { name: /^releases,/ });
  await releases.focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New folder" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByText("1 selected", { exact: true })).not.toBeVisible();

  await releases.focus();
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", { name: "Delete 1 item?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(releases).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/releases\/$/);
});

test("Delete works again after dismissing a mouse-opened delete dialog", async ({ page }) => {
  await page.goto("/");

  const releaseCheckbox = page.getByRole("checkbox", { name: "Select releases" });
  await releaseCheckbox.click();
  await expect(releaseCheckbox).toBeChecked();

  const rowDelete = page.getByRole("menuitem", { name: "Delete releases" });
  await page.getByRole("button", { name: "Actions for releases" }).click();
  await rowDelete.click();
  const dialog = page.getByRole("dialog", { name: "Delete 1 item?" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(releaseCheckbox).toBeChecked();
  await expect(page.getByRole("button", { name: "Actions for releases" })).toBeFocused();

  await page.keyboard.press("Delete");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");

  const bulkDelete = page.getByRole("button", { name: "Delete selected" });
  await bulkDelete.click();
  await page.keyboard.press("Escape");
  await expect(bulkDelete).toBeFocused();
  await expect(releaseCheckbox).toBeChecked();

  await page.keyboard.press("Delete");
  await expect(dialog).toBeVisible();
});

test("selection controls preserve a useful keyboard focus", async ({ page }) => {
  await page.goto("/");

  const releases = page.getByRole("row", { name: /^releases,/ });
  await releases.click();
  await page.getByRole("button", { name: "Clear" }).click();

  await expect(releases).toBeFocused();
  await expect(page.getByText("1 selected", { exact: true })).not.toBeVisible();
});

test("mouse and keyboard transitions keep layer and trigger ownership", async ({ page }) => {
  await page.goto("/");

  const newFolder = page.getByRole("button", { name: "New folder" });
  await newFolder.click();
  const folderDialog = page.getByRole("dialog", { name: "New folder" });
  await expect(folderDialog.getByRole("textbox", { name: "Folder name" })).toBeFocused();
  await page.keyboard.press("Escape");
  // The exit is AnimatePresence's now, so assert what the user can observe: the
  // dialog leaves and the trigger takes focus back.
  await expect(folderDialog).not.toBeVisible();
  await expect(newFolder).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(folderDialog).toBeVisible();
  await page.keyboard.press("Escape");

  const parallel = page.getByRole("button", { name: /Parallel uploads:/ });
  await parallel.click();
  const parallelDialog = page.getByRole("group", { name: "Parallel uploads" });
  await page.keyboard.press("Escape");
  await expect(parallelDialog).not.toBeVisible();
  await expect(parallel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(parallelDialog).toBeVisible();
  await page.keyboard.press("Escape");

  const anonymous = page.getByText("anonymous", { exact: true });
  await expect(anonymous).toHaveCSS("font-size", "12px");
  await page.getByRole("row", { name: /^releases,/ }).click();
  await expect(anonymous).toBeVisible();
  await expect(page.getByRole("button", { name: "Account: anonymous" })).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("1 selected", { exact: true })).not.toBeVisible();
});

test("dragging files exposes feedback and a delayed-drop fallback", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");

  const app = page.locator(".xw-app");
  await app.dispatchEvent("dragenter");
  await app.dispatchEvent("dragover");
  // Scoped: the boot card keeps role=status until its removal timer runs, and
  // this test freezes the clock, so a bare role lookup matches two elements.
  const target = page.locator(".drop-target");
  await expect(target).toContainText("Drop files here");
  await expect(target).toContainText("Upload to /");

  await page.clock.fastForward(1000);
  await app.dispatchEvent("dragover");
  await page.clock.fastForward(1000);
  await expect(target).toContainText("Drop files here");

  await page.clock.fastForward(500);
  await expect(page.locator(".drop-wait [role=status]")).toHaveText("Preparing upload…");

  await page.clock.fastForward(15000);
  await expect(page.locator(".drop-wait [role=status]")).toHaveText("Upload hasn't started yet.");
  await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();

});

// The dismissal lives on its own: this one runs on the real clock, because the
// bar leaves through an exit animation and a fake clock's frozen frame loop
// never lets it finish.
test("dismissing the drop feedback clears it", async ({ page }) => {
  await page.goto("/");

  const app = page.locator(".xw-app");
  await app.dispatchEvent("dragenter");
  await app.dispatchEvent("dragover");
  await expect(page.locator(".drop-wait")).toBeVisible();

  await page.getByRole("button", { name: "Dismiss upload status" }).click();
  await expect(page.locator(".drop-wait")).toHaveCount(0);
  await expect(page.locator(".drop-target")).toHaveCount(0);
});

test("a completed browser upload refreshes the folder automatically", async ({ page }) => {
  await page.goto("/");

  const bootstrap = JSON.parse(await page.locator("#xwing-bootstrap").textContent() ?? "{}") as { files: unknown[] } & Record<string, unknown>;
  let directoryRefreshes = 0;
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/_upload/")) {
      if (path === "/_upload/init") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ upload_id: "browser-upload", chunk_size: 8 * 1024 * 1024, concurrency: 4, size: 18 }) });
      }
      if (path.endsWith("/complete")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: "browser-upload.txt", size: 18 }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ received: 18, ranges: [[0, 18]], next_offset: 18 }) });
    }
    const accept = route.request().headers().accept ?? "";
    if (route.request().method() !== "GET" || !accept.includes("application/vnd.xwing.directory+json")) {
      return route.continue();
    }
    directoryRefreshes += 1;
    await new Promise(resolve => setTimeout(resolve, 120));
    return route.fulfill({
      status: 200,
      contentType: "application/vnd.xwing.directory+json",
      body: JSON.stringify({
        ...bootstrap,
        files: [...bootstrap.files, {
          name: "browser-upload.txt",
          path: "/browser-upload.txt",
          kind: "file",
          size: 18,
          modified: "2026-07-19T12:00:00Z",
          editable: true,
        }],
      }),
    });
  });

  // A finished upload is background news. It must not take focus from the field
  // the user is typing in, and it must not clear what they have selected.
  await page.getByRole("checkbox", { name: "Select README.md" }).click();
  const filter = page.getByRole("searchbox", { name: "Filter files by name" });
  await filter.focus();

  await page.locator("input[type=file]").first().setInputFiles({
    name: "browser-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("real browser fetch"),
  });

  const upload = page.getByRole("complementary", { name: "Uploads" });
  await expect(upload).toContainText("1 complete");
  await expect(upload).toContainText("Upload complete");
  await expect(page.getByRole("row", { name: /^browser-upload\.txt,/ })).toBeVisible();
  await expect(filter).toBeFocused();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect.poll(() => directoryRefreshes).toBe(1);
  await expect(page.getByRole("button", { name: "Refresh folder" })).toHaveCount(0);
  await expect(upload).not.toBeVisible({ timeout: 6000 });
});

test("nested file controls preserve native keys and file commands", async ({ page }) => {
  await page.goto("/");

  const releases = page.getByRole("row", { name: /^releases,/ });
  const releaseCheckbox = page.getByRole("checkbox", { name: "Select releases" });
  const readmeCheckbox = page.getByRole("checkbox", { name: "Select README.md" });
  await releaseCheckbox.click();
  await readmeCheckbox.click({ modifiers: ["Shift"] });
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /^README\.md,/ })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

  const download = page.getByRole("menuitem", { name: "Download releases" });
  await page.getByRole("button", { name: "Actions for releases" }).click();
  await download.focus();
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", { name: "Delete 2 items?" });
  await expect(dialog).toBeVisible();
  // Delete is a row shortcut that also works from inside the open menu, and it
  // takes the menu with it the same way choosing the entry does.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Actions for releases" })).toBeFocused();

  await page.getByRole("button", { name: /Name/ }).focus();
  await page.keyboard.press("Delete");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await releases.focus();
  await page.keyboard.press("Escape");
});

test("successful deletion focuses the nearest surviving row", async ({ page }) => {
  await page.goto("/");
  const bootstrap = JSON.parse(await page.locator("#xwing-bootstrap").textContent() ?? "{}") as { files: Array<{ path: string }> };
  let deleted = false;
  await page.route("**/*", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "DELETE" && path === "/releases/") {
      deleted = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ transaction_id: "delete-1" }) });
    } else if (request.method() === "POST" && path === "/api/restore/delete-1") {
      deleted = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ restored: 1 }) });
    } else if (deleted && request.method() === "GET" && path === "/" && request.headers().accept?.includes("application/vnd.xwing.directory+json")) {
      await route.fulfill({ status: 200, contentType: "application/vnd.xwing.directory+json", body: JSON.stringify({ ...bootstrap, files: bootstrap.files.filter(file => file.path !== "/releases/") }) });
    } else await route.continue();
  });

  const releases = page.getByRole("row", { name: /^releases,/ });
  await releases.focus();
  await page.keyboard.press("Delete");
  await page.getByRole("dialog", { name: "Delete 1 item?" }).getByRole("button", { name: "Delete" }).click();

  await expect(releases).not.toBeVisible();
  await expect(page.getByRole("row", { name: /^README\.md,/ })).toBeFocused();
  const deletedToast = page.getByRole("status").filter({ hasText: "1 item deleted" });
  await expect(deletedToast).toHaveClass(/deleted/);
  // The bar carries the countdown for the toast's own lifetime. Its computed
  // duration is clamped to nothing when the user asks for less motion, so assert
  // the value the app sets rather than the one the stylesheet may lower.
  await expect(deletedToast.locator(".toast-timer")).toHaveAttribute("style", /animation-duration:\s*15000ms/);
  await deletedToast.getByRole("button", { name: "Undo" }).click();
  await expect(deletedToast).not.toBeVisible();
  const restoredToast = page.getByRole("status").filter({ hasText: "1 item restored" });
  await expect(restoredToast).toHaveClass(/restored/);
  await expect(restoredToast.locator(".toast-timer")).toHaveAttribute("style", /animation-duration:\s*15000ms/);
  await expect(page.getByRole("row", { name: /^releases,/ })).toBeVisible();
});

test("failed deletion keeps the dialog keyboard-operable", async ({ page }) => {
  await page.route("**/releases/", route => route.request().method() === "DELETE"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Storage unavailable" }) })
    : route.continue());
  await page.goto("/");

  await page.getByRole("row", { name: /^releases,/ }).focus();
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", { name: "Delete 1 item?" });
  const confirm = dialog.getByRole("button", { name: "Delete" });
  await confirm.click();

  await expect(dialog.getByRole("alert")).toHaveText("Storage unavailable");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("a row can be renamed from its control or with F2", async ({ page }, testInfo) => {
  // The dedicated writable root, and a name unique per invocation: the chromium
  // and firefox projects run this test at the same time against the same server.
  const api = WRITABLE;
  const stamp = `${testInfo.project.name}-${Date.now()}`;
  const original = `e2e-rename-${stamp}.txt`;
  const renamed = `e2e-renamed-${stamp}.txt`;
  const folder = `e2e-dir-${stamp}`;
  const renamedFolder = `${folder}-renamed`;
  await page.request.put(`${api}/${original}`, { data: "hello" });
  await page.request.fetch(`${api}/${folder}/`, { method: "MKCOL" });
  try {
    await page.goto(`${api}/`);
    await expect(page.getByRole("row", { name: `${original}, file`, exact: true })).toBeVisible();

    await page.getByRole("button", { name: `Actions for ${original}` }).click();
    await page.getByRole("menuitem", { name: `Rename ${original}` }).click();
    const dialog = page.getByRole("dialog", { name: `Rename ${original}` });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("textbox");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(original);

    await input.fill(renamed);
    await dialog.getByRole("button", { name: "Rename" }).click();

    const renamedRow = page.getByRole("row", { name: `${renamed}, file`, exact: true });
    await expect(renamedRow).toBeVisible();
    await expect(page.getByRole("row", { name: `${original}, file`, exact: true })).toHaveCount(0);
    await expect(page.getByText(`Renamed to ${renamed}`)).toBeVisible();
    await expect.poll(() => renamedRow.evaluate(row => document.activeElement === row)).toBe(true);

    await renamedRow.focus();
    await page.keyboard.press("F2");
    const keyboardDialog = page.getByRole("dialog", { name: `Rename ${renamed}` });
    await expect(keyboardDialog).toBeVisible();
    await keyboardDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(keyboardDialog).not.toBeVisible();
    await expect(renamedRow).toBeFocused();

    // A folder keeps its trailing slash through the move.
    await page.getByRole("button", { name: `Actions for ${folder}` }).click();
    await page.getByRole("menuitem", { name: `Rename ${folder}` }).click();
    const folderDialog = page.getByRole("dialog", { name: `Rename ${folder}` });
    await folderDialog.getByRole("textbox").fill(renamedFolder);
    await folderDialog.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByRole("row", { name: `${renamedFolder}, directory`, exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: `${folder}, directory`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("row", { name: `${renamed}, file`, exact: true })).toBeVisible();
  } finally {
    await page.request.delete(`${api}/${renamedFolder}`);
    await page.request.delete(`${api}/${folder}`);
    await page.request.delete(`${api}/${renamed}`);
    await page.request.delete(`${api}/${original}`);
  }
});

test("renaming to an exotic name stores exactly that name", async ({ page }, testInfo) => {
  const api = WRITABLE;
  const source = `e2e-exotic-${testInfo.project.name}-${Date.now()}.txt`;
  // A space, an apostrophe, a percent, a hash, a plus and a non-ASCII letter:
  // encodeURIComponent leaves some of these raw while the server re-encodes
  // them, so the client and the server disagree about the path text.
  const exotic = "sp ace'quote%pct#hash+bü.txt";
  await page.request.put(`${api}/${source}`, { data: "payload" });
  try {
    await page.goto(`${api}/`);
    await page.getByRole("button", { name: `Actions for ${source}` }).click();
    await page.getByRole("menuitem", { name: `Rename ${source}` }).click();
    const dialog = page.getByRole("dialog", { name: `Rename ${source}` });
    await dialog.getByRole("textbox").fill(exotic);
    await dialog.getByRole("button", { name: "Rename" }).click();

    const renamedRow = page.getByRole("row", { name: `${exotic}, file`, exact: true });
    await expect(renamedRow).toBeVisible();
    await expect(page.getByRole("row", { name: `${source}, file`, exact: true })).toHaveCount(0);

    // The server reports the name it stored, whatever encoding it chose for the
    // path, and the bytes are intact.
    const listing = await page.request.get(`${api}/`, {
      headers: { Accept: "application/vnd.xwing.directory+json" },
    });
    const body = (await listing.json()) as { files: Array<{ name: string; path: string }> };
    const stored = body.files.find(file => file.name === exotic);
    expect(stored).toBeDefined();
    expect(await (await page.request.get(`${api}/${stored!.path.split("/").pop()}`)).text()).toBe(
      "payload",
    );
  } finally {
    await page.request.delete(`${api}/${encodeURIComponent(exotic)}`);
    await page.request.delete(`${api}/${source}`);
  }
});

test("renaming refuses an empty name and never overwrites an existing one", async ({ page }, testInfo) => {
  const api = WRITABLE;
  const stamp = `${testInfo.project.name}-${Date.now()}`;
  const first = `e2e-take-a-${stamp}.txt`;
  const second = `e2e-take-b-${stamp}.txt`;
  await page.request.put(`${api}/${first}`, { data: "a" });
  await page.request.put(`${api}/${second}`, { data: "b" });
  try {
    await page.goto(`${api}/`);
    await page.getByRole("button", { name: `Actions for ${first}` }).click();
    await page.getByRole("menuitem", { name: `Rename ${first}` }).click();
    const dialog = page.getByRole("dialog", { name: `Rename ${first}` });
    const input = dialog.getByRole("textbox");

    await input.fill("   ");
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Enter one valid name.");
    await expect(input).toHaveAttribute("aria-invalid", "true");

    await input.fill(second);
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("That name is already taken.");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("row", { name: `${first}, file`, exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: `${second}, file`, exact: true })).toBeVisible();
    expect(await (await page.request.get(`${api}/${second}`)).text()).toBe("b");
  } finally {
    await page.request.delete(`${api}/${first}`);
    await page.request.delete(`${api}/${second}`);
  }
});

test("editor shell keeps CodeMirror and dirty-buffer guard", async ({ page }) => {
  await page.goto("/README.md?edit");
  const editor = page.getByRole("textbox");
  await expect(editor).toContainText("Browser regression fixture");
  await expect(editor).toBeFocused();
  await editor.press("End");
  await editor.type("\nUpdated");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Back to files" }).click();
  await expect(page.getByRole("dialog")).toContainText("Discard unsaved changes?");
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(editor).toContainText("Updated");
});

test("editor discard dialog owns focus and restores it", async ({ page }) => {
  await page.goto("/README.md?edit");
  const editor = page.getByRole("textbox");
  await editor.press("End");
  await editor.type("\nUpdated");

  const back = page.getByRole("button", { name: "Back to files" });
  await back.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expect(dialog.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(back).toBeFocused();
  await expect(editor).toContainText("Updated");
});

test("responsive browser has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  await expect(page.getByText("anonymous", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account: anonymous" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New folder" })).toBeVisible();
});

// The editor and the console animate their entrance with motion. A missing
// `LazyMotion` provider leaves every `m.*` component at its initial state, so the
// surface renders, passes every DOM assertion, and is still invisible. Paint is
// the assertion that catches that.
test("a motion-driven surface is painted, not just mounted", async ({ page }) => {
  await page.goto("/README.md?edit");
  await expect(page.locator(".editor-app")).toHaveCSS("opacity", "1");
  await expect(page.locator(".editor-app")).toHaveCSS("transform", "none");
});

test("editor controls keep the same appearance across browser engines", async ({ page }) => {
  await page.goto("/README.md?edit");
  const download = page.getByRole("link", { name: "Download" });
  const save = page.getByRole("button", { name: "Save" });
  await expect(download).toHaveCSS("color", "rgb(231, 234, 240)");
  await expect(download).toHaveCSS("text-decoration-line", "none");
  await expect(download).toHaveCSS("appearance", "none");
  await expect(save).toHaveCSS("background-color", "rgb(124, 58, 237)");
  await expect(page.getByText("anonymous", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account: anonymous" })).toHaveCount(0);
});

test("approved visual states", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium owns deterministic baselines");
  // A fixed listing, because this screenshots the root that other tests add
  // files to and remove files from. Pinning it keeps the baseline about the
  // chrome and the row layout, which is what it is here to protect, instead of
  // about whichever files happened to exist at that moment.
  const files = [
    { name: "releases", path: "/releases/", kind: "directory" as const, size: null, modified: "2026-07-19T12:26:00+00:00", editable: false },
    { name: "README.md", path: "/README.md", kind: "file" as const, size: 38, modified: "2026-07-19T12:26:00+00:00", editable: true },
    { name: "checksums.txt", path: "/checksums.txt", kind: "file" as const, size: 12345, modified: "2026-07-19T12:20:00+00:00", editable: true },
  ];
  await page.setViewportSize({ width: 1440, height: 900 });
  // The route stays installed, so the mobile reload gets the same listing.
  await gotoWithBootstrap(page, { files });
  await expect(page).toHaveScreenshot("browser-desktop.png", { fullPage: true });
  await page.getByRole("button", { name: "Parallel uploads: 4" }).click();
  await expect(page).toHaveScreenshot("parallel-menu-desktop.png", { fullPage: true });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await expect(page).toHaveScreenshot("browser-mobile.png", { fullPage: true });
});


test("dropping files queues them, and an unreadable drop explains itself", async ({ page }) => {
  await page.goto("/");
  await page.route("**/_upload/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/_upload/init") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ upload_id: "drop", chunk_size: 8 * 1024 * 1024, concurrency: 4, size: 12 }) });
    }
    if (path.endsWith("/complete")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: "dropped.txt", size: 12 }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ received: 12, ranges: [[0, 12]], next_offset: 12 }) });
  });

  // A drop carrying nothing is what a DLP extension leaves behind; the page
  // has to say so instead of looking broken.
  await page.locator(".xw-app").dispatchEvent("drop", {
    bubbles: true,
    cancelable: true,
    dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
  });
  await expect(page.getByRole("alert")).toContainText("That drop contained no files");

  await page.locator(".xw-app").dispatchEvent("drop", {
    bubbles: true,
    cancelable: true,
    dataTransfer: await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["dropped body"], "dropped.txt", { type: "text/plain" }));
      return transfer;
    }),
  });

  const upload = page.getByRole("complementary", { name: "Uploads" });
  await expect(upload).toContainText("dropped.txt");
  await expect(upload).toContainText("1 complete");
});

test("shows an in-flight overlay while the archive is built", async ({ page }) => {
  await page.goto("/");

  let release = () => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.route("**/_bulk/zip", async route => {
    await held;
    return route.fulfill({ status: 200, contentType: "application/zip", body: "PK\u0003\u0004zip" });
  });
  page.on("download", () => {});

  await page.getByRole("checkbox", { name: "Select README.md" }).click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Download selected as zip" }).click();

  const overlay = page.getByRole("status").filter({ hasText: "Zipping 1 file" });
  await expect(overlay).toBeVisible();
  await expect(page.getByRole("button", { name: "Download selected as zip" })).toBeDisabled();

  release();
  await expect(overlay).toHaveCount(0);
});

test("a dialog owns the viewport and explains itself", async ({ page }) => {
  // `.modal-backdrop` carries no utility: it is hand-written CSS, and a rule
  // whose declarations go missing does not fail the build — the next rule's
  // block silently adopts its selector. That is how the dialog ended up in the
  // document flow at the bottom of the page with its description clipped.
  await page.goto("/");
  await page.getByRole("button", { name: "Actions for README.md" }).click();
  await page.getByRole("menuitem", { name: "Rename README.md" }).click();

  const backdrop = page.locator(".modal-backdrop");
  await expect(backdrop).toBeVisible();
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const back = (await backdrop.boundingBox())!;
  const card = (await page.locator(".modal").boundingBox())!;
  const description = (await page.locator("#dialog-description").boundingBox())!;

  expect(await backdrop.evaluate(node => getComputedStyle(node).position)).toBe("fixed");
  expect(Math.round(back.width)).toBe(view.w);
  expect(Math.round(back.height)).toBe(view.h);
  expect(Math.abs(card.x + card.width / 2 - view.w / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(card.y + card.height / 2 - view.h / 2)).toBeLessThanOrEqual(1);
  // The sr-only block must not be styling the paragraph: 1px tall is the failure.
  expect(description.height).toBeGreaterThan(10);
});

test("listing controls are named and reachable, and the stylesheet keeps its guards", async ({ page }) => {
  await page.goto("/");

  // The skip link is off-screen until focused, then it must be usable.
  const skip = page.getByRole("link", { name: "Skip to files" });
  await skip.focus();
  await expect(skip).toBeFocused();

  await expect(page.getByRole("menuitem", { name: "Download README.md" })).toBeHidden();
  await page.getByRole("button", { name: "Actions for README.md" }).click();
  await expect(page.getByRole("menuitem", { name: "Download README.md" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename README.md" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete README.md" })).toBeVisible();

  await page.getByRole("checkbox", { name: "Select all" }).click();
  await expect(page.getByRole("checkbox", { name: "Deselect all" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download selected as zip" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete selected" })).toBeVisible();

  const css = await page.evaluate(() => {
    const out: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) out.push(rule.cssText);
      } catch {
        // A stylesheet the page cannot read is skipped rather than hidden.
      }
    }
    return out.join("\n");
  });
  // Without this the page rubber-bands when a drag overshoots it.
  expect(css).toContain("overscroll-behavior: none");
  expect(css).toMatch(/@keyframes xw-spin/);
});


test("an empty folder invites the next step and sorting survives a reload", async ({ page }) => {
  await page.goto(`${WRITABLE}/`);

  await page.getByRole("button", { name: "Name, not sorted" }).click();
  await expect(page.getByRole("button", { name: /^Name, ascending/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Name, ascending/ })).toBeVisible();

  const folder = `e2e-empty-${Date.now()}`;
  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await dialog.getByRole("textbox").fill(folder);
  await dialog.getByRole("button", { name: "Create folder" }).click();

  const row = page.getByRole("row", { name: new RegExp(`^${folder},`) });
  await expect(row).toBeVisible();
  await row.dblclick();

  await expect(page.getByText("This folder is empty")).toBeVisible();
  await expect(page.getByText("Upload files or create a folder to get started.")).toBeVisible();
  await expect(page.getByLabel("Files and folders").getByRole("button", { name: "Upload files" })).toBeEnabled();

  await page.getByRole("link", { name: "workspace" }).click();
  await page.getByRole("checkbox", { name: `Select ${folder}` }).click();
  await page.getByRole("button", { name: "Delete selected" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete 1 item?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("row", { name: new RegExp(`^${folder},`) })).toHaveCount(0);
});

test("the editor reports saves in a live region and Escape returns to the folder", async ({ page }) => {
  const path = `${WRITABLE}/e2e-editor.txt`;
  await page.request.put(path, { data: "start" });
  try {
    await page.goto(`${path}?edit`);
    const editor = page.getByRole("textbox");
    await expect(editor).toContainText("start");
    await editor.press("End");
    await editor.type("\nmore");
    await page.getByRole("button", { name: "Save" }).click();

    // Scoped to the editor's own banner: the boot card keeps role=status until
    // its removal timer runs, so a bare lookup can match two elements.
    await expect(page.getByRole("banner").getByRole("status")).toContainText("Saved");
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await page.request.delete(path);
  }
});


test.describe("limited access server", () => {
  test("read-only folders explain the limits instead of offering dead controls", async ({ page }) => {
    await page.goto("http://127.0.0.1:8991/");

    await expect(
      page.getByText(
        "Read-only access. Uploads, folder creation, rename and delete are disabled.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "New folder" })).toBeDisabled();

    // Rename and delete are policy-disabled and point at the permission notice.
    await page.getByRole("button", { name: "Actions for oversized.txt" }).click();
    const rename = page.getByRole("menuitem", { name: "Rename oversized.txt" });
    await expect(rename).toBeDisabled();
    await expect(rename).toHaveAttribute("aria-describedby", "permission-notice");
    await expect(page.getByRole("menuitem", { name: "Delete oversized.txt" })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "Download oversized.txt" })).toBeEnabled();

    await page.goto("http://127.0.0.1:8991/empty/");
    await expect(page.getByText("This folder is empty")).toBeVisible();
    await expect(page.getByText("You have read-only access here.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
  });

  test("a file too large to edit opens as a read-only preview", async ({ page }) => {
    await page.goto("http://127.0.0.1:8991/oversized.txt?edit");

    await expect(page.getByText(/File too large to edit here/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    // Nothing in the editor accepts typing when the file is only previewed.
    await expect(page.locator(".cm-content[contenteditable=true]")).toHaveCount(0);
  });
});

test.describe("restricted permissions", () => {
  const writeWithoutDelete = { read: true, write: true, delete: false };
  const deleteWithoutWrite = { read: true, write: false, delete: true };

  test("a partial restriction is explained instead of being called read-only", async ({ page }) => {
    await gotoWithBootstrap(page, { permissions: writeWithoutDelete });

    // Uploading is still allowed, so the notice must not claim read-only access.
    await expect(
      page.getByText("Renaming and deleting are disabled for your account."),
    ).toBeVisible();
    await expect(page.getByText(/Read-only access/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload files" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "New folder" })).toBeEnabled();

    // Every control this profile disables points at the notice that explains it,
    // and looks disabled: a full-strength entry that swallows the click reads as
    // broken rather than denied.
    await page.getByRole("button", { name: "Actions for README.md" }).click();
    const rename = page.getByRole("menuitem", { name: "Rename README.md" });
    await expect(rename).toBeDisabled();
    await expect(rename).toHaveAttribute("aria-describedby", "permission-notice");
    await expect(rename).toHaveCSS("opacity", "0.42");
    await expect(rename).toHaveCSS("cursor", "not-allowed");
    const rowDelete = page.getByRole("menuitem", { name: "Delete README.md" });
    await expect(rowDelete).toBeDisabled();
    await expect(rowDelete).toHaveAttribute("aria-describedby", "permission-notice");
    await expect(rowDelete).toHaveCSS("opacity", "0.42");
    const download = page.getByRole("menuitem", { name: "Download README.md" });
    await expect(download).toHaveCSS("opacity", "1");
    await expect(download).toHaveCSS("cursor", "pointer");

    await page.getByRole("checkbox", { name: "Select README.md" }).click();
    const toolbarDelete = page.getByRole("button", { name: "Delete selected" });
    await expect(toolbarDelete).toBeDisabled();
    await expect(toolbarDelete).toHaveAttribute("aria-describedby", "permission-notice");
    await expect(page.getByRole("button", { name: "Download selected as zip" })).toBeEnabled();

    // The regions a keyboard user does reach carry the explanation, because the
    // controls it disables are not focusable.
    await expect(page.getByRole("region", { name: "File actions" })).toHaveAttribute(
      "aria-describedby",
      "permission-notice",
    );
    await expect(page.getByRole("table", { name: "Files" })).toHaveAttribute(
      "aria-describedby",
      "permission-notice",
    );

    // No aria-describedby anywhere on the page points at a missing element.
    const dangling = await page.evaluate(() =>
      [...document.querySelectorAll("[aria-describedby]")]
        .flatMap(element => element.getAttribute("aria-describedby")!.split(/\s+/))
        .filter(id => !document.getElementById(id)),
    );
    expect(dangling).toEqual([]);
  });

  test("a delete-only account can delete but is not told it is read-only", async ({ page }) => {
    await gotoWithBootstrap(page, { permissions: deleteWithoutWrite });

    // Rename is a move, so it also needs write; delete does not.
    await expect(
      page.getByText("Uploads, folder creation and renaming are disabled for your account."),
    ).toBeVisible();
    await expect(page.getByText(/Read-only access/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "New folder" })).toBeDisabled();
    await page.getByRole("button", { name: "Actions for README.md" }).click();
    const rename = page.getByRole("menuitem", { name: "Rename README.md" });
    await expect(rename).toBeDisabled();
    await expect(rename).toHaveAttribute("aria-describedby", "permission-notice");
    await expect(rename).toHaveCSS("opacity", "0.42");
    // Deletion stays available, so it must not be dimmed or pointed at a notice
    // that says it is not.
    const rowDelete = page.getByRole("menuitem", { name: "Delete README.md" });
    await expect(rowDelete).toBeEnabled();
    await expect(rowDelete).not.toHaveAttribute("aria-describedby", "permission-notice");
    await expect(rowDelete).toHaveCSS("opacity", "1");
    await page.getByRole("checkbox", { name: "Select README.md" }).click();
    await expect(page.getByRole("button", { name: "Delete selected" })).toBeEnabled();
  });

  test("an empty folder does not offer an invitation the account cannot take", async ({ page }) => {
    await gotoWithBootstrap(page, { permissions: deleteWithoutWrite, files: [] });

    await expect(page.getByText("This folder is empty")).toBeVisible();
    await expect(page.getByText("You don't have permission to add files here.")).toBeVisible();
    await expect(page.getByText("Upload files or create a folder to get started.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
  });

  test("F2 opens nothing when renaming is not allowed", async ({ page }) => {
    await gotoWithBootstrap(page, { permissions: writeWithoutDelete });

    const row = page.getByRole("row", { name: /^README\.md,/ });
    await row.focus();
    await page.keyboard.press("F2");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row).toBeFocused();
  });
});

/**
 * A control that is only an icon names itself with `aria-label` and shows those
 * same words as a hint. The hint is `aria-hidden` — announcing it as well would
 * say the name twice — so it is found by its class, not by `getByRole`.
 */
test("an icon-only control carries its name as a hover and focus hint", async ({ page }) => {
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Actions for README.md" });
  const hint = page.locator(".tooltip");
  await expect(hint).toHaveCount(0);

  await trigger.hover();
  await expect(hint).toHaveText("Actions for README.md");
  // Centred by measurement, never by a `translate` utility: the entrance
  // keyframes set `transform` too, so a translate-based centring was replaced
  // while they ran and the hint snapped half its width sideways when they ended.
  await expect(hint).toHaveCSS("transform", "none");
  // The trigger sits at the right edge of its row, so the hint has to be clamped
  // back inside the viewport rather than centred off the side of it.
  await expect
    .poll(() =>
      hint.evaluate(element => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= window.innerWidth && box.top >= 0;
      }),
    )
    .toBe(true);

  // WCAG 1.4.13: a hint that opens on hover is dismissible without moving the
  // pointer or the focus.
  await page.keyboard.press("Escape");
  await expect(hint).toHaveCount(0);

  // A keyboard user gets the same hint, and the control keeps its own name.
  await trigger.focus();
  await expect(hint).toHaveText("Actions for README.md");
  await expect(trigger).toHaveAttribute("aria-label", "Actions for README.md");
});

/**
 * Enter in the New folder dialog. Two things used to go wrong. A second Enter
 * submitted the form again, hit the 405 for the folder the first one had just
 * made and reopened the dialog with an error about a success. And a key still
 * held when the dialog closed auto-repeated onto the row that had just taken
 * focus, which opened the folder that had just been made.
 */
test("creating a folder with Enter submits once and never opens the folder", async ({ page }) => {
  await page.goto(`${WRITABLE}/`);
  // Hold the MKCOL answer until both presses have been delivered, so the second
  // Enter lands on the dialog while it is pending — that is the guard under test.
  // A second press that arrives after the dialog is gone is a real press on the
  // row that took focus, and opening the folder is then the right answer.
  await page.route("**/*", async route => {
    if (route.request().method() !== "MKCOL") return route.continue();
    await page.waitForTimeout(400);
    return route.continue();
  });
  // Sorted by name the new folder is not the top row, so focus landing on it
  // cannot be mistaken for "focus the first row".
  await page.getByRole("button", { name: "Name, not sorted" }).click();
  const stamp = Date.now();
  const first = `zz-e2e-enter-a-${stamp}`;
  const second = `zz-e2e-enter-b-${stamp}`;
  try {
    await page.getByRole("button", { name: "New folder" }).click();
    const dialog = page.getByRole("dialog", { name: "New folder" });
    await dialog.getByRole("textbox", { name: "Folder name" }).fill(first);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("row", { name: new RegExp(`^${first},`) })).toBeFocused();
    await expect(page.locator("[role=alert]")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);

    // Hold Enter through the hand-over: the first keydown submits from the
    // field, every one after it is an auto-repeat that lands on the new row.
    await page.getByRole("button", { name: "New folder" }).click();
    await dialog.getByRole("textbox", { name: "Folder name" }).fill(second);
    await page.keyboard.down("Enter");
    await expect(page.getByRole("row", { name: new RegExp(`^${second},`) })).toBeFocused();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await page.request.delete(`${WRITABLE}/${first}/`);
    await page.request.delete(`${WRITABLE}/${second}/`);
  }
});

// `.xw-app button{color:inherit}` once outranked every single-class `text-*`
// utility on a button, so a label took whatever colour its parent had: inside an
// empty folder the primary action came out muted grey on violet.
test("buttons keep the label colour their own class gives them", async ({ page }) => {
  const folder = `e2e-empty-colour-${Date.now()}`;
  await page.request.fetch(`${WRITABLE}/${folder}/`, { method: "MKCOL" });
  try {
    await page.goto(`${WRITABLE}/${folder}/`);
    await expect(page.getByText("This folder is empty")).toBeVisible();
    const invite = page.getByLabel("Files and folders").getByRole("button", { name: "Upload files" });
    await expect(invite).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.getByLabel("File actions").getByRole("button", { name: "Upload files" })).toHaveCSS("color", "rgb(255, 255, 255)");
  } finally {
    await page.request.delete(`${WRITABLE}/${folder}/`);
  }

  await page.goto("/");
  await page.getByRole("checkbox", { name: "Select README.md" }).click();
  await expect(page.getByRole("button", { name: "Delete selected" })).toHaveCSS("color", "rgb(255, 155, 163)");
  await expect(page.getByRole("button", { name: "Clear", exact: true })).toHaveCSS("color", "rgb(139, 149, 168)");
});

// Only Regular and Bold of JetBrains Mono ship. Mono text at 600 (the current
// crumb, upload percentages) needs the Bold face declared, or the browser
// smears the Regular outlines to fake it.
test("monospace emphasis uses a real bold face", async ({ page }) => {
  await page.goto("/releases/");
  await expect
    .poll(() => page.evaluate(() => [...document.fonts].filter(face => face.status === "loaded").map(face => `${face.family} ${face.weight}`)))
    .toContain("JetBrains Mono 700");
});

// CodeMirror's own `.cm-scroller{line-height:1.4}` sat between the editor's 1.7
// and its lines, so rows came out 18.1875px apart. A fractional pitch lands
// alternate baselines between device pixels, which is what reads as soft text.
test("editor lines sit a whole number of pixels apart", async ({ page }) => {
  await page.goto("/README.md?edit");
  await expect(page.locator(".cm-line").nth(2)).toBeVisible();
  // The pitch is a layout measurement, so wait for the faces the editor draws
  // with: reading the first painted frame under load measured a line box the
  // font had not settled into yet, and reported 23 instead of 22.
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tops = [...document.querySelectorAll(".cm-line")].slice(0, 3).map(line => line.getBoundingClientRect().top);
        return tops.slice(1).map((top, index) => top - tops[index]!);
      }),
    )
    .toEqual([22, 22]);
});

// CodeMirror scopes its theme as `.ͼ1 .cm-panel.cm-search …`, three classes deep.
// The editor's own two-class selectors never beat it, so the panel kept
// CodeMirror's cramped padding and every field its stray margin.
test("the search panel wears the spacing the editor stylesheet gives it", async ({ page }) => {
  await page.goto("/README.md?edit");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+f");
  const panel = page.locator(".cm-panel.cm-search");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS("padding", "8px 32px 8px 8px");
  await expect(panel.locator("input.cm-textfield").first()).toHaveCSS("margin", "0px");
  await expect(panel.locator("button.cm-button").first()).toHaveCSS("margin", "0px");
});

// The editor bootstrap used to be read in text mode, which translates CRLF to LF
// before the page ever sees the file: CodeMirror then held LF and saving rewrote
// every line of a Windows file. The bootstrap now keeps the bytes, so the ending
// the file arrived with is what a save writes back.
test("the editor preserves a file's CRLF line endings on save", async ({ page }) => {
  const path = `${WRITABLE}/e2e-crlf-${Date.now()}.txt`;
  await page.request.fetch(path, { method: "PUT", data: "one\r\ntwo\r\n" });
  try {
    await page.goto(`${path}?edit`);
    const editor = page.getByRole("textbox");
    await expect(editor).toContainText("one");
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("three");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    const saved = await page.request.get(path);
    expect(await saved.text()).toBe("one\r\ntwo\r\nthree");
  } finally {
    await page.request.delete(path);
  }
});

// The menu is `fixed`, so what it has to stay inside is the viewport, not the
// table's scroll container: it used to be clipped by the container, and a row
// near the bottom edge opened a menu with its lower items cut off below the
// fold. The side it opens on is measured now.
test("the row actions menu stays inside the viewport at the bottom edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  const files = Array.from({ length: 24 }, (_, index) => ({
    name: `row-${index}.txt`, path: `/row-${index}.txt`, kind: "file" as const,
    size: 10, modified: "2026-07-19T12:00:00Z", editable: true,
  }));
  await gotoWithBootstrap(page, { files });

  const target = await page.evaluate(() => {
    const table = document.querySelector(".file-table")!;
    table.scrollTop = 0;
    const box = table.getBoundingClientRect();
    const rows = [...document.querySelectorAll<HTMLElement>(".file-row")].filter(row => {
      const r = row.getBoundingClientRect();
      return r.top >= box.top && r.bottom <= box.bottom;
    });
    return rows[rows.length - 1]!.querySelector(".filename")!.getAttribute("title")!;
  });

  await page.getByRole("button", { name: `Actions for ${target}` }).click();
  const menu = page.locator("#row-actions-menu");
  await expect(menu).toBeVisible();
  // The menu rises into place over 180ms and the entrance transform is part of
  // its box, so measure the settled one: this test is about where it ends up.
  await expect(menu).toHaveCSS("opacity", "1");
  const state = await menu.evaluate(element => {
    const box = element.getBoundingClientRect();
    return {
      outside: Math.max(0, Math.round(box.bottom - window.innerHeight), Math.round(-box.top), Math.round(box.right - window.innerWidth), Math.round(-box.left)),
      itemsInside: [...element.children].map(child => {
        const r = child.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }),
    };
  });
  expect(state.outside).toBe(0);
  expect(state.itemsInside).toEqual([true, true, true]);
});

/**
 * A row is not a link, so the browser's own menu has nothing to say about it;
 * xwing's actions replace it, and `Shift+F10` is the keyboard's right click.
 * The row the menu belongs to is the one it acts on, so a right click on a row
 * outside the selection selects it first.
 */
test("a row opens its actions menu by right click and by Shift+F10", async ({ page }) => {
  await page.goto("/");
  const readme = page.getByRole("row", { name: /^README\.md,/ });

  await readme.click({ button: "right" });
  const menu = page.locator("#row-actions-menu");
  await expect(menu).toHaveAttribute("role", "menu");
  await expect(page.getByRole("menuitem", { name: "Rename README.md" })).toBeFocused();
  await expect(readme).toHaveAttribute("aria-selected", "true");

  // Escape closes the menu and hands focus back to where it was opened — for a
  // right click that is the row, not the `⋮` the pointer never touched. The row
  // reads Escape as "clear the selection", so a menu that let it through would
  // drop the selection the menu was acting on.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(readme).toBeFocused();
  await expect(readme).toHaveAttribute("aria-selected", "true");

  // The same menu, from the keyboard, on the row that has focus.
  const releases = page.getByRole("row", { name: /^releases,/ });
  await releases.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#row-actions-menu")).toHaveAttribute("aria-label", "Actions for releases");
  await expect(page.getByRole("menuitem", { name: "Rename releases" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(releases).toBeFocused();
});

test("the actions menu walks its entries with the arrow keys", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("row", { name: /^README\.md,/ }).focus();
  await page.keyboard.press("Shift+F10");

  const renamed = page.getByRole("menuitem", { name: "Rename README.md" });
  const download = page.getByRole("menuitem", { name: "Download README.md" });
  const deleted = page.getByRole("menuitem", { name: "Delete README.md" });
  await expect(renamed).toBeFocused();

  // Both ends wrap, which is what a menu is expected to do.
  await page.keyboard.press("ArrowDown");
  await expect(download).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(deleted).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(renamed).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(deleted).toBeFocused();
  await page.keyboard.press("Home");
  await expect(renamed).toBeFocused();
  await page.keyboard.press("End");
  await expect(deleted).toBeFocused();
});

/**
 * The menu leaves through an exit animation, so it stays mounted for a moment
 * after its row stops being the open one. It must not stay reachable while it
 * does: a right click on another row opens that row's menu with the previous one
 * still on screen, and a click where the old entries sat would otherwise act on
 * the row the user has already moved on from.
 */
test("a menu that is leaving cannot be clicked", async ({ page }) => {
  const files = Array.from({ length: 12 }, (_, index) => ({
    name: `row-${index}.txt`, path: `/row-${index}.txt`, kind: "file" as const,
    size: 10, modified: "2026-07-19T12:00:00Z", editable: true,
  }));
  await gotoWithBootstrap(page, { files });

  await page.getByRole("row", { name: /^row-0\.txt,/ }).click({ button: "right" });
  const abandoned = (await page.getByRole("menuitem", { name: "Delete row-0.txt" }).boundingBox())!;
  expect(abandoned.height).toBeGreaterThan(0);

  await page.getByRole("row", { name: /^row-8\.txt,/ }).click({ button: "right" });
  await expect(page.locator("#row-actions-menu")).toHaveAttribute("aria-label", "Actions for row-8.txt");

  await page.mouse.click(abandoned.x + abandoned.width / 2, abandoned.y + abandoned.height / 2);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The menu that is actually open still answers, so the check above is not
  // passing because nothing is clickable.
  await page.getByRole("row", { name: /^row-8\.txt,/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete row-8.txt" }).click();
  await expect(page.getByRole("dialog", { name: "Delete 1 item?" })).toBeVisible();
});

/**
 * The file table is a scroll container, so anything a row draws past its right
 * edge becomes sideways scroll — and in Gecko, which draws a classic 12px bar for
 * it, a bar along the bottom of the listing. The row's actions trigger carries a
 * 40px hit area that is translated 5px at rest, which put 3px of it outside the
 * row. Chromium reports the overflow but never makes it scrollable, so only the
 * measurement catches it there.
 */
test("the file table has nothing to scroll sideways at rest", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("row", { name: /^README\.md,/ })).toBeVisible();
  const table = page.locator(".file-table");

  for (const width of [1280, 700, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() => table.evaluate(element => element.scrollWidth - element.clientWidth), { message: `${width}px wide` })
      .toBe(0);
  }
});

/**
 * A menu entry that opens a dialog closes the menu first: the menu is a transient
 * overlay and the dialog owns the screen. It used to stay mounted behind the
 * dialog — only so the dialog's focus trap could hand focus back to an entry —
 * and was still open after the dialog was cancelled. Focus goes back to what
 * opened the menu instead, which the dialog's trap restores because it records
 * whatever has focus when it mounts.
 */
test("choosing a row action closes the menu, and cancelling its dialog gives focus back", async ({ page }) => {
  await page.goto("/");
  const readme = page.getByRole("row", { name: /^README\.md,/ });

  await readme.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename README.md" }).click();
  await expect(page.getByRole("dialog", { name: "Rename README.md" })).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A right click opened the menu, so the row is where focus goes back to.
  await expect(readme).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

/**
 * The row menu is portalled to <body>, outside `.xw-app` — which is where the shared
 * focus ring, the row's hover and the trigger's focus-within reveal all live. Each
 * of them used to quietly stop reaching it.
 */
test("the open row menu keeps the app's focus ring", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("row", { name: /^README\.md,/ }).focus();
  await page.keyboard.press("Shift+F10");
  const rename = page.getByRole("menuitem", { name: "Rename README.md" });
  await expect(rename).toBeFocused();
  await expect(rename).toHaveCSS("outline-style", "solid");
  await expect(rename).toHaveCSS("outline-color", "rgb(167, 139, 250)");
});

test("a row whose menu is open stays lit and keeps its trigger in view", async ({ page }) => {
  await page.goto("/");
  const readme = page.getByRole("row", { name: /^README\.md,/ });
  await readme.hover();
  await page.getByRole("button", { name: "Actions for README.md" }).click();
  // The pointer moves onto the menu, which is not inside the row, so the row's own
  // hover and focus-within no longer hold: the open menu has to hold them up.
  await page.getByRole("menuitem", { name: "Download README.md" }).hover();
  await expect(readme.locator(".row-actions")).toHaveCSS("opacity", "1");
  await expect(readme).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("Tab leaves the row menu, closing it, and carries on from where it was opened", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("row", { name: /^README\.md,/ }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Rename README.md" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  // Not the next entry, and not the end of the document where the menu is
  // portalled: the control after the row it was opened from.
  await expect(page.getByRole("checkbox", { name: "Select README.md" })).toBeFocused();
});

test("scrolling the listing closes the row menu instead of leaving it behind", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  const files = Array.from({ length: 40 }, (_, index) => ({
    name: `row-${index}.txt`, path: `/row-${index}.txt`, kind: "file" as const,
    size: 10, modified: "2026-07-19T12:00:00Z", editable: true,
  }));
  await gotoWithBootstrap(page, { files });
  await page.getByRole("row", { name: /^row-2\.txt,/ }).click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  // Away from the menu, so the wheel reaches the listing and not the page.
  await page.mouse.move(100, 420);
  await page.mouse.wheel(0, 300);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("a right click on the row's own trigger opens the menu too", async ({ page }) => {
  await page.goto("/");
  const readme = page.getByRole("row", { name: /^README\.md,/ });
  await readme.hover();
  await page.getByRole("button", { name: "Actions for README.md" }).click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(readme).toHaveAttribute("aria-selected", "true");
});

/**
 * Two scrollbar dialects exist and exactly one may be active per engine. Blink
 * reads `::-webkit-scrollbar`, which is what makes its bar 6px and app-coloured;
 * merely naming `scrollbar-width` there hands the bar back to the platform, which
 * draws an overlay that only shows on hover. Gecko ignores `::-webkit-scrollbar`
 * and needs the standard pair, or it draws the desktop's own bar. This pins which
 * engine gets which. It cannot see the one failure that shipped: the guard was
 * `not selector(::-webkit-scrollbar)`, which Playwright's Firefox answers false
 * for and Waterfox 153 answers true for, so this passed while Waterfox kept the
 * desktop's bar. Scrollbar changes still need a look in the real browser.
 */
test("each engine gets exactly one scrollbar dialect", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  const files = Array.from({ length: 40 }, (_, index) => ({
    name: `row-${index}.txt`, path: `/row-${index}.txt`, kind: "file" as const,
    size: 10, modified: "2026-07-19T12:00:00Z", editable: true,
  }));
  await gotoWithBootstrap(page, { files });
  const table = page.locator(".file-table");
  await expect(table).toBeVisible();
  const bar = await table.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      scrolls: element.scrollHeight > element.clientHeight,
      drawnWidth: element.offsetWidth - element.clientWidth,
      standardWidth: style.scrollbarWidth,
      standardColor: style.scrollbarColor,
    };
  });
  expect(bar.scrolls).toBe(true);
  if (browserName === "firefox") {
    // Not the width: Playwright's Firefox reports `none` for it whatever the
    // page says, so the colour pair is what shows the standard properties applied.
    expect(bar.standardColor).not.toBe("auto");
  } else {
    expect(bar.standardWidth).toBe("auto");
    expect(bar.standardColor).toBe("auto");
    expect(bar.drawnWidth).toBe(6);
  }
});
