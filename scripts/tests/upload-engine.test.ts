import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UploadClient,
  UploadError,
  UploadState,
  committedBytes,
  SpeedTracker,
  missingRanges,
  planWindows,
  uploadFile,
} from "../../xwing/frontend/src/upload-engine";

interface ProgressLike {
  loaded: number;
  total?: number;
}

/**
 * Controllable XMLHttpRequest stand-in.
 *
 * `uploadAbort` dispatches asynchronously, exactly like the browser, so tests
 * prove the engine settles on its own reason rather than on event ordering.
 */
class FakeXHR {
  static all: FakeXHR[] = [];

  status = 0;
  method = "";
  url = "";
  body: Blob | null = null;
  aborted = false;
  responseText = "";

  private listeners = new Map<string, Array<(event?: unknown) => void>>();
  private uploadListeners = new Map<string, Array<(event: ProgressLike) => void>>();

  upload = {
    addEventListener: (type: string, handler: (event: ProgressLike) => void): void => {
      const handlers = this.uploadListeners.get(type) ?? [];
      handlers.push(handler);
      this.uploadListeners.set(type, handlers);
    },
  };

  constructor() {
    FakeXHR.all.push(this);
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(): void {}

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: Blob): void {
    this.body = body;
    this.dispatchUpload("loadstart", { loaded: 0 });
  }

  abort(): void {
    this.aborted = true;
    queueMicrotask(() => this.dispatch("abort"));
  }

  progress(loaded: number, total: number): void {
    this.dispatchUpload("progress", { loaded, total });
  }

  /** The browser finished sending the body; the response is still pending. */
  bodySent(): void {
    this.dispatchUpload("load", { loaded: this.body?.size ?? 0 });
  }

  finish(status: number, payload: unknown = { ranges: [[0, 0]] }): void {
    this.status = status;
    this.responseText = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.dispatch("load");
  }

  uploadError(): void {
    this.dispatchUpload("error", { loaded: 0, total: 0 });
  }

  networkError(): void {
    this.dispatch("error");
  }

  timeout(): void {
    this.dispatch("timeout");
  }

  private dispatch(type: string, event?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  private dispatchUpload(type: string, event: ProgressLike): void {
    for (const handler of this.uploadListeners.get(type) ?? []) handler(event);
  }
}

/** Client whose `complete` call succeeds unless a test overrides it. */
function completingFetch() {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({ path: "file.bin" }),
  }));
}

function client(): UploadClient {
  return new UploadClient({ base: "/_upload", fetchImpl: completingFetch() as unknown as typeof fetch });
}

function blobOf(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

/** Drive an engine call far enough to create the first XHR. */
/** Let queued microtasks and one macrotask run under real timers. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function startUpload(overrides: Record<string, unknown> = {}) {
  const states: string[] = [];
  const progress: number[] = [];
  const promise = uploadFile({
    client: client(),
    file: blobOf(8),
    destDir: "/",
    session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 8 },
    chunkSize: 4,
    minChunkBytes: 4,
    concurrency: 1,
    backoffMs: [1, 1, 1],
    callbacks: {
      onState: (state: string) => states.push(state),
      onProgress: (committed: number) => progress.push(committed),
      onRetry: () => {},
    },
    ...overrides,
  });
  await Promise.resolve();
  return { promise, states, progress };
}

beforeEach(() => {
  FakeXHR.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SpeedTracker", () => {
  it("computes bytes per second across the sampled window", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const tracker = new SpeedTracker();
    expect(tracker.speed()).toBe(0);
    tracker.sample(0);
    now.mockReturnValue(2_000);
    tracker.sample(10_000);
    expect(tracker.speed()).toBe(10_000);
    now.mockReturnValue(3_000);
    tracker.sample(25_000);
    expect(tracker.speed()).toBe(12_500);
    now.mockRestore();
  });

  it("drops samples older than the sliding window", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(0);
    const tracker = new SpeedTracker();
    tracker.sample(0);
    now.mockReturnValue(6_000);
    tracker.sample(6_000);
    now.mockReturnValue(7_000);
    tracker.sample(10_000);
    expect(tracker.speed()).toBe(4_000);
    now.mockRestore();
  });
});

describe("range planning", () => {
  it("reports the gaps the server has not got yet", () => {
    expect(missingRanges(null, 10)).toEqual([[0, 10]]);
    expect(missingRanges([], 10)).toEqual([[0, 10]]);
    expect(missingRanges([[0, 4], [8, 10]], 10)).toEqual([[4, 8]]);
    expect(missingRanges([[0, 10]], 10)).toEqual([]);
    expect(missingRanges([[0, 4], [4, 10]], 10)).toEqual([]);
    expect(missingRanges([[null, "bad"], [0, 4]] as unknown as number[][], 10)).toEqual([[4, 10]]);
    expect(missingRanges([[5, 2]], 10)).toEqual([[0, 10]]);
  });

  it("splits gaps into equal windows and keeps the remainder", () => {
    expect(planWindows([], 10, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(planWindows([[4, 8]], 10, 4)).toEqual([
      [0, 4],
      [8, 10],
    ]);
  });

  it("counts committed bytes", () => {
    expect(committedBytes([[0, 4], [8, 10]])).toBe(6);
    expect(committedBytes(null)).toBe(0);
    expect(committedBytes([[5, 2]])).toBe(0);
  });
});

describe("UploadClient", () => {
  it("appends client-wide query parameters to every request", async () => {
    const fetchImpl = completingFetch();
    const client = new UploadClient({
      base: "/_upload",
      params: { session_id: "session-b", tab_id: "tab-a" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.initWithRetry({ filename: "a.bin", size: 1, dir: "/" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/_upload/init?session_id=session-b&tab_id=tab-a");

    await client.complete("abc");
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      "/_upload/abc/complete?session_id=session-b&tab_id=tab-a",
    );

    const put = client.put("abc", 7, blobOf(1));
    const xhr = FakeXHR.all[0]!;
    expect(xhr.url).toBe("/_upload/abc?session_id=session-b&tab_id=tab-a&offset=7");
    xhr.finish(200, { ranges: [[7, 8]] });
    await put;
  });

  it("surfaces a JSON and a non-JSON init rejection", async () => {
    const jsonFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ detail: "init failed" }),
    }));
    await expect(new UploadClient({ fetchImpl: jsonFetch as unknown as typeof fetch }).initWithRetry({
      filename: "a",
      size: 1,
      dir: "/",
    })).rejects.toMatchObject({ status: 500, message: "init failed", retryable: true });

    const textFetch = vi.fn(async () => ({
      ok: false,
      status: 418,
      json: async () => { throw new Error("not json"); },
    }));
    await expect(new UploadClient({ fetchImpl: textFetch as unknown as typeof fetch }).initWithRetry({
      filename: "a",
      size: 1,
      dir: "/",
    })).rejects.toMatchObject({ status: 418, message: "Upload failed (418)" });
  });

  it("swallows a failed best-effort cancel", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await expect(new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).cancel("abc"))
      .resolves.toBeUndefined();
  });

  it("rejects immediately when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client().put("abc", 0, blobOf(1), { signal: controller.signal }))
      .rejects.toMatchObject({ code: "ABORTED" });
    expect(FakeXHR.all[0]!.aborted).toBe(true);
  });

  it("rejects a put when its upload stream errors", async () => {
    const put = client().put("abc", 0, blobOf(1));
    FakeXHR.all[0]!.uploadError();
    await expect(put).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("uploadFile", () => {
  it("sends each planned window and completes", async () => {
    const { promise } = await startUpload();
    expect(FakeXHR.all).toHaveLength(1);
    expect(FakeXHR.all[0]!.url).toBe("/_upload/session?offset=0");

    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.url).toBe("/_upload/session?offset=4");

    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]], received: 4 });
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 8 });
  });

  it("derives a range from received bytes when the server omits ranges", async () => {
    const fake = {
      put: vi.fn(async () => ({ received: 8 })),
      complete: vi.fn(async () => ({ path: "file.bin" })),
      status: vi.fn(async () => ({ ranges: [[0, 8]] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
    })).resolves.toMatchObject({ ok: true, path: "file.bin" });
  });

  it("reports both uploading and processing phases", async () => {
    const states: string[] = [];
    const fake = {
      put: vi.fn(async (_id, _offset, _blob, handlers) => {
        handlers.onPhase(UploadState.UPLOADING);
        handlers.onPhase(UploadState.PROCESSING);
        return { ranges: [[0, 8]] };
      }),
      complete: vi.fn(async () => ({ path: "file.bin" })),
      status: vi.fn(async () => ({ ranges: [[0, 8]] })),
    };
    await uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      callbacks: { onState: (state: string) => states.push(state) },
    });
    expect(states).toEqual(expect.arrayContaining([UploadState.UPLOADING, UploadState.PROCESSING]));
  });

  it("shrinks a rejected 1 MB upload below the proxy body limit", async () => {
    const size = 1_000_000;
    const { promise } = await startUpload({
      file: blobOf(size),
      chunkSize: size,
      maxChunkBytes: size,
      concurrency: 1,
      session: { uploadId: "session", chunkSize: size, concurrency: 1, ranges: [], size },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0]!.body!.size).toBe(size);

    // Model a reverse proxy rejecting the raw PUT before it reaches X-wing.
    FakeXHR.all[0]!.finish(413, "Request Entity Too Large");
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.body!.size).toBe(500_000);

    FakeXHR.all[1]!.finish(200, { ranges: [[0, 500_000]], received: 500_000 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    expect(FakeXHR.all[2]!.url).toContain("offset=500000");
    expect(FakeXHR.all[2]!.body!.size).toBe(500_000);
    FakeXHR.all[2]!.finish(200, { ranges: [[0, size]], received: 500_000 });

    await expect(promise).resolves.toMatchObject({ ok: true, bytes: size });
  });

  it("skips windows the server already holds", async () => {
    const { promise } = await startUpload({
      session: { uploadId: "s", chunkSize: 4, concurrency: 1, ranges: [[0, 4]], size: 8 },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0]!.url).toBe("/_upload/s?offset=4");
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 8]], received: 4 });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("retries a failed window and shrinks it after repeated failures", async () => {
    const retries: number[] = [];
    const { promise } = await startUpload({
      file: blobOf(4000),
      chunkSize: 4000,
      minChunkBytes: 100,
      maxChunkBytes: 4000,
      concurrency: 1,
      callbacks: { onRetry: (info: { attempt: number }) => retries.push(info.attempt) },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    expect(FakeXHR.all[0]!.body!.size).toBe(4000);

    FakeXHR.all[0]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.body!.size).toBe(4000);
    expect(retries).toEqual([1]);

    FakeXHR.all[1]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    // Fourth attempt onwards halves the window so a slow link can finish it.
    FakeXHR.all[2]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(4));
    expect(FakeXHR.all[3]!.body!.size).toBeLessThan(4000);

    FakeXHR.all[3]!.finish(200, { ranges: [[0, 2000]], received: 2000 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(5));
    expect(FakeXHR.all[4]!.url).toContain("offset=2000");
    FakeXHR.all[4]!.finish(200, { ranges: [[0, 4000]], received: 2000 });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("sends the tail a shrunk window gave up before starting later windows", async () => {
    const { promise } = await startUpload({
      file: blobOf(12000),
      chunkSize: 4000,
      minChunkBytes: 100,
      maxChunkBytes: 4000,
      concurrency: 2,
      session: { uploadId: "session", chunkSize: 4000, concurrency: 2, ranges: [], size: 12000 },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[0]!.url).toContain("offset=0");
    expect(FakeXHR.all[1]!.url).toContain("offset=4000");

    FakeXHR.all[0]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    FakeXHR.all[2]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(4));
    expect(FakeXHR.all[3]!.body!.size).toBe(2000);

    // The other worker frees up first. The abandoned half of window 0 must be
    // next, not window 2: an in-order sink would otherwise stall behind the gap.
    FakeXHR.all[1]!.finish(200, { ranges: [[4000, 8000]], received: 4000 });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(5));
    expect(FakeXHR.all[4]!.url).toContain("offset=2000");

    void promise.catch(() => {});
  });

  it("gives up after the attempt budget and keeps the server's ranges", async () => {
    const progress: number[] = [];
    const { promise } = await startUpload({
      maxAttempts: 2,
      backoffMs: [1],
      callbacks: { onProgress: (committed: number) => progress.push(committed) },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(500);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(500);

    await expect(promise).rejects.toBeInstanceOf(UploadError);
    expect(progress).toContain(0);
  });

  it("does not retry a non-retryable rejection", async () => {
    const { promise } = await startUpload();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(403, { detail: "Not permitted" });

    await expect(promise).rejects.toMatchObject({ status: 403, retryable: false });
    expect(FakeXHR.all).toHaveLength(1);
  });

  it("surfaces a finalize failure instead of retrying a session the server dropped", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        ok: false,
        code: "server_error",
        message: "Upload finalize failed: Permission denied",
      }),
    });
    const { promise } = await startUpload({
      client: new UploadClient({ base: "/_upload", fetchImpl: fetchImpl as unknown as typeof fetch }),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [[0, 8]], size: 8 },
    });

    await expect(promise).rejects.toMatchObject({
      status: 500,
      message: "Upload finalize failed: Permission denied",
    });
    const completeCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("/complete"));
    expect(completeCalls).toHaveLength(1);
  });

  it("reports a 2xx that is not the JSON envelope instead of accepting it", async () => {
    const { promise } = await startUpload();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    // An authenticated redirect followed by XHR lands here as the login page.
    FakeXHR.all[0]!.finish(200, "<!doctype html><title>Sign in</title>");

    await expect(promise).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("restarts once when the session is gone", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ upload_id: "fresh", chunk_size: 4, concurrency: 1, size: 8 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ path: "file.bin" }) });
    const retries: string[] = [];
    const { promise } = await startUpload({
      client: new UploadClient({ base: "/_upload", fetchImpl: fetchImpl as unknown as typeof fetch }),
      callbacks: { onRetry: (info: { code: string; message: string }) => retries.push(`${info.code}:${info.message}`) },
    });
    expect(FakeXHR.all).toHaveLength(1);

    FakeXHR.all[0]!.finish(404, { detail: "Upload session not found" });
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith("/_upload/init", expect.anything());
    expect(FakeXHR.all).toHaveLength(2);
    expect(FakeXHR.all[1]!.url).toBe("/_upload/fresh?offset=0");

    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await flush();
    expect(FakeXHR.all[2]!.url).toBe("/_upload/fresh?offset=4");
    FakeXHR.all[2]!.finish(200, { ranges: [[0, 8]], received: 4 });
    await flush();
    expect(retries).toEqual([]);
    await expect(promise).resolves.toMatchObject({ ok: true, uploadId: "fresh", restarted: true });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const { promise } = await startUpload({ signal: controller.signal });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    expect(FakeXHR.all[0]!.aborted).toBe(true);
  });

  it("retries an upload connection error", async () => {
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      backoffMs: [1],
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.uploadError();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]] });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("retries an XHR network error", async () => {
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      backoffMs: [1],
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.networkError();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]] });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("retries a browser timeout", async () => {
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      backoffMs: [1],
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.timeout();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]] });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("retries a missing final response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ detail: "busy" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ path: "file.bin" }),
      });
    await expect(uploadFile({
      client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [[0, 8]], size: 8 },
      backoffMs: [1],
    })).resolves.toMatchObject({ ok: true, path: "file.bin" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("replans after a proxy rejects a window", async () => {
    const { promise } = await startUpload({
      file: blobOf(12000),
      chunkSize: 4000,
      maxChunkBytes: 4000,
      minChunkBytes: 100,
      concurrency: 1,
      session: { uploadId: "s", chunkSize: 4000, concurrency: 1, ranges: [], size: 12000 },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(413);
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.body!.size).toBe(2000);

    for (let index = 1; index < 9; index += 1) {
      const xhr = FakeXHR.all[index];
      if (!xhr) break;
      const start = Number(new URL(xhr.url, "http://xwing.test").searchParams.get("offset"));
      xhr.finish(200, { ranges: [[0, start + xhr.body!.size]] });
      await flush();
    }
    FakeXHR.all.at(-1)!.finish(200, { ranges: [[0, 12000]] });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("cancels a backoff before it starts", async () => {
    const controller = new AbortController();
    const { promise } = await startUpload({ signal: controller.signal, backoffMs: [1000] });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    controller.abort();
    FakeXHR.all[0]!.finish(500);
    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("aborts a retry when the signal is closed by the retry callback", async () => {
    const controller = new AbortController();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      signal: controller.signal,
      backoffMs: [1000],
      callbacks: { onRetry: () => controller.abort() },
    });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(500);
    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("cancels a backoff while it is waiting", async () => {
    const controller = new AbortController();
    const { promise } = await startUpload({ signal: controller.signal, backoffMs: [1000] });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.finish(500);
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("reports incomplete passes and stops when the server never accepts every byte", async () => {
    const retries: string[] = [];
    const fake = {
      put: vi.fn(async () => ({ ranges: [] })),
      complete: vi.fn(async () => ({ path: "short.bin" })),
      status: vi.fn(async () => ({ ranges: [] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(1),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 1, concurrency: 1, ranges: [], size: 1 },
      callbacks: { onRetry: (info: { code: string }) => retries.push(info.code) },
    })).rejects.toMatchObject({ code: "INCOMPLETE" });
    expect(fake.put).toHaveBeenCalledTimes(4);
    expect(retries).toContain("INCOMPLETE");
  });

  it("moves to the processing phase once the body is sent", async () => {
    const states: string[] = [];
    await startUpload({ callbacks: { onState: (state: string) => states.push(state) } });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(1));
    FakeXHR.all[0]!.bodySent();
    expect(states).toContain(UploadState.PROCESSING);
  });
});

describe("request deadlines", () => {
  it("abandons a stalled request after the idle timeout and retries it", async () => {
    vi.useFakeTimers();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      idleTimeoutMs: 1000,
      backoffMs: [1],
    });
    expect(FakeXHR.all).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeXHR.all[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeXHR.all).toHaveLength(2);

    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("keeps a slow request alive while bytes keep moving", async () => {
    vi.useFakeTimers();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      idleTimeoutMs: 1000,
      backoffMs: [1],
    });
    expect(FakeXHR.all).toHaveLength(1);

    for (let step = 0; step < 5; step += 1) {
      await vi.advanceTimersByTimeAsync(900);
      FakeXHR.all[0]!.progress((step + 1) * 100, 400);
    }
    expect(FakeXHR.all[0]!.aborted).toBe(false);

    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("waits out a DLP scan after the body is sent", async () => {
    vi.useFakeTimers();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      idleTimeoutMs: 1000,
      responseTimeoutMs: 60_000,
      backoffMs: [1],
    });
    expect(FakeXHR.all).toHaveLength(1);
    FakeXHR.all[0]!.progress(400, 400);
    FakeXHR.all[0]!.bodySent();

    // Far longer than the idle timeout: the scan must not kill the request.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeXHR.all[0]!.aborted).toBe(false);
    expect(FakeXHR.all).toHaveLength(1);

    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], received: 4 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("gives up when the server does not answer after the body is sent", async () => {
    vi.useFakeTimers();
    const { promise } = await startUpload({
      file: blobOf(4),
      session: { uploadId: "session", chunkSize: 4, concurrency: 1, ranges: [], size: 4 },
      idleTimeoutMs: 1000,
      responseTimeoutMs: 2000,
      maxAttempts: 1,
      backoffMs: [1],
    });
    FakeXHR.all[0]!.progress(400, 400);
    FakeXHR.all[0]!.bodySent();
    const assertion = expect(promise).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });
});

describe("fallback conditions", () => {
  it("derives the defaults when init and the server omit optional fields", async () => {
    const fake = {
      initWithRetry: vi.fn(async () => ({ upload_id: "bare", size: 8 })),
      put: vi.fn(async () => ({ received: 0 })),
      complete: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ ranges: [] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      filename: "bare.bin",
    })).resolves.toMatchObject({ ok: true, path: "bare.bin", bytes: 8 });
  });

  it("wraps a non-upload rejection from a window", async () => {
    const fake = {
      put: vi.fn(async () => { throw "boom"; }),
      complete: vi.fn(async () => ({ path: "x" })),
      status: vi.fn(async () => ({ ranges: [[0, 8]] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
      maxAttempts: 1,
    })).rejects.toMatchObject({ message: "Upload failed", retryable: true });
  });

  it("wraps a non-error finalize failure", async () => {
    const fake = {
      put: vi.fn(async () => ({ ranges: [[0, 8]], received: 8 })),
      complete: vi.fn(async () => { throw "done"; }),
      status: vi.fn(async () => ({ ranges: [[0, 8]] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
      maxAttempts: 1,
    })).rejects.toMatchObject({ message: "done" });
  });

  it("stops when session loss restart is disabled or already used", async () => {
    const failed = {
      put: vi.fn(async () => { throw new UploadError("lost", { code: "SESSION_LOST" }); }),
      complete: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ ranges: [] })),
    };
    await expect(uploadFile({
      client: failed as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
      restartOnSessionLoss: false,
    })).rejects.toMatchObject({ code: "SESSION_LOST" });

    let inits = 0;
    const restarted = {
      initWithRetry: vi.fn(async () => {
        inits += 1;
        return { upload_id: `s${inits}`, chunk_size: 8, concurrency: 1, ranges: [], size: 8 };
      }),
      put: vi.fn(async () => { throw new UploadError("lost", { code: "SESSION_LOST" }); }),
      complete: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ ranges: [] })),
    };
    await expect(uploadFile({
      client: restarted as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
    })).rejects.toMatchObject({ code: "SESSION_LOST" });
    expect(inits).toBe(1);
  });

  it("shrinks a window that the server rejects as too large", async () => {
    const retries: number[] = [];
    const fake = {
      put: vi.fn(async () => { throw new UploadError("too large", { status: 413, retryable: true }); }),
      complete: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ ranges: [] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
      minChunkBytes: 2,
      maxAttempts: 1,
      callbacks: { onRetry: info => retries.push(info.attempt) },
    })).rejects.toMatchObject({ status: 413 });
    expect(retries.length).toBeGreaterThan(0);
  });

  it("wraps a non-error init failure", async () => {
    const fake = {
      initWithRetry: vi.fn(async () => { throw "init down"; }),
      put: vi.fn(),
      complete: vi.fn(),
      status: vi.fn(),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
    })).rejects.toBe("init down");
  });

  it("wraps a non-error thrown by the state callback", async () => {
    const fake = {
      put: vi.fn(async () => ({ ranges: [[0, 8]], received: 8 })),
      complete: vi.fn(async () => ({ path: "x" })),
      status: vi.fn(async () => ({ ranges: [[0, 8]] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
      callbacks: {
        onState: state => {
          if (state === UploadState.FINALIZING) throw "final callback";
        },
      },
    })).rejects.toMatchObject({ message: "Upload failed" });
  });

  it("wraps a non-error thrown after completion", async () => {
    const fake = {
      put: vi.fn(async () => ({ ranges: [[0, 8]], received: 8 })),
      complete: vi.fn(async () => ({ path: "x" })),
      status: vi.fn(async () => ({ ranges: [[0, 8]] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
      callbacks: {
        onState: state => {
          if (state === UploadState.DONE) throw "done callback";
        },
      },
    })).rejects.toMatchObject({ message: "Upload failed" });
  });

  it("keeps a full retry window when the minimum blocks shrinking", async () => {
    const fake = {
      put: vi.fn(async () => { throw new UploadError("retry", { retryable: true }); }),
      complete: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ ranges: [] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
      minChunkBytes: 8,
      maxAttempts: 2,
      backoffMs: [0],
    })).rejects.toMatchObject({ message: "retry" });
  });

  it("rejects a 413 window when the computed size cannot shrink", async () => {
    const floor = vi.spyOn(Math, "floor").mockReturnValueOnce(8);
    const fake = {
      put: vi.fn(async () => { throw new UploadError("too large", { status: 413 }); }),
      complete: vi.fn(async () => ({})),
      status: vi.fn(async () => ({ ranges: [] })),
    };
    await expect(uploadFile({
      client: fake as unknown as UploadClient,
      file: blobOf(8),
      destDir: "/",
      session: { uploadId: "s", chunkSize: 8, concurrency: 1, ranges: [], size: 8 },
      chunkSize: 8,
      minChunkBytes: 4,
      maxAttempts: 1,
    })).rejects.toMatchObject({ status: 413 });
    floor.mockRestore();
  });

  it("re-arms response deadlines and reads a session without ranges", async () => {
    const { promise } = await startUpload({
      session: { uploadId: "no-ranges", chunkSize: 0, concurrency: 1, size: 8 },
      chunkSize: 0,
      minChunkBytes: 1,
    });
    const xhr = FakeXHR.all[0]!;
    xhr.progress(8, 8);
    xhr.bodySent();
    xhr.bodySent();
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 8]], received: 8 });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });
});
