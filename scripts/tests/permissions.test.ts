import { describe, expect, it } from "vitest";

import { permissionNotice } from "../../xwing/frontend/src/permissions";

// `write` and `delete` are independent in users.yaml, so all four combinations
// are reachable. Rename is a move and therefore needs both.
describe("permissionNotice", () => {
  it("stays silent when nothing is denied", () => {
    expect(permissionNotice({ read: true, write: true, delete: true })).toBeNull();
  });

  it("names rename and delete when only delete is missing", () => {
    expect(permissionNotice({ read: true, write: true, delete: false })).toBe(
      "Renaming and deleting are disabled for your account.",
    );
  });

  it("names uploads, folders and rename when only write is missing", () => {
    expect(permissionNotice({ read: true, write: false, delete: true })).toBe(
      "Uploads, folder creation and renaming are disabled for your account.",
    );
  });

  it("names every disabled action for a read-only account", () => {
    expect(permissionNotice({ read: true, write: false, delete: false })).toBe(
      "Read-only access. Uploads, folder creation, rename and delete are disabled.",
    );
  });

  it("never claims read-only access while an action is still allowed", () => {
    const deleteOnly = permissionNotice({ read: true, write: false, delete: true }) ?? "";
    expect(deleteOnly).not.toContain("Read-only");

    const writeOnly = permissionNotice({ read: true, write: true, delete: false }) ?? "";
    expect(writeOnly).not.toContain("Read-only");
  });
});
