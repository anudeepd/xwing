import type { XwingFile } from "./types";

export type SortKey = "name" | "size" | "modified";
export type SortDirection = "asc" | "desc";
export interface SortEntry { key: SortKey; direction: SortDirection }

export const DEFAULT_SORT: SortEntry[] = [{ key: "modified", direction: "desc" }];

const SORT_KEYS = new Set<SortKey>(["name", "size", "modified"]);
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function normalizeSortPreference(value: unknown): SortEntry[] {
  const candidates = Array.isArray(value) ? value : [value];
  const entries: SortEntry[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const legacy = candidate as { key?: unknown; direction?: unknown; dir?: unknown };
    const key = legacy.key === "mtime" ? "modified" : legacy.key;
    const direction = legacy.direction ?? legacy.dir;
    if (SORT_KEYS.has(key as SortKey) && (direction === "asc" || direction === "desc")) {
      entries.push({ key: key as SortKey, direction });
    }
  }
  return entries.length ? entries : [...DEFAULT_SORT];
}

export function nextSort(entries: SortEntry[], key: SortKey): SortEntry[] {
  const existing = entries.find(entry => entry.key === key);
  if (!existing) return [...entries, { key, direction: "asc" }];
  if (existing.direction === "asc") {
    return entries.map(entry => entry.key === key ? { key, direction: "desc" } : entry);
  }
  const next = entries.filter(entry => entry.key !== key);
  return next.length ? next : [{ key: "name", direction: "asc" }];
}

export function sortFiles(files: XwingFile[], entries: SortEntry[]): XwingFile[] {
  return [...files].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    for (const entry of entries) {
      const a = entry.key === "name" ? left.name : entry.key === "size" ? left.size ?? -1 : left.modified ?? "";
      const b = entry.key === "name" ? right.name : entry.key === "size" ? right.size ?? -1 : right.modified ?? "";
      const result = typeof a === "string" && typeof b === "string" && entry.key === "name"
        ? nameCollator.compare(a, b)
        : a < b ? -1 : a > b ? 1 : 0;
      if (result) return entry.direction === "asc" ? result : -result;
    }
    return nameCollator.compare(left.name, right.name);
  });
}
