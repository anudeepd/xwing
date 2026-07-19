import type { UploadItem, UploadSnapshot, UploadStatus } from "./upload-manager";

const WORKING = new Set<UploadStatus>(["queued", "preparing", "uploading", "retrying"]);

export function uploadSummary(snapshot: UploadSnapshot): string {
  const working = snapshot.items.filter(item => WORKING.has(item.status)).length;
  if (working) return `${working} uploading`;
  const failed = snapshot.items.filter(item => item.status === "failed").length;
  if (failed) return `${failed} failed`;
  const cancelled = snapshot.items.filter(item => item.status === "cancelled").length;
  if (cancelled) return `${cancelled} cancelled`;
  const completed = snapshot.items.filter(item => item.status === "completed").length;
  return `${completed} complete`;
}

export function uploadSummaryKind(snapshot: UploadSnapshot): "active" | "error" | "muted" | "complete" {
  if (snapshot.items.some(item => WORKING.has(item.status))) return "active";
  if (snapshot.items.some(item => item.status === "failed")) return "error";
  if (snapshot.items.some(item => item.status === "cancelled")) return "muted";
  return "complete";
}

export function uploadItemLabel(item: UploadItem): string {
  if (item.error) return item.error;
  const labels: Record<UploadStatus, string> = {
    queued: "Waiting to upload",
    preparing: "Preparing…",
    uploading: "Uploading…",
    retrying: "Retrying…",
    completed: "Upload complete",
    failed: "Upload failed",
    cancelled: "Upload cancelled",
  };
  return labels[item.status];
}
