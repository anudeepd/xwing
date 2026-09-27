import type { XwingBootstrapV1 } from "./types";

type Permissions = XwingBootstrapV1["permissions"];

/**
 * One sentence naming every action the current permissions disable, or `null`
 * when nothing is denied.
 *
 * The file browser renders this as the permission notice and every control that
 * policy disables points at that notice with `aria-describedby`, so a dimmed
 * control is never the only signal. The copy is derived from the capability set
 * rather than from `write` alone: `write` and `delete` are independent, and a
 * user holding only one of them must not be told they have read-only access.
 *
 * Returns `null` only when both `write` and `delete` are granted, which is also
 * the only case where no control is disabled by policy — so a caller that links
 * a policy-disabled control to the notice can rely on the notice existing.
 */
export function permissionNotice(permissions: Permissions): string | null {
  if (permissions.write && permissions.delete) return null;
  if (!permissions.write && !permissions.delete) {
    return "Read-only access. Uploads, folder creation, rename and delete are disabled.";
  }
  // Rename is a move, so it needs both capabilities; delete needs only delete.
  if (!permissions.delete) return "Renaming and deleting are disabled for your account.";
  return "Uploads, folder creation and renaming are disabled for your account.";
}
