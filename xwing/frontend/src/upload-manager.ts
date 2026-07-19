import type { Parallelism } from "./types";

const RETRY_DELAYS = [750, 1500, 3000] as const;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export type UploadStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export interface UploadItem {
  id: string;
  name: string;
  relativePath: string;
  destination: string;
  size: number;
  uploaded: number;
  status: UploadStatus;
  error?: string | undefined;
}

interface InternalItem extends UploadItem {
  file: File;
  sessionId?: string;
  chunkSize: number;
  chunkCount: number;
  nextChunk: number;
  completedChunks: Set<number>;
  controller: AbortController;
}

export interface UploadSnapshot {
  items: readonly UploadItem[];
  active: number;
  parallel: Parallelism;
}

type Fetch = typeof fetch;

export class UploadManager {
  private readonly items = new Map<string, InternalItem>();
  private readonly listeners = new Set<() => void>();
  private active = 0;
  private parallel: Parallelism = 4;
  private cursor = 0;
  private frame: number | null = null;
  private snapshot: UploadSnapshot = { items: [], active: 0, parallel: 4 };

  constructor(
    private readonly fetcher: Fetch = globalThis.fetch.bind(globalThis),
    private readonly requestFrame: (callback: FrameRequestCallback) => number = globalThis.requestAnimationFrame.bind(globalThis),
    private readonly cancelFrame: (handle: number) => void = globalThis.cancelAnimationFrame.bind(globalThis),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UploadSnapshot => this.snapshot;

  setParallel(value: Parallelism): void {
    this.parallel = value;
    this.flush(true);
    this.pump();
  }

  add(files: Iterable<File>, destination: string, chunkSize: number): void {
    for (const file of files) {
      const relativePath = file.webkitRelativePath || file.name;
      const id = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
      this.items.set(id, {
        id,
        name: file.name,
        relativePath,
        size: file.size,
        uploaded: 0,
        status: "queued",
        file,
        destination,
        chunkSize: Math.max(1, chunkSize),
        chunkCount: Math.max(1, Math.ceil(file.size / Math.max(1, chunkSize))),
        nextChunk: 0,
        completedChunks: new Set(),
        controller: new AbortController(),
      });
    }
    this.flush(true);
    void this.prepareQueued();
  }

  cancel(id: string): void {
    const item = this.items.get(id);
    if (!item || item.status === "completed") return;
    item.controller.abort();
    item.status = "cancelled";
    this.flush(true);
    this.pump();
  }

  retry(id: string): void {
    const item = this.items.get(id);
    if (!item || (item.status !== "failed" && item.status !== "cancelled")) return;
    item.controller = new AbortController();
    item.error = undefined;
    // A failed request may have advanced the scheduler beyond its chunk. Start
    // over so every chunk is present before completion; duplicate PUTs are
    // idempotent server-side and this also recovers a failed completion call.
    item.nextChunk = 0;
    item.completedChunks.clear();
    item.uploaded = 0;
    item.status = item.sessionId ? "uploading" : "queued";
    this.flush(true);
    void this.prepareQueued();
    this.pump();
  }

  dismissCompleted(): void {
    for (const [id, item] of this.items) {
      if (item.status === "completed" || item.status === "cancelled") this.items.delete(id);
    }
    this.flush(true);
  }

  dismissSuccessful(): void {
    for (const [id, item] of this.items) {
      if (item.status === "completed") this.items.delete(id);
    }
    this.flush(true);
  }

  hasActive(): boolean {
    return [...this.items.values()].some(item =>
      ["queued", "preparing", "uploading", "retrying"].includes(item.status),
    );
  }

  private async prepareQueued(): Promise<void> {
    const queued = [...this.items.values()].filter(item => item.status === "queued");
    await Promise.all(queued.map(item => this.initialize(item)));
    this.pump();
  }

  private async initialize(item: InternalItem): Promise<void> {
    item.status = "preparing";
    this.flush();
    try {
      const directoryParts = item.relativePath.split("/").slice(0, -1);
      const destination = directoryParts.length
        ? `${item.destination.replace(/\/$/, "")}/${directoryParts.join("/")}`
        : item.destination;
      await this.ensureDirectories(destination, item.destination, item.controller.signal);
      const response = await this.fetcher("/_upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: item.name,
          total_chunks: item.chunkCount,
          chunk_size: item.chunkSize,
          dir: destination,
        }),
        signal: item.controller.signal,
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const data = (await response.json()) as { session_id?: string; ignored?: boolean };
      if (data.ignored) {
        item.status = "completed";
        item.uploaded = item.size;
      } else if (data.session_id) {
        item.sessionId = data.session_id;
        item.status = "uploading";
      } else {
        throw new Error("Upload session was not created");
      }
    } catch (error) {
      if (item.controller.signal.aborted) item.status = "cancelled";
      else {
        item.status = "failed";
        item.error = errorMessage(error);
      }
    }
    this.flush(true);
  }

  private async ensureDirectories(path: string, base: string, signal: AbortSignal): Promise<void> {
    const baseSegments = base.split("/").filter(Boolean);
    const segments = path.split("/").filter(Boolean);
    for (let index = baseSegments.length; index < segments.length; index += 1) {
      const target = `/${segments.slice(0, index + 1).map(encodeURIComponent).join("/")}/`;
      const response = await this.fetcher(target, { method: "MKCOL", signal });
      if (!response.ok && response.status !== 405) throw new Error(await responseMessage(response));
    }
  }

  private pump(): void {
    while (this.active < this.parallel) {
      const ready = [...this.items.values()].filter(
        item => item.status === "uploading" && item.nextChunk < item.chunkCount,
      );
      if (!ready.length) break;
      const item = ready[this.cursor % ready.length];
      if (!item) break;
      this.cursor += 1;
      const chunk = item.nextChunk++;
      this.active += 1;
      void this.sendChunk(item, chunk).finally(() => {
        this.active -= 1;
        this.flush(true);
        this.pump();
      });
    }
  }

  private async sendChunk(item: InternalItem, index: number): Promise<void> {
    if (!item.sessionId || item.controller.signal.aborted) return;
    const start = index * item.chunkSize;
    const end = Math.min(item.size, start + item.chunkSize);
    const body = item.file.slice(start, end);
    try {
      await retry(async () => {
        const response = await this.fetcher(`/_upload/${item.sessionId}/${index}`, {
          method: "PUT",
          body,
          signal: item.controller.signal,
        });
        if (!response.ok) {
          const error = new Error(await responseMessage(response)) as Error & { status?: number };
          error.status = response.status;
          throw error;
        }
      }, item);
      item.completedChunks.add(index);
      item.uploaded = Math.min(item.size, item.uploaded + body.size);
      this.flush();
      if (item.completedChunks.size === item.chunkCount) await this.complete(item);
    } catch (error) {
      if (item.controller.signal.aborted) item.status = "cancelled";
      else {
        item.status = "failed";
        item.error = errorMessage(error);
      }
      this.flush(true);
    }
  }

  private async complete(item: InternalItem): Promise<void> {
    if (!item.sessionId) return;
    try {
      const response = await this.fetcher(`/_upload/${item.sessionId}/complete`, {
        method: "POST",
        signal: item.controller.signal,
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      item.status = "completed";
      item.uploaded = item.size;
    } catch (error) {
      item.status = item.controller.signal.aborted ? "cancelled" : "failed";
      item.error = errorMessage(error);
    }
    this.flush(true);
  }

  private flush(immediate = false): void {
    const notify = () => {
      this.frame = null;
      this.snapshot = {
        items: [...this.items.values()].map(({ file: _file, controller: _controller, completedChunks: _chunks, ...item }) => ({ ...item })),
        active: this.active,
        parallel: this.parallel,
      };
      for (const listener of this.listeners) listener();
    };
    if (immediate) {
      if (this.frame !== null) this.cancelFrame(this.frame);
      notify();
    } else if (this.frame === null) {
      this.frame = this.requestFrame(notify);
    }
  }
}

async function retry(action: () => Promise<void>, item: InternalItem): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await action();
      item.status = "uploading";
      return;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (item.controller.signal.aborted || attempt >= RETRY_DELAYS.length || (status && !RETRYABLE.has(status))) throw error;
      item.status = "retrying";
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const value = (await response.json()) as { detail?: string };
    return value.detail || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Upload failed";
}
