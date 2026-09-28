/**
 * The class strings more than one surface needs, in one place.
 *
 * Three copies of the control set had already drifted apart before this file
 * existed (the file browser's carried its mobile overrides, the console's did
 * not), which is exactly the drift a shared source prevents. Everything here is
 * a literal string, so Tailwind's scanner still sees it.
 *
 * The Jinja templates cannot import: the boot card, the console's skip link and
 * its auth overlay repeat values from here as literals, and the admin spec's
 * paint assertion is what notices if they stop matching.
 */

/** Base control: a button, a link that looks like one, or an icon button. */
export const CONTROL =
  "h-11 min-h-11 min-w-11 inline-flex items-center justify-center gap-2 px-3 border border-solid border-xw-line-hi rounded-md " +
  "bg-xw-raised text-xw-text text-xs font-medium leading-normal no-underline whitespace-nowrap appearance-none cursor-pointer " +
  "transition-[transform,border-color,background-color] duration-micro ease-xw " +
  "[&:hover:not(:disabled)]:-translate-y-px [&:hover:not(:disabled)]:border-[#4b5873] [&:hover:not(:disabled)]:bg-[#172034] " +
  "[&:active:not(:disabled)]:scale-[.96] disabled:opacity-[.42] disabled:cursor-not-allowed";

/** The file browser's toolbar collapses to squares on a phone; the console's
 *  record tables keep their labels, so this is opt-in per surface. */
export const CONTROL_COMPACT = "max-[640px]:w-11 max-[640px]:p-0 max-[640px]:[&>.label]:hidden";

export const CONTROL_PRIMARY =
  "border-xw-accent-border bg-xw-accent-fill text-white [&:hover:not(:disabled)]:bg-xw-accent-fill-hover " +
  "[&:hover:not(:disabled)]:border-xw-accent [&:hover:not(:disabled)]:text-white";

/** Primary buttons keep their label when the rest of the toolbar collapses. */
export const CONTROL_PRIMARY_COMPACT = "max-[640px]:w-auto max-[640px]:px-3 max-[640px]:[&>.label]:inline";

export const CONTROL_DANGER =
  "text-[#ff9ba3] border-[#67323b] bg-[#24161d] [&:hover:not(:disabled)]:border-[#a65260] [&:hover:not(:disabled)]:bg-[#421e28]";

export const CONTROL_GHOST = "border-transparent bg-transparent text-xw-muted";

export const CONTROL_SMALL = "text-[11px]";

/** The notification rail and one toast. */
export const RAIL =
  "notify-rail fixed right-8 bottom-8 flex flex-col items-end gap-2 z-rail pb-[env(safe-area-inset-bottom)] " +
  "max-h-[calc(100vh-96px)] pointer-events-none [&>*]:pointer-events-auto max-[640px]:right-3 max-[640px]:bottom-4";

export const TOAST =
  "toast relative min-h-[46px] grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden " +
  "border border-solid border-[#3a465c] rounded-lg bg-[#141b2a] px-3 pb-1 shadow-[0_16px_42px_rgba(0,0,0,.48)] text-[11px]";

export const TOAST_SUCCESS = "border-[#326d55] bg-[#10251e] text-[#b8f2d5]";
export const TOAST_ERROR = "border-[#743943] bg-[#29171d] text-[#ffc1c7]";

export const TOAST_ICON = "toast-icon w-6 h-6 grid place-items-center rounded-full bg-[rgba(255,255,255,.06)]";
export const TOAST_MESSAGE = "toast-message flex-1 min-w-0 [overflow-wrap:anywhere] font-semibold";
export const TOAST_TIMER = "toast-timer absolute inset-x-0 bottom-0 h-1 bg-current origin-left animate-[xw-toast-timer_linear_forwards]";

/** Header chrome, shared by all three surfaces. */
export const BRAND = "brand flex items-center gap-2 min-h-11 text-inherit no-underline rounded-md";
export const BRAND_NAME = "font-sans text-[13px] font-semibold leading-none text-[#f1f3f7]";
export const BRAND_CONTEXT =
  "brand-context h-[13px] inline-flex items-center -translate-y-px text-xw-faint text-[11px] font-medium leading-none";
export const ACCOUNT_INLINE = "account-inline flex items-center gap-2 text-[#aeb6c5] text-xs";
export const ACCOUNT_TRIGGER =
  "account-trigger h-11 min-h-11 flex items-center gap-2 px-2 border border-solid border-transparent rounded-md bg-transparent " +
  "text-[#aeb6c5] text-xs hover:border-xw-line-hi hover:bg-xw-raised hover:text-xw-text " +
  "aria-expanded:border-xw-line-hi aria-expanded:bg-xw-raised aria-expanded:text-xw-text";
export const SIGNOUT =
  "signout-button h-11 min-h-11 px-2 border border-solid border-xw-line-hi rounded-md bg-transparent text-[#aeb6c5] " +
  "text-[11px] font-medium hover:border-[#67323b] hover:bg-[#24161d] hover:text-[#ff9ba3]";
export const POPOVER =
  "popover absolute right-0 top-[38px] z-popover p-1 border border-solid border-[#3b465c] rounded-[7px] bg-[#111827] " +
  "shadow-[0_18px_45px_rgba(0,0,0,.46)] origin-top-right animate-[xw-surface-in_var(--xw-surface)_var(--xw-ease)]";
export const MENU_ITEM =
  "menu-item w-full h-11 min-h-11 flex items-center px-2 border-0 rounded-[5px] bg-transparent text-[#b9c1ce] " +
  "no-underline cursor-pointer text-xs hover:bg-xw-hover hover:text-xw-text";
