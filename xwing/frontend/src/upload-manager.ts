import type { Parallelism } from "./types";
import {
  SpeedTracker,
  UploadClient,
  UploadState,
  newUploadKey,
  uploadFile,
} from "./upload-engine";
import {
  clearResumeSession,
  loadResumeSession,
  saveResumeSession,
} from "./upload-resume";
import { noteAuthActivity } from "./shared.js";

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
  transport?: string | undefined;
  protocol?: string | undefined;
}

interface UploadSession {
  uploadId: string;
  uploadKey?: string;
  chunkSize: number;
  concurrency: number;
  ranges: number[][];
  size: number;
  transport?: string | null | undefined;
}

interface InternalItem extends UploadItem {
  file: File;
  controller: AbortController;
  tracker: SpeedTracker;
  chunkSize: number;
  uploadKey: string;
  fingerprint: { name: string; size: number; last_modified: number };
  resumeDestination: string;
  lastDiagnostic?: Record<string, unknown> | undefined;
  /** Last server-confirmed session, reused so a retry resumes instead of restarting. */
  session?: UploadSession | undefined;
}

export interface UploadSnapshot {
  items: readonly UploadItem[];
  active: number;
  parallel: Parallelism;
}

type Fetch = typeof fetch;

let fallbackUploadId = 0;

function uploadId(): string {
  const timestamp = Date.now().toString(36);
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto && typeof crypto.randomUUID === "function") {
    return `${timestamp}-${crypto.randomUUID()}`;
  }
  if (crypto && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const suffix = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${timestamp}-${suffix}`;
  }
  fallbackUploadId += 1;
  return `${timestamp}-${fallbackUploadId.toString(36)}`;
}

function fileFromCandidate(candidate: File | UploadCandidate): File | null {
  const direct = candidate as File;
  if (
    direct &&
    typeof direct.name === "string" &&
    typeof direct.size === "number" &&
    typeof direct.slice === "function"
  ) {
    return direct;
  }
  const nested = (candidate as UploadCandidate)?.file;
  if (
    nested &&
    typeof nested.name === "string" &&
    typeof nested.size === "number" &&
    typeof nested.slice === "function"
  ) {
    return nested;
  }
  return null;
}

/**
 * Schedules file uploads and exposes their progress to React.
 *
 * Chunking, retries, resume and request timeouts live in the upload engine;
 * this class owns the queue, the per-item state machine and the snapshot the
 * UI renders.
 */
export class UploadManager {
  private readonly items = new Map<string, InternalItem>();
  private readonly listeners = new Set<() => void>();
  private parallel: Parallelism = 2;
  private running = 0;
  private frame: number | null = null;
  private snapshot: UploadSnapshot = { items: [], active: 0, parallel: 2 };

  constructor(
    private readonly fetcher: Fetch = globalThis.fetch.bind(globalThis),
    private readonly requestFrame: (callback: FrameRequestCallback) => number = globalThis.requestAnimationFrame.bind(globalThis),
    private readonly cancelFrame: (handle: number) => void = globalThis.cancelAnimationFrame.bind(globalThis),
    private readonly storage: Storage | null | undefined = undefined,
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
      const file = fileFromCandidate(candidate);
      if (!file) continue;
      const relativePath =
        (candidate === file ? "" : (candidate as UploadCandidate).relativePath) ||
        file.webkitRelativePath ||
        file.name;
      const finalDestination = this.destinationFor(relativePath, destination);
      if (
        [...this.items.values()].some(
          item =>
            item.resumeDestination === finalDestination &&
            item.name === file.name &&
            item.size === file.size &&
            !["completed", "cancelled"].includes(item.status),
        )
      ) {
        continue;
      }
      const resume = loadResumeSession(file, finalDestination, this.storage);
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
        resumeDestination: finalDestination,
        controller: new AbortController(),
        tracker: new SpeedTracker(5000),
        chunkSize,
        uploadKey: resume?.uploadKey ?? newUploadKey(),
        fingerprint: {
          name: file.name,
          size: file.size,
          last_modified: Number(file.lastModified || 0),
        },
        ...(resume
          ? {
              session: {
                uploadId: resume.uploadId,
                uploadKey: resume.uploadKey,
                chunkSize: resume.chunkSize,
                concurrency: resume.concurrency,
                ranges: resume.ranges,
                size: resume.size,
                transport: resume.transport,
              },
            }
          : {}),
      });
    }
    noteAuthActivity();
    this.flush(true);
    void this.prepareQueued();
  }

  cancel(id: string): void {
    const item = this.items.get(id);
    if (!item || item.status === "completed") return;
    item.controller.abort();
    if (item.session?.uploadId) {
      void new UploadClient({ fetchImpl: this.fetcher }).cancel(item.session.uploadId);
    }
    clearResumeSession(item.file, item.resumeDestination, this.storage);
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
    item.phase = undefined;
    item.status = "queued";
    this.flush(true);
    void this.prepareQueued();
  }

  dismissCompleted(): void {
    this.items.forEach((item, id) => {
      if (item.status === "completed" || item.status === "cancelled") this.items.delete(id);
    });
    this.flush(true);
  }

  dismissSuccessful(): void {
    this.items.forEach((item, id) => {
      if (item.status === "completed") this.items.delete(id);
    });
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
      const destination = this.destinationFor(item.relativePath, item.destination);
      await this.ensureDirectories(destination, item.destination, item.controller.signal);

      // The client only builds paths under the app's own /_upload route. The
      // server's upload id is URL-encoded before it is appended.
      const client = new UploadClient({
        fetchImpl: this.fetcher,
        signal: item.controller.signal,
      });
      await uploadFile({
        client,
        file: item.file,
        destDir: destination,
        session: item.session ?? null,
        uploadKey: item.uploadKey,
        fingerprint: item.fingerprint,
        chunkSize: item.chunkSize,
        concurrency: this.concurrencyForFile(),
        signal: item.controller.signal,
        callbacks: {
          onState: (state: string) => {
            noteAuthActivity();
            this.applyState(item, state);
          },
          onProgress: (committed: number) => {
            noteAuthActivity();
            item.uploaded = committed;
            item.tracker.sample(committed);
            item.speed = item.tracker.speed();
            this.flush();
          },
          onSession: (session: UploadSession) => {
            session.uploadKey = item.uploadKey;
            item.session = session;
            saveResumeSession(item.file, item.resumeDestination, {
              uploadKey: item.uploadKey,
              uploadId: session.uploadId,
              ranges: session.ranges,
              chunkSize: session.chunkSize,
              concurrency: session.concurrency,
              size: session.size,
              transport: session.transport ?? null,
            }, this.storage);
          },
          onRetry: (retry: { code: string; message: string; transport?: string | null }) => {
            noteAuthActivity();
            item.status = "retrying";
            if (retry.transport) item.transport = retry.transport;
            this.flush(true);
          },
          onDiagnostic: (report: Record<string, unknown>) => {
            item.lastDiagnostic = report;
            if (typeof report.transport === "string") item.transport = report.transport;
            if (typeof report.protocol === "string") item.protocol = report.protocol;
          },
        },
      });
      item.status = "completed";
      item.uploaded = item.size;
      item.speed = 0;
      item.phase = undefined;
      item.session = undefined;
      clearResumeSession(item.file, item.resumeDestination, this.storage);
      this.reportDiagnostics(item, "success");
    } catch (error) {
      if (item.controller.signal.aborted) {
        item.status = "cancelled";
        clearResumeSession(item.file, item.resumeDestination, this.storage);
      } else {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : "Upload failed";
        this.reportDiagnostics(item, "failed");
      }
      item.speed = 0;
      item.phase = undefined;
    } finally {
      this.running -= 1;
    }
    this.flush(true);
  }

  private destinationFor(relativePath: string, base: string): string {
    const directoryParts = relativePath.split("/").slice(0, -1);
    return directoryParts.length
      ? `${base.replace(/\/$/, "")}/${directoryParts.join("/")}`
      : base;
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
      const response = await this.fetchWithRetry(target, { method: "MKCOL", signal });
      if (!response.ok && response.status !== 405) {
        throw new Error(`Could not create folder (${response.status})`);
      }
      noteAuthActivity();
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    attempts = 3,
  ): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.fetcher(url, init);
      } catch (error) {
        lastError = error;
        if (init.signal?.aborted || attempt >= attempts) break;
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Could not reach the server");
  }

  private reportDiagnostics(item: InternalItem, event: string): void {
    const report = item.lastDiagnostic;
    if (!report) return;
    const payload = JSON.stringify({
      ...report,
      event,
      filename: item.relativePath,
      size: item.size,
      upload_id: item.session?.uploadId ?? report.upload_id ?? null,
      transport: item.transport ?? report.transport ?? null,
      protocol: item.protocol ?? report.protocol ?? null,
    });
    void this.fetcher("/_upload/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    }).catch(() => {
      /* Diagnostics must never change the upload result. */
    });
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
      if (item.transport !== undefined) published.transport = item.transport;
      if (item.protocol !== undefined) published.protocol = item.protocol;
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
