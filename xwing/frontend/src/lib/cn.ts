import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge does not know the project's own scales
 * (`tailwind.config.mjs` → `zIndex` and `borderRadius`), so without this it
 * treats `z-raise` and `z-modal` as unrelated classes: both stay in the class
 * list, the stylesheet order decides the winner, and a caller's layer token
 * cannot override the default it collides with. The radius scale is extended
 * for the same reason (`rounded-admin`).
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      z: [{ z: ["base", "raise", "sticky", "popover", "drag", "rail", "modal"] }],
      rounded: [{ rounded: ["admin"] }],
    },
  },
});

/**
 * Join class names, letting a later class win over an earlier one that sets the
 * same property. `clsx` alone only concatenates, so `cn("w-full", "w-80")`
 * would leave both classes in place and let the stylesheet order decide — it
 * would not return `w-80`, and a component's base classes could beat the
 * `className` its consumer passed in. Conditional class lists in the editor go
 * through here so "the last class wins" holds at the call site.
 */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
