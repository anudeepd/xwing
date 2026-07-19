import { describe, expect, it } from "vitest";
import { encodePath, parseBootstrap } from "../../xwing/frontend/src/types";

const payload = {
  version: 1,
  path: "/release notes/日本語",
  breadcrumbs: [{ name: "workspace", path: "/" }],
  user: { name: "alice", authenticated: true },
  permissions: { read: true, write: true, delete: true },
  files: [{ name: "</script> 日本語.txt", path: "/%3C%2Fscript%3E%20%E6%97%A5%E6%9C%AC%E8%AA%9E.txt", kind: "file", size: 4, modified: null, editable: true }],
  upload: { chunkSize: 1024, parallelDefault: 4 },
};

describe("directory contract", () => {
  it("validates versioned payloads including hostile and Unicode names", () => {
    expect(parseBootstrap(payload).files[0]?.name).toBe("</script> 日本語.txt");
  });

  it("rejects malformed payloads", () => {
    expect(() => parseBootstrap({ ...payload, version: 2 })).toThrow("Unsupported");
    expect(() => parseBootstrap({ ...payload, files: [{ name: 4 }] })).toThrow("Invalid file entry");
  });

  it("encodes decoded path segments exactly once", () => {
    expect(encodePath("/release notes/日本語")).toBe("/release%20notes/%E6%97%A5%E6%9C%AC%E8%AA%9E");
    expect(encodePath("/release%20notes/%E6%97%A5%E6%9C%AC%E8%AA%9E")).toBe("/release%20notes/%E6%97%A5%E6%9C%AC%E8%AA%9E");
  });
});
