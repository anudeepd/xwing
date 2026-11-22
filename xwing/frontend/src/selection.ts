export interface SelectableFile { path: string }

export function selectionRange(files: SelectableFile[], anchorPath: string | null, targetIndex: number): string[] {
  const anchorIndex = anchorPath === null ? -1 : files.findIndex(file => file.path === anchorPath);
  if (anchorIndex < 0) return files[targetIndex] ? [files[targetIndex]!.path] : [];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return files.slice(start, end + 1).map(file => file.path);
}

export function nearestSurvivor(files: SelectableFile[], removedPaths: Iterable<string>): string | null {
  const removed = new Set(removedPaths);
  const firstRemoved = files.findIndex(file => removed.has(file.path));
  if (firstRemoved < 0) return null;
  const survivors = files.filter(file => !removed.has(file.path));
  return survivors[Math.min(firstRemoved, survivors.length - 1)]?.path ?? null;
}
