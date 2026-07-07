"use strict";

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;  // 8 MB
const TARGET_UPLOAD_CHUNKS = 128;
const MAX_BROWSER_CHUNK_SIZE = 32 * 1024 * 1024;  // 32 MB
const UPLOAD_PROGRESS_CAP = 95;
const UPLOAD_STALL_MS = 1500;
const UPLOAD_RETRY_DELAYS_MS = [750, 1500, 3000];
const RETRYABLE_UPLOAD_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const CURRENT_PATH = document.body.dataset.currentPath || "/";
const CURRENT_USER = document.body.dataset.user || "anonymous";
const CAN_WRITE = document.body.dataset.canWrite === "true";
const CAN_DELETE = document.body.dataset.canDelete === "true";
const SERVER_MAX_CHUNK_BYTES = parseInt(document.body.dataset.maxChunkBytes, 10) || DEFAULT_CHUNK_SIZE;
const SORT_STORAGE_KEY = `xwing.sort.${CURRENT_USER}`;
const AUTH_REDIRECT_DELAY_MS = 1500;
let authRedirecting = false;

function currentAuthRedirectTarget() {
  return `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;
}

function loginUrlForCurrentPage() {
  return `/_auth/login?redirect=${encodeURIComponent(currentAuthRedirectTarget())}`;
}

function isLoginResponseUrl(url) {
  if (!url) return false;
  try {
    return new URL(url, window.location.href).pathname === "/_auth/login";
  } catch {
    return false;
  }
}

function redirectToLogin() {
  if (authRedirecting) return;
  authRedirecting = true;
  showAuthOverlay("Session expired", "Your session has ended. Redirecting to sign in...");
  window.setTimeout(() => window.location.assign(loginUrlForCurrentPage()), AUTH_REDIRECT_DELAY_MS);
}

function showAuthOverlay(title, message) {
  const overlay = document.getElementById("auth-overlay");
  if (!overlay) return;
  const titleEl = document.getElementById("auth-overlay-title");
  const messageEl = document.getElementById("auth-overlay-message");
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  overlay.hidden = false;
}

function wireLogoutForm() {
  const form = document.getElementById("logout-form");
  if (!form) return;
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (authRedirecting) return;
    authRedirecting = true;
    showAuthOverlay("Signing out", "Ending your session...");
    window.setTimeout(() => form.submit(), AUTH_REDIRECT_DELAY_MS);
  });
}

async function authFetch(input, init) {
  const res = await fetch(input, init);
  if (res.status === 401 || isLoginResponseUrl(res.url)) {
    redirectToLogin();
    throw new Error("authentication required");
  }
  return res;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpStatusError(status, message = `HTTP ${status}`) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isRetryableUploadError(error) {
  if (authRedirecting) return false;
  if (RETRYABLE_UPLOAD_STATUSES.has(error?.status)) return true;
  return error?.message === "network error" || error?.message === "timeout";
}

async function withUploadRetries(action, { label, ui } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (!isRetryableUploadError(error) || attempt >= UPLOAD_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const delay = UPLOAD_RETRY_DELAYS_MS[attempt];
      ui?.setStatus(`${label} failed (${error.message}); retrying ${attempt + 1}/${UPLOAD_RETRY_DELAYS_MS.length}...`);
      await sleep(delay);
    }
  }
}

function warnReadOnly(action) {
  alert(`Read-only access: ${action} is disabled for your user.`);
}

function getConcurrency() {
  return parseInt(document.getElementById("concurrency-select").value, 10) || 4;
}

function chunkSizeForFile(fileSize) {
  if (fileSize <= 0) return DEFAULT_CHUNK_SIZE;
  const targetSize = Math.ceil(fileSize / TARGET_UPLOAD_CHUNKS);
  const chunkSize = Math.max(DEFAULT_CHUNK_SIZE, targetSize);
  return Math.max(1, Math.min(chunkSize, MAX_BROWSER_CHUNK_SIZE, SERVER_MAX_CHUNK_BYTES));
}

function appendPath(base, name) {
  return base + encodeURIComponent(name) + "/";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function filenameFromContentDisposition(header) {
  if (!header) return null;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  return plainMatch ? plainMatch[1] : null;
}

function stagingFolderName(name) {
  const nonce = Math.random().toString(36).slice(2);
  return `.xwing-upload-${Date.now()}-${nonce}-${name}`;
}

function nextPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

// ── Date formatting ────────────────────────────────────────────────────────────
wireLogoutForm();

document.querySelectorAll("[data-mtime]").forEach(td => {
  const ts = parseFloat(td.dataset.mtime);
  if (!isNaN(ts)) {
    td.textContent = new Date(ts * 1000).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }
});

// ── Selection + bulk actions ─────────────────────────────────────────────────
const selectAll = document.getElementById("select-all");
let selectableRows = [...document.querySelectorAll(".selectable-entry")];
const zipSelectedBtn = document.getElementById("zip-selected-btn");
const deleteSelectedBtn = document.getElementById("delete-selected-btn");
const selectedPaths = new Set();
let lastSelectedIndex = null;

// ── Sorting ──────────────────────────────────────────────────────────────────
const SORT_KEYS = ["name", "size", "mtime"];
const DEFAULT_SORT = [{ key: "name", dir: "asc" }];
const sortHeaders = [...document.querySelectorAll(".sort-header")];
const resetSortBtn = document.getElementById("reset-sort-btn");
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function isValidSortEntry(entry) {
  return entry
    && SORT_KEYS.includes(entry.key)
    && ["asc", "desc"].includes(entry.dir);
}

function readSortPreference() {
  try {
    const pref = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || "null");
    if (Array.isArray(pref)) {
      const entries = pref.filter(isValidSortEntry);
      if (entries.length) return entries;
    }
    if (isValidSortEntry(pref)) {
      return [pref];
    }
  } catch {
    // Ignore invalid browser storage and fall back to the default listing.
  }
  return [...DEFAULT_SORT];
}

function writeSortPreference(pref) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Sorting still works for the current page when storage is unavailable.
  }
}

function clearSortPreference() {
  try {
    localStorage.removeItem(SORT_STORAGE_KEY);
  } catch {
    // Ignore locked-down browser storage.
  }
}

function rowSortValue(row, key) {
  if (key === "name") return row.dataset.sortName || row.dataset.name || "";
  const value = Number(row.dataset[`sort${key[0].toUpperCase()}${key.slice(1)}`]);
  return Number.isFinite(value) ? value : 0;
}

function compareRowsByEntry(a, b, entry) {
  const aValue = rowSortValue(a, entry.key);
  const bValue = rowSortValue(b, entry.key);
  const result = typeof aValue === "string"
    ? collator.compare(aValue, String(bValue))
    : aValue - Number(bValue);
  return entry.dir === "asc" ? result : -result;
}

function compareRows(a, b, sortEntries) {
  const aDir = a.dataset.isDir === "true";
  const bDir = b.dataset.isDir === "true";
  if (aDir !== bDir) return aDir ? -1 : 1;

  for (const entry of sortEntries) {
    const result = compareRowsByEntry(a, b, entry);
    if (result !== 0) return result;
  }
  return collator.compare(a.dataset.sortName || "", b.dataset.sortName || "");
}

function refreshSelectableRows() {
  selectableRows = [...document.querySelectorAll(".selectable-entry")];
}

function updateSortUi(sortEntries) {
  sortHeaders.forEach(btn => {
    const index = sortEntries.findIndex(entry => entry.key === btn.dataset.sortKey);
    const entry = sortEntries[index];
    const active = Boolean(entry);
    const th = btn.closest("th");
    const indicator = btn.querySelector(".sort-indicator");
    btn.classList.toggle("active", active);
    if (indicator) {
      indicator.textContent = active
        ? `${entry.dir === "asc" ? "▲" : "▼"}${sortEntries.length > 1 ? index + 1 : ""}`
        : "";
    }
    if (th) th.setAttribute("aria-sort", active ? (entry.dir === "asc" ? "ascending" : "descending") : "none");
  });
}

function applySort(sortEntries) {
  const tbody = document.querySelector(".file-table tbody");
  if (!tbody) return;
  const rows = [...tbody.querySelectorAll(".selectable-entry")].sort((a, b) => compareRows(a, b, sortEntries));
  rows.forEach(row => tbody.appendChild(row));
  refreshSelectableRows();
  updateSortUi(sortEntries);
}

let currentSort = readSortPreference();
applySort(currentSort);

sortHeaders.forEach(btn => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.sortKey;
    const existing = currentSort.find(entry => entry.key === key);
    if (!existing) {
      currentSort = [
        ...currentSort,
        { key, dir: "asc" },
      ];
    } else if (existing.dir === "asc") {
      currentSort = currentSort.map(entry => (
        entry.key === key ? { key, dir: "desc" } : entry
      ));
    } else {
      currentSort = currentSort.filter(entry => entry.key !== key);
    }
    writeSortPreference(currentSort);
    clearSelection();
    applySort(currentSort);
  });
});

resetSortBtn.addEventListener("click", () => {
  currentSort = [...DEFAULT_SORT];
  clearSortPreference();
  clearSelection();
  applySort(currentSort);
});

function rowPath(row) {
  return row.dataset.path;
}

function setRowSelected(row, selected) {
  const path = rowPath(row);
  if (!path) return;
  row.classList.toggle("selected", selected);
  const checkbox = row.querySelector(".entry-select");
  if (checkbox) checkbox.checked = selected;
  if (selected) selectedPaths.add(path);
  else selectedPaths.delete(path);
}

function updateBulkActions() {
  const count = selectedPaths.size;
  zipSelectedBtn.disabled = count === 0;
  zipSelectedBtn.textContent = count ? `Download zip (${count})` : "Download zip";
  zipSelectedBtn.title = count ? "Download selected files and folders as zip" : "Select files or folders first";

  if (CAN_DELETE) {
    deleteSelectedBtn.disabled = count === 0;
    deleteSelectedBtn.textContent = count ? `Delete selected (${count})` : "Delete selected";
    deleteSelectedBtn.title = count ? "Delete selected files and folders" : "Select files or folders first";
  }

  if (selectAll) {
    selectAll.checked = count > 0 && count === selectableRows.length;
    selectAll.indeterminate = count > 0 && count < selectableRows.length;
  }
}

function clearSelection() {
  selectableRows.forEach(row => setRowSelected(row, false));
  lastSelectedIndex = null;
  updateBulkActions();
}

function selectRange(toIndex, selected) {
  const fromIndex = lastSelectedIndex === null ? toIndex : lastSelectedIndex;
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  for (let i = start; i <= end; i++) setRowSelected(selectableRows[i], selected);
}

function handleRowSelection(row, event) {
  const index = selectableRows.indexOf(row);
  const checkbox = row.querySelector(".entry-select");
  const target = event.target instanceof Element ? event.target : event.target.parentElement;
  const nextSelected = checkbox ? checkbox.checked : !selectedPaths.has(rowPath(row));

  if (event.shiftKey) {
    selectRange(index, nextSelected);
  } else if (event.metaKey || event.ctrlKey || target?.classList.contains("entry-select")) {
    setRowSelected(row, nextSelected);
  } else {
    const wasOnlySelected = selectedPaths.size === 1 && selectedPaths.has(rowPath(row));
    clearSelection();
    setRowSelected(row, !wasOnlySelected);
  }
  lastSelectedIndex = index;
  updateBulkActions();
}

selectableRows.forEach(row => {
  const checkbox = row.querySelector(".entry-select");
  checkbox.addEventListener("click", event => {
    event.stopPropagation();
    handleRowSelection(row, event);
  });
  row.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    if (target && target.closest("a, button, input")) return;
    handleRowSelection(row, event);
  });
});

if (selectAll) {
  selectAll.addEventListener("change", () => {
    selectableRows.forEach(row => setRowSelected(row, selectAll.checked));
    lastSelectedIndex = null;
    updateBulkActions();
  });
}

zipSelectedBtn.addEventListener("click", async () => {
  if (!selectedPaths.size) return;
  const res = await authFetch("/_bulk/zip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base: CURRENT_PATH, paths: [...selectedPaths] }),
  });
  if (!res.ok) {
    alert("Zip download failed: " + res.status);
    return;
  }
  const blob = await res.blob();
  const filename = filenameFromContentDisposition(res.headers.get("Content-Disposition")) || "xwing-selection.zip";
  downloadBlob(blob, filename);
});

deleteSelectedBtn.addEventListener("click", async () => {
  if (!CAN_DELETE) {
    warnReadOnly("delete");
    return;
  }
  if (!selectedPaths.size) return;
  const names = selectableRows
    .filter(row => selectedPaths.has(rowPath(row)))
    .map(row => row.dataset.name);
  const preview = names.slice(0, 6).join("\n");
  const extra = names.length > 6 ? `\n…and ${names.length - 6} more` : "";
  if (!confirm(`Delete ${names.length} selected item${names.length === 1 ? "" : "s"}?\n\n${preview}${extra}`)) return;
  const res = await authFetch("/_bulk/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [...selectedPaths] }),
  });
  if (res.ok) location.reload();
  else alert("Delete failed: " + res.status);
});

updateBulkActions();

// ── Delete ─────────────────────────────────────────────────────────────────────
document.querySelectorAll(".btn-delete").forEach(btn => {
  btn.addEventListener("click", async () => {
    if (!CAN_DELETE) {
      warnReadOnly("delete");
      return;
    }
    const path = btn.dataset.path;
    const name = path.replace(/\/$/, "").split("/").pop();
    if (!confirm(`Delete "${name}"?`)) return;
    const res = await authFetch(path, { method: "DELETE" });
    if (res.ok) location.reload();
    else alert("Delete failed: " + res.status);
  });
});

// ── New folder ─────────────────────────────────────────────────────────────────
document.getElementById("mkdir-btn").addEventListener("click", async () => {
  if (!CAN_WRITE) {
    warnReadOnly("folder creation");
    return;
  }
  const name = prompt("Folder name:");
  if (!name) return;
  const path = appendPath(CURRENT_PATH, name);
  const res = await authFetch(path, { method: "MKCOL" });
  if (res.ok || res.status === 201) location.reload();
  else alert("Could not create folder: " + res.status);
});

// ── Upload panel ───────────────────────────────────────────────────────────────
const panel = document.getElementById("upload-panel");
const uploadList = document.getElementById("upload-list");
let pendingReload = false;

document.getElementById("close-panel").addEventListener("click", () => {
  panel.classList.add("hidden");
  uploadList.innerHTML = "";
  if (pendingReload) location.reload();
});

function showPanel() {
  panel.classList.remove("hidden");
}

function addUploadItem(name) {
  const item = document.createElement("div");
  item.className = "upload-item";

  const nameEl = document.createElement("div");
  nameEl.className = "upload-item-name";
  nameEl.title = name;
  nameEl.textContent = name;

  const progressWrap = document.createElement("div");
  progressWrap.className = "progress-bar-wrap";

  const progressBar = document.createElement("div");
  progressBar.className = "progress-bar";
  progressBar.style.width = "0%";
  progressWrap.appendChild(progressBar);

  const status = document.createElement("div");
  status.className = "upload-status";
  status.textContent = "Preparing upload...";

  item.append(nameEl, progressWrap, status);
  uploadList.appendChild(item);
  uploadList.scrollTop = uploadList.scrollHeight;
  return {
    setProgress(pct) {
      progressBar.style.width = pct + "%";
      status.textContent = Math.round(pct) + "%";
    },
    setStatus(msg) {
      status.textContent = msg;
    },
    setProcessing(on) {
      item.classList.toggle("processing", on);
    },
    setDone() {
      item.classList.remove("processing");
      item.classList.add("done");
      progressBar.style.width = "100%";
      status.textContent = "Done";
    },
    setError(msg) {
      item.classList.remove("processing");
      item.classList.add("error");
      status.textContent = "Error: " + msg;
    },
  };
}

// ── Directory helpers ─────────────────────────────────────────────────────────
async function ensureDir(serverPath) {
  const res = await authFetch(serverPath, { method: "MKCOL" });
  if (!res.ok && res.status !== 405 && res.status !== 301) {
    throw new Error(`MKCOL ${serverPath} failed: ${res.status}`);
  }
  return res.status !== 405 && res.status !== 301;
}

async function prepareFolderRoot(name) {
  const finalRoot = appendPath(CURRENT_PATH, name);
  const created = await ensureDir(finalRoot);
  if (created) {
    return { uploadRoot: finalRoot, finalRoot, staged: false };
  }

  if (!confirm(`Replace existing folder "${name}"?`)) {
    return null;
  }

  const uploadRoot = appendPath(CURRENT_PATH, stagingFolderName(name));
  await ensureDir(uploadRoot);
  return { uploadRoot, finalRoot, staged: true };
}

async function finishFolderRoot(root) {
  if (!root || !root.staged) return true;
  const res = await authFetch(root.uploadRoot, {
    method: "MOVE",
    headers: {
      "Destination": root.finalRoot,
      "Overwrite": "T",
    },
  });
  if (res.ok || res.status === 201 || res.status === 204) return true;

  try {
    await authFetch(root.uploadRoot, { method: "DELETE" });
  } catch {
    if (authRedirecting) return false;
    // Best-effort cleanup; leave the staging folder visible if delete fails.
  }
  alert("Could not replace folder: " + res.status);
  return false;
}

function putBlob(url, blob, callbacks = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let uploadComplete = false;
    let stallTimer = null;
    let responseTimer = null;

    const clearTimers = () => {
      clearTimeout(stallTimer);
      clearTimeout(responseTimer);
    };
    const fail = message => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(new Error(message));
    };
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      if (blob.size === 0) return;
      stallTimer = setTimeout(() => {
        if (!settled && !uploadComplete) callbacks.onStalled?.();
      }, UPLOAD_STALL_MS);
    };

    xhr.upload.addEventListener("loadstart", () => {
      callbacks.onStart?.();
      armStallTimer();
    });
    xhr.upload.addEventListener("progress", event => {
      const loaded = Math.min(blob.size, event.loaded);
      callbacks.onProgress?.(loaded, event.lengthComputable ? event.total : blob.size);
      if (loaded >= blob.size) {
        clearTimeout(stallTimer);
      } else {
        armStallTimer();
      }
    });
    xhr.upload.addEventListener("load", () => {
      uploadComplete = true;
      clearTimeout(stallTimer);
      callbacks.onProgress?.(blob.size, blob.size);
      callbacks.onUploaded?.();
      responseTimer = setTimeout(() => {
        if (!settled) callbacks.onResponseWait?.();
      }, UPLOAD_STALL_MS);
    });

    xhr.addEventListener("load", () => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (xhr.status === 401 || isLoginResponseUrl(xhr.responseURL)) {
        redirectToLogin();
        reject(new Error("authentication required"));
      } else if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr);
      } else {
        reject(httpStatusError(xhr.status));
      }
    });
    xhr.addEventListener("error", () => fail("network error"));
    xhr.addEventListener("abort", () => fail("aborted"));
    xhr.addEventListener("timeout", () => fail("timeout"));

    xhr.open("PUT", url, true);
    xhr.send(blob);
  });
}

// ── Core: upload a single File to destDir on the server ───────────────────────
async function uploadFile(file, destDir) {
  const label = destDir !== CURRENT_PATH
    ? destDir.slice(CURRENT_PATH.length) + file.name
    : file.name;
  const ui = addUploadItem(label);
  showPanel();
  await nextPaint();

  const chunkSize = chunkSizeForFile(file.size);
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

  let sessionId;
  try {
    ui.setStatus("Creating upload session...");
    const res = await withUploadRetries(async () => {
      const initRes = await authFetch("/_upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, total_chunks: totalChunks, chunk_size: chunkSize, dir: destDir }),
      });
      if (!initRes.ok) throw httpStatusError(initRes.status, "init failed " + initRes.status);
      return initRes;
    }, { label: "Upload session", ui });
    ({ session_id: sessionId } = await res.json());
  } catch (e) {
    if (authRedirecting) return false;
    ui.setError(e.message);
    return false;
  }

  const concurrency = getConcurrency();
  const chunkLoaded = new Array(totalChunks).fill(0);
  let loadedBytes = 0;

  function noteChunkLoaded(i, loaded, chunkSize) {
    const nextLoaded = Math.max(chunkLoaded[i], Math.min(chunkSize, loaded));
    loadedBytes += nextLoaded - chunkLoaded[i];
    chunkLoaded[i] = nextLoaded;
    const pct = file.size === 0
      ? UPLOAD_PROGRESS_CAP
      : Math.min(UPLOAD_PROGRESS_CAP, (loadedBytes / file.size) * UPLOAD_PROGRESS_CAP);
    ui.setProgress(pct);
  }

  async function uploadChunk(i) {
    const start = i * chunkSize;
    const slice = file.slice(start, start + chunkSize);
    try {
      await withUploadRetries(() => putBlob(`/_upload/${sessionId}/${i}`, slice, {
        onStart() {
          ui.setProcessing(false);
          ui.setStatus(`Starting chunk ${i + 1}/${totalChunks}...`);
        },
        onProgress(loaded) {
          ui.setProcessing(false);
          noteChunkLoaded(i, loaded, slice.size);
          ui.setStatus("Uploading...");
        },
        onStalled() {
          ui.setProcessing(true);
          ui.setStatus("Processing upload...");
        },
        onUploaded() {
          ui.setProcessing(true);
          noteChunkLoaded(i, slice.size, slice.size);
          ui.setStatus("Waiting for server response...");
        },
        onResponseWait() {
          ui.setProcessing(true);
          ui.setStatus("Still processing...");
        },
      }), { label: `Chunk ${i + 1}/${totalChunks}`, ui });
      noteChunkLoaded(i, slice.size, slice.size);
    } finally {
      ui.setProcessing(false);
    }
  }

  try {
    let nextChunk = 0;
    async function uploadWorker() {
      while (nextChunk < totalChunks) {
        const chunkIndex = nextChunk;
        nextChunk += 1;
        await uploadChunk(chunkIndex);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, totalChunks); i++) {
      workers.push(uploadWorker());
    }
    await Promise.all(workers);
  } catch (e) {
    if (authRedirecting) return false;
    ui.setError(e.message);
    return false;
  }

  try {
    ui.setStatus("Finalizing...");
    await withUploadRetries(async () => {
      const res = await authFetch(`/_upload/${sessionId}/complete`, { method: "POST" });
      if (!res.ok) throw httpStatusError(res.status, "complete → " + res.status);
      return res;
    }, { label: "Finalizing upload", ui });
  } catch (e) {
    if (authRedirecting) return false;
    ui.setError(e.message);
    return false;
  }

  ui.setDone();
  return true;
}

// ── Folder traversal via FileSystem API ───────────────────────────────────────
async function collectEntries(dirEntry, serverBase) {
  // Returns [{file, destDir}]
  const results = [];
  const reader = dirEntry.createReader();

  async function readAll() {
    return new Promise((resolve, reject) => {
      let all = [];
      function batch() {
        reader.readEntries(entries => {
          if (!entries.length) return resolve(all);
          all = all.concat([...entries]);
          batch();
        }, reject);
      }
      batch();
    });
  }

  const entries = await readAll();
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      results.push({ file, destDir: serverBase });
    } else if (entry.isDirectory) {
      const childBase = appendPath(serverBase, entry.name);
      await ensureDir(childBase);
      const sub = await collectEntries(entry, childBase);
      results.push(...sub);
    }
  }
  return results;
}

// ── Upload a list of {file, destDir} pairs — N files in parallel ──────────────
async function uploadPairs(pairs, { reload = true } = {}) {
  let anySuccess = false;
  const concurrency = getConcurrency();

  // Process files in batches of `concurrency`
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency).map(async ({ file, destDir }) => {
      const ok = await uploadFile(file, destDir);
      if (ok) anySuccess = true;
    });
    await Promise.all(batch);
  }

  if (anySuccess && reload) {
    pendingReload = true;
    setTimeout(() => location.reload(), 600);
  }
  return anySuccess;
}

// ── Handle flat File[] from input[type=file] ──────────────────────────────────
async function uploadFlatFiles(files) {
  if (!CAN_WRITE) {
    warnReadOnly("uploads");
    return;
  }
  const pairs = [...files].map(f => ({ file: f, destDir: CURRENT_PATH }));
  await uploadPairs(pairs);
}

// ── Handle folder from input[webkitdirectory] ─────────────────────────────────
async function uploadFolderInput(files) {
  if (!CAN_WRITE) {
    warnReadOnly("uploads");
    return;
  }
  if (!files.length) return;
  // files[0].webkitRelativePath gives "folderName/sub/file.txt"
  const rootName = files[0].webkitRelativePath.split("/")[0];
  const root = await prepareFolderRoot(rootName);
  if (!root) return;

  const pairs = [];
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/");
    // Build intermediate dirs
    let cur = root.uploadRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      if (i > 0) {
        cur = appendPath(cur, parts[i]);
        await ensureDir(cur);
      }
    }
    pairs.push({ file, destDir: cur });
  }
  const ok = await uploadPairs(pairs, { reload: false });
  if (ok && await finishFolderRoot(root)) {
    pendingReload = true;
    setTimeout(() => location.reload(), 600);
  }
}

// ── Handle DataTransfer items (supports folders via FileSystem API) ────────────
async function uploadDataTransfer(dt) {
  if (!CAN_WRITE) {
    warnReadOnly("uploads");
    return;
  }
  const items = [...dt.items].filter(i => i.kind === "file");
  if (!items.length) return;

  const pairs = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) {
      const root = await prepareFolderRoot(entry.name);
      if (!root) continue;
      const sub = await collectEntries(entry, root.uploadRoot);
      pairs.push(...sub);
      pairs.push({ folderRoot: root });
    } else {
      const file = item.getAsFile();
      if (file) pairs.push({ file, destDir: CURRENT_PATH });
    }
  }

  const folderRoots = pairs.filter(p => p.folderRoot).map(p => p.folderRoot);
  const filePairs = pairs.filter(p => p.file);
  const ok = await uploadPairs(filePairs, { reload: false });
  let finished = true;
  for (const root of folderRoots) {
    finished = await finishFolderRoot(root) && finished;
  }
  if ((ok || folderRoots.length) && finished) {
    pendingReload = true;
    setTimeout(() => location.reload(), 600);
  }
}

// ── File input buttons ─────────────────────────────────────────────────────────
const fileInput = document.getElementById("file-input");
const folderInput = document.getElementById("folder-input");

document.getElementById("upload-btn").addEventListener("click", () => {
  if (!CAN_WRITE) {
    warnReadOnly("uploads");
    return;
  }
  fileInput.click();
});
document.getElementById("upload-folder-btn").addEventListener("click", () => {
  if (!CAN_WRITE) {
    warnReadOnly("uploads");
    return;
  }
  folderInput.click();
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length) uploadFlatFiles(fileInput.files);
  fileInput.value = "";
});

folderInput.addEventListener("change", () => {
  if (folderInput.files.length) uploadFolderInput(folderInput.files);
  folderInput.value = "";
});

// ── Drag and drop ──────────────────────────────────────────────────────────────
const dropZone = document.getElementById("drop-zone");
let dragCounter = 0;

dropZone.addEventListener("dragenter", e => {
  e.preventDefault();
  dragCounter++;
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => {
  dragCounter--;
  if (dragCounter === 0) dropZone.classList.remove("dragging");
});

dropZone.addEventListener("dragover", e => e.preventDefault());

dropZone.addEventListener("drop", async e => {
  e.preventDefault();
  dragCounter = 0;
  dropZone.classList.remove("dragging");
  await uploadDataTransfer(e.dataTransfer);
});
