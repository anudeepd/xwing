/**
 * Durable, checksum-verified upload client.
 *
 * The browser is the only component that can discover which request shape a
 * corporate proxy will pass. It starts with a real canary window, rotates
 * between typed binary POST, multipart POST and PUT when a request is dropped,
 * and locks in the transport that worked.
 *
 * Every chunk carries SHA-256. The server credits a range only after the body
 * matches. A failed request is retried from the server's committed ranges, so
 * duplicate data is harmless and a lost response does not lose bytes.
 */

import { sha256Blob } from './sha256.js';

export const UploadState = {
  PREPARING: 'preparing',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  FINALIZING: 'finalizing',
  DONE: 'done',
  ERROR: 'error',
};

export const TRANSPORTS = ['binary_post', 'multipart_post', 'binary_put'];

export const DEFAULT_MIN_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_INITIAL_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_CHUNK_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_IDLE_TIMEOUT_MS = 20_000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_ATTEMPTS = 6;
export const MAX_PASSES = 6;
export const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SESSION_LOST_STATUSES = new Set([404, 410]);
const RETRYABLE_CODES = new Set([
  'BAD_RESPONSE',
  'CHUNK_TOO_LARGE',
  'CLIENT_DISCONNECTED',
  'CONNECTION_CLOSED',
  'DIGEST_MISMATCH',
  'INIT_DROPPED',
  'LENGTH_MISMATCH',
  'NETWORK',
  'RESPONSE_TIMEOUT',
  'STALLED',
  'TRANSFER_FAILED',
  'TRANSPORT_DROPPED',
  'UPLOAD_INCOMPLETE',
  'WRITE_FAILED',
]);
let fallbackClientKey = 0;
const TRANSPORT_CODES = new Set([
  'BAD_RESPONSE',
  'NETWORK',
  'RESPONSE_TIMEOUT',
  'STALLED',
  'TRANSPORT_DROPPED',
]);

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

function windowCovered(ranges, start, end) {
  return (ranges || []).some(([left, right]) => {
    const spanStart = Number(left);
    const spanEnd = Number(right);
    return Number.isFinite(spanStart) && Number.isFinite(spanEnd)
      && spanStart <= start && spanEnd >= end;
  });
}

export class UploadError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, retryable?: boolean, transport?: string}} [options]
   */
  constructor(message, { status = 0, code = 'UPLOAD_FAILED', retryable = false, transport = null } = {}) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.transport = transport;
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
  const detail = payload?.detail;
  const nested = detail && typeof detail === 'object' ? detail : null;
  const code = String(nested?.code || payload?.code || '');
  const message =
    nested?.message ||
    payload?.message ||
    (typeof detail === 'string' ? detail : '') ||
    fallback ||
    `Upload failed (${status})`;

  if (status === 401) {
    return new UploadError(message, { status, code: 'AUTH_REQUIRED', retryable: false });
  }
  if (status === 403) {
    const auth = /authentication required|sign[ -]?in|log[ -]?in/i.test(message);
    return new UploadError(message, {
      status,
      code: auth ? 'AUTH_REQUIRED' : 'PERMISSION_DENIED',
      retryable: false,
    });
  }
  if (status === 413) {
    return new UploadError(message, { status, code: 'CHUNK_TOO_LARGE', retryable: true });
  }
  if (SESSION_LOST_STATUSES.has(status) || code === 'SESSION_LOST') {
    return new UploadError(message, { status, code: 'SESSION_LOST', retryable: true });
  }
  if (status === 400 && (code === 'UPLOAD_INCOMPLETE' || code === 'STAGED_FILE_TRUNCATED')) {
    return new UploadError(message, { status, code: code || 'UPLOAD_INCOMPLETE', retryable: true });
  }
  if (status === 409 && code !== 'UPLOAD_INCOMPLETE') {
    return new UploadError(message, { status, code: code || 'SESSION_LOST', retryable: true });
  }
  const retryable =
    RETRYABLE_STATUSES.has(status) ||
    RETRYABLE_CODES.has(code) ||
    status === 0;
  return new UploadError(message, { status, code: code || 'UPLOAD_FAILED', retryable });
}

function clampChunkSize(value, min, max) {
  const floor = Math.max(1, Math.floor(min));
  const ceiling = Math.max(floor, Math.floor(max));
  if (!Number.isFinite(value) || value <= 0) return floor;
  return Math.max(floor, Math.min(ceiling, Math.floor(value)));
}

function makeClientKey() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (crypto && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `k-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  fallbackClientKey += 1;
  return `k-${Date.now().toString(36)}-${fallbackClientKey.toString(36)}`;
}

export function newUploadKey() {
  return makeClientKey();
}

function normalizeTransports(values) {
  const allowed = new Set(TRANSPORTS);
  const filtered = Array.isArray(values) ? values.filter(value => allowed.has(value)) : [];
  return filtered.length ? filtered : [...TRANSPORTS];
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadError('Upload cancelled', { code: 'ABORTED' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new UploadError('Upload cancelled', { code: 'ABORTED' }));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffDelay(backoffMs, attempt) {
  const base = backoffMs[Math.min(Math.max(0, attempt - 1), backoffMs.length - 1)] ?? 0;
  const crypto = globalThis.crypto;
  const jitter = crypto && typeof crypto.getRandomValues === 'function'
    ? crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000
    : 0.5;
  return Math.max(0, Math.round(base * (0.5 + jitter * 0.5)));
}

function resourceProtocol(url) {
  try {
    const entries = performance.getEntriesByName(url, 'resource');
    const entry = entries.length ? entries[entries.length - 1] : null;
    return entry?.nextHopProtocol || null;
  } catch {
    return null;
  }
}

function parsePayload(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readResponseText(response) {
  if (typeof response.text === 'function') {
    try {
      return await response.text();
    } catch {
      /* A test or an exotic Response implementation may only expose json(). */
    }
  }
  if (typeof response.json === 'function') {
    try {
      return JSON.stringify(await response.json());
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * HTTP client for the upload protocol.
 */
export class UploadClient {
  /**
   * @param {{base?: string, params?: Record<string, string> | null, fetchImpl?: typeof fetch | null, signal?: AbortSignal | null}} [options]
   */
  constructor({ base = '/_upload', params = null, fetchImpl = null, signal = null } = {}) {
    this.base = base.replace(/\/$/, '');
    this.params = params || null;
    this.fetchImpl = fetchImpl || ((url, options) => fetch(url, options));
    this.signal = signal;
  }

  url(path, extra = null) {
    const search = new URLSearchParams(this.params || undefined);
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (value !== null && value !== undefined) search.set(key, String(value));
      }
    }
    const query = search.toString();
    return `${this.base}${path}${query ? `?${query}` : ''}`;
  }

  async _requestJson(path, init = {}, timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS) {
    if (this.signal?.aborted) {
      throw new UploadError('Upload cancelled', { code: 'ABORTED' });
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = this.signal
      ? AbortSignal.any([this.signal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await this.fetchImpl(this.url(path), {
        ...init,
        signal,
      });
      const text = await readResponseText(response);
      const payload = parsePayload(text);
      if (!response.ok) {
        throw errorFromResponse(
          response.status,
          payload,
          text ? text.slice(0, 300) : undefined,
        );
      }
      if (payload === null || typeof payload !== 'object') {
        throw new UploadError(
          'The server sent a page instead of an upload response. Sign in again or check the proxy.',
          { status: response.status, code: 'AUTH_REQUIRED', retryable: false },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof UploadError) throw error;
      if (this.signal?.aborted) {
        throw new UploadError('Upload cancelled', { code: 'ABORTED' });
      }
      if (timeoutSignal.aborted) {
        throw new UploadError('Upload setup timed out', {
          code: 'RESPONSE_TIMEOUT',
          retryable: true,
        });
      }
      throw new UploadError('Upload setup was blocked or the connection dropped', {
        code: 'INIT_DROPPED',
        retryable: true,
      });
    }
  }

  async initWithRetry(body, { attempts = 4, backoffMs = DEFAULT_BACKOFF_MS } = {}) {
    const maximumAttempts = Math.max(1, attempts);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this._requestJson('/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        const lastError = error instanceof UploadError
          ? error
          : new UploadError(error?.message || 'Upload setup failed', { retryable: true });
        if (
          !lastError.retryable ||
          attempt >= maximumAttempts ||
          lastError.code === 'ABORTED'
        ) {
          throw lastError;
        }
        await sleep(backoffDelay(backoffMs, attempt), this.signal);
      }
    }
  }

  async status(uploadId) {
    return this._requestJson(`/${encodeURIComponent(uploadId)}`, { method: 'GET' });
  }

  async complete(uploadId) {
    return this._requestJson(`/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' });
  }

  async cancel(uploadId) {
    try {
      await this.fetchImpl(this.url(`/${encodeURIComponent(uploadId)}`), {
        method: 'DELETE',
        signal: this.signal || undefined,
      });
    } catch {
      /* Cancellation is best effort. */
    }
  }

  /**
   * Send one verified byte window.
   *
   * @param {string} uploadId
   * @param {number} offset
   * @param {Blob} blob
   * @param {string} digest
   * @param {string} transport
   * @param {object} [handlers]
   * @returns {Promise<any>}
   */
  sendChunk(uploadId, offset, blob, digest, transport, handlers = {}) {
    const {
      idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
      ackTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
      signal = null,
      filename = 'upload',
    } = handlers;
    const requestId = makeClientKey();
    const url = this.url(`/${encodeURIComponent(uploadId)}/chunk`, {
      offset,
      sha256: digest,
      length: blob.size,
      request_id: requestId,
    });

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let idleTimer = null;
      let ackTimer = null;
      let settled = false;
      let bodySent = false;
      let bodyMoved = false;
      let phase = UploadState.UPLOADING;

      const clearTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (ackTimer) clearTimeout(ackTimer);
        idleTimer = null;
        ackTimer = null;
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimers();
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };

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
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          failWith(
            new UploadError(
              bodyMoved
                ? 'The proxy stopped moving upload data'
                : 'The upload connection was dropped before data moved',
              {
                code: bodyMoved ? 'STALLED' : 'TRANSPORT_DROPPED',
                retryable: true,
                transport,
              },
            ),
          );
        }, idleTimeoutMs);
      };
      const armAck = () => {
        if (ackTimer) clearTimeout(ackTimer);
        ackTimer = setTimeout(() => {
          failWith(
            new UploadError('The proxy held the upload response too long', {
              code: 'RESPONSE_TIMEOUT',
              retryable: true,
              transport,
            }),
          );
        }, ackTimeoutMs);
      };

      try {
        xhr.open(transport === 'binary_put' ? 'PUT' : 'POST', url, true);
        xhr.withCredentials = false;
        if (typeof xhr.setRequestHeader === 'function') {
          xhr.setRequestHeader('X-Xwing-Transport', transport);
          xhr.setRequestHeader(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          );
          if (transport !== 'multipart_post') {
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          }
        }
      } catch {
        finish(
          reject,
          new UploadError('This browser could not start the upload request', {
            code: 'BAD_REQUEST',
            retryable: false,
          }),
        );
        return;
      }

      xhr.upload.addEventListener('loadstart', () => armIdle());
      xhr.upload.addEventListener('progress', event => {
        bodyMoved = event.loaded > 0;
        handlers.onProgress?.(event.loaded, blob.size);
        armIdle();
      });
      xhr.upload.addEventListener('load', () => {
        bodySent = true;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        handlers.onProgress?.(blob.size, blob.size);
        setPhase(UploadState.PROCESSING);
        armAck();
      });
      xhr.upload.addEventListener('error', () => {
        finish(
          reject,
          new UploadError('The proxy dropped the upload request', {
            code: bodyMoved ? 'NETWORK' : 'TRANSPORT_DROPPED',
            retryable: true,
            transport,
          }),
        );
      });
      xhr.addEventListener('abort', () => {
        finish(
          reject,
          new UploadError('Upload aborted', {
            code: 'ABORTED',
            retryable: !bodySent,
            transport,
          }),
        );
      });
      xhr.addEventListener('error', () => {
        finish(
          reject,
          new UploadError(
            bodyMoved
              ? 'Upload connection failed'
              : 'The proxy dropped the upload request',
            {
              code: bodyMoved ? 'NETWORK' : 'TRANSPORT_DROPPED',
              retryable: true,
              transport,
            },
          ),
        );
      });
      xhr.addEventListener('timeout', () => {
        finish(
          reject,
          new UploadError('Upload timed out', {
            code: 'RESPONSE_TIMEOUT',
            retryable: true,
            transport,
          }),
        );
      });
      // WebKit can finish a dropped request at DONE with status 0 without
      // dispatching an `error` event. Give the normal `load` handler one turn
      // to run, then fail with the same retryable reason the other engines use.
      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState !== 4) return;
        setTimeout(() => {
          if (settled) return;
          finish(
            reject,
            new UploadError(
              bodyMoved
                ? 'Upload connection closed before a response'
                : 'The proxy dropped the upload request',
              {
                code: bodyMoved ? 'NETWORK' : 'TRANSPORT_DROPPED',
                retryable: true,
                transport,
              },
            ),
          );
        }, 0);
      });
      xhr.addEventListener('load', () => {
        const payload = parsePayload(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          if (payload === null || typeof payload !== 'object') {
            finish(
              reject,
              new UploadError(
                'The proxy returned a page instead of an upload response',
                {
                  status: xhr.status,
                  code: 'AUTH_REQUIRED',
                  retryable: false,
                  transport,
                },
              ),
            );
            return;
          }
          finish(resolve, {
            ...payload,
            transport,
            protocol: resourceProtocol(url),
          });
          return;
        }
        const error = errorFromResponse(xhr.status, payload);
        error.transport = transport;
        finish(reject, error);
      });

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      setPhase(UploadState.UPLOADING);
      let body = blob;
      if (transport === 'multipart_post') {
        body = new FormData();
        body.set('offset', String(offset));
        body.set('length', String(blob.size));
        body.set('sha256', digest);
        body.set('request_id', requestId);
        body.set('file', blob, filename);
      }
      xhr.send(body);
    });
  }
}

class ShrinkWindow extends Error {
  constructor(bytes) {
    super('The proxy rejected the upload window');
    this.bytes = bytes;
  }
}

/**
 * Upload one blob through the v2 protocol.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function uploadFile({
  client,
  file,
  filename = null,
  destDir = '/',
  session = null,
  uploadKey = null,
  fingerprint = null,
  transports = null,
  chunkSize = null,
  concurrency = null,
  minChunkBytes = DEFAULT_MIN_CHUNK_BYTES,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  ackTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  restartOnSessionLoss = true,
  callbacks = {},
  signal = null,
}) {
  const size = file.size;
  const name = filename || file.name || 'upload';
  const key = uploadKey || session?.uploadKey || makeClientKey();
  const print = fingerprint || {
    name,
    size,
    last_modified: Number(file.lastModified || 0),
  };

  let info = null;
  let ranges = [];
  let highWater = 0;
  let restartUsed = false;
  let restarted = false;
  // The caller supplies the largest window the destination permits. The first
  // request is a canary at the server's advertised initial size, never that
  // ceiling, so a DLP appliance sees a small classified body first.
  const offeredMax = clampChunkSize(
    Math.min(maxChunkBytes, chunkSize || session?.chunkSize || maxChunkBytes),
    minChunkBytes,
    maxChunkBytes,
  );
  let windowSize = clampChunkSize(
    session?.chunkSize || DEFAULT_INITIAL_CHUNK_BYTES,
    minChunkBytes,
    offeredMax,
  );
  let maxWindow = offeredMax;
  let maxWorkers = Math.max(1, concurrency || session?.concurrency || DEFAULT_CONCURRENCY);
  let workers = 1;
  let transportOrder = normalizeTransports(transports || session?.transports);
  const transportState = {
    chosen: session?.transport || null,
    index: 0,
  };
  let consecutiveTransportFailures = 0;
  let transportRotations = 0;
  let lastProtocol = null;
  const digestCache = new Map();
  const inFlight = new Map();

  const setState = state => callbacks.onState?.(state);
  const reportProgress = pending => {
    if (!callbacks.onProgress) return;
    const committed = committedBytes(ranges) + (pending || 0);
    highWater = Math.max(highWater, Math.min(size, committed));
    callbacks.onProgress(highWater, size);
  };
  const reportInFlight = () => {
    let pending = 0;
    for (const loaded of inFlight.values()) pending += loaded;
    reportProgress(pending);
  };
  const publishSession = () => {
    callbacks.onSession?.({
      uploadId: info.uploadId,
      uploadKey: key,
      chunkSize: windowSize,
      concurrency: workers,
      ranges,
      size,
      transport: transportState.chosen,
    });
  };
  const diagnostic = event => {
    callbacks.onDiagnostic?.({
      ...event,
      upload_id: info?.uploadId || null,
      filename: name,
      size,
      chunk_bytes: windowSize,
      concurrency: workers,
      transport: transportState.chosen,
      protocol: lastProtocol,
    });
  };

  const initSession = async () => {
    const created = await client.initWithRetry(
      {
        upload_key: key,
        filename: name,
        size,
        dir: destDir,
        fingerprint: print,
      },
      { attempts: Math.min(4, maxAttempts), backoffMs },
    );
    if (created.ignored) return created;
    info = {
      uploadId: created.upload_id,
      chunkSize: created.chunk_policy?.initial_bytes || created.chunk_size || session?.chunkSize,
      concurrency:
        created.chunk_policy?.max_concurrency || created.concurrency || session?.concurrency,
      ranges: Array.isArray(created.ranges) ? created.ranges : [],
      size: created.size ?? size,
      state: created.state || 'open',
      transportOrder: created.transport_order,
      ackTimeoutMs: created.ack_timeout_ms,
    };
    ranges = info.ranges;
    transportOrder = normalizeTransports(
      transports || info.transportOrder || transportOrder,
    );
    const advertisedMax =
      created.chunk_policy?.max_bytes || created.chunk_size || maxChunkBytes;
    maxWindow = clampChunkSize(
      Math.min(offeredMax, advertisedMax),
      minChunkBytes,
      maxChunkBytes,
    );
    const advertisedInitial =
      created.chunk_policy?.initial_bytes ||
      info.chunkSize ||
      DEFAULT_INITIAL_CHUNK_BYTES;
    windowSize = clampChunkSize(
      Math.min(session?.chunkSize || advertisedInitial, advertisedInitial, maxWindow),
      minChunkBytes,
      maxWindow,
    );
    maxWorkers = Math.max(
      1,
      Math.min(
        concurrency || maxWorkers,
        created.chunk_policy?.max_concurrency || created.concurrency || maxWorkers,
      ),
    );
    if (!transportState.chosen && transportOrder.length) {
      transportState.index = 0;
    }
    if (session?.uploadId && session.uploadId !== info.uploadId) restarted = true;
    return created;
  };

  setState(UploadState.PREPARING);
  const created = await initSession();
  if (created.ignored) {
    setState(UploadState.DONE);
    return {
      ok: true,
      ignored: true,
      path: name,
      bytes: 0,
      uploadId: null,
      restarted: false,
    };
  }
  if (created.state === 'complete') {
    setState(UploadState.DONE);
    return {
      ok: true,
      path: created.path || name,
      bytes: size,
      uploadId: info.uploadId,
      restarted,
      transport: transportState.chosen,
    };
  }
  publishSession();

  async function digestFor(start, end) {
    const cacheKey = `${start}-${end}`;
    let digest = digestCache.get(cacheKey);
    if (!digest) {
      digest = await sha256Blob(file.slice(start, end, 'application/octet-stream'));
      digestCache.set(cacheKey, digest);
    }
    return digest;
  }

  async function runWindow(start, end) {
    let attempts = 0;
    let transportFailures = 0;
    const digest = await digestFor(start, end);

    for (;;) {
      if (signal?.aborted) throw new UploadError('Upload cancelled', { code: 'ABORTED' });
      const transport =
        transportState.chosen ||
        transportOrder[transportState.index] ||
        TRANSPORTS[0];
      const keyForProgress = `${start}-${end}-${transport}-${attempts}`;
      try {
        const result = await client.sendChunk(
          info.uploadId,
          start,
          file.slice(start, end, 'application/octet-stream'),
          digest,
          transport,
          {
            idleTimeoutMs,
            ackTimeoutMs: info.ackTimeoutMs || ackTimeoutMs,
            filename: name,
            signal,
            onProgress: loaded => {
              inFlight.set(keyForProgress, Math.min(loaded, end - start));
              reportInFlight();
            },
            onPhase: phase => {
              setState(phase === UploadState.PROCESSING ? UploadState.PROCESSING : UploadState.UPLOADING);
            },
          },
        );
        inFlight.delete(keyForProgress);
        reportInFlight();
        transportState.chosen = result.transport || transport;
        consecutiveTransportFailures = 0;
        transportRotations = 0;
        lastProtocol = result.protocol || lastProtocol;
        if (Array.isArray(result.ranges)) {
          ranges = result.ranges;
        } else {
          ranges = [...ranges, [start, start + (result.received || end - start)]];
        }
        publishSession();
        diagnostic({
          event: 'chunk-ok',
          status: 200,
          attempts,
          retries: attempts,
          transport,
        });
        return result;
      } catch (error) {
        inFlight.delete(keyForProgress);
        reportInFlight();
        const uploadError = error instanceof UploadError
          ? error
          : new UploadError(error?.message || 'Upload failed', { retryable: true });
        uploadError.transport = uploadError.transport || transport;

        if (
          uploadError.code === 'ABORTED' ||
          uploadError.code === 'AUTH_REQUIRED' ||
          uploadError.code === 'NOT_OWNER'
        ) {
          throw uploadError;
        }
        if (uploadError.status === 413 || uploadError.code === 'CHUNK_TOO_LARGE') {
          const windowBytes = end - start;
          if (windowBytes <= minChunkBytes) throw uploadError;
          throw new ShrinkWindow(
            Math.max(minChunkBytes, Math.floor(windowBytes / 2)),
          );
        }

        const transportFailure =
          TRANSPORT_CODES.has(uploadError.code) ||
          uploadError.status === 405 ||
          uploadError.code === 'UPLOAD_FAILED' && uploadError.status === 0;
        if (transportFailure) consecutiveTransportFailures += 1;
        if (transportFailure) transportFailures += 1;
        if (
          transportFailure &&
          transportFailures > transportOrder.length &&
          end - start > minChunkBytes
        ) {
          // Every request shape was dropped at this size. Halve the window
          // before spending the full retry budget on a body the proxy is
          // refusing to pass.
          throw new ShrinkWindow(
            Math.max(minChunkBytes, Math.floor((end - start) / 2)),
          );
        }
        if (
          transportFailure &&
          transportOrder.length > 1 &&
          transportRotations < transportOrder.length * 2 &&
          (!transportState.chosen || consecutiveTransportFailures >= 2)
        ) {
          const currentIndex = Math.max(0, transportOrder.indexOf(transport));
          transportState.index = (currentIndex + 1) % transportOrder.length;
          transportState.chosen = null;
          transportRotations += 1;
          consecutiveTransportFailures = 0;
          callbacks.onRetry?.({
            attempt: transportRotations,
            code: 'TRANSPORT_FALLBACK',
            message: `${transport.replaceAll('_', ' ')} was blocked; trying ${transportOrder[transportState.index].replaceAll('_', ' ')}`,
            transport: transportOrder[transportState.index],
          });
          diagnostic({
            event: 'transport-fallback',
            status: uploadError.status,
            code: uploadError.code,
            message: uploadError.message,
            attempts: transportRotations,
            retries: transportRotations,
            transport,
          });
          setState(UploadState.UPLOADING);
          continue;
        }

        attempts += 1;
        if (!uploadError.retryable && !transportFailure) throw uploadError;
        if (attempts >= maxAttempts) throw uploadError;
        callbacks.onRetry?.({
          attempt: attempts,
          code: uploadError.code,
          message: uploadError.message,
          transport,
        });
        diagnostic({
          event: 'chunk-retry',
          status: uploadError.status,
          code: uploadError.code,
          message: uploadError.message,
          attempts,
          retries: attempts,
          transport,
        });
        setState(UploadState.UPLOADING);
        await sleep(backoffDelay(backoffMs, attempts), signal);
      }
    }
  }

  async function runPass(limitWindows = null) {
    const queue = planWindows(ranges, size, windowSize);
    if (limitWindows !== null) queue.length = Math.min(queue.length, limitWindows);
    if (!queue.length) return { done: true };
    return new Promise((resolve, reject) => {
      let nextIndex = 0;
      let active = 0;
      let fatal = null;
      let shrink = null;
      let successes = 0;
      let finished = false;
      const settle = () => {
        if (finished) return;
        finished = true;
        if (fatal) reject(fatal);
        else if (shrink) resolve({ shrink: shrink.bytes });
        else resolve({ done: missingRanges(ranges, size).length === 0 });
      };
      const launch = () => {
        if (finished) return;
        if (!fatal && !shrink) {
          while (active < workers && nextIndex < queue.length) {
            const [start, end] = queue[nextIndex];
            nextIndex += 1;
            if (windowCovered(ranges, start, end)) continue;
            active += 1;
            runWindow(start, end)
              .then(() => {
                successes += 1;
                if (successes % 2 === 0) workers = Math.min(maxWorkers, workers + 1);
              })
              .catch(error => {
                if (error instanceof ShrinkWindow) {
                  if (!shrink) shrink = error;
                } else if (!fatal) {
                  fatal = error;
                }
              })
              .finally(() => {
                active -= 1;
                if (active === 0 && (fatal || shrink || nextIndex >= queue.length)) {
                  settle();
                } else {
                  launch();
                }
              });
          }
        }
        if (active === 0 && (fatal || shrink || nextIndex >= queue.length)) settle();
      };
      launch();
    });
  }

  async function runPasses() {
    let lastCommitted = committedBytes(ranges);
    let grow = true;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      if (!missingRanges(ranges, size).length) return;
      setState(UploadState.UPLOADING);
      const canGrow = grow && windowSize < maxWindow;
      let outcome;
      try {
        outcome = await runPass(canGrow ? 1 : null);
      } catch (error) {
        const uploadError = error instanceof UploadError
          ? error
          : new UploadError(error?.message || 'Upload failed', {});
        if (
          uploadError.code === 'ABORTED' ||
          uploadError.code === 'AUTH_REQUIRED' ||
          uploadError.code === 'NOT_OWNER' ||
          uploadError.code === 'SESSION_LOST'
        ) {
          throw uploadError;
        }
        const refreshed = await client.status(info.uploadId).catch(() => null);
        if (refreshed?.ranges) ranges = refreshed.ranges;
        const committed = committedBytes(ranges);
        if (committed <= lastCommitted || pass + 1 >= MAX_PASSES) throw uploadError;
        lastCommitted = committed;
        callbacks.onRetry?.({
          attempt: pass + 2,
          code: 'INCOMPLETE',
          message: 'Some upload windows still need another pass',
        });
        continue;
      }
      if (outcome?.shrink) {
        grow = false;
        windowSize = clampChunkSize(outcome.shrink, minChunkBytes, maxWindow);
        workers = Math.max(1, Math.floor(workers / 2));
        callbacks.onRetry?.({
          attempt: pass + 2,
          code: 'CHUNK_TOO_LARGE',
          message: `The proxy rejected a ${Math.round(windowSize / 1024)} KiB window`,
        });
        publishSession();
        continue;
      }
      if (!missingRanges(ranges, size).length) return;
      if (canGrow) {
        windowSize = clampChunkSize(windowSize * 2, minChunkBytes, maxWindow);
        workers = Math.min(maxWorkers, Math.max(2, workers));
        publishSession();
        continue;
      }
      if (pass + 1 >= MAX_PASSES) break;
      callbacks.onRetry?.({
        attempt: pass + 2,
        code: 'INCOMPLETE',
        message: 'Server did not accept every byte',
      });
    }
    throw new UploadError('Server never accepted every byte of the upload', {
      code: 'INCOMPLETE',
      retryable: true,
    });
  }

  async function completeWithRetries() {
    let attempts = 0;
    for (;;) {
      try {
        return await client.complete(info.uploadId);
      } catch (error) {
        const uploadError = error instanceof UploadError
          ? error
          : new UploadError(String(error), {});
        attempts += 1;
        if (
          uploadError.code === 'ABORTED' ||
          uploadError.code === 'AUTH_REQUIRED' ||
          uploadError.code === 'SESSION_LOST' ||
          !uploadError.retryable ||
          attempts >= Math.min(3, maxAttempts)
        ) {
          throw uploadError;
        }
        await sleep(backoffDelay(backoffMs, attempts), signal);
        setState(UploadState.FINALIZING);
      }
    }
  }

  async function runEverything() {
    await runPasses();
    setState(UploadState.FINALIZING);
    return completeWithRetries();
  }

  try {
    let result;
    try {
      result = await runEverything();
    } catch (error) {
      const uploadError = error instanceof UploadError
        ? error
        : new UploadError(error?.message || 'Upload failed', {});
      if (uploadError.code !== 'SESSION_LOST' || !restartOnSessionLoss || restartUsed) {
        throw uploadError;
      }
      restartUsed = true;
      restarted = true;
      await initSession();
      result = info.state === 'complete'
        ? { path: name, verified: true }
        : await runEverything();
    }
    setState(UploadState.DONE);
    diagnostic({ event: 'complete', status: 200, attempts: 0, retries: 0 });
    return {
      ok: true,
      path: result?.path ?? name,
      bytes: size,
      uploadId: info.uploadId,
      restarted,
      transport: transportState.chosen,
      protocol: lastProtocol,
      verified: result?.verified ?? false,
    };
  } catch (error) {
    const uploadError = error instanceof UploadError
      ? error
      : new UploadError(error?.message || 'Upload failed', {});
    if (uploadError.code !== 'ABORTED' && info?.uploadId) {
      const status = await client.status(info.uploadId).catch(() => null);
      if (status?.ranges) {
        ranges = status.ranges;
        reportProgress(0);
      }
      diagnostic({
        event: 'failed',
        status: uploadError.status,
        code: uploadError.code,
        message: uploadError.message,
        attempts: 1,
        retries: 1,
      });
    }
    setState(UploadState.ERROR);
    throw uploadError;
  }
}
