import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToHex, sha256Blob, sha256Bytes } from "../../xwing/frontend/src/sha256.js";

function expected(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("upload chunk hashing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("falls back to FileReader when Blob.arrayBuffer is unavailable", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    class Reader {
      result: ArrayBuffer | null = bytes.buffer;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsArrayBuffer(): void {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("FileReader", Reader);
    expect(
      await sha256Blob({ arrayBuffer: undefined } as unknown as Blob, null),
    ).toBe(expected(bytes));
  });

  it("reports a FileReader failure", async () => {
    class Reader {
      result: ArrayBuffer | null = null;
      error = new Error("read failed");
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsArrayBuffer(): void {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("FileReader", Reader);
    await expect(
      sha256Blob({ arrayBuffer: undefined } as unknown as Blob, null),
    ).rejects.toThrow("read failed");
  });

  it("uses a fallback message when FileReader reports no error", async () => {
    class Reader {
      result: ArrayBuffer | null = null;
      error = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsArrayBuffer(): void {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("FileReader", Reader);
    await expect(
      sha256Blob({ arrayBuffer: undefined } as unknown as Blob, null),
    ).rejects.toThrow("Could not read upload chunk");
  });
});
