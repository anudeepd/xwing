/**
 * Where a same-directory rename sends the item: the parent directory, under the
 * new name.
 *
 * A directory's path carries the trailing slash that keeps its links inside it,
 * so the parent is the segment before the *name*, not before the slash. Reading
 * it the other way nests the new name inside the folder — `/folder/` became
 * `/folder/renamed/` — which is why this is its own tested function rather than
 * an inline expression.
 */
export function renameDestination(path: string, name: string): string {
  const isDirectory = path.endsWith("/");
  const current = isDirectory ? path.slice(0, -1) : path;
  const parent = current.slice(0, current.lastIndexOf("/"));
  return `${parent}/${encodeURIComponent(name)}${isDirectory ? "/" : ""}`;
}
