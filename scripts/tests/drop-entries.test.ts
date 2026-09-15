import { describe, expect, it } from "vitest";
import { collectDroppedEntries } from "../../xwing/frontend/src/drop-entries";

/** The shape the traversal actually reads; the browser types are richer. */
interface FakeEntry {
  isFile?: boolean;
  isDirectory?: boolean;
  name: string;
  file?: (resolve: (file: File) => void) => void;
  createReader?: () => {
    readEntries: (
      resolve: (entries: FakeEntry[]) => void,
      reject?: (error: unknown) => void,
    ) => void;
  };
}

/** FileSystemFileEntry stand-in. */
function fileEntry(name: string, body = "x"): FakeEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve: (file: File) => void) => resolve(new File([body], name)),
  };
}

/**
 * FileSystemDirectoryEntry stand-in. `batches` mirrors real browsers, which
 * return directory contents a batch at a time and signal completion with an
 * empty batch.
 */
function dirEntry(
  name: string,
  batches: FakeEntry[][],
  { fails = false }: { fails?: boolean } = {},
): FakeEntry {
  let call = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (
        resolve: (entries: FakeEntry[]) => void,
        reject?: (error: unknown) => void,
      ) => {
        if (fails) {
          reject?.(new Error("unreadable"));
          return;
        }
        const batch = batches[call++] ?? [];
        resolve(batch);
      },
    }),
  };
}

/** DataTransfer stand-in built from entries, files, or both. */
function dataTransferFrom({
  entries = null,
  files = null,
}: { entries?: (FakeEntry | null)[] | null; files?: File[] | null } = {}): DataTransfer {
  const items: unknown[] = (entries ?? []).map(entry => ({
    kind: "file",
    webkitGetAsEntry: () => entry,
    getAsFile: () => null,
  }));
  if (files && !entries) {
    for (const file of files) {
      items.push({ kind: "file", getAsFile: () => file, webkitGetAsEntry: undefined });
    }
  }
  return { items, files: files ?? [] } as unknown as DataTransfer;
}

describe("collectDroppedEntries", () => {
  it("flattens a nested folder into uploadable paths", async () => {
    const tree = dirEntry("trip", [
      [
        fileEntry("notes.txt"),
        dirEntry("photos", [[fileEntry("one.jpg"), fileEntry("two.jpg")]]),
      ],
    ]);

    const { entries, skipped } = await collectDroppedEntries(
      dataTransferFrom({ entries: [tree] }),
    );

    expect(skipped).toBe(0);
    expect(entries.map(entry => entry.relativePath)).toEqual([
      "trip/notes.txt",
      "trip/photos/one.jpg",
      "trip/photos/two.jpg",
    ]);
    expect(entries.every(entry => entry.file instanceof File)).toBe(true);
  });

  it("reads every batch of a large folder", async () => {
    // Chromium caps each readEntries call, so the walk must keep asking.
    const tree = dirEntry("many", [
      [fileEntry("a.txt"), fileEntry("b.txt")],
      [fileEntry("c.txt")],
      [],
    ]);

    const { entries } = await collectDroppedEntries(dataTransferFrom({ entries: [tree] }));
    expect(entries.map(entry => entry.relativePath)).toEqual([
      "many/a.txt",
      "many/b.txt",
      "many/c.txt",
    ]);
  });

  it("keeps loose files at the top level", async () => {
    const { entries } = await collectDroppedEntries(
      dataTransferFrom({ entries: [fileEntry("one.txt"), fileEntry("two.txt")] }),
    );
    expect(entries.map(entry => entry.relativePath)).toEqual(["one.txt", "two.txt"]);
  });

  it("reports an unreadable folder instead of uploading a stand-in", async () => {
    const { entries, skipped } = await collectDroppedEntries(
      dataTransferFrom({ entries: [dirEntry("locked", [], { fails: true })] }),
    );
    expect(entries).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("skips null slots left by content-script extensions", async () => {
    const transfer = dataTransferFrom({ entries: [fileEntry("real.txt")] });
    (transfer as unknown as { items: unknown[] }).items.unshift(null, { kind: "string" });

    const { entries } = await collectDroppedEntries(transfer);
    expect(entries.map(entry => entry.relativePath)).toEqual(["real.txt"]);
  });

  it("falls back to dataTransfer.files when the File System API is absent", async () => {
    const { entries } = await collectDroppedEntries(
      dataTransferFrom({ files: [new File(["a"], "a.txt"), new File(["b"], "b.txt")] }),
    );
    expect(entries.map(entry => entry.relativePath)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns nothing for an empty drop", async () => {
    expect(await collectDroppedEntries(null)).toEqual({ entries: [], skipped: 0 });
    expect(await collectDroppedEntries(dataTransferFrom())).toEqual({
      entries: [],
      skipped: 0,
    });
  });

  it("counts an item whose file an extension stripped", async () => {
    const { entries, skipped } = await collectDroppedEntries(
      dataTransferFrom({ entries: [null, fileEntry("real.txt")] }),
    );
    expect(entries.map(entry => entry.relativePath)).toEqual(["real.txt"]);
    expect(skipped).toBe(1);
  });

  it("reads the drop before the first await, while items is still live", async () => {
    const entry = fileEntry("live.txt");
    let neutered = false;
    const transfer = {
      items: [
        {
          kind: "file",
          get webkitGetAsEntry() {
            return () => {
              if (neutered) throw new Error("items already emptied");
              return entry;
            };
          },
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    const pending = collectDroppedEntries(transfer);
    neutered = true; // the browser clears items as soon as the event returns

    await expect(pending).resolves.toMatchObject({
      entries: [{ relativePath: "live.txt" }],
    });
  });
});
