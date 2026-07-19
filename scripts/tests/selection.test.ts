import { describe, expect, it } from "vitest";

import { nearestSurvivor, selectionRange } from "../../xwing/frontend/src/selection";

describe("file selection transitions", () => {
  it("keeps the Shift anchor attached to its file after sorting", () => {
    const sorted = [{ path: "/release.txt" }, { path: "/README.md" }, { path: "/checksums.txt" }];

    expect(selectionRange(sorted, "/release.txt", 1)).toEqual(["/release.txt", "/README.md"]);
  });

  it("falls back to the target when the anchor disappeared", () => {
    const files = [{ path: "/a.txt" }, { path: "/b.txt" }];

    expect(selectionRange(files, "/deleted.txt", 1)).toEqual(["/b.txt"]);
  });

  it("chooses the nearest surviving row after deletion", () => {
    const files = [{ path: "/a.txt" }, { path: "/b.txt" }, { path: "/c.txt" }, { path: "/d.txt" }];

    expect(nearestSurvivor(files, ["/b.txt", "/c.txt"])).toBe("/d.txt");
    expect(nearestSurvivor(files, ["/d.txt"])).toBe("/c.txt");
    expect(nearestSurvivor(files, files.map(file => file.path))).toBeNull();
  });
});
