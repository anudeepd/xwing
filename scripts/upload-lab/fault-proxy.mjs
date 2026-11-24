/**
 * Corporate-proxy fault lab.
 *
 * Run the browser through this HTTP forward proxy and set one of its modes to
 * reproduce the failures an enterprise DLP gateway causes:
 *
 * - drop upload requests before they reach the app
 * - reject bodies above a byte limit
 * - hold request bodies before forwarding them
 * - hold responses after the app has answered
 * - return an HTML login page
 *
 * Control the proxy directly on its listening port:
 *
 *   POST /__config
 *   GET  /__events
 *   POST /__reset
 */

import http from "node:http";
import { fileURLToPath } from "node:url";

const DEFAULT_UPSTREAM = { host: "127.0.0.1", port: 8990 };
const DEFAULT_UPLOAD_PATH = "/_upload/";

function defaultConfig() {
  return {
    upstream: { ...DEFAULT_UPSTREAM },
    uploadPath: DEFAULT_UPLOAD_PATH,
    dropContentTypePrefix: "",
    dropPathIncludes: "",
    dropMethod: "",
    maxBodyBytes: 0,
    holdRequestMs: 0,
    holdResponseMs: 0,
    htmlStatus: 0,
    htmlBody: "<html><body>Blocked by corporate proxy</body></html>",
    rejectStatus: 0,
    rejectBody: "",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("control body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function applyFaults(config, req, path) {
  const upload = path.includes(config.uploadPath);
  if (!upload) return null;
  const contentType = String(req.headers["content-type"] || "");
  if (
    config.dropContentTypePrefix &&
    contentType.startsWith(config.dropContentTypePrefix)
  ) {
    return { kind: "drop", reason: `content-type ${config.dropContentTypePrefix}` };
  }
  if (config.dropMethod && req.method === config.dropMethod) {
    return { kind: "drop", reason: `method ${config.dropMethod}` };
  }
  if (config.dropPathIncludes && path.includes(config.dropPathIncludes)) {
    return { kind: "drop", reason: `path ${config.dropPathIncludes}` };
  }
  if (config.maxBodyBytes) {
    const length = Number(req.headers["content-length"] || 0);
    if (length > config.maxBodyBytes) {
      return { kind: "reject", reason: `body ${length} > ${config.maxBodyBytes}` };
    }
  }
  if (config.htmlStatus) {
    return { kind: "html", reason: `synthetic ${config.htmlStatus}` };
  }
  if (config.rejectStatus) {
    return { kind: "reject", reason: `synthetic ${config.rejectStatus}` };
  }
  return null;
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createFaultProxy({ upstream = DEFAULT_UPSTREAM } = {}) {
  const config = defaultConfig();
  config.upstream = { ...upstream };
  const events = [];

  const record = event => {
    events.push({ at: Date.now(), ...event });
    if (events.length > 500) events.shift();
  };

  const server = http.createServer(async (req, res) => {
    let targetUrl;
    try {
      targetUrl = new URL(req.url, `http://${req.headers.host || "proxy.local"}`);
    } catch {
      res.writeHead(400);
      res.end("bad request URL");
      return;
    }

    if (targetUrl.pathname === "/__config" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const patch = JSON.parse(body.toString("utf8"));
        Object.assign(config, patch);
        if (patch.upstream) config.upstream = { ...upstream, ...patch.upstream };
        record({ type: "config", config: { ...config } });
        writeJson(res, 200, { ok: true, config });
      } catch (error) {
        writeJson(res, 400, { error: String(error) });
      }
      return;
    }
    if (targetUrl.pathname === "/__events" && req.method === "GET") {
      writeJson(res, 200, { events });
      return;
    }
    if (targetUrl.pathname === "/__reset" && req.method === "POST") {
      Object.assign(config, defaultConfig());
      config.upstream = { ...upstream };
      events.length = 0;
      writeJson(res, 200, { ok: true });
      return;
    }

    const path = targetUrl.pathname + targetUrl.search;
    const fault = applyFaults(config, req, path);
    if (fault?.kind === "drop") {
      record({
        type: "drop",
        method: req.method,
        path,
        contentType: req.headers["content-type"] || "",
        reason: fault.reason,
      });
      req.socket.destroy();
      return;
    }
    if (fault?.kind === "reject") {
      const status = config.rejectStatus || 413;
      const body = config.rejectBody || "Request Entity Too Large";
      record({ type: "reject", method: req.method, path, status, reason: fault.reason });
      req.resume();
      res.writeHead(status, {
        "content-type": "text/plain",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (fault?.kind === "html") {
      record({
        type: "html",
        method: req.method,
        path,
        status: config.htmlStatus,
        reason: fault.reason,
      });
      req.resume();
      res.writeHead(config.htmlStatus, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(config.htmlBody),
      });
      res.end(config.htmlBody);
      return;
    }

    const upload = path.includes(config.uploadPath);
    let body = null;
    if (upload && (config.holdRequestMs || config.maxBodyBytes)) {
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end("body too large");
        return;
      }
    }

    const sendUpstream = () => {
      const upstreamReq = http.request(
        {
          host: config.upstream.host,
          port: config.upstream.port,
          method: req.method,
          path,
          headers: {
            ...req.headers,
            host: `${config.upstream.host}:${config.upstream.port}`,
            "x-lab-proxy": "fault-proxy",
          },
        },
        upstreamRes => {
          record({
            type: "response",
            method: req.method,
            path,
            status: upstreamRes.statusCode,
          });
          const finish = () => {
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          };
          if (upload && config.holdResponseMs) setTimeout(finish, config.holdResponseMs);
          else finish();
        },
      );
      upstreamReq.on("error", error => {
        record({ type: "upstream-error", path, error: String(error) });
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("upstream unavailable");
        }
      });
      if (body) upstreamReq.end(body);
      else req.pipe(upstreamReq);
    };

    record({
      type: "request",
      method: req.method,
      path,
      contentType: req.headers["content-type"] || "",
      length: Number(req.headers["content-length"] || 0),
    });
    if (upload && config.holdRequestMs) setTimeout(sendUpstream, config.holdRequestMs);
    else sendUpstream();
  });

  server.on("upgrade", (_req, socket) => socket.destroy());

  return {
    server,
    config,
    events,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const proxy = createFaultProxy({
    upstream: {
      host: process.env.FAULT_UPSTREAM_HOST || DEFAULT_UPSTREAM.host,
      port: Number(process.env.FAULT_UPSTREAM_PORT || DEFAULT_UPSTREAM.port),
    },
  });
  const port = Number(process.env.FAULT_PORT || 8995);
  await proxy.listen(port);
  console.log(`fault proxy listening on http://127.0.0.1:${port}`);
  console.log(`control: curl -X POST http://127.0.0.1:${port}/__config -d '{...}'`);
}
