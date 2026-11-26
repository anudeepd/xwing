import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadManager } from "../../xwing/frontend/src/upload-manager";
import { saveResumeSession } from "../../xwing/frontend/src/upload-resume";
import { AUTH_ACTIVITY_EVENT, resetAuthActivityForTests } from "../../xwing/frontend/src/shared.js";

/**
 * The manager owns queueing, item state and the concurrency budget. Transfer
 * mechanics live in the upload engine, which is mocked here so these tests
 * exercise the scheduler without pretending to be a network.
 */
interface EngineCallbacks {
  onState: (state: string) => void;
  onProgress: (committed: number, total: number) => void;
  onSession: (session: unknown) => void;
  onRetry: (info: { attempt: number; code: string; message: string }) => void;
}

interface EngineCallOptions {
  destDir: string;
  uploadKey: string;
  fingerprint: { name: string; size: number; last_modified: number };
  chunkSize: number;
  concurrency: number;
  session?: unknown;
  callbacks: EngineCallbacks;
}

interface PendingCall {
  options: EngineCallOptions;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const engine = vi.hoisted(() => {
  return {
    calls: [] as PendingCall[],
    clientOptions: [] as Array<Record<string, unknown>>,
    uploadFile: vi.fn(),
  };
});

vi.mock("../../xwing/frontend/src/upload-engine", () => ({
  UploadClient: class {
    constructor(options: Record<string, unknown>) {
      engine.clientOptions.push(options);
    }
  },
  UploadState: {
    PREPARING: "preparing",
    UPLOADING: "uploading",
    PROCESSING: "processing",
    FINALIZING: "finalizing",
    DONE: "done",
    ERROR: "error",
  },
  SpeedTracker: class {
    sample(): void {}
    speed(): number {
      return 0;
    }
  },
  newUploadKey: vi.fn(() => "generated-upload-key"),
  uploadFile: (options: EngineCallOptions) => engine.uploadFile(options),
}));

function deferred() {
  return Promise.withResolvers<unknown>();
}

/** Engine call `index`, once the manager has reached it. */
async function pendingCall(index: number) {
  await vi.waitFor(() => expect(engine.calls).toHaveLength(index + 1));
  return engine.calls[index]!;
}

function okResponse(body: unknown = {}) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function managerWith(fetcher = vi.fn(async () => okResponse())) {
  const manager = new UploadManager(
    fetcher as unknown as typeof fetch,
    callback => {
      queueMicrotask(() => callback(0));
      return 1;
    },
    vi.fn(),
  );
  return { manager, fetcher };
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

beforeEach(() => {
  engine.calls = [];
  engine.clientOptions = [];
  engine.uploadFile.mockReset();
  engine.uploadFile.mockImplementation((options: EngineCallOptions) => {
    const call = deferred();
    engine.calls.push({ options, resolve: call.resolve, reject: call.reject });
    return call.promise;
  });
  resetAuthActivityForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UploadManager scheduling", () => {
  it("notifies subscribers until they unsubscribe", () => {
    const { manager } = managerWith();
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    manager.add([new File(["a"], "a.txt")], "/", 1024);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    manager.add([new File(["b"], "b.txt")], "/", 1024);
    expect(listener).not.toHaveBeenCalled();
  });

  it("moves an item from queued to completed", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "hello.txt")], "/docs", 1024);

    expect(manager.getSnapshot().items[0]).toMatchObject({
      name: "hello.txt",
      status: "queued",
      size: 5,
    });
    const call = await pendingCall(0);
    expect(call.options).toMatchObject({
      destDir: "/docs",
      chunkSize: 1024,
      uploadKey: "generated-upload-key",
      fingerprint: { name: "hello.txt", size: 5, last_modified: expect.any(Number) },
    });

    call.options.callbacks.onState("uploading");
    call.options.callbacks.onProgress(3, 5);
    await vi.waitFor(() =>
      expect(manager.getSnapshot().items[0]).toMatchObject({ status: "uploading", uploaded: 3 }),
    );

    call.resolve({ ok: true, path: "hello.txt" });
    await vi.waitFor(() =>
      expect(manager.getSnapshot().items[0]).toMatchObject({
        status: "completed",
        uploaded: 5,
      }),
    );
    expect(manager.hasActive()).toBe(false);
  });

  it("reports upload progress as auth activity", async () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const { manager } = managerWith();
    manager.add([new File(["hello"], "hello.txt")], "/docs", 1024);
    const call = await pendingCall(0);

    resetAuthActivityForTests();
    call.options.callbacks.onProgress(3, 5);

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: AUTH_ACTIVITY_EVENT }),
    );
  });

  it("reports a DLP wait as a processing phase rather than a stall", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "a.txt")], "/", 1024);
    const call = await pendingCall(0);

    call.options.callbacks.onState("processing");
    await vi.waitFor(() =>
      expect(manager.getSnapshot().items[0]).toMatchObject({
        status: "uploading",
        phase: "processing",
      }),
    );
  });

  it("creates folder ancestors before uploading", async () => {
    const { manager, fetcher } = managerWith();
    const file = new File(["hi"], "note.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "trip/photos/note.txt" });

    manager.add([file], "/root", 1024);
    await pendingCall(0);

    const created = fetcher.mock.calls.map(call => String(call[0]));
    expect(created).toContain("/root/trip/");
    expect(created).toContain("/root/trip/photos/");
    expect(engine.calls[0]!.options.destDir).toBe("/root/trip/photos");
  });

  it("retries folder creation after transient network failures", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("drop one"))
      .mockRejectedValueOnce(new Error("drop two"))
      .mockResolvedValue(okResponse());
    const { manager } = managerWith(fetcher);
    const file = new File(["hi"], "note.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "trip/note.txt" });
    manager.add([file], "/", 1024);
    await pendingCall(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("turns repeated non-Error folder failures into a plain message", async () => {
    const fetcher = vi.fn(async () => {
      throw "offline";
    });
    const { manager } = managerWith(fetcher);
    const file = new File(["hi"], "note.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "trip/note.txt" });
    manager.add([file], "/", 1024);
    await vi.waitFor(() =>
      expect(manager.getSnapshot().items[0]).toMatchObject({
        status: "failed",
        error: "Could not reach the server",
      }),
    );
  });

  it("preserves repeated Error folder failures", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    const { manager } = managerWith(fetcher);
    const file = new File(["hi"], "note.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "trip/note.txt" });
    manager.add([file], "/", 1024);
    await vi.waitFor(() =>
      expect(manager.getSnapshot().items[0]).toMatchObject({
        status: "failed",
        error: "offline",
      }),
    );
  });

  it("splits the parallel budget across the files running at once", async () => {
    const { manager } = managerWith();
    manager.setParallel(4);
    manager.add(
      [new File(["a"], "a.txt"), new File(["b"], "b.txt"), new File(["c"], "c.txt"), new File(["d"], "d.txt")],
      "/",
      1024,
    );

    await vi.waitFor(() => expect(engine.calls).toHaveLength(4));
    expect(engine.calls.map(call => call.options.concurrency)).toEqual([1, 1, 1, 1]);
  });

  it("gives a lone file the whole parallel budget", async () => {
    const { manager } = managerWith();
    manager.setParallel(4);
    manager.add([new File(["a"], "a.txt")], "/", 1024);

    const call = await pendingCall(0);
    expect(call.options.concurrency).toBe(4);
  });

  it("ignores a duplicate file that is already queued or running", async () => {
    const { manager } = managerWith();
    const subject = new File(["same"], "same.txt");
    manager.add([subject], "/", 1024);
    manager.add([subject], "/", 1024);
    expect(manager.getSnapshot().items).toHaveLength(1);
  });

  it("accepts a file-like object from another browser realm", async () => {
    const { manager } = managerWith();
    const foreign = {
      name: "foreign.txt",
      size: 7,
      lastModified: 123,
      slice: () => new Blob(["foreign"]),
    } as unknown as File;

    manager.add([foreign], "/", 1024);

    expect(manager.getSnapshot().items[0]).toMatchObject({
      name: "foreign.txt",
      size: 7,
      status: "queued",
    });
  });

  it("covers zero modification time and diagnostic fallbacks", async () => {
    const { manager, fetcher } = managerWith();
    const file = new File(["x"], "x.txt", { lastModified: 0 });
    manager.add([file], "/", 1024);
    const call = await pendingCall(0);
    expect(call.options.fingerprint.last_modified).toBe(0);

    call.options.callbacks.onDiagnostic({ event: "test", protocol: "h2" });
    call.resolve({ ok: true });
    await vi.waitFor(() =>
      expect(manager.getSnapshot().items[0]).toMatchObject({
        status: "completed",
        protocol: "h2",
      }),
    );
    const diagnostic = fetcher.mock.calls.find(call => String(call[0]) === "/_upload/diagnostics");
    expect(JSON.parse(String(diagnostic?.[1]?.body))).toMatchObject({
      upload_id: null,
      protocol: "h2",
    });
  });

  it("records the session so a retry resumes instead of restarting", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "a.txt")], "/", 1024);
    const call = await pendingCall(0);

    call.options.callbacks.onSession({
      uploadId: "abc123",
      chunkSize: 1024,
      concurrency: 1,
      ranges: [[0, 4096]],
      size: 8192,
    });
    call.reject(new Error("Upload stalled"));
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]?.status).toBe("failed"));
    expect(manager.getSnapshot().items[0]?.error).toBe("Upload stalled");

    const id = manager.getSnapshot().items[0]!.id;
    manager.retry(id);

    const retried = await pendingCall(1);
    expect(retried.options.session).toMatchObject({ uploadId: "abc123", ranges: [[0, 4096]] });
    retried.resolve({ ok: true });
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]?.status).toBe("completed"));
  });

  it("resumes a dropped file in a new page from stored session state", async () => {
    const storage = new MemoryStorage();
    const file = new File(["hello"], "hello.txt", { lastModified: 123 });
    saveResumeSession(
      file,
      "/",
      {
        uploadKey: "stored-key",
        uploadId: "stored-upload",
        ranges: [[0, 2]],
        chunkSize: 1024,
        concurrency: 1,
        size: 5,
        transport: "multipart_post",
      },
      storage,
    );
    const manager = new UploadManager(
      vi.fn(async () => okResponse()) as unknown as typeof fetch,
      callback => {
        queueMicrotask(() => callback(0));
        return 1;
      },
      vi.fn(),
      storage,
    );

    manager.add([file], "/", 1024);
    const call = await pendingCall(0);
    expect(call.options.uploadKey).toBe("stored-key");
    expect(call.options.session).toMatchObject({
      uploadId: "stored-upload",
      ranges: [[0, 2]],
      transport: "multipart_post",
    });
    call.resolve({ ok: true });
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]?.status).toBe("completed"));
    expect(storage.length).toBe(0);
  });

  it("surfaces a retry to the UI", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "a.txt")], "/", 1024);
    const call = await pendingCall(0);

    call.options.callbacks.onRetry({ attempt: 2, code: "STALLED", message: "no data moved" });
    expect(manager.getSnapshot().items[0]?.status).toBe("retrying");
    expect(manager.hasActive()).toBe(true);
  });

  it("marks an item cancelled when the caller cancels", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "a.txt")], "/", 1024);
    await pendingCall(0);

    manager.cancel(manager.getSnapshot().items[0]!.id);
    expect(manager.getSnapshot().items[0]?.status).toBe("cancelled");
    expect(engine.clientOptions[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("dismisses a cancelled item", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "a.txt")], "/", 1024);
    await pendingCall(0);
    manager.cancel(manager.getSnapshot().items[0]!.id);
    manager.dismissCompleted();
    expect(manager.getSnapshot().items).toEqual([]);
  });

  it("marks an aborted transfer cancelled even when the engine rejects it", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "a.txt")], "/", 1024);
    const call = await pendingCall(0);
    manager.cancel(manager.getSnapshot().items[0]!.id);
    call.reject(new Error("cancelled"));
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]?.status).toBe("cancelled"));
  });

  it("uses a plain failure message for a non-Error rejection", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "a.txt")], "/", 1024);
    const call = await pendingCall(0);
    call.reject("network is down");
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]).toMatchObject({
      status: "failed",
      error: "Upload failed",
    }));
  });

  it("ignores cancel and retry requests for missing or ineligible items", async () => {
    const { manager } = managerWith();
    manager.cancel("missing");
    manager.retry("missing");
    manager.add([new File(["x"], "x.txt")], "/", 1024);
    await pendingCall(0);
    manager.cancel("missing");
    manager.retry(manager.getSnapshot().items[0]!.id);
    expect(manager.getSnapshot().items[0]?.status).toBe("preparing");
  });

  it("dismisses completed items without hiding failures", async () => {
    const { manager } = managerWith();
    manager.add([new File(["ok"], "ok.txt"), new File(["no"], "no.txt")], "/", 1024);

    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    engine.calls[0]!.resolve({ ok: true });
    engine.calls[1]!.reject(new Error("nope"));
    await vi.waitFor(() =>
      expect(manager.getSnapshot().items.map(item => item.status).sort()).toEqual([
        "completed",
        "failed",
      ]),
    );

    manager.dismissSuccessful();
    expect(manager.getSnapshot().items.map(item => item.status)).toEqual(["failed"]);
  });

  it("dismisses both completed and cancelled items when the dock is cleared", async () => {
    const { manager } = managerWith();
    manager.add([new File(["ok"], "ok.txt"), new File(["no"], "no.txt")], "/", 1024);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
    engine.calls[0]!.resolve({ ok: true });
    engine.calls[1]!.reject(new Error("stop"));
    await vi.waitFor(() => expect(manager.getSnapshot().items.map(item => item.status).sort()).toEqual([
      "completed",
      "failed",
    ]));
    manager.dismissCompleted();
    expect(manager.getSnapshot().items.map(item => item.status)).toEqual(["failed"]);
  });

  it("uploads dropped entries under the folder they came from", async () => {
    const { manager } = managerWith();
    const viaInput = new File(["a"], "a.txt");
    Object.defineProperty(viaInput, "webkitRelativePath", { value: "picked/a.txt" });

    manager.add(
      [
        { file: new File(["b"], "b.txt"), relativePath: "trip/photos/b.txt" },
        viaInput,
        new File(["c"], "c.txt"),
      ],
      "/root",
      1024,
    );

    await vi.waitFor(() => expect(engine.calls).toHaveLength(3));
    expect(engine.calls.map(call => call.options.destDir).sort()).toEqual([
      "/root",
      "/root/picked",
      "/root/trip/photos",
    ]);
  });

  it("skips corrupted FileList entries instead of aborting the drop", async () => {
    const { manager } = managerWith();
    // A DLP extension can leave null slots in a dropped FileList.
    manager.add([null as unknown as File, new File(["ok"], "ok.txt")], "/", 1024);

    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    expect(manager.getSnapshot().items).toHaveLength(1);
    expect(manager.getSnapshot().items[0]?.name).toBe("ok.txt");
  });

  it("groups uploads by status for the dock summary", async () => {
    const { manager } = managerWith();
    manager.add([new File(["x"], "x.txt")], "/", 1024);
    await pendingCall(0);

    const snapshot = manager.getSnapshot();
    expect(snapshot.active).toBe(1);
    expect(snapshot.parallel).toBe(2);
  });

  it("publishes the finalizing phase", async () => {
    const { manager } = managerWith();
    manager.add([new File(["x"], "x.txt")], "/", 1024);
    const call = await pendingCall(0);
    call.options.callbacks.onState("finalizing");
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]).toMatchObject({
      status: "preparing",
      phase: "finalizing",
    }));
  });

  it("fails the item when an ancestor folder cannot be created", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    const { manager } = managerWith(fetcher);
    const file = new File(["x"], "x.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "parent/x.txt" });
    manager.add([file], "/root", 1024);
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]).toMatchObject({
      status: "failed",
      error: "Could not create folder (500)",
    }));
  });

  it("accepts an existing ancestor folder as success", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 405 }) as unknown as Response);
    const { manager } = managerWith(fetcher);
    const file = new File(["x"], "x.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "parent/x.txt" });
    manager.add([file], "/root", 1024);
    await pendingCall(0);
    expect(manager.getSnapshot().items[0]?.op).toBeUndefined();
    expect(manager.getSnapshot().items[0]?.status).toBe("preparing");
  });

  it("cancels a pending animation frame before publishing immediately", async () => {
    let frame: FrameRequestCallback | null = null;
    const cancelFrame = vi.fn();
    const manager = new UploadManager(
      vi.fn(async () => okResponse()) as unknown as typeof fetch,
      callback => {
        frame = callback;
        return 4;
      },
      cancelFrame,
    );
    manager.add([new File(["x"], "x.txt")], "/", 1024);
    const call = await pendingCall(0);
    call.options.callbacks.onProgress(1, 1);
    expect(frame).not.toBeNull();
    manager.setParallel(8);
    expect(cancelFrame).toHaveBeenCalledWith(4);
  });
});

describe("upload ids", () => {
  it("does not use Math.random when randomUUID is unavailable", () => {
    const random = vi.spyOn(Math, "random");
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    });

    const { manager } = managerWith();
    manager.add([new File(["a"], "a.txt")], "/", 1024);

    const [item] = manager.getSnapshot().items;
    expect(item?.id).toContain("07070707070707070707070707070707");
    expect(random).not.toHaveBeenCalled();
  });

  it("falls back to a local counter when Web Crypto is absent", () => {
    vi.stubGlobal("crypto", undefined);

    const { manager } = managerWith();
    manager.add(
      [new File(["a"], "a.txt"), new File(["b"], "b.txt")],
      "/",
      1024,
    );

    const ids = manager.getSnapshot().items.map(item => item.id);
    expect(new Set(ids).size).toBe(2);
  });
});
