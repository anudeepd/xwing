/**
 * Folder-aware drag-and-drop traversal, shared by xwing and torrus.
 *
 * This file is vendored verbatim into both repositories; keep the two copies
 * byte-identical (the parity test pins the digest). It has no imports and no
 * framework dependency.
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
 *   counts directories that could not be traversed, so the caller can explain
 *   why a drop produced nothing.
 */
export async function collectDroppedEntries(dataTransfer) {
  const roots = takeRoots(dataTransfer);
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
  if (roots.length > 0) return roots;

  const files = dataTransfer && dataTransfer.files ? Array.from(dataTransfer.files) : [];
  for (const file of files) {
    if (file && typeof file.name === 'string') roots.push({ entry: null, file });
  }
  return roots;
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
    let failed = false;
    const readBatch = () => {
      reader.readEntries(
        batch => {
          const children = (batch || []).filter(child => child);
          if (children.length === 0) {
            resolve(failed && found.length === 0 ? null : found);
            return;
          }
          found.push(...children);
          readBatch();
        },
        () => {
          failed = true;
          resolve(found.length > 0 ? found : null);
        },
      );
    };
    readBatch();
  });
}
