import { describe, expect, it } from "vitest";

import { Logo } from "../../xwing/frontend/src/logo";

describe("Logo", () => {
  it("renders the shared brand mark", () => {
    const element = Logo();

    expect(element.type).toBe("svg");
    expect(element.props.className).toBe("brand-mark");
    expect(element.props["aria-label"]).toBe("X-wing logo");
  });
});
