import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadManager } from "../../xwing/frontend/src/upload-manager";

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

beforeEach(() => {
  engine.calls = [];
  engine.clientOptions = [];
  engine.uploadFile.mockReset();
  engine.uploadFile.mockImplementation((options: EngineCallOptions) => {
    const call = deferred();
    engine.calls.push({ options, resolve: call.resolve, reject: call.reject });
    return call.promise;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UploadManager scheduling", () => {
  it("moves an item from queued to completed", async () => {
    const { manager } = managerWith();
    manager.add([new File(["hello"], "hello.txt")], "/docs", 1024);

    expect(manager.getSnapshot().items[0]).toMatchObject({
      name: "hello.txt",
      status: "queued",
      size: 5,
    });
    const call = await pendingCall(0);
    expect(call.options).toMatchObject({ destDir: "/docs", chunkSize: 1024 });

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
    expect(snapshot.parallel).toBe(4);
  });
});
