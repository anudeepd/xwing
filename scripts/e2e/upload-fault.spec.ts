import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "./coverage-fixture";
import type { Browser, BrowserContext, Page } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 30_000 });

const fixtureDir = path.resolve(process.cwd(), ".e2e-upload");
const uploaded: string[] = [];

function proxyPort(projectName: string): number {
  return projectName === "webkit-upload" ? 8996 : 8995;
}

async function configure(port: number, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/__config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.ok).toBe(true);
}

async function pageThroughProxy(
  browser: Browser,
  port: number,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    proxy: { server: `http://127.0.0.1:${port}` },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto("http://xwing.test:8994/");
  await expect(page.getByLabel("Files and folders")).toBeVisible();
  return { context, page };
}

async function uploadAndWait(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  const dock = page.getByRole("complementary", { name: "Uploads" });
  await expect(dock).toContainText("1 complete", { timeout: 120_000 });
}

async function expectFixture(name: string, bytes: Buffer): Promise<void> {
  const actual = await readFile(path.join(fixtureDir, name));
  expect(createHash("sha256").update(actual).digest("hex")).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  uploaded.push(path.join(fixtureDir, name));
}

function probeBytes(size: number, seed: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + seed) & 0xff;
  }
  return bytes;
}

async function writeProbeFile(filePath: string, size: number, seed: number): Promise<string> {
  const handle = await open(filePath, "w");
  const hash = createHash("sha256");
  const block = Buffer.alloc(Math.min(size, 1024 * 1024));
  try {
    for (let offset = 0; offset < size; offset += block.length) {
      const length = Math.min(block.length, size - offset);
      for (let index = 0; index < length; index += 1) {
        block[index] = ((offset + index) * 31 + seed) & 0xff;
      }
      const view = block.subarray(0, length);
      hash.update(view);
      await handle.write(view);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

test.afterEach(async () => {
  const port = proxyPort(test.info().project.name);
  await fetch(`http://127.0.0.1:${port}/__reset`, { method: "POST" }).catch(() => {});
  while (uploaded.length) {
    await unlink(uploaded.pop()!).catch(() => {});
  }
});

test("a dropped binary POST falls back to multipart and lands intact", async ({ browser }) => {
  const port = proxyPort(test.info().project.name);
  await configure(port, { dropContentTypePrefix: "application/octet-stream" });
  const { context, page } = await pageThroughProxy(browser, port);
  const name = `fault-fallback-${Date.now()}.bin`;
  const bytes = probeBytes(2 * 1024 * 1024, 7);

  await uploadAndWait(page, name, bytes);
  await expectFixture(name, bytes);

  const events = await fetch(`http://127.0.0.1:${port}/__events`).then(r => r.json()) as {
    events: Array<{ type: string; contentType?: string }>;
  };
  expect(events.events.some(event => event.type === "drop")).toBe(true);
  expect(
    events.events.some(
      event => event.type === "request" && event.contentType?.startsWith("multipart/form-data"),
    ),
  ).toBe(true);
  await context.close();
});

test("a 1 MiB proxy body cap shrinks the window and completes", async ({ browser }) => {
  test.setTimeout(180_000);
  const port = proxyPort(test.info().project.name);
  const bodyCap = Number(process.env.XWING_FAULT_BODY_CAP ?? 1024 * 1024);
  const capHoldMs = Number(process.env.XWING_FAULT_CAP_HOLD_MS ?? 0);
  await configure(port, { maxBodyBytes: bodyCap, holdRequestMs: capHoldMs });
  const { context, page } = await pageThroughProxy(browser, port);
  const name = `fault-limit-${Date.now()}.bin`;
  const limitBytes = Number(process.env.XWING_FAULT_CAP_BYTES || 1536 * 1024);
  const source = path.join(tmpdir(), name);
  uploaded.push(source);
  const streamed = limitBytes > 64 * 1024 * 1024;
  const bytes = streamed ? null : probeBytes(limitBytes, 11);
  const expectedHash = streamed
    ? await writeProbeFile(source, limitBytes, 11)
    : (await writeFile(source, bytes!), createHash("sha256").update(bytes!).digest("hex"));

  const started = Date.now();
  await page.locator('input[type="file"]').first().setInputFiles(source);
  const dock = page.getByRole("complementary", { name: "Uploads" });
  await expect(dock).toContainText("1 complete", { timeout: 180_000 });
  const elapsedMs = Date.now() - started;
  console.log(
    `[upload-perf] browser=${test.info().project.name} bytes=${limitBytes} bodyCap=${bodyCap} elapsedMs=${elapsedMs}`,
  );
  if (bytes) await expectFixture(name, bytes);
  else expect(await hashFile(path.join(fixtureDir, name))).toBe(expectedHash);
  await context.close();
});

test("a browser reload resumes from the server's committed ranges", async ({ browser }) => {
  test.setTimeout(60_000);
  const port = proxyPort(test.info().project.name);
  const { context, page } = await pageThroughProxy(browser, port);
  const name = `fault-reload-${Date.now()}.bin`;
  const bytes = probeBytes(16 * 1024 * 1024, 19);
  const source = path.join(tmpdir(), name);
  await writeFile(source, bytes);
  uploaded.push(source);

  await configure(port, { holdResponseMs: 6000 });
  await page.locator('input[type="file"]').first().setInputFiles(source);
  const dock = page.getByRole("complementary", { name: "Uploads" });
  await expect(dock).toContainText("Waiting for server", { timeout: 10_000 });
  await expect
    .poll(async () => {
      const events = await fetch(`http://127.0.0.1:${port}/__events`).then(r => r.json()) as {
        events: Array<{ type: string; path: string; status?: number }>;
      };
      return events.events.some(
        event =>
          event.type === "response" &&
          event.path.includes("/chunk?") &&
          event.status === 200,
      );
    }, { timeout: 10_000 })
    .toBe(true);

  // The server has committed the first window while the proxy holds its
  // response. Reload before the client can record that acknowledgement.
  const events = await fetch(`http://127.0.0.1:${port}/__events`).then(r => r.json()) as {
    events: Array<{ type: string; path: string }>;
  };
  const beforeReload = events.events.length;
  await configure(port, { holdResponseMs: 0 });
  await page.reload();
  await expect(page.getByLabel("Files and folders")).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles(source);
  await expect(dock).toContainText("1 complete", { timeout: 60_000 });
  await expectFixture(name, bytes);

  const after = await fetch(`http://127.0.0.1:${port}/__events`).then(r => r.json()) as {
    events: Array<{ type: string; path: string }>;
  };
  const chunksAfterReload = after.events
    .slice(beforeReload)
    .filter(event => event.type === "request" && event.path.includes("/chunk?"));
  expect(chunksAfterReload.length).toBeGreaterThan(0);
  expect(
    chunksAfterReload.some(event => new URL(event.path, "http://proxy").searchParams.get("offset") === "0"),
  ).toBe(false);
  await context.close();
});

test("a request body hold does not fail the upload", async ({ browser }) => {
  test.setTimeout(60_000);
  const port = proxyPort(test.info().project.name);
  const holdMs = Number(process.env.XWING_FAULT_HOLD_MS || 1500);
  await configure(port, { holdRequestMs: holdMs });
  const { context, page } = await pageThroughProxy(browser, port);
  const name = `fault-hold-${Date.now()}.bin`;
  const bytes = probeBytes(1024 * 1024, 13);

  await uploadAndWait(page, name, bytes);
  await expectFixture(name, bytes);
  await context.close();
});

test("a proxy login page fails clearly instead of hanging", async ({ browser }) => {
  const port = proxyPort(test.info().project.name);
  await configure(port, { htmlStatus: 200 });
  const { context, page } = await pageThroughProxy(browser, port);
  const bytes = probeBytes(1024 * 1024, 17);

  await page.locator('input[type="file"]').first().setInputFiles({
    name: `fault-login-${Date.now()}.bin`,
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  const dock = page.getByRole("complementary", { name: "Uploads" });
  await expect(dock).toContainText("failed", { timeout: 10_000 });
  await expect(dock).toContainText(/sign in|proxy/i);
  await context.close();
});
