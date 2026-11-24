import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UploadClient,
  UploadError,
  UploadState,
  committedBytes,
  missingRanges,
  planWindows,
  uploadFile,
} from "../../xwing/frontend/src/upload-engine";

interface ProgressLike {
  loaded: number;
  total?: number;
}

class FakeXHR {
  static all: FakeXHR[] = [];

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
});

describe("uploadFile", () => {
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
});
