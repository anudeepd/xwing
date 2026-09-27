import { describe, expect, it } from "vitest";

import { renameDestination } from "../../xwing/frontend/src/rename";

describe("renameDestination", () => {
  it("keeps a file in its own directory", () => {
    expect(renameDestination("/README.md", "NOTES.md")).toBe("/NOTES.md");
    expect(renameDestination("/docs/README.md", "NOTES.md")).toBe("/docs/NOTES.md");
  });

  it("keeps a directory's trailing slash", () => {
    expect(renameDestination("/releases/", "archive")).toBe("/archive/");
    expect(renameDestination("/docs/releases/", "archive")).toBe("/docs/archive/");
  });

  it("never nests the new name inside a directory", () => {
    expect(renameDestination("/folder/", "renamed")).not.toContain("/folder/renamed");
    expect(renameDestination("/a/b/", "c")).toBe("/a/c/");
  });

  it("encodes the name for the Destination header", () => {
    expect(renameDestination("/src.txt", "sp ace'quote%pct#hash+bü.txt")).toBe(
      "/sp%20ace'quote%25pct%23hash%2Bb%C3%BC.txt",
    );
  });

  it("keeps a renamed file out of the root's own parent", () => {
    expect(renameDestination("/a.txt", "b.txt")).toBe("/b.txt");
  });
});
