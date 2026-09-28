import React from "react";
import * as m from "motion/react-m";
import { AUTH_OVERLAY_COPY, redirectToLoginNow } from "./shared.js";
import { prefersReducedMotion } from "./format";

/**
 * The session overlay: one set of words for expiry and sign-out, shared by the
 * file browser and the editor. The admin console renders the same markup from
 * its template (that page has to show the overlay before the bundle loads), so
 * the classes here and the ones in `templates/admin.html` have to stay in step.
 */
const OVERLAY = "auth-overlay fixed inset-0 z-modal flex items-center justify-center p-4 bg-[rgba(2,6,23,.7)] [&[hidden]]:hidden";
const CARD = "auth-overlay-card flex flex-col items-stretch gap-4 w-[min(100%,384px)] p-5 border border-solid border-xw-line-hi rounded-lg bg-[rgba(15,23,42,.96)] shadow-[0_24px_70px_rgba(0,0,0,.45)]";
const ROW = "auth-overlay-row flex items-center gap-3";
const PULSE = "auth-pulse w-9 h-9 flex-none rounded-full border border-solid border-[rgba(124,58,237,.48)] bg-[rgba(124,58,237,.14)] p-2 [&>span]:block [&>span]:w-full [&>span]:h-full [&>span]:rounded-full [&>span]:bg-xw-accent [&>span]:animate-[auth-pulse_1.2s_ease-in-out_infinite]";
const TITLE = "mb-1 font-sans text-sm font-semibold text-[#f8fafc]";
const MESSAGE = "text-xw-muted text-xs leading-tight";
const ACTION = "button inline-flex items-center justify-center gap-2 w-full h-11 min-h-11 px-3 border border-solid border-xw-accent-border rounded-md bg-xw-accent-fill text-white text-xs font-medium no-underline whitespace-nowrap cursor-pointer [&:hover:not(:disabled)]:bg-xw-accent-fill-hover";

export function AuthOverlay({ kind }: { kind: keyof typeof AUTH_OVERLAY_COPY }): React.JSX.Element {
  const copy = AUTH_OVERLAY_COPY[kind];
  const reduced = prefersReducedMotion();
  return <m.div className={OVERLAY} role="status" aria-live="polite"
    initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }}>
    <div className={CARD}>
      <div className={ROW}>
        <span className={PULSE}><span/></span>
        <div><h2 className={TITLE}>{copy.title}</h2><p className={MESSAGE}>{copy.message}</p></div>
      </div>
      {copy.action && <button className={ACTION} type="button" onClick={() => redirectToLoginNow()}>{copy.action}</button>}
    </div>
  </m.div>;
}
