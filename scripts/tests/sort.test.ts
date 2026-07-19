import { describe, expect, it } from "vitest";
import { nextSort, normalizeSortPreference, sortFiles } from "../../xwing/frontend/src/sort";
import type { XwingFile } from "../../xwing/frontend/src/types";

const file = (name: string, modified: string, size = 1): XwingFile => ({
  name, path: `/${name}`, kind: "file", size, modified, editable: false,
});

describe("file sorting", () => {
  it("defaults to newest modified first", () => {
    const entries = normalizeSortPreference(null);
    expect(entries).toEqual([{ key: "modified", direction: "desc" }]);
    expect(sortFiles([file("old", "2025-01-01"), file("new", "2026-01-01")], entries).map(item => item.name)).toEqual(["new", "old"]);
  });

  it("normalizes the original mtime/dir preference shape when explicitly imported", () => {
    expect(normalizeSortPreference([{ key: "mtime", dir: "desc" }, { key: "name", dir: "asc" }])).toEqual([
      { key: "modified", direction: "desc" },
      { key: "name", direction: "asc" },
    ]);
  });

  it("adds, reverses, and removes sort columns without Shift", () => {
    const initial = [{ key: "modified", direction: "desc" }] as const;
    const added = nextSort([...initial], "name");
    expect(added).toEqual([...initial, { key: "name", direction: "asc" }]);
    const reversed = nextSort(added, "name");
    expect(reversed.at(-1)).toEqual({ key: "name", direction: "desc" });
    expect(nextSort(reversed, "name")).toEqual([...initial]);
  });
});
