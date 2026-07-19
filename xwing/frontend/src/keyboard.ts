import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Owns focus for a mounted modal and restores it when the modal closes. */
export function useModalFocus<T extends HTMLElement>(onDismiss: () => void, dismissible = true): RefObject<T | null> {
  const root = useRef<T>(null);
  const dismiss = useRef(onDismiss);
  const canDismiss = useRef(dismissible);
  dismiss.current = onDismiss;
  canDismiss.current = dismissible;

  useLayoutEffect(() => {
    const modalRoot = root.current;
    if (!modalRoot) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = (): HTMLElement[] => [...modalRoot.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(element => element.getClientRects().length > 0);
    const initial = modalRoot.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0];
    initial?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && canDismiss.current) {
        event.preventDefault();
        event.stopPropagation();
        dismiss.current();
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
      if (event.shiftKey && (document.activeElement === first || !modalRoot.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modalRoot.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    modalRoot.addEventListener("keydown", handleKeyDown, true);
    return () => {
      modalRoot.removeEventListener("keydown", handleKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return root;
}
