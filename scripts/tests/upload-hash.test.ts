import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { bytesToHex, sha256Blob, sha256Bytes } from "../../xwing/frontend/src/sha256.js";

function expected(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("upload chunk hashing", () => {
  it("matches Node crypto for the empty input and every length around a block boundary", async () => {
    for (const size of [0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 129, 1000, 65536]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 17 + 3) & 0xff);
      expect(bytesToHex(sha256Bytes(bytes))).toBe(expected(bytes));
      expect(await sha256Blob(new Blob([bytes]), null)).toBe(expected(bytes));
    }
  });

  it("uses WebCrypto when it is available", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const subtle = {
      digest: async () => createHash("sha256").update(bytes).digest(),
    };
    expect(await sha256Blob(new Blob([bytes]), subtle as SubtleCrypto)).toBe(expected(bytes));
  });
});
