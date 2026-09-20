import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { trapFocus } from "./focus-trap";

/**
 * Owns focus for a mounted modal and restores it when the modal closes: the
 * React surface of `trapFocus`, which holds the only focus-trap implementation
 * in the frontend (the admin console drives the same helper directly).
 */
export function useModalFocus<T extends HTMLElement>(onDismiss: () => void, dismissible = true): RefObject<T | null> {
  const root = useRef<T>(null);
  const dismiss = useRef(onDismiss);
  const canDismiss = useRef(dismissible);
  dismiss.current = onDismiss;
  canDismiss.current = dismissible;

  useLayoutEffect(() => {
    const modalRoot = root.current;
    if (!modalRoot) return;
    return trapFocus(modalRoot, {
      onEscape: () => { if (canDismiss.current) dismiss.current(); },
    });
  }, []);

  return root;
}
