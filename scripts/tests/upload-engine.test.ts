import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UploadClient,
  UploadError,
  UploadState,
  committedBytes,
  errorFromResponse,
  missingRanges,
  newUploadKey,
  planWindows,
  uploadFile,
} from "../../xwing/frontend/src/upload-engine";

interface ProgressLike {
  loaded: number;
  total?: number;
}

class FakeXHR {
  static all: FakeXHR[] = [];
  static throwOnOpen = false;

  status = 0;
  readyState = 0;
  method = "";
  url = "";
  body: Blob | FormData | null = null;
  headers: Record<string, string> = {};
  aborted = false;
  responseText = "";
  withCredentials = false;

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
    if (FakeXHR.throwOnOpen) throw new Error("blocked");
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: Blob | FormData): void {
    this.body = body;
    this.dispatchUpload("loadstart", { loaded: 0 });
  }

  abort(): void {
    this.aborted = true;
    queueMicrotask(() => this.dispatch("abort"));
  }

  get bodySize(): number {
    if (this.body instanceof Blob) return this.body.size;
    const file = this.body instanceof FormData ? this.body.get("file") : null;
    return file instanceof Blob ? file.size : 0;
  }

  progress(loaded: number, total = this.bodySize): void {
    this.dispatchUpload("progress", { loaded, total });
  }

  bodySent(): void {
    this.dispatchUpload("load", { loaded: this.bodySize });
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

  webKitDone(status = 0): void {
    this.readyState = 4;
    this.status = status;
    this.dispatch("readystatechange");
  }

  readyStateChange(): void {
    this.readyState = 0;
    this.dispatch("readystatechange");
  }

  private dispatch(type: string, event?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  private dispatchUpload(type: string, event: ProgressLike): void {
    for (const handler of this.uploadListeners.get(type) ?? []) handler(event);
  }
}

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    json: async () => payload,
  } as unknown as Response;
}

function initPayload(overrides: Record<string, unknown> = {}) {
  return {
    upload_id: "session",
    state: "open",
    size: 8,
    ranges: [],
    chunk_policy: { initial_bytes: 4, max_bytes: 100, max_concurrency: 1 },
    transport_order: ["binary_post", "multipart_post", "binary_put"],
    ack_timeout_ms: 1000,
    ...overrides,
  };
}

function clientWith(
  init: Record<string, unknown> | (() => Response | Promise<Response>) = initPayload(),
  complete: Record<string, unknown> | (() => Response | Promise<Response>) = {
    path: "file.bin",
    size: 8,
    verified: true,
  },
) {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.includes("/init")) {
      return typeof init === "function" ? init() : response(init);
    }
    if (path.includes("/complete")) {
      return typeof complete === "function" ? complete() : response(complete);
    }
    return response({ ranges: [] });
  });
  return {
    fetchImpl,
    client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
  };
}

function blobOf(size: number): Blob {
  return new Blob([Uint8Array.from({ length: size }, (_, index) => index & 0xff)]);
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function startUpload(overrides: Record<string, unknown> = {}) {
  const states: string[] = [];
  const progress: number[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const file = (overrides.file as Blob | undefined) ?? blobOf(8);
  const setup = clientWith(
    (overrides.init as Record<string, unknown> | undefined) ?? initPayload({ size: file.size }),
    (overrides.complete as Record<string, unknown> | undefined) ?? {
      path: "file.bin",
      size: file.size,
      verified: true,
    },
  );
  const client = (overrides.client as UploadClient | undefined) ?? setup.client;
  const extraOptions = (overrides.options as Record<string, unknown> | undefined) ?? {};
  const baseCallbacks = {
    onState: (state: string) => states.push(state),
    onProgress: (committed: number) => progress.push(committed),
    onDiagnostic: (event: Record<string, unknown>) => diagnostics.push(event),
  };
  const promise = uploadFile({
    client,
    file,
    destDir: "/",
    uploadKey: "test-upload-key",
    fingerprint: { name: "file.bin", size: file.size, last_modified: 1 },
    chunkSize: 4,
    minChunkBytes: 4,
    maxChunkBytes: 100,
    concurrency: 1,
    ackTimeoutMs: 1000,
    idleTimeoutMs: 1000,
    backoffMs: [0],
    ...extraOptions,
    callbacks: {
      ...baseCallbacks,
      ...((extraOptions.callbacks as Record<string, unknown> | undefined) ?? {}),
    },
  });
  await vi.waitFor(() => expect(FakeXHR.all[0]?.body).toBeTruthy());
  return { promise, states, progress, diagnostics, setup, client };
}

beforeEach(() => {
  FakeXHR.all = [];
  FakeXHR.throwOnOpen = false;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("range planning", () => {
  it("reports the gaps the server has not got yet", () => {
    expect(missingRanges(null, 10)).toEqual([[0, 10]]);
    expect(missingRanges([], 10)).toEqual([[0, 10]]);
    expect(missingRanges([[0, 4], [8, 10]], 10)).toEqual([[4, 8]]);
    expect(missingRanges([[0, 10]], 10)).toEqual([]);
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

describe("UploadClient setup", () => {
  it("classifies the remaining response status families", () => {
    expect(errorFromResponse(401, null)).toMatchObject({
      code: "AUTH_REQUIRED",
      retryable: false,
    });
    expect(
      errorFromResponse(400, { detail: { code: "UPLOAD_INCOMPLETE" } }),
    ).toMatchObject({ code: "UPLOAD_INCOMPLETE", retryable: true });
    expect(
      errorFromResponse(409, { detail: { code: "SESSION_CLOSING" } }),
    ).toMatchObject({ code: "SESSION_CLOSING", retryable: true });
    expect(errorFromResponse(409, {})).toMatchObject({
      code: "SESSION_LOST",
      retryable: true,
    });
    const { client } = clientWith();
    expect(client.url("/x", { drop: null, skip: undefined, keep: "yes" })).toBe(
      "/_upload/x?keep=yes",
    );
  });

  it("creates upload keys with and without WebCrypto", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7);
        return bytes;
      },
    });
    expect(newUploadKey()).toBe(`k-${"07".repeat(16)}`);

    vi.stubGlobal("crypto", undefined);
    const first = newUploadKey();
    const second = newUploadKey();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^k-[a-z0-9]+-[a-z0-9]+$/);
  });

  it("retries a dropped init and appends client-wide query parameters", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("proxy dropped the setup"))
      .mockResolvedValueOnce(response(initPayload()));
    const client = new UploadClient({
      params: { tab_id: "tab-a" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.initWithRetry(
      { upload_key: "key-123456", filename: "a.bin", size: 8, dir: "/" },
      { attempts: 2, backoffMs: [0] },
    );
    expect(result.upload_id).toBe("session");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0]).toBe("/_upload/init?tab_id=tab-a");
  });

  it("turns a 403 into a non-retryable auth error", async () => {
    const fetchImpl = vi.fn(async () => response("Authentication required", 403));
    await expect(
      new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).initWithRetry(
        { upload_key: "key-123456", filename: "a.bin", size: 1, dir: "/" },
        { attempts: 3, backoffMs: [0] },
      ),
    ).rejects.toMatchObject({ status: 403, code: "AUTH_REQUIRED", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("turns an already-aborted signal into cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new UploadClient({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: controller.signal,
    });
    await expect(client._requestJson("/init")).rejects.toMatchObject({
      code: "ABORTED",
      retryable: false,
    });
  });

  it("stops a retry when cancellation happens during backoff", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      setTimeout(() => controller.abort(), 0);
      throw new Error("dropped");
    });
    const client = new UploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    const pending = client.initWithRetry(
      { upload_key: "key-123456", filename: "a.bin", size: 1, dir: "/" },
      { attempts: 2, backoffMs: [100] },
    );
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects before sleeping when the signal is already aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new Error("dropped");
    });
    const client = new UploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    await expect(
      client.initWithRetry(
        { upload_key: "key-123456", filename: "a.bin", size: 1, dir: "/" },
        { attempts: 2, backoffMs: [10_000] },
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("wraps non-UploadError init failures and their missing messages", async () => {
    const client = new UploadClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    const request = vi.spyOn(client, "_requestJson");
    request.mockRejectedValueOnce({ message: "plain" });
    await expect(
      client.initWithRetry({}, { attempts: 1 }),
    ).rejects.toMatchObject({ message: "plain", retryable: true });

    request.mockRejectedValueOnce({});
    await expect(
      client.initWithRetry({}, { attempts: 1 }),
    ).rejects.toMatchObject({ message: "Upload setup failed", retryable: true });
  });

  it("uses an empty backoff schedule when Web Crypto is absent", async () => {
    vi.stubGlobal("crypto", undefined);
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("dropped"))
      .mockResolvedValueOnce(response(initPayload()));
    await expect(
      new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).initWithRetry(
        { upload_key: "key-123456", filename: "a.bin", size: 1, dir: "/" },
        { attempts: 2, backoffMs: [] },
      ),
    ).resolves.toMatchObject({ upload_id: "session" });
  });

  it("survives responses that expose neither readable text nor JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error("text failed");
      },
      json: async () => {
        throw new Error("json failed");
      },
    }) as unknown as Response);
    const client = new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client._requestJson("/init")).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
  });

  it("rejects a 200 page from a corporate login proxy", async () => {
    const fetchImpl = vi.fn(async () => response("<html>sign in</html>", 200));
    await expect(
      new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).initWithRetry(
        { upload_key: "key-123456", filename: "a.bin", size: 1, dir: "/" },
        { attempts: 1 },
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED", retryable: false });
  });

  it("distinguishes a setup timeout from user cancellation", async () => {
    const timeoutFetch = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const timeoutClient = new UploadClient({
      fetchImpl: timeoutFetch as unknown as typeof fetch,
    });
    await expect(timeoutClient._requestJson("/init", {}, 5)).rejects.toMatchObject({
      code: "RESPONSE_TIMEOUT",
      retryable: true,
    });

    const controller = new AbortController();
    const abortedClient = new UploadClient({
      fetchImpl: timeoutFetch as unknown as typeof fetch,
      signal: controller.signal,
    });
    const cancelled = abortedClient._requestJson("/init", {}, 10_000);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: "ABORTED",
      retryable: false,
    });
  });
});

describe("UploadClient chunk transport", () => {
  it("sends a typed binary POST with the digest in the URL", async () => {
    const { client } = clientWith();
    const promise = client.sendChunk("abc", 7, blobOf(4), "a".repeat(64), "binary_post");
    const xhr = FakeXHR.all[0]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toContain("/_upload/abc/chunk?");
    expect(xhr.url).toContain("offset=7");
    expect(xhr.url).toContain(`sha256=${"a".repeat(64)}`);
    expect(xhr.headers["Content-Type"]).toBe("application/octet-stream");
    expect(xhr.headers["Content-Disposition"]).toContain("attachment");
    expect(xhr.body).toBeInstanceOf(Blob);
    xhr.finish(200, { ranges: [[7, 11]], transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ranges: [[7, 11]], transport: "binary_post" });
  });

  it("sends multipart metadata and a real file part", async () => {
    const { client } = clientWith();
    const promise = client.sendChunk("abc", 0, blobOf(4), "b".repeat(64), "multipart_post");
    const xhr = FakeXHR.all[0]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.body).toBeInstanceOf(FormData);
    const form = xhr.body as FormData;
    expect(form.get("offset")).toBe("0");
    expect(form.get("sha256")).toBe("b".repeat(64));
    expect(form.get("file")).toBeInstanceOf(Blob);
    xhr.finish(200, { ranges: [[0, 4]], transport: "multipart_post" });
    await expect(promise).resolves.toMatchObject({ transport: "multipart_post" });
  });

  it("reports an immediate drop separately from a network failure after bytes moved", async () => {
    const { client } = clientWith();
    const dropped = client.sendChunk("abc", 0, blobOf(4), "c".repeat(64), "binary_post");
    FakeXHR.all[0]!.uploadError();
    await expect(dropped).rejects.toMatchObject({ code: "TRANSPORT_DROPPED" });

    const moved = client.sendChunk("abc", 0, blobOf(4), "c".repeat(64), "binary_post");
    FakeXHR.all[1]!.progress(2);
    FakeXHR.all[1]!.networkError();
    await expect(moved).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("fails a WebKit request that reaches DONE with status 0", async () => {
    const { client } = clientWith();
    const dropped = client.sendChunk("abc", 0, blobOf(4), "e".repeat(64), "binary_post");
    FakeXHR.all[0]!.webKitDone();

    await expect(dropped).rejects.toMatchObject({
      code: "TRANSPORT_DROPPED",
      retryable: true,
      transport: "binary_post",
    });
  });

  it("waits for the response after the whole body has been sent", async () => {
    vi.useFakeTimers();
    const { client } = clientWith();
    const promise = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post", {
      ackTimeoutMs: 2000,
    });
    FakeXHR.all[0]!.progress(4);
    FakeXHR.all[0]!.bodySent();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeXHR.all[0]!.aborted).toBe(false);
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]] });
    await expect(promise).resolves.toMatchObject({ ranges: [[0, 4]] });
  });

  it("reports idle and acknowledgement deadlines", async () => {
    vi.useFakeTimers();
    const { client } = clientWith();
    const idle = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post", {
      idleTimeoutMs: 100,
      ackTimeoutMs: 200,
    });
    const idleFailure = expect(idle).rejects.toMatchObject({ code: "TRANSPORT_DROPPED" });
    await vi.advanceTimersByTimeAsync(100);
    await idleFailure;

    const ack = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post", {
      idleTimeoutMs: 100,
      ackTimeoutMs: 200,
    });
    const ackFailure = expect(ack).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
    FakeXHR.all[1]!.bodySent();
    await vi.advanceTimersByTimeAsync(200);
    await ackFailure;
  });

  it("reports an open failure, a timeout event and an aborted start", async () => {
    FakeXHR.throwOnOpen = true;
    const { client } = clientWith();
    await expect(
      client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", retryable: false });

    FakeXHR.throwOnOpen = false;
    const timedOut = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post");
    FakeXHR.all.at(-1)!.timeout();
    await expect(timedOut).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("tolerates a performance API failure while reading the protocol", async () => {
    vi.spyOn(performance, "getEntriesByName").mockImplementation(() => {
      throw new Error("unsupported");
    });
    const { client } = clientWith();
    const promise = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post");
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]] });
    await expect(promise).resolves.toMatchObject({ protocol: null });
  });

  it("reads an empty performance entry list as no protocol", async () => {
    vi.spyOn(performance, "getEntriesByName").mockReturnValue([]);
    const { client } = clientWith();
    const promise = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post");
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]] });
    await expect(promise).resolves.toMatchObject({ protocol: null });
  });

  it("reads the negotiated protocol from a performance entry", async () => {
    vi.spyOn(performance, "getEntriesByName").mockReturnValue([
      { nextHopProtocol: "h2" } as PerformanceResourceTiming,
    ]);
    const { client } = clientWith();
    const promise = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post");
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]] });
    await expect(promise).resolves.toMatchObject({ protocol: "h2" });
  });

  it("times out after bytes moved and reports the upload error branch", async () => {
    vi.useFakeTimers();
    const { client } = clientWith();
    const idle = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post", {
      idleTimeoutMs: 100,
    });
    FakeXHR.all[0]!.progress(2);
    const idleFailure = expect(idle).rejects.toMatchObject({ code: "STALLED" });
    await vi.advanceTimersByTimeAsync(100);
    await idleFailure;

    const upload = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post");
    FakeXHR.all[1]!.progress(2);
    FakeXHR.all[1]!.uploadError();
    await expect(upload).rejects.toMatchObject({ code: "NETWORK" });

    const ready = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post");
    FakeXHR.all[2]!.readyStateChange();
    FakeXHR.all[2]!.finish(200, { ranges: [[0, 4]] });
    await expect(ready).resolves.toMatchObject({ ranges: [[0, 4]] });

    const webkit = client.sendChunk("abc", 0, blobOf(4), "d".repeat(64), "binary_post");
    FakeXHR.all[3]!.progress(2);
    FakeXHR.all[3]!.webKitDone();
    const webkitFailure = expect(webkit).rejects.toMatchObject({ code: "NETWORK" });
    await vi.advanceTimersByTimeAsync(0);
    await webkitFailure;
  });
});

describe("uploadFile", () => {
  it("returns immediately for an ignored file and a completed session", async () => {
    const ignored = await uploadFile({
      client: new UploadClient({
        fetchImpl: vi.fn(async () => response({ ignored: true })) as unknown as typeof fetch,
      }),
      file: blobOf(4),
      destDir: "/",
      uploadKey: "ignored-key",
    });
    expect(ignored).toMatchObject({ ok: true, ignored: true, bytes: 0 });

    const completed = await uploadFile({
      client: new UploadClient({
        fetchImpl: vi.fn(async () =>
          response(initPayload({ state: "complete", path: "done.bin" })),
        ) as unknown as typeof fetch,
      }),
      file: blobOf(4),
      destDir: "/",
      uploadKey: "completed-key",
    });
    expect(completed).toMatchObject({ ok: true, path: "done.bin", bytes: 4 });
  });

  it("handles a completed session without a path and a minimal open session", async () => {
    const completed = await uploadFile({
      client: new UploadClient({
        fetchImpl: vi.fn(async () =>
          response({ upload_id: "session", state: "complete" }),
        ) as unknown as typeof fetch,
      }),
      file: blobOf(4),
      destDir: "/",
      uploadKey: "completed-no-path",
    });
    expect(completed).toMatchObject({ ok: true, path: "upload", bytes: 4 });

    const setup = clientWith({ upload_id: "session", state: "open", ranges: [] });
    const { promise } = await startUpload({
      client: setup.client,
      options: {
        concurrency: 0,
        session: {
          uploadId: "stale",
          uploadKey: "test-upload-key",
          chunkSize: 4,
          concurrency: 1,
          ranges: [],
          size: 8,
          transport: "binary_post",
        },
      },
    });
    let committed = 0;
    for (let index = 0; committed < 8; index += 1) {
      await vi.waitFor(() => expect(FakeXHR.all.length).toBeGreaterThan(index));
      const xhr = FakeXHR.all[index]!;
      committed = Math.min(8, committed + xhr.bodySize);
      xhr.finish(200, { ranges: [[0, committed]], transport: "binary_post" });
    }
    await expect(promise).resolves.toMatchObject({ ok: true, restarted: true });
  });

  it("starts at the server's initial window when the caller allows a larger one", async () => {
    const { promise } = await startUpload({
      file: blobOf(32),
      options: { chunkSize: 16, maxChunkBytes: 32 },
    });
    expect(FakeXHR.all[0]!.bodySize).toBe(4);
    FakeXHR.all[0]!.finish(400, "bad request");
    await expect(promise).rejects.toMatchObject({ status: 400 });
  });

  it("starts with one canary, then completes from committed ranges", async () => {
    const { promise, states } = await startUpload();
    expect(FakeXHR.all[0]!.method).toBe("POST");
    expect(FakeXHR.all[0]!.bodySize).toBe(4);
    FakeXHR.all[0]!.progress(4);
    FakeXHR.all[0]!.bodySent();
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], received: 4, transport: "binary_post" });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.url).toContain("offset=4");
    FakeXHR.all[1]!.progress(4);
    FakeXHR.all[1]!.bodySent();
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]], received: 4, transport: "binary_post" });

    await expect(promise).resolves.toMatchObject({
      ok: true,
      bytes: 8,
      transport: "binary_post",
      verified: true,
    });
    expect(states).toContain(UploadState.PROCESSING);
  });

  it("falls back to multipart when the proxy drops a binary POST", async () => {
    const { promise } = await startUpload();
    FakeXHR.all[0]!.uploadError();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.body).toBeInstanceOf(FormData);
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]], transport: "multipart_post" });

    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    expect(FakeXHR.all[2]!.body).toBeInstanceOf(FormData);
    FakeXHR.all[2]!.finish(200, { ranges: [[0, 8]], transport: "multipart_post" });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      transport: "multipart_post",
    });
  });

  it("grows the window after clean canary acknowledgements", async () => {
    const { promise } = await startUpload({
      file: blobOf(32),
      options: { chunkSize: 32, maxChunkBytes: 32 },
    });
    expect(FakeXHR.all[0]!.bodySize).toBe(4);
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], transport: "binary_post" });

    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.bodySize).toBe(8);
    expect(FakeXHR.all[1]!.url).toContain("offset=4");
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 12]], transport: "binary_post" });

    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    expect(FakeXHR.all[2]!.bodySize).toBe(16);
    expect(FakeXHR.all[2]!.url).toContain("offset=12");
    FakeXHR.all[2]!.finish(200, { ranges: [[0, 28]], transport: "binary_post" });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(4));
    expect(FakeXHR.all[3]!.bodySize).toBe(4);
    FakeXHR.all[3]!.finish(200, { ranges: [[0, 32]], transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 32 });
  });

  it("shrinks after every transport drops the same window", async () => {
    const { promise } = await startUpload({
      options: { chunkSize: 4, maxChunkBytes: 4, minChunkBytes: 2 },
    });
    for (let index = 0; index < 4; index += 1) {
      await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(index + 1));
      FakeXHR.all[index]!.uploadError();
    }

    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(5));
    expect(FakeXHR.all[4]!.bodySize).toBe(2);
    let committed = 0;
    for (let index = 4; index < 8; index += 1) {
      await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(index + 1));
      committed += 2;
      FakeXHR.all[index]!.finish(200, {
        ranges: [[0, committed]],
        transport: "binary_post",
      });
    }
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 8 });
  });

  it("shrinks the window after 413 and finishes the whole file", async () => {
    const { promise } = await startUpload({
      file: blobOf(8),
      options: { minChunkBytes: 2, maxAttempts: 2 },
    });
    FakeXHR.all[0]!.finish(413, "Request Entity Too Large");
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.bodySize).toBe(2);

    let committed = 0;
    let index = 1;
    while (committed < 8 && index < 20) {
      await vi.waitFor(() => expect(FakeXHR.all.length).toBeGreaterThan(index));
      const xhr = FakeXHR.all[index]!;
      committed = Math.min(8, committed + xhr.bodySize);
      xhr.finish(200, {
        ranges: [[0, committed]],
        transport: "binary_post",
      });
      await flush();
      index += 1;
    }
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 8 });
  });

  it("replans a partial window instead of silently completing a short file", async () => {
    const { promise } = await startUpload({
      options: { chunkSize: 8, maxChunkBytes: 8 },
    });
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 2]], received: 2, transport: "binary_post" });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.url).toContain("offset=2");
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]], received: 6, transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 8 });
  });

  it("always reconciles with init, even when a local session exists", async () => {
    const setup = clientWith(initPayload({ ranges: [[0, 4]] }));
    const { promise } = await startUpload({
      client: setup.client,
      options: {
        session: {
          uploadId: "session",
          uploadKey: "test-upload-key",
          chunkSize: 4,
          concurrency: 1,
          ranges: [[0, 2]],
          size: 8,
          transport: "binary_post",
        },
      },
    });
    expect(setup.fetchImpl.mock.calls[0]![0]).toBe("/_upload/init");
    expect(FakeXHR.all[0]!.url).toContain("offset=4");
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 8]], transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("reinitialises once when the server loses the session", async () => {
    let inits = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.includes("/init")) {
        inits += 1;
        return response(initPayload());
      }
      if (path.includes("/complete")) {
        return response({ path: "file.bin", size: 8, verified: true });
      }
      return response({ ranges: [] });
    });
    const { promise } = await startUpload({
      client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      options: { maxAttempts: 1 },
    });
    FakeXHR.all[0]!.finish(404, { detail: { code: "SESSION_LOST", message: "gone" } });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 4]], transport: "binary_post" });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    FakeXHR.all[2]!.finish(200, { ranges: [[0, 8]], transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ok: true, restarted: true });
    expect(inits).toBe(2);
  });

  it("does not retry an authentication rejection", async () => {
    const { promise } = await startUpload();
    FakeXHR.all[0]!.finish(403, { detail: { code: "NOT_AUTHORIZED", message: "sign in" } });
    await expect(promise).rejects.toMatchObject({ code: "AUTH_REQUIRED", retryable: false });
    expect(FakeXHR.all).toHaveLength(1);
  });

  it("retries a retryable complete failure", async () => {
    let completes = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.includes("/init")) return response(initPayload({ ranges: [[0, 8]] }));
      if (path.includes("/complete")) {
        completes += 1;
        return completes === 1
          ? response({ detail: "busy" }, 503)
          : response({ path: "file.bin", size: 8, verified: true });
      }
      return response({});
    });
    const result = await uploadFile({
      client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      file: blobOf(8),
      destDir: "/",
      uploadKey: "test-upload-key",
      chunkSize: 4,
      backoffMs: [0],
    });
    expect(result).toMatchObject({ ok: true, verified: true });
    expect(completes).toBe(2);
  });

  it("reports the transport and protocol to diagnostics", async () => {
    const { promise, diagnostics } = await startUpload();
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 8]], transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ok: true });
    expect(diagnostics.some(event => event.event === "chunk-ok")).toBe(true);
    expect(diagnostics.some(event => event.event === "complete")).toBe(true);
  });

  it("reconciles progress from status after a failed upload", async () => {
    const setup = clientWith();
    setup.fetchImpl.mockImplementation(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.includes("/init")) return response(initPayload());
      if (path.endsWith("/session")) return response({ ranges: [[0, 4]] });
      return response({});
    });
    const { promise, progress } = await startUpload({ client: setup.client });
    FakeXHR.all[0]!.finish(400, "bad request");
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.url).toContain("offset=4");
    FakeXHR.all[1]!.finish(400, "bad request");
    await expect(promise).rejects.toMatchObject({ status: 400 });
    expect(progress.at(-1)).toBe(4);
  });

  it("falls back to the received length when a chunk omits ranges", async () => {
    const { promise } = await startUpload();
    FakeXHR.all[0]!.finish(200, { received: 4, transport: "binary_post" });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]], received: 4, transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 8 });
  });

  it("rotates after two failures once a transport was chosen", async () => {
    const { promise } = await startUpload();
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], transport: "binary_post" });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.uploadError();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(3));
    FakeXHR.all[2]!.uploadError();
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(4));
    expect(FakeXHR.all[3]!.body).toBeInstanceOf(FormData);
    FakeXHR.all[3]!.finish(200, { ranges: [[0, 8]], transport: "multipart_post" });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      transport: "multipart_post",
    });
  });

  it("clamps a non-finite requested window", async () => {
    const { promise } = await startUpload({
      options: { chunkSize: Infinity, maxChunkBytes: Infinity },
    });
    expect(FakeXHR.all[0]!.bodySize).toBe(4);
    FakeXHR.all[0]!.finish(200, { ranges: [[0, 4]], transport: "binary_post" });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]], transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 8 });
  });

  it("falls back to the window length when ranges and received are absent", async () => {
    const { promise } = await startUpload();
    FakeXHR.all[0]!.finish(200, { transport: "binary_post" });
    await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(2));
    expect(FakeXHR.all[1]!.url).toContain("offset=4");
    FakeXHR.all[1]!.finish(200, { ranges: [[0, 8]], transport: "binary_post" });
    await expect(promise).resolves.toMatchObject({ ok: true, bytes: 8 });
  });

  it("fails clearly when repeated passes credit nothing", async () => {
    const { promise } = await startUpload({
      init: initPayload({
        chunk_policy: { initial_bytes: 8, max_bytes: 8, max_concurrency: 1 },
      }),
      options: { chunkSize: 8, maxChunkBytes: 8 },
    });
    for (let index = 0; index < 6; index += 1) {
      await vi.waitFor(() => expect(FakeXHR.all).toHaveLength(index + 1));
      FakeXHR.all[index]!.finish(200, { ranges: [] });
    }
    await expect(promise).rejects.toMatchObject({ code: "INCOMPLETE" });
  });

  it("throws after repeated retryable completion failures", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.includes("/init")) return response(initPayload({ ranges: [[0, 8]] }));
      return response({ detail: "busy" }, 503);
    });
    await expect(
      uploadFile({
        client: new UploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
        file: blobOf(8),
        destDir: "/",
        uploadKey: "retry-complete-key",
        chunkSize: 4,
        maxAttempts: 3,
        backoffMs: [0],
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("cancels a completion retry when the caller aborts before backoff", async () => {
    const controller = new AbortController();
    const client = {
      initWithRetry: vi.fn(async () => initPayload({ ranges: [[0, 8]] })),
      status: vi.fn(),
      sendChunk: vi.fn(),
      complete: vi.fn(async () => {
        controller.abort();
        throw new UploadError("busy", {
          code: "RESPONSE_TIMEOUT",
          retryable: true,
        });
      }),
    };
    await expect(
      uploadFile({
        client: client as unknown as UploadClient,
        file: blobOf(8),
        destDir: "/",
        uploadKey: "cancel-complete-key",
        signal: controller.signal,
        backoffMs: [10_000],
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects a non-Error init failure", async () => {
    const client = {
      initWithRetry: vi.fn(async () => {
        throw new UploadError("init down", { code: "INIT_DROPPED", retryable: false });
      }),
      sendChunk: vi.fn(),
      status: vi.fn(),
      complete: vi.fn(),
    };
    await expect(
      uploadFile({
        client: client as unknown as UploadClient,
        file: blobOf(8),
        destDir: "/",
        uploadKey: "test-upload-key",
      }),
    ).rejects.toMatchObject({ code: "INIT_DROPPED" });
  });

  it("wraps non-UploadError chunk and completion failures", async () => {
    const chunkClient = {
      initWithRetry: vi.fn(async () => initPayload()),
      sendChunk: vi.fn(async () => {
        throw new Error("plain chunk");
      }),
      status: vi.fn(async () => ({ ranges: [] })),
      complete: vi.fn(),
    };
    await expect(
      uploadFile({
        client: chunkClient as unknown as UploadClient,
        file: blobOf(8),
        destDir: "/",
        uploadKey: "plain-chunk",
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({ message: "plain chunk" });

    const emptyChunkClient = {
      ...chunkClient,
      sendChunk: vi.fn(async () => {
        throw {};
      }),
    };
    await expect(
      uploadFile({
        client: emptyChunkClient as unknown as UploadClient,
        file: blobOf(8),
        destDir: "/",
        uploadKey: "empty-chunk",
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({ message: "Upload failed" });

    const completeClient = {
      initWithRetry: vi.fn(async () => initPayload({ ranges: [[0, 8]] })),
      sendChunk: vi.fn(),
      status: vi.fn(async () => ({ ranges: [[0, 8]] })),
      complete: vi.fn(async () => {
        throw new Error("complete broke");
      }),
    };
    await expect(
      uploadFile({
        client: completeClient as unknown as UploadClient,
        file: blobOf(8),
        destDir: "/",
        uploadKey: "complete-broke",
      }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("continues a failed pass when status returns no ranges", async () => {
    const client = {
      initWithRetry: vi.fn(async () => initPayload()),
      sendChunk: vi.fn(async () => {
        throw new UploadError("temporary", { status: 500, retryable: true });
      }),
      status: vi.fn(async () => ({})),
      complete: vi.fn(),
    };
    await expect(
      uploadFile({
        client: client as unknown as UploadClient,
        file: blobOf(8),
        destDir: "/",
        uploadKey: "status-no-ranges",
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("stops at the minimum window when a 413 cannot shrink", async () => {
    const { promise } = await startUpload({
      options: {
        chunkSize: 4,
        maxChunkBytes: 4,
        minChunkBytes: 4,
        maxAttempts: 1,
      },
    });
    FakeXHR.all[0]!.finish(413, "too large");
    await expect(promise).rejects.toMatchObject({ code: "CHUNK_TOO_LARGE" });
    expect(FakeXHR.all).toHaveLength(1);
  });

  it("fails a single transport without trying to rotate", async () => {
    const { promise } = await startUpload({
      options: { transports: ["binary_post"], maxAttempts: 1 },
    });
    FakeXHR.all[0]!.uploadError();
    await expect(promise).rejects.toMatchObject({ code: "TRANSPORT_DROPPED" });
    expect(FakeXHR.all).toHaveLength(1);
  });

  it("restarts a lost session into an already complete upload", async () => {
    let inits = 0;
    const client = {
      initWithRetry: vi.fn(async () => {
        inits += 1;
        return inits === 1
          ? initPayload()
          : { upload_id: "session", state: "complete" };
      }),
      sendChunk: vi.fn(async () => {
        throw new UploadError("lost", { code: "SESSION_LOST", retryable: true });
      }),
      status: vi.fn(async () => ({ ranges: [] })),
      complete: vi.fn(),
    };
    await expect(
      uploadFile({
        client: client as unknown as UploadClient,
        file: blobOf(8),
        destDir: "/",
        uploadKey: "restart-complete",
        maxAttempts: 1,
      }),
    ).resolves.toMatchObject({ ok: true, restarted: true, path: "upload" });
  });

  it("uses the upload name when completion returns no path", async () => {
    const client = {
      initWithRetry: vi.fn(async () => initPayload({ ranges: [[0, 8]] })),
      sendChunk: vi.fn(),
      status: vi.fn(async () => ({ ranges: [[0, 8]] })),
      complete: vi.fn(async () => ({ verified: true })),
    };
    await expect(
      uploadFile({
        client: client as unknown as UploadClient,
        file: blobOf(8),
        destDir: "/",
        uploadKey: "complete-no-path",
      }),
    ).resolves.toMatchObject({ ok: true, path: "upload" });
  });
});
