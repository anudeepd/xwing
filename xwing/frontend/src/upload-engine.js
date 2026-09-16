/**
 * Chunked upload client shared by torrus and xwing.
 *
 * This file is vendored verbatim into both repositories; keep the two copies
 * byte-identical (the parity test pins the digest). It has no imports and no
 * framework dependency, so it drops into a Vite/React build and into plain
 * ESM alike.
 *
 * Why it is shaped this way:
 *
 * - Chunk size never scales with file size. A fixed window means a multi-GB
 *   file behaves exactly like a small one; the old "fileSize / 128, capped at
 *   64MB" rule gave the largest files the longest per-request wall time.
 * - There is no absolute per-request timeout. A request is abandoned only
 *   after `idleTimeoutMs` with *no byte movement*, so a DLP scanner
 *   (ForcePoint, Menlo, Zscaler) holding or inspecting a body produces an
 *   "processing" status instead of a killed upload. After the body is sent,
 *   `responseTimeoutMs` covers the server pushing bytes to the destination.
 * - The server is the source of truth. Every response carries committed byte
 *   ranges; a failed range is retried from whatever the server already holds,
 *   and its window halves on repeat failure instead of re-sending the whole
 *   chunk.
 */

export const UploadState = {
  PREPARING: 'preparing',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  FINALIZING: 'finalizing',
  DONE: 'done',
  ERROR: 'error',
};

export const DEFAULT_MIN_CHUNK_BYTES = 1 * 1024 * 1024;
// Matches the server's own ceiling: a window is one request, so the client is
// allowed to use the largest window the engine will advertise.
export const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_ATTEMPTS = 6;
/** Bounded re-plans when the server credits less than a whole window. */
export const MAX_PASSES = 4;
export const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SESSION_LOST_STATUSES = new Set([404, 409, 410]);

/**
 * Server-confirmed upload state. `ranges` are committed byte ranges as
 * `[[start, end], ...]`, which is what makes a resume possible.
 *
 * @typedef {object} UploadSessionInfo
 * @property {string} uploadId
 * @property {number} chunkSize
 * @property {number} concurrency
 * @property {number[][]} ranges
 * @property {number} size
 */

/**
 * @typedef {object} UploadCallbacks
 * @property {(state: string) => void} [onState] Phase changes, see `UploadState`.
 * @property {(committed: number, total: number) => void} [onProgress] Monotonic bytes.
 * @property {(session: UploadSessionInfo) => void} [onSession] Keep this to resume later.
 * @property {(retry: {attempt: number, code: string, message: string}) => void} [onRetry]
 */

/**
 * @typedef {object} PutHandlers
 * @property {number} [idleTimeoutMs] Abort only after this long with no byte movement.
 * @property {number} [responseTimeoutMs] Abort after the body is sent but unacknowledged.
 * @property {AbortSignal | null} [signal]
 * @property {(loaded: number, total: number) => void} [onProgress]
 * @property {(phase: string) => void} [onPhase]
 */

/**
 * @typedef {object} UploadFileOptions
 * @property {UploadClient} client
 * @property {Blob} file
 * @property {string | null} [filename] Defaults to `file.name`.
 * @property {string} [destDir]
 * @property {UploadSessionInfo | null} [session] Reuse to resume instead of restarting.
 * @property {number | null} [chunkSize]
 * @property {number | null} [concurrency]
 * @property {number} [minChunkBytes]
 * @property {number} [maxChunkBytes]
 * @property {number} [maxAttempts]
 * @property {number[]} [backoffMs]
 * @property {number} [idleTimeoutMs]
 * @property {number} [responseTimeoutMs]
 * @property {boolean} [restartOnSessionLoss]
 * @property {UploadCallbacks} [callbacks]
 * @property {AbortSignal | null} [signal]
 */

/** Sliding-window transfer speed in bytes per second. */
export class SpeedTracker {
  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  sample(bytes) {
    const now = Date.now();
    this.samples.push({ t: now, b: bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  speed() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsed = (last.t - first.t) / 1000;
    if (elapsed <= 0) return 0;
    return Math.max(0, (last.b - first.b) / elapsed);
  }
}

/**
 * Gaps in `[0, size)` given server-reported `[[start, end], ...]` ranges.
 *
 * @param {number[][] | null | undefined} ranges
 * @param {number} size
 * @returns {number[][]}
 */
export function missingRanges(ranges, size) {
  const spans = (ranges || [])
    .map(([start, end]) => [Number(start), Number(end)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start > cursor) gaps.push([cursor, Math.min(start, size)]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < size) gaps.push([cursor, size]);
  return gaps.filter(([start, end]) => end > start);
}

/**
 * Split gaps into windows no larger than `chunkSize`.
 *
 * @param {number[][] | null | undefined} ranges
 * @param {number} size
 * @param {number} chunkSize
 * @returns {number[][]}
 */
export function planWindows(ranges, size, chunkSize) {
  const windows = [];
  for (const [start, end] of missingRanges(ranges, size)) {
    let offset = start;
    while (offset < end) {
      const next = Math.min(offset + chunkSize, end);
      windows.push([offset, next]);
      offset = next;
    }
  }
  return windows;
}

/**
 * Total committed bytes across server-reported ranges.
 *
 * @param {number[][] | null | undefined} ranges
 * @returns {number}
 */
export function committedBytes(ranges) {
  return (ranges || []).reduce(
    (total, [start, end]) => total + Math.max(0, Number(end) - Number(start)),
    0,
  );
}

export class UploadError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, retryable?: boolean}} [options]
   */
  constructor(message, { status = 0, code = 'UPLOAD_FAILED', retryable = false } = {}) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Normalise the server's error envelope into an `UploadError`.
 *
 * @param {number} status
 * @param {any} payload
 * @param {string} [fallback]
 * @returns {UploadError}
 */
export function errorFromResponse(status, payload, fallback) {
  const code = (payload && payload.code) || '';
  const message = (payload && (payload.message || payload.detail)) || fallback || `Upload failed (${status})`;
  if (SESSION_LOST_STATUSES.has(status) && code !== 'UPLOAD_INCOMPLETE') {
    return new UploadError(message, { status, code: 'SESSION_LOST', retryable: true });
  }
  const retryable =
    RETRYABLE_STATUSES.has(status) ||
    ['CONNECTION_CLOSED', 'TRANSFER_FAILED', 'SINK_ERROR'].includes(code);
  return new UploadError(message, { status, code: code || 'UPLOAD_FAILED', retryable });
}

/**
 * HTTP client for the shared upload protocol.
 *
 * `fetchImpl` defaults to `fetch`; pass the application's authenticated fetch
 * when one exists.
 */
export class UploadClient {
  /**
   * @param {{base?: string, params?: Record<string, string> | null, fetchImpl?: typeof fetch | null, signal?: AbortSignal | null}} [options]
   * @param options.params Query parameters appended to every request, e.g. the
   *   `session_id`/`tab_id` pair a tab-scoped server needs.
   */
  constructor({ base = '/_upload', params = null, fetchImpl = null, signal = null } = {}) {
    this.base = base.replace(/\/$/, '');
    this.params = params || null;
    this.fetchImpl = fetchImpl || ((url, options) => fetch(url, options));
    this.signal = signal;
  }

  /** Request URL for `path`, carrying any client-wide query parameters. */
  url(path, extra = null) {
    const search = new URLSearchParams(this.params || undefined);
    if (extra) {
      for (const [key, value] of Object.entries(extra)) search.set(key, String(value));
    }
    const query = search.toString();
    return `${this.base}${path}${query ? `?${query}` : ''}`;
  }

  _requestOptions(options = {}) {
    const merged = { ...options };
    const signal = merged.signal || this.signal;
    if (signal) merged.signal = signal;
    return merged;
  }

  /**
   * @param {object} body `{filename, size, dir}`
   * @returns {Promise<any>}
   */
  async initWithRetry(body) {
    const response = await this.fetchImpl(
      this.url('/init'),
      this._requestOptions({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* Non-JSON error body: fall back to the status text. */
      }
      throw errorFromResponse(response.status, payload);
    }
    return response.json();
  }

  async status(uploadId) {
    const response = await this.fetchImpl(
      this.url(`/${encodeURIComponent(uploadId)}`),
      this._requestOptions({ method: 'GET' }),
    );
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* Non-JSON error body: fall back to the status text. */
      }
      throw errorFromResponse(response.status, payload);
    }
    return response.json();
  }

  async complete(uploadId) {
    const response = await this.fetchImpl(
      this.url(`/${encodeURIComponent(uploadId)}/complete`),
      this._requestOptions({ method: 'POST' }),
    );
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* Non-JSON error body: fall back to the status text. */
      }
      throw errorFromResponse(response.status, payload);
    }
    return response.json();
  }

  async cancel(uploadId) {
    try {
      await this.fetchImpl(
        this.url(`/${encodeURIComponent(uploadId)}`),
        this._requestOptions({ method: 'DELETE' }),
      );
    } catch {
      /* Cancellation is best effort. */
    }
  }

  /**
   * Send one byte window. Resolves with the server's committed ranges.
   *
   * `handlers.onProgress(loaded)` fires as the body drains.
   * `handlers.onPhase('uploading'|'processing')` distinguishes "bytes are
   * moving" from "bytes are sent, waiting for the server" so the UI can show
   * a DLP scan without pretending the transfer is broken.
   *
   * @param {string} uploadId
   * @param {number} offset
   * @param {Blob} blob
   * @param {PutHandlers} [handlers]
   * @returns {Promise<any>}
   */
  put(uploadId, offset, blob, handlers = {}) {
    const { idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS, signal = null } = handlers;
    const url = this.url(`/${encodeURIComponent(uploadId)}`, { offset });

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let idleTimer = null;
      let responseTimer = null;
      let settled = false;
      let bodySent = false;
      let phase = UploadState.UPLOADING;

      const clearTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (responseTimer) clearTimeout(responseTimer);
        idleTimer = null;
        responseTimer = null;
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };

      // Settle the promise before aborting: `xhr.abort()` fires its event
      // asynchronously, and the reason must not depend on that ordering.
      const failWith = error => {
        finish(reject, error);
        try {
          xhr.abort();
        } catch {
          /* already finished */
        }
      };

      const onAbort = () => failWith(new UploadError('Upload cancelled', { code: 'ABORTED' }));

      const setPhase = next => {
        if (phase === next) return;
        phase = next;
        handlers.onPhase?.(next);
      };

      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          failWith(
            new UploadError(`Upload stalled: no data moved for ${idleTimeoutMs / 1000}s`, {
              code: 'STALLED',
              retryable: true,
            }),
          );
        }, idleTimeoutMs);
      };

      const armResponseTimer = () => {
        if (responseTimer) clearTimeout(responseTimer);
        responseTimer = setTimeout(() => {
          failWith(
            new UploadError(`Server did not acknowledge within ${responseTimeoutMs / 1000}s`, {
              code: 'RESPONSE_TIMEOUT',
              retryable: true,
            }),
          );
        }, responseTimeoutMs);
      };

      xhr.open('PUT', url, true);
      xhr.withCredentials = false;

      xhr.upload.addEventListener('loadstart', () => {
        armIdleTimer();
      });
      xhr.upload.addEventListener('progress', event => {
        handlers.onProgress?.(event.loaded, blob.size);
        armIdleTimer();
      });
      xhr.upload.addEventListener('load', () => {
        bodySent = true;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        handlers.onProgress?.(blob.size, blob.size);
        setPhase(UploadState.PROCESSING);
        armResponseTimer();
      });
      xhr.upload.addEventListener('error', () => {
        finish(reject, new UploadError('Upload connection failed', { code: 'NETWORK', retryable: true }));
      });
      xhr.addEventListener('abort', () => {
        finish(reject, new UploadError('Upload aborted', { code: 'ABORTED', retryable: !bodySent }));
      });
      xhr.addEventListener('error', () => {
        finish(reject, new UploadError('Upload connection failed', { code: 'NETWORK', retryable: true }));
      });
      xhr.addEventListener('timeout', () => {
        finish(reject, new UploadError('Upload timed out', { code: 'TIMEOUT', retryable: true }));
      });
      xhr.addEventListener('load', () => {
        let payload = null;
        let parsed = false;
        try {
          payload = JSON.parse(xhr.responseText);
          parsed = true;
        } catch {
          /* Not our envelope; `parsed` stays false. */
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          if (!parsed || payload === null || typeof payload !== 'object') {
            // A 2xx that is not our JSON envelope usually means an
            // authentication redirect was followed. Never treat it as success.
            finish(
              reject,
              new UploadError('Server returned an unexpected response', {
                status: xhr.status,
                code: 'BAD_RESPONSE',
              }),
            );
            return;
          }
          finish(resolve, payload);
          return;
        }
        finish(reject, errorFromResponse(xhr.status, payload));
      });

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      setPhase(UploadState.UPLOADING);
      xhr.send(blob);
    });
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new UploadError('Upload cancelled', { code: 'ABORTED' }));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new UploadError('Upload cancelled', { code: 'ABORTED' }));
    }
    if (signal) signal.addEventListener('abort', onAbort);
  });
}

function clampChunkSize(value, min, max) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CHUNK_BYTES;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Upload one blob through the shared protocol.
 *
 * Returns `{ok, path, bytes, uploadId, restarted}`. Progress and phase changes
 * arrive through `callbacks`:
 *   `onState(state)`               - see `UploadState`
 *   `onProgress(committed, total)` - committed bytes, monotonic per attempt span
 *   `onSession(info)`              - fired on init so the caller can persist it
 */
/**
 * @param {UploadFileOptions} options
 * @returns {Promise<{ok: boolean, path: string, bytes: number, uploadId: string, restarted: boolean}>}
 */
export async function uploadFile({
  client,
  file,
  filename = null,
  destDir = '/',
  session = null,
  chunkSize = null,
  concurrency = null,
  minChunkBytes = DEFAULT_MIN_CHUNK_BYTES,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  restartOnSessionLoss = true,
  callbacks = {},
  signal = null,
}) {
  const size = file.size;
  const name = filename || file.name;
  let info = session && session.uploadId ? session : null;
  let restarted = false;
  let restartUsed = false;

  const setState = state => callbacks.onState?.(state);
  let highWater = 0;
  const reportProgress = (ranges, inFlight) => {
    if (!callbacks.onProgress) return;
    const committed = committedBytes(ranges) + (inFlight || 0);
    highWater = Math.max(highWater, Math.min(size, committed));
    callbacks.onProgress(highWater, size);
  };
  // Emitted on init and after every accepted request so the caller can keep
  // the session for a later resume instead of starting over.
  const publishSession = () => {
    callbacks.onSession?.({
      uploadId: info.uploadId,
      chunkSize: windowSize,
      concurrency: workers,
      ranges,
      size,
    });
  };

  const initSession = async () => {
    const created = await client.initWithRetry({
      filename: name,
      size,
      dir: destDir,
    });
    info = {
      uploadId: created.upload_id,
      chunkSize: created.chunk_size,
      concurrency: created.concurrency,
      ranges: Array.isArray(created.ranges) ? created.ranges : [],
      size: created.size,
    };
    return info;
  };

  setState(UploadState.PREPARING);
  if (!info) await initSession();
  let ranges = Array.isArray(info.ranges) ? info.ranges : [];
  const windowSize = clampChunkSize(
    chunkSize || info.chunkSize || DEFAULT_CHUNK_BYTES,
    minChunkBytes,
    maxChunkBytes,
  );
  const workers = Math.max(1, concurrency || info.concurrency || DEFAULT_CONCURRENCY);
  publishSession();

  let queue = planWindows(ranges, size, windowSize);
  let nextIndex = 0;
  const inFlight = new Map();

  const reportInFlight = () => {
    let total = 0;
    for (const loaded of inFlight.values()) total += loaded;
    reportProgress(ranges, total);
  };

  // A lost session means the server dropped every staged byte, so the whole
  // file restarts from zero. Allowed once: a second loss is a real failure.
  const handleSessionLoss = async () => {
    if (!restartOnSessionLoss || restartUsed) return false;
    restartUsed = true;
    restarted = true;
    await initSession();
    ranges = [];
    queue = planWindows(ranges, size, windowSize);
    highWater = 0;
    return true;
  };

  const runWindow = async (start, end) => {
    let windowStart = start;
    let windowEnd = end;
    let tries = 0;
    for (;;) {
      if (signal && signal.aborted) throw new UploadError('Upload cancelled', { code: 'ABORTED' });
      const key = `${windowStart}-${windowEnd}-${tries}`;
      try {
        const result = await client.put(
          info.uploadId,
          windowStart,
          file.slice(windowStart, windowEnd),
          {
            idleTimeoutMs,
            responseTimeoutMs,
            signal,
            onProgress: loaded => {
              inFlight.set(key, Math.min(loaded, windowEnd - windowStart));
              reportInFlight();
            },
            onPhase: phase => {
              if (phase === UploadState.PROCESSING) setState(UploadState.PROCESSING);
              else setState(UploadState.UPLOADING);
            },
          },
        );
        inFlight.delete(key);
        if (Array.isArray(result.ranges)) {
          ranges = result.ranges;
        } else {
          ranges.push([windowStart, windowStart + (result.received || windowEnd - windowStart)]);
        }
        publishSession();
        reportInFlight();
        return true;
      } catch (error) {
        inFlight.delete(key);
        reportInFlight();
        const uploadError =
          error instanceof UploadError
            ? error
            : new UploadError(error?.message || 'Upload failed', { retryable: true });
        if (uploadError.code === 'SESSION_LOST' || uploadError.code === 'ABORTED') {
          throw uploadError;
        }
        tries += 1;
        if (!uploadError.retryable || tries >= maxAttempts) throw uploadError;
        if (tries % 2 === 0) {
          const length = Math.max(minChunkBytes, Math.floor((windowEnd - windowStart) / 2));
          windowEnd = Math.min(windowEnd, windowStart + length);
        }
        callbacks.onRetry?.({
          attempt: tries,
          code: uploadError.code,
          message: uploadError.message,
        });
        setState(UploadState.UPLOADING);
        await sleep(backoffMs[Math.min(tries - 1, backoffMs.length - 1)], signal);
      }
    }
  };

  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      if (index >= queue.length) return;
      nextIndex += 1;
      const [start, end] = queue[index];
      await runWindow(start, end);
    }
  };

  const completeWithRetries = async () => {
    let attempts = 0;
    for (;;) {
      try {
        return await client.complete(info.uploadId);
      } catch (error) {
        const uploadError =
          error instanceof UploadError ? error : new UploadError(String(error), {});
        attempts += 1;
        if (
          uploadError.code === 'SESSION_LOST' ||
          !uploadError.retryable ||
          attempts >= maxAttempts
        ) {
          throw uploadError;
        }
        await sleep(backoffMs[Math.min(attempts - 1, backoffMs.length - 1)], signal);
        setState(UploadState.FINALIZING);
      }
    }
  };

  /**
   * Upload every byte the server is still missing.
   *
   * A pass re-plans from the server's committed ranges, so a response that
   * credits only part of a window is caught and the remainder is resent rather
   * than silently completing a short file.
   */
  const runPasses = async () => {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      queue = planWindows(ranges, size, windowSize);
      if (queue.length === 0) return;
      nextIndex = 0;
      setState(UploadState.UPLOADING);
      await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, worker));
      if (missingRanges(ranges, size).length === 0) return;
      callbacks.onRetry?.({
        attempt: pass + 2,
        code: 'INCOMPLETE',
        message: 'Server did not accept every byte',
      });
    }
    throw new UploadError('Server never accepted every byte of the upload', {
      code: 'INCOMPLETE',
    });
  };

  const runEverything = async () => {
    await runPasses();
    setState(UploadState.FINALIZING);
    return completeWithRetries();
  };

  try {
    let result;
    try {
      result = await runEverything();
    } catch (error) {
      const uploadError =
        error instanceof UploadError ? error : new UploadError(error?.message || 'Upload failed', {});
      if (uploadError.code !== 'SESSION_LOST' || !(await handleSessionLoss())) {
        throw uploadError;
      }
      result = await runEverything();
    }
    setState(UploadState.DONE);
    return {
      ok: true,
      path: result?.path ?? name,
      bytes: size,
      uploadId: info.uploadId,
      restarted,
    };
  } catch (error) {
    const uploadError =
      error instanceof UploadError ? error : new UploadError(error?.message || 'Upload failed', {});
    if (uploadError.code !== 'ABORTED') {
      // Re-anchor the caller's progress bar on what the server actually holds
      // so a failed upload can be retried from the right offset.
      const status = await client.status(info.uploadId).catch(() => null);
      if (status) reportProgress(status.ranges || ranges, 0);
    }
    setState(UploadState.ERROR);
    throw uploadError;
  }
}
