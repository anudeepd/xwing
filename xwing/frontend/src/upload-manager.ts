import type { Parallelism } from "./types";
import { SpeedTracker, UploadClient, UploadState, uploadFile } from "./upload-engine";

export type UploadStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Server-side phase of the current request, so the panel can say what the
 * transfer is actually doing. `processing` is the state a DLP scanner
 * (ForcePoint, Menlo) produces: the browser finished sending the body and the
 * server has not answered yet. It is not a failure.
 */
export type UploadPhase = "uploading" | "processing" | "finalizing";

/** A file plus the folder path it was dropped under. */
export interface UploadCandidate {
  file: File;
  relativePath: string;
}

export interface UploadItem {
  id: string;
  name: string;
  relativePath: string;
  destination: string;
  size: number;
  uploaded: number;
  speed: number;
  status: UploadStatus;
  phase?: UploadPhase | undefined;
  error?: string | undefined;
}

interface UploadSession {
  uploadId: string;
  chunkSize: number;
  concurrency: number;
  ranges: number[][];
  size: number;
}

interface InternalItem extends UploadItem {
  file: File;
  controller: AbortController;
  tracker: SpeedTracker;
  chunkSize: number;
  /** Last server-confirmed session, reused so a retry resumes instead of restarting. */
  session?: UploadSession | undefined;
}

export interface UploadSnapshot {
  items: readonly UploadItem[];
  active: number;
  parallel: Parallelism;
}

type Fetch = typeof fetch;

function uploadId(): string {
  const timestamp = Date.now().toString(36);
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
    return `${timestamp}-${randomUUID.call(globalThis.crypto)}`;
  }
  return `${timestamp}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Schedules file uploads and exposes their progress to React.
 *
 * Chunking, retries, resume and request timeouts live in the shared upload
 * engine; this class owns the queue, the per-item state machine and the
 * snapshot the UI renders.
 */
export class UploadManager {
  private readonly items = new Map<string, InternalItem>();
  private readonly listeners = new Set<() => void>();
  private parallel: Parallelism = 4;
  private running = 0;
  private frame: number | null = null;
  private snapshot: UploadSnapshot = { items: [], active: 0, parallel: 4 };

  constructor(
    private readonly fetcher: Fetch = globalThis.fetch.bind(globalThis),
    private readonly requestFrame: (callback: FrameRequestCallback) => number = globalThis.requestAnimationFrame.bind(globalThis),
    private readonly cancelFrame: (handle: number) => void = globalThis.cancelAnimationFrame.bind(globalThis),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UploadSnapshot => this.snapshot;

  setParallel(value: Parallelism): void {
    this.parallel = value;
    this.flush(true);
  }

  add(files: Iterable<File | UploadCandidate>, destination: string, chunkSize: number): void {
    for (const candidate of files) {
      // Enterprise browser extensions (DLP, Menlo, ForcePoint) and other
      // content scripts can leave null or half-formed entries in a dropped
      // FileList. Reading `.name` off one would abort the whole drop, so skip
      // them instead.
      const file = candidate instanceof File ? candidate : candidate?.file;
      if (!file || typeof file.name !== "string") continue;
      const relativePath =
        (candidate instanceof File ? "" : candidate.relativePath) ||
        file.webkitRelativePath ||
        file.name;
      const id = uploadId();
      this.items.set(id, {
        id,
        name: file.name,
        relativePath,
        size: file.size,
        uploaded: 0,
        speed: 0,
        status: "queued",
        file,
        destination,
        controller: new AbortController(),
        tracker: new SpeedTracker(5000),
        chunkSize,
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
    item.speed = 0;
    this.flush(true);
  }

  retry(id: string): void {
    const item = this.items.get(id);
    if (!item || (item.status !== "failed" && item.status !== "cancelled")) return;
    item.controller = new AbortController();
    item.error = undefined;
    item.speed = 0;
    item.status = "queued";
    this.flush(true);
    void this.prepareQueued();
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
    await Promise.all(queued.map(item => this.run(item)));
  }

  /**
   * Concurrency budget for one file: the operator's parallel setting is a cap
   * on *total* in-flight requests, split across the files running right now.
   * One file alone gets the whole budget; four files get a quarter each.
   */
  private concurrencyForFile(): number {
    return Math.max(1, Math.floor(this.parallel / Math.max(1, this.running)));
  }

  private async run(item: InternalItem): Promise<void> {
    item.status = "preparing";
    this.flush();
    this.running += 1;
    try {
      const directoryParts = item.relativePath.split("/").slice(0, -1);
      const destination = directoryParts.length
        ? `${item.destination.replace(/\/$/, "")}/${directoryParts.join("/")}`
        : item.destination;
      await this.ensureDirectories(destination, item.destination, item.controller.signal);

      const client = new UploadClient({
        fetchImpl: this.fetcher,
        signal: item.controller.signal,
      });
      await uploadFile({
        client,
        file: item.file,
        destDir: destination,
        session: item.session ?? null,
        chunkSize: item.chunkSize,
        concurrency: this.concurrencyForFile(),
        signal: item.controller.signal,
        callbacks: {
          onState: (state: string) => this.applyState(item, state),
          onProgress: (committed: number) => {
            item.uploaded = committed;
            item.tracker.sample(committed);
            item.speed = item.tracker.speed();
            this.flush();
          },
          onSession: (session: UploadSession) => {
            item.session = session;
          },
          onRetry: () => {
            item.status = "retrying";
            this.flush(true);
          },
        },
      });
      item.status = "completed";
      item.uploaded = item.size;
      item.speed = 0;
      item.phase = undefined;
      item.session = undefined;
    } catch (error) {
      if (item.controller.signal.aborted) {
        item.status = "cancelled";
      } else {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : "Upload failed";
      }
      item.speed = 0;
      item.phase = undefined;
    } finally {
      this.running -= 1;
    }
    this.flush(true);
  }

  private applyState(item: InternalItem, state: string): void {
    if (state === UploadState.UPLOADING) {
      item.status = "uploading";
      item.phase = "uploading";
    } else if (state === UploadState.PROCESSING) {
      item.status = "uploading";
      item.phase = "processing";
    } else if (state === UploadState.FINALIZING) {
      item.phase = "finalizing";
    }
    this.flush();
  }

  private async ensureDirectories(path: string, base: string, signal: AbortSignal): Promise<void> {
    const baseSegments = base.split("/").filter(Boolean);
    const segments = path.split("/").filter(Boolean);
    for (let index = baseSegments.length; index < segments.length; index += 1) {
      const target = `/${segments.slice(0, index + 1).map(encodeURIComponent).join("/")}/`;
      const response = await this.fetcher(target, { method: "MKCOL", signal });
      if (!response.ok && response.status !== 405) {
        throw new Error(`Could not create folder (${response.status})`);
      }
    }
  }

  private flush(immediate = false): void {
    if (immediate) {
      if (this.frame !== null) {
        this.cancelFrame(this.frame);
        this.frame = null;
      }
      this.publish();
      return;
    }
    if (this.frame !== null) return;
    this.frame = this.requestFrame(() => {
      this.frame = null;
      this.publish();
    });
  }

  private publish(): void {
    const items: UploadItem[] = [...this.items.values()].map(item => {
      const published: UploadItem = {
        id: item.id,
        name: item.name,
        relativePath: item.relativePath,
        destination: item.destination,
        size: item.size,
        uploaded: item.uploaded,
        speed: item.speed,
        status: item.status,
      };
      if (item.phase !== undefined) published.phase = item.phase;
      if (item.error !== undefined) published.error = item.error;
      return published;
    });
    this.snapshot = {
      items,
      active: items.filter(item =>
        ["queued", "preparing", "uploading", "retrying"].includes(item.status),
      ).length,
      parallel: this.parallel,
    };
    for (const listener of this.listeners) listener();
  }
}
