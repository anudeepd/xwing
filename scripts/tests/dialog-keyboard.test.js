import { beforeEach, describe, expect, it } from "vitest";

import { createDialogController } from "../../xwing/frontend/src/app-core.js";

describe("dialog keyboard UX", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("submits a prompt through its form action", async () => {
    const dialogs = createDialogController({ documentRef: document });
    const result = dialogs.prompt("New folder", "Create a folder.", "Folder name");
    const dialog = document.querySelector(".xwing-dialog");

    document.querySelector(".xwing-dialog-input").value = "  reports  ";
    expect(dialog.tagName).toBe("FORM");
    expect(document.querySelector(".btn-primary").type).toBe("submit");
    dialog.requestSubmit();

    await expect(result).resolves.toBe("reports");
  });

  it("keeps Tab focus inside an open prompt", () => {
    const dialogs = createDialogController({ documentRef: document });
    dialogs.prompt("New folder", "Create a folder.", "Folder name");
    const overlay = document.querySelector(".xwing-dialog-overlay");
    const input = document.querySelector(".xwing-dialog-input");
    const confirm = document.querySelector(".btn-primary");

    confirm.focus();
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(input);

    input.focus();
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(confirm);
  });
});
