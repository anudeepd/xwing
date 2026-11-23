const PANEL =
  "boot-error h-full flex flex-col items-center justify-center gap-2 bg-xw-bg text-xw-muted font-sans " +
  "[&_strong]:text-xw-text [&_button]:mt-2 [&_button]:px-3 [&_button]:py-2 [&_button]:border [&_button]:border-solid " +
  "[&_button]:border-xw-line-hi [&_button]:rounded-md [&_button]:bg-xw-raised [&_button]:text-xw-text";

/** Render the shell that replaces the app when startup data cannot be parsed.
 *  The reload action uses a listener because `script-src 'self'` blocks inline
 *  handlers. */
export function renderStartupError(root: HTMLElement, message: string, reload: () => void): void {
  const panel = document.createElement("div");
  panel.className = PANEL;

  const heading = document.createElement("strong");
  heading.textContent = "X-wing couldn’t start";

  const detail = document.createElement("span");
  detail.textContent = message;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Reload";
  button.addEventListener("click", reload);

  panel.append(heading, detail, button);
  root.replaceChildren(panel);
}
