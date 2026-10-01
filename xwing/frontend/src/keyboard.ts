import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { trapFocus } from "./focus-trap";

/**
 * Owns focus for a mounted modal and restores it when the modal closes: the
 * React surface of `trapFocus`, which holds the only focus-trap implementation
 * in the frontend (the admin console drives the same helper directly).
 *
 * `shouldRestoreFocus` is asked at teardown; answer false when the action that
 * closed the modal is about to put focus somewhere of its own.
 */
export function useModalFocus<T extends HTMLElement>(onDismiss: () => void, dismissible = true, shouldRestoreFocus?: () => boolean): RefObject<T | null> {
  const root = useRef<T>(null);
  const dismiss = useRef(onDismiss);
  const canDismiss = useRef(dismissible);
  const restore = useRef(shouldRestoreFocus);
  dismiss.current = onDismiss;
  canDismiss.current = dismissible;
  restore.current = shouldRestoreFocus;

  useLayoutEffect(() => {
    const modalRoot = root.current;
    if (!modalRoot) return;
    return trapFocus(modalRoot, {
      onEscape: () => { if (canDismiss.current) dismiss.current(); },
      shouldRestore: () => restore.current?.() ?? true,
    });
  }, []);

  return root;
}
