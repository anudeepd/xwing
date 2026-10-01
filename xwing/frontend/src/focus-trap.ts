/** Focusable descendants, mirroring the selector used by the React modal helper in keyboard.ts. */
const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Owns focus for a modal subtree: focuses the first `[data-autofocus]`
 * descendant (or the first focusable one), keeps Tab/Shift+Tab inside `root`,
 * reports Escape through `onEscape`, and restores the previously focused
 * element on teardown. Returns the teardown function; call it once, when the
 * subtree leaves the document.
 *
 * `shouldRestore` is asked at teardown; answer false when whatever closed the
 * modal is about to put focus somewhere of its own.
 */
export function trapFocus(root: HTMLElement, options: { onEscape?: () => void; shouldRestore?: () => boolean } = {}): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusable = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter(element => element.getClientRects().length > 0);
  const initial = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0];
  initial?.focus();

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      options.onEscape?.();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = focusable();
    if (!controls.length) {
      event.preventDefault();
      return;
    }
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };

  root.addEventListener("keydown", handleKeyDown, true);
  return () => {
    root.removeEventListener("keydown", handleKeyDown, true);
    // Hand focus back to what opened the modal, unless the app has already put it
    // somewhere on purpose (the row a new folder or a rename lands on, the
    // survivor after a delete) or says it is about to (`shouldRestore`). Restoring
    // blindly bounced focus onto the opener for a moment and back, which flashed
    // its focus ring and left a window in which a stray Enter reopened the dialog.
    const active = document.activeElement;
    const focusStillHere = !active || active === document.body || root.contains(active);
    if (focusStillHere && options.shouldRestore?.() !== false && previous?.isConnected) previous.focus();
  };
}
