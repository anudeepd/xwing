import type { UploadItem, UploadSnapshot, UploadStatus } from "./upload-manager";

const WORKING_STATUSES: Partial<Record<UploadStatus, true>> = {
  queued: true,
  preparing: true,
  uploading: true,
  retrying: true,
};

const STATUS_LABELS: Record<UploadStatus, string> = {
  queued: "Waiting to upload",
  preparing: "Preparing…",
  uploading: "Uploading…",
  retrying: "Retrying…",
  completed: "Upload complete",
  failed: "Upload failed",
  cancelled: "Upload cancelled",
};

export function isWorking(item: UploadItem): boolean {
  return WORKING_STATUSES[item.status] === true;
}

export function uploadSummary(snapshot: UploadSnapshot): string {
  const working = snapshot.items.filter(isWorking).length;
  if (working) return `${working} uploading`;
  const failed = snapshot.items.filter(item => item.status === "failed").length;
  if (failed) return `${failed} failed`;
  const cancelled = snapshot.items.filter(item => item.status === "cancelled").length;
  if (cancelled) return `${cancelled} cancelled`;
  const completed = snapshot.items.filter(item => item.status === "completed").length;
  return `${completed} complete`;
}

export function uploadSummaryKind(snapshot: UploadSnapshot): "active" | "error" | "muted" | "complete" {
  if (snapshot.items.some(isWorking)) return "active";
  if (snapshot.items.some(item => item.status === "failed")) return "error";
  if (snapshot.items.some(item => item.status === "cancelled")) return "muted";
  return "complete";
}

export function uploadItemLabel(item: UploadItem): string {
  if (item.error) return item.error;
  // A DLP scanner (ForcePoint, Menlo) holds the response after the browser has
  // finished sending. Say so instead of showing a frozen "Uploading…".
  if (item.status === "uploading" && item.phase === "processing") return "Waiting for server…";
  if (item.status === "uploading" && item.phase === "finalizing") return "Finalizing…";
  return STATUS_LABELS[item.status];
}
