const PREFIX = "xwing.upload.v2.";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 50;

export interface ResumeSession {
  uploadKey: string;
  uploadId: string;
  ranges: number[][];
  chunkSize: number;
  concurrency: number;
  size: number;
  transport?: string | null;
  savedAt: number;
}

export function resumeRecordKey(file: File, destination: string): string {
  return `${PREFIX}${encodeURIComponent(destination)}|${encodeURIComponent(file.name)}|${file.size}|${Number(file.lastModified || 0)}`;
}

function storageOrNull(storage?: Storage | null): Storage | null {
  if (storage) return storage;
  try {
    return globalThis.window?.localStorage ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadResumeSession(
  file: File,
  destination: string,
  manager: Storage | null = storageOrNull(),
): ResumeSession | null {
  if (!manager) return null;
  const key = resumeRecordKey(file, destination);
  try {
    const raw = manager.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ResumeSession>;
    if (
      typeof parsed.uploadKey !== "string" ||
      typeof parsed.uploadId !== "string" ||
      !Array.isArray(parsed.ranges) ||
      typeof parsed.size !== "number" ||
      typeof parsed.savedAt !== "number" ||
      Date.now() - parsed.savedAt > MAX_AGE_MS
    ) {
      manager.removeItem(key);
      return null;
    }
    return {
      uploadKey: parsed.uploadKey,
      uploadId: parsed.uploadId,
      ranges: parsed.ranges.filter(
        (range): range is number[] =>
          Array.isArray(range) && range.length === 2 && range.every(Number.isFinite),
      ),
      chunkSize: Number(parsed.chunkSize) || 0,
      concurrency: Number(parsed.concurrency) || 1,
      size: parsed.size,
      transport: typeof parsed.transport === "string" ? parsed.transport : null,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function saveResumeSession(
  file: File,
  destination: string,
  session: Omit<ResumeSession, "savedAt"> & { savedAt?: number },
  manager: Storage | null = storageOrNull(),
): void {
  if (!manager) return;
  const key = resumeRecordKey(file, destination);
  try {
    pruneResumeSessions(manager, key);
    const record: ResumeSession = {
      ...session,
      savedAt: session.savedAt ?? Date.now(),
    };
    manager.setItem(key, JSON.stringify(record));
  } catch {
    /* Private mode and quota limits must never break the upload. */
  }
}

export function clearResumeSession(
  file: File,
  destination: string,
  manager: Storage | null = storageOrNull(),
): void {
  if (!manager) return;
  try {
    manager.removeItem(resumeRecordKey(file, destination));
  } catch {
    /* Best effort. */
  }
}

function pruneResumeSessions(manager: Storage, keepKey: string): void {
  const records: Array<{ key: string; savedAt: number }> = [];
  const keys = Array.from({ length: manager.length }, (_, index) => manager.key(index));
  for (const key of keys) {
    if (!key?.startsWith(PREFIX) || key === keepKey) continue;
    try {
      const parsed = JSON.parse(manager.getItem(key) || "{}") as { savedAt?: number };
      const savedAt = Number(parsed.savedAt) || 0;
      if (!savedAt || Date.now() - savedAt > MAX_AGE_MS) {
        manager.removeItem(key);
      } else {
        records.push({ key, savedAt });
      }
    } catch {
      manager.removeItem(key);
    }
  }
  records.sort((a, b) => b.savedAt - a.savedAt);
  for (const stale of records.slice(MAX_RECORDS - 1)) manager.removeItem(stale.key);
}
