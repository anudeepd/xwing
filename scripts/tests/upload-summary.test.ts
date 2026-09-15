import { describe, expect, it } from "vitest";

import type { UploadItem, UploadSnapshot, UploadStatus } from "../../xwing/frontend/src/upload-manager";
import { uploadItemLabel, uploadSummary, uploadSummaryKind } from "../../xwing/frontend/src/upload-summary";

function item(status: UploadStatus, error?: string): UploadItem {
  return {
    id: status,
    name: `${status}.txt`,
    relativePath: `${status}.txt`,
    destination: "/",
    size: 10,
    uploaded: status === "completed" ? 10 : 0,
    status,
    ...(error ? { error } : {}),
  };
}

function snapshot(...items: UploadItem[]): UploadSnapshot {
  return { items, active: 0, parallel: 4 };
}

describe("upload status copy", () => {
  it("describes every working state as an upload in progress", () => {
    const state = snapshot(
      item("queued"),
      item("preparing"),
      item("uploading"),
      item("retrying"),
    );

    expect(uploadSummary(state)).toBe("4 uploading");
    expect(uploadSummaryKind(state)).toBe("active");
  });

  it("uses concrete terminal summaries instead of a vague warning", () => {
    expect(uploadSummary(snapshot(item("failed")))).toBe("1 failed");
    expect(uploadSummaryKind(snapshot(item("failed")))).toBe("error");
    expect(uploadSummary(snapshot(item("cancelled")))).toBe("1 cancelled");
    expect(uploadSummaryKind(snapshot(item("cancelled")))).toBe("muted");
    expect(uploadSummary(snapshot(item("completed")))).toBe("1 complete");
    expect(uploadSummaryKind(snapshot(item("completed")))).toBe("complete");
  });

  it("reports a server-side wait without claiming the transfer failed", () => {
    // What a DLP scanner holding the response looks like: the browser has sent
    // the body and the server has not answered yet.
    expect(uploadItemLabel({ ...item("uploading"), phase: "processing" })).toBe(
      "Waiting for server…",
    );
    expect(uploadItemLabel({ ...item("uploading"), phase: "finalizing" })).toBe(
      "Finalizing…",
    );
    expect(uploadItemLabel({ ...item("uploading"), phase: "uploading" })).toBe("Uploading…");
  });

  it("turns internal states into user-facing item labels", () => {
    expect(uploadItemLabel(item("preparing"))).toBe("Preparing…");
    expect(uploadItemLabel(item("uploading"))).toBe("Uploading…");
    expect(uploadItemLabel(item("cancelled"))).toBe("Upload cancelled");
    expect(uploadItemLabel(item("failed", "Network unavailable"))).toBe("Network unavailable");
  });
});
