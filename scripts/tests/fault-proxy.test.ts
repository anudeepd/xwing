import { describe, expect, it } from "vitest";

import { applyFaults } from "../upload-lab/fault-proxy.mjs";

function config(overrides: Record<string, unknown> = {}) {
  return {
    uploadPath: "/_upload/",
    dropContentTypePrefix: "",
    dropPathIncludes: "",
    dropMethod: "",
    maxBodyBytes: 0,
    holdRequestMs: 0,
    holdResponseMs: 0,
    htmlStatus: 0,
    htmlBody: "blocked",
    rejectStatus: 0,
    rejectBody: "",
    ...overrides,
  };
}

function request(method = "POST", contentType = "application/octet-stream", length = 10) {
  return {
    method,
    headers: {
      "content-type": contentType,
      "content-length": String(length),
    },
  };
}

describe("fault proxy matching", () => {
  it("drops an upload by content type but leaves init alone", () => {
    const settings = config({ dropContentTypePrefix: "application/octet-stream" });
    expect(applyFaults(settings, request(), "/_upload/id/chunk")).toMatchObject({
      kind: "drop",
    });
    expect(applyFaults(settings, request("POST", "application/json", 20), "/_upload/init")).toBeNull();
  });

  it("drops only the configured path and method", () => {
    expect(
      applyFaults(config({ dropMethod: "PUT" }), request("PUT"), "/_upload/id/chunk"),
    ).toMatchObject({ kind: "drop" });
    expect(
      applyFaults(config({ dropPathIncludes: "chunk" }), request(), "/_upload/id/chunk"),
    ).toMatchObject({ kind: "drop" });
  });

  it("rejects a body above the cap", () => {
    expect(
      applyFaults(config({ maxBodyBytes: 1024 }), request("POST", "application/octet-stream", 2048), "/_upload/id/chunk"),
    ).toMatchObject({ kind: "reject" });
    expect(
      applyFaults(config({ maxBodyBytes: 1024 }), request("POST", "application/octet-stream", 1024), "/_upload/id/chunk"),
    ).toBeNull();
  });

  it("can synthesize a login page or a custom status", () => {
    expect(
      applyFaults(config({ htmlStatus: 200 }), request(), "/_upload/id/chunk"),
    ).toMatchObject({ kind: "html" });
    expect(
      applyFaults(config({ rejectStatus: 503 }), request(), "/_upload/id/chunk"),
    ).toMatchObject({ kind: "reject" });
  });

  it("does not interfere with folder creation or ordinary page requests", () => {
    const settings = config({
      dropContentTypePrefix: "application/octet-stream",
      maxBodyBytes: 1,
    });
    expect(applyFaults(settings, request("MKCOL", "", 0), "/docs/")).toBeNull();
    expect(applyFaults(settings, request("GET", "text/html", 0), "/")).toBeNull();
  });
});
