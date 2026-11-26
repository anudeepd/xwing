import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearResumeSession,
  loadResumeSession,
  resumeRecordKey,
  saveResumeSession,
} from "../../xwing/frontend/src/upload-resume";

function file(name = "a.bin", size = 8, lastModified = 123): File {
  return new File([new Uint8Array(size)], name, { lastModified });
}

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

let storage: MemoryStorage;

afterEach(() => {
  storage.clear();
});

describe("upload resume storage", () => {
  it("round-trips a session and clears it", () => {
    storage = new MemoryStorage();
    const subject = file();
    saveResumeSession(subject, "/docs", {
      uploadKey: "key-123",
      uploadId: "upload-123",
      ranges: [[0, 4]],
      chunkSize: 4,
      concurrency: 1,
      size: 8,
      transport: "multipart_post",
    }, storage);
    expect(loadResumeSession(subject, "/docs", storage)).toMatchObject({
      uploadKey: "key-123",
      uploadId: "upload-123",
      ranges: [[0, 4]],
      transport: "multipart_post",
    });
    clearResumeSession(subject, "/docs", storage);
    expect(loadResumeSession(subject, "/docs", storage)).toBeNull();
  });

  it("ignores an expired record and removes it", () => {
    storage = new MemoryStorage();
    const subject = file();
    storage.setItem(
      resumeRecordKey(subject, "/"),
      JSON.stringify({
        uploadKey: "old",
        uploadId: "old",
        ranges: [],
        chunkSize: 4,
        concurrency: 1,
        size: 8,
        savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      }),
    );
    expect(loadResumeSession(subject, "/", storage)).toBeNull();
    expect(storage.getItem(resumeRecordKey(subject, "/"))).toBeNull();
  });

  it("keeps different destinations separate", () => {
    storage = new MemoryStorage();
    const subject = file();
    saveResumeSession(subject, "/a", {
      uploadKey: "a",
      uploadId: "a",
      ranges: [],
      chunkSize: 4,
      concurrency: 1,
      size: 8,
    }, storage);
    saveResumeSession(subject, "/b", {
      uploadKey: "b",
      uploadId: "b",
      ranges: [],
      chunkSize: 4,
      concurrency: 1,
      size: 8,
    }, storage);
    expect(loadResumeSession(subject, "/a", storage)?.uploadKey).toBe("a");
    expect(loadResumeSession(subject, "/b", storage)?.uploadKey).toBe("b");
  });

  it("covers a zero modification time and default storage", () => {
    storage = new MemoryStorage();
    const subject = file("zero.bin", 0, 0);
    expect(resumeRecordKey(subject, "/")).toBe(
      "xwing.upload.v2.%2F|zero.bin|0|0",
    );

    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    try {
      saveResumeSession(subject, "/", {
        uploadKey: "default-store",
        uploadId: "default-store",
        ranges: [],
        chunkSize: 0,
        concurrency: 0,
        size: 0,
      });
      expect(loadResumeSession(subject, "/")).toMatchObject({
        uploadKey: "default-store",
        chunkSize: 0,
        concurrency: 1,
      });
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
      else delete (window as unknown as { localStorage?: Storage }).localStorage;
    }
  });

  it("does not break when storage is unavailable", () => {
    storage = new MemoryStorage();
    const subject = file();
    expect(() =>
      saveResumeSession(
        subject,
        "/",
        {
          uploadKey: "a",
          uploadId: "a",
          ranges: [],
          chunkSize: 4,
          concurrency: 1,
          size: 8,
        },
        null,
      ),
    ).not.toThrow();
    expect(loadResumeSession(subject, "/", null)).toBeNull();
  });

  it("ignores malformed and unavailable browser storage", () => {
    storage = new MemoryStorage();
    const subject = file();
    storage.setItem(resumeRecordKey(subject, "/"), "{bad");
    expect(loadResumeSession(subject, "/", storage)).toBeNull();

    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(loadResumeSession(subject, "/")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
      else delete (window as unknown as { localStorage?: Storage }).localStorage;
    }
  });

  it("prunes expired and corrupt records before saving", () => {
    storage = new MemoryStorage();
    const subject = file();
    storage.setItem(
      "xwing.upload.v2.expired",
      JSON.stringify({ savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
    );
    storage.setItem("xwing.upload.v2.corrupt", "{bad");
    saveResumeSession(subject, "/", {
      uploadKey: "new",
      uploadId: "new",
      ranges: [],
      chunkSize: 4,
      concurrency: 1,
      size: 8,
    }, storage);
    expect(storage.getItem("xwing.upload.v2.expired")).toBeNull();
    expect(storage.getItem("xwing.upload.v2.corrupt")).toBeNull();
    expect(loadResumeSession(subject, "/", storage)?.uploadKey).toBe("new");
  });

  it("prunes null keys, missing values and zero timestamps", () => {
    storage = new MemoryStorage();
    const keys = [null, "xwing.upload.v2.missing", "xwing.upload.v2.zero"];
    Object.defineProperty(storage, "length", { get: () => keys.length });
    vi.spyOn(storage, "key").mockImplementation(index => keys[index] ?? null);
    vi.spyOn(storage, "getItem").mockImplementation(key =>
      key === "xwing.upload.v2.zero" ? JSON.stringify({ savedAt: 0 }) : null,
    );
    const removeItem = vi.spyOn(storage, "removeItem");

    saveResumeSession(file(), "/", {
      uploadKey: "new",
      uploadId: "new",
      ranges: [],
      chunkSize: 4,
      concurrency: 1,
      size: 8,
    }, storage);

    expect(removeItem).toHaveBeenCalledWith("xwing.upload.v2.missing");
    expect(removeItem).toHaveBeenCalledWith("xwing.upload.v2.zero");
  });
});
