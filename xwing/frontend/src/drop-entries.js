/**
 * Folder-aware drag-and-drop traversal shared with torrus.
 *
 * It has no imports and no framework dependency. X-wing does not pin a digest
 * of the copy in another repository.
 *
 * Why it exists: `DataTransfer.files` only carries the *top* items of a drop.
 * Dropping a folder yields a single entry for the folder itself, so a naive
 * uploader creates one empty file named after the directory and uploads
 * nothing inside it. The File System API in `dataTransfer.items` is the only
 * way to walk the tree, and its readers must be driven from the drop handler
 * itself: `items` is emptied as soon as the event finishes dispatching, so
 * `collectDroppedEntries` grabs the entries synchronously before awaiting.
 */

/** Directory entries are reported through the non-standard File System API. */
const ENTRY_ACCESSOR = 'webkitGetAsEntry';

/**
 * @typedef {object} DroppedEntry
 * @property {File} file
 * @property {string} relativePath Path inside the drop, folder names included.
 */

/**
 * Walk a drop synchronously-issued readers into a flat upload list.
 *
 * @param {DataTransfer | null | undefined} dataTransfer
 * @returns {Promise<{entries: DroppedEntry[], skipped: number}>} `skipped`
 *   counts entries that could not be traversed or read, so the caller can
 *   explain why a drop produced nothing.
 */
export async function collectDroppedEntries(dataTransfer) {
  const roots = takeRoots(dataTransfer);
  // Snapshot the FileList before the first await too. Some extensions block
  // FileSystemEntry.file() while leaving the plain File objects intact.
  const fallbackFiles = takeFiles(dataTransfer);
  const entries = [];
  let skipped = 0;

  for (const root of roots) {
    if (root.entry) {
      await walk(root.entry, '', entries, () => {
        skipped += 1;
      });
    } else if (root.file) {
      entries.push({ file: root.file, relativePath: root.file.name });
    } else {
      skipped += 1;
    }
  }
  if (
    entries.length === 0 &&
    skipped > 0 &&
    roots.every(root => !root.entry?.isDirectory) &&
    fallbackFiles.length > 0
  ) {
    for (const file of fallbackFiles) {
      entries.push({ file, relativePath: file.name });
    }
  }
  return { entries, skipped };
}

/**
 * Snapshot what the drop carries. Must run while the drop event is still
 * dispatching: `dataTransfer.items` is neutered afterwards.
 *
 * @param {DataTransfer | null | undefined} dataTransfer
 * @returns {Array<{entry: any, file: File | null}>}
 */
function takeRoots(dataTransfer) {
  const roots = [];
  const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
  for (const item of items) {
    // Enterprise extensions (DLP, Menlo, ForcePoint) can leave null slots.
    if (!item || item.kind !== 'file') continue;
    let entry = null;
    try {
      entry = typeof item[ENTRY_ACCESSOR] === 'function' ? item[ENTRY_ACCESSOR]() : null;
    } catch {
      // An extension can make the accessor throw; fall back to the file slot.
    }
    if (entry) {
      roots.push({ entry, file: null });
      continue;
    }
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    roots.push({ entry: null, file: file && typeof file.name === 'string' ? file : null });
  }
  // A content script can leave a placeholder item that has no entry and no
  // file while the FileList still has the real file. Only treat the item
  // snapshot as usable when at least one slot can actually produce a file.
  if (roots.some(root => root.file || root.entry?.isFile || root.entry?.isDirectory)) {
    return roots;
  }

  const files = dataTransfer && dataTransfer.files ? Array.from(dataTransfer.files) : [];
  for (const file of files) {
    if (file && typeof file.name === 'string') roots.push({ entry: null, file });
  }
  return roots;
}

/**
 * Snapshot the top-level files independently of the File System API.
 *
 * @param {DataTransfer | null | undefined} dataTransfer
 * @returns {File[]}
 */
function takeFiles(dataTransfer) {
  const files = dataTransfer && dataTransfer.files ? Array.from(dataTransfer.files) : [];
  return files.filter(file => file && typeof file.name === 'string');
}

/**
 * @param {any} entry FileSystemEntry (file or directory)
 * @param {string} prefix Path of the enclosing folders, trailing slash included
 * @param {Array<{file: File, relativePath: string}>} out
 * @param {() => void} onSkipped
 */
async function walk(entry, prefix, out, onSkipped) {
  if (!entry) return;
  if (entry.isFile) {
    const file = await readFile(entry);
    if (file) out.push({ file, relativePath: prefix + file.name });
    else onSkipped();
    return;
  }
  if (entry.isDirectory) {
    const children = await readAll(entry);
    if (children === null) {
      // The tree could not be read (permissions, or the directory vanished
      // mid-drop). Report it rather than uploading an empty stand-in.
      onSkipped();
      return;
    }
    const nextPrefix = `${prefix}${entry.name}/`;
    for (const child of children) await walk(child, nextPrefix, out, onSkipped);
  }
}

/** @param {any} entry @returns {Promise<File | null>} */
function readFile(entry) {
  return new Promise(resolve => {
    try {
      entry.file(
        file => resolve(file),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Read a directory to exhaustion: browsers return batches (Chromium caps each
 * call), and an empty batch is the only reliable end-of-directory signal.
 *
 * @param {any} entry
 * @returns {Promise<any[] | null>} null when the directory could not be read
 */
function readAll(entry) {
  return new Promise(resolve => {
    let reader;
    try {
      reader = entry.createReader();
    } catch {
      resolve(null);
      return;
    }
    const found = [];
    const readBatch = () => {
      reader.readEntries(
        batch => {
          const children = (batch || []).filter(child => child);
          if (children.length === 0) {
            resolve(found);
            return;
          }
          found.push(...children);
          readBatch();
        },
        () => {
          resolve(found.length > 0 ? found : null);
        },
      );
    };
    readBatch();
  });
}
