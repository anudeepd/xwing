import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TOOLTIP } from "./ui";

const ANCHOR = "inline-flex";

interface Props {
  /** The words of the hint. Every caller passes the control's own `aria-label`,
   *  so the control keeps its accessible name and the hint stays visual. */
  label: string;
  children: React.ReactNode;
  side?: "top" | "bottom";
}

/**
 * A hint for a control that shows no text of its own — a row's action trigger, a
 * toolbar button that is only an icon, the editor's back arrow.
 *
 * The hint is portalled to the body and fixed: inside the file listing an
 * absolutely positioned one would be cut off by the table's own scroll container.
 * That also means it has to be re-measured as the page scrolls, because a fixed
 * box does not travel with its anchor.
 *
 * The wrapper carries the hover and focus handling rather than the child, so the
 * child keeps its own handlers and no call site has to merge props. Entering any
 * descendant is what opens the hint, and `focusin`/`focusout` (React's `onFocus`
 * and `onBlur`) means a keyboard user gets it too.
 *
 * The hint itself is `aria-hidden`: its words are the control's accessible name,
 * so announcing it as well would say the same thing twice. It is a sighted-user
 * affordance, and its lifetime is WCAG 1.4.13's — Escape dismisses it without
 * moving the pointer or the focus, and it never takes either.
 */
export function Tooltip({ label, children, side = "top" }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const tip = tipRef.current;
      if (!anchor || !tip) return;
      // `offsetWidth`/`offsetHeight` are the layout box. `getBoundingClientRect`
      // would report the box mid-entrance, scaled by the animation's transform.
      const width = tip.offsetWidth;
      const height = tip.offsetHeight;
      // The tip is centred on the control, but a control against an edge would
      // push it off screen, so it is clamped to the viewport.
      const left = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, 8), Math.max(8, window.innerWidth - width - 8));
      const top = side === "top" ? anchor.top - height - 6 : anchor.bottom + 6;
      // Whole device pixels: a fractional offset resamples the glyphs and the
      // hint reads soft next to the crisp text around it.
      const scale = window.devicePixelRatio || 1;
      const snap = (value: number): number => Math.round(value * scale) / scale;
      setPosition(previous => {
        const next = { left: snap(left), top: snap(top) };
        return previous.left === next.left && previous.top === next.top ? previous : next;
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, side]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  return (
    <span ref={anchorRef} className={ANCHOR} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {open && createPortal(
        <span ref={tipRef} className={TOOLTIP} role="tooltip" aria-hidden="true" style={{ left: position.left, top: position.top }}>{label}</span>,
        document.body,
      )}
    </span>
  );
}
