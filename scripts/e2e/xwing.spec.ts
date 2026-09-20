import { expect, test } from "@playwright/test";

test("daily browser workflow is keyboard-accessible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("img", { name: "X-wing logo" })).toBeVisible();
  await expect(page.getByText("X-wing", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Breadcrumb").getByText("workspace", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Parallel uploads: 4" }).click();
  const menu = page.getByRole("dialog", { name: "Concurrent uploads" });
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
  const releaseDelete = page.getByRole("button", { name: "Delete releases" });

  await releases.focus();
  await page.keyboard.press("Tab");
  await expect(releaseCheckbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(releaseCheckbox).toBeChecked();
  await expect(releaseCheckbox).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(releaseCheckbox).not.toBeChecked();

  await releaseDelete.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete 1 item?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(releaseDelete).toBeFocused();
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

  const rowDelete = page.getByRole("button", { name: "Delete releases" });
  await rowDelete.click();
  const dialog = page.getByRole("dialog", { name: "Delete 1 item?" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(releaseCheckbox).toBeChecked();
  await expect(rowDelete).toBeFocused();

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
  await expect(page.locator(".modal-backdrop")).toHaveClass(/closing/);
  await expect(newFolder).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(folderDialog).toBeVisible();
  await page.keyboard.press("Escape");

  const parallel = page.getByRole("button", { name: /Parallel uploads:/ });
  await parallel.click();
  const parallelDialog = page.getByRole("dialog", { name: "Concurrent uploads" });
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
  const target = page.getByRole("status");
  await expect(target).toContainText("Drop files here");
  await expect(target).toContainText("Upload to /");

  await page.clock.fastForward(1000);
  await app.dispatchEvent("dragover");
  await page.clock.fastForward(1000);
  await expect(target).toContainText("Drop files here");

  await page.clock.fastForward(500);
  await expect(page.getByRole("status")).toHaveText("Preparing upload…");

  await page.clock.fastForward(15000);
  await expect(page.getByRole("status")).toHaveText("Upload hasn't started yet.");
  await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();

  await page.getByRole("button", { name: "Dismiss upload status" }).click();
  await expect(page.getByText("Upload hasn't started yet.")).not.toBeVisible();
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

  await page.locator("input[type=file]").first().setInputFiles({
    name: "browser-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("real browser fetch"),
  });

  const upload = page.getByRole("complementary", { name: "Uploads" });
  await expect(upload).toContainText("1 complete");
  await expect(upload).toContainText("Upload complete");
  await expect(page.getByRole("row", { name: /^browser-upload\.txt,/ })).toBeVisible();
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

  const download = page.getByRole("link", { name: "Download releases" });
  await download.focus();
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", { name: "Delete 2 items?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(download).toBeFocused();

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
  await expect(deletedToast.locator(".toast-timer")).toHaveCSS("animation-duration", "15s");
  await deletedToast.getByRole("button", { name: "Undo" }).click();
  await expect(deletedToast).not.toBeVisible();
  const restoredToast = page.getByRole("status").filter({ hasText: "1 item restored" });
  await expect(restoredToast).toHaveClass(/restored/);
  await expect(restoredToast.locator(".toast-timer")).toHaveCSS("animation-duration", "15s");
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
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
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
  await expect(dialog.getByRole("button", { name: "Discard changes" })).toBeFocused();
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
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

test("listing controls are named and reachable, and the stylesheet keeps its guards", async ({ page }) => {
  await page.goto("/");

  // The skip link is off-screen until focused, then it must be usable.
  const skip = page.getByRole("link", { name: "Skip to files" });
  await skip.focus();
  await expect(skip).toBeFocused();

  await expect(page.getByRole("link", { name: "Download README.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete README.md" })).toBeVisible();

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
  expect(css).toContain(".boot-loading::before");
});


test("an empty folder invites the next step and sorting survives a reload", async ({ page }) => {
  await page.goto("/");

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
  await page.request.put("/e2e-editor.txt", { data: "start" });
  try {
    await page.goto("/e2e-editor.txt?edit");
    const editor = page.getByRole("textbox");
    await expect(editor).toContainText("start");
    await editor.press("End");
    await editor.type("\nmore");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("status")).toContainText("Saved");
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await page.request.delete("/e2e-editor.txt");
  }
});


test.describe("limited access server", () => {
  test("read-only folders explain the limits instead of offering dead controls", async ({ page }) => {
    await page.goto("http://127.0.0.1:8991/");

    await expect(
      page.getByText("Read-only access. Uploads and folder creation are disabled."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "New folder" })).toBeDisabled();

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
