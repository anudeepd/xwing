import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadManager } from "../../xwing/frontend/src/upload-manager";

async function settle(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

afterEach(() => vi.unstubAllGlobals());

describe("UploadManager global scheduler", () => {
  it("preserves browser receivers for the native upload primitives", async () => {
    const fetcher = vi.fn(function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      const url = String(input);
      if (url === "/_upload/init") return Promise.resolve(new Response(JSON.stringify({ session_id: "native-fetch" }), { status: 200 }));
      if (url.endsWith("/complete")) return Promise.resolve(new Response(JSON.stringify({ path: "/native.txt" }), { status: 200 }));
      if (init?.method === "PUT") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response(null, { status: 201 }));
    });
    const requestFrame = vi.fn(function (this: unknown, callback: FrameRequestCallback): number {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      queueMicrotask(() => callback(0));
      return 1;
    });
    const cancelFrame = vi.fn(function (this: unknown): void {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const manager = new UploadManager();

    manager.add([new File(["works"], "native.txt")], "/", 5);
    manager.setParallel(2);

    await vi.waitFor(() => expect(manager.getSnapshot().items[0]?.status).toBe("completed"));
    expect(fetcher).toHaveBeenCalledWith("/_upload/init", expect.any(Object));
    expect(requestFrame).toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalled();
  });

  it("never exceeds the selected global chunk cap and rotates files", async () => {
    let session = 0;
    let active = 0;
    let maximum = 0;
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const frames: FrameRequestCallback[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/_upload/init") return new Response(JSON.stringify({ session_id: `s${++session}` }), { status: 200 });
      if (url.endsWith("/complete")) return new Response(JSON.stringify({ path: "done" }), { status: 200 });
      if (init?.method === "PUT") {
        active += 1; maximum = Math.max(maximum, active); started.push(url);
        await new Promise<void>(resolve => releases.push(resolve));
        active -= 1; return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 201 });
    });
    const manager = new UploadManager(fetcher as typeof fetch, callback => { frames.push(callback); return frames.length; }, vi.fn());
    manager.setParallel(2);
    manager.add([new File(["abcdef"], "a.txt"), new File(["ghijkl"], "b.txt")], "/", 2);
    await vi.waitFor(() => expect(maximum).toBe(2));
    expect(started).toHaveLength(2);
    expect(new Set(started.map(url => url.split("/")[2]))).toEqual(new Set(["s1", "s2"]));

    while (releases.length) { releases.shift()?.(); await settle(); }
    expect(maximum).toBe(2);
  });

  it("publishes terminal cancellation immediately", () => {
    const frames: FrameRequestCallback[] = [];
    const manager = new UploadManager(vi.fn(() => new Promise(() => {})) as typeof fetch, callback => { frames.push(callback); return frames.length; }, vi.fn());
    manager.add([new File(["abc"], "a.txt")], "/", 2);
    const item = manager.getSnapshot().items[0];
    expect(item).toBeDefined();
    manager.cancel(item!.id);
    expect(manager.getSnapshot().items[0]?.status).toBe("cancelled");
  });

  it("dismisses successful uploads without hiding failures", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/_upload/init") {
        const body = JSON.parse(String(init?.body)) as { filename: string };
        return new Response(JSON.stringify({ session_id: body.filename.startsWith("failed") ? "failed" : "successful" }), { status: 200 });
      }
      if (init?.method === "PUT") return new Response(null, { status: url.includes("/failed/") ? 400 : 204 });
      if (url.endsWith("/complete")) return new Response(JSON.stringify({ path: "/successful.txt" }), { status: 200 });
      return new Response(null, { status: 201 });
    });
    const manager = new UploadManager(fetcher as typeof fetch, callback => { callback(0); return 1; }, vi.fn());
    manager.setParallel(2);
    manager.add([new File(["ok"], "successful.txt"), new File(["no"], "failed.txt")], "/", 2);
    await vi.waitFor(() => expect(new Set(manager.getSnapshot().items.map(item => item.status))).toEqual(new Set(["completed", "failed"])));

    manager.dismissSuccessful();

    expect(manager.getSnapshot().items.map(item => item.status)).toEqual(["failed"]);
  });

  it("replays chunks after a failure so retry cannot skip data", async () => {
    let attempts = 0;
    const chunkIndexes: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/_upload/init") return new Response(JSON.stringify({ session_id: "retry-session" }), { status: 200 });
      if (url.endsWith("/complete")) return new Response(JSON.stringify({ path: "done" }), { status: 200 });
      if (init?.method === "PUT") {
        chunkIndexes.push(url.split("/").at(-1) ?? "");
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 400 : 204 });
      }
      return new Response(null, { status: 201 });
    });
    const manager = new UploadManager(fetcher as typeof fetch, callback => {
      callback(0);
      return 1;
    }, vi.fn());
    manager.setParallel(1);
    manager.add([new File(["abcd"], "a.txt")], "/", 2);
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]?.status).toBe("failed"));

    const id = manager.getSnapshot().items[0]!.id;
    manager.retry(id);
    await vi.waitFor(() => expect(manager.getSnapshot().items[0]?.status).toBe("completed"));
    expect(chunkIndexes).toEqual(["0", "0", "1"]);
  });
});
