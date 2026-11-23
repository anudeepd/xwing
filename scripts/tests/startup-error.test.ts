import { describe, expect, it, vi } from "vitest";
import { renderStartupError } from "../../xwing/frontend/src/startup-error";

describe("startup error fallback", () => {
  it("renders the message as text and reloads from a listener", () => {
    const root = document.createElement("div");
    const reload = vi.fn();

    renderStartupError(root, "<strong>broken</strong>", reload);

    const panel = root.querySelector(".boot-error");
    const button = root.querySelector<HTMLButtonElement>("button");
    expect(panel?.querySelector("strong")?.textContent).toBe("X-wing couldn’t start");
    expect(panel?.querySelector("span")?.textContent).toBe("<strong>broken</strong>");
    expect(button?.type).toBe("button");
    expect(button?.getAttribute("onclick")).toBeNull();
    button?.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
