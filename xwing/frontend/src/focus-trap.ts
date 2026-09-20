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
 */
export function trapFocus(root: HTMLElement, options: { onEscape?: () => void } = {}): () => void {
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
    if (previous?.isConnected) previous.focus();
  };
}
