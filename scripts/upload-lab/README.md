# Upload fault lab

`fault-proxy.mjs` is an HTTP forward proxy that reproduces the proxy failures
that matter to browser uploads.

Run it directly:

```bash
node scripts/upload-lab/fault-proxy.mjs
```

It listens on `127.0.0.1:8995` and forwards to `127.0.0.1:8990`.

Configure a fault directly against the proxy:

```bash
# Drop raw binary upload POSTs but allow multipart.
curl -X POST http://127.0.0.1:8995/__config \
  -H 'Content-Type: application/json' \
  -d '{"dropContentTypePrefix":"application/octet-stream"}'

# Reject bodies over 1 MiB.
curl -X POST http://127.0.0.1:8995/__config \
  -H 'Content-Type: application/json' \
  -d '{"maxBodyBytes":1048576}'

# Hold each upload body for 1.5 seconds.
curl -X POST http://127.0.0.1:8995/__config \
  -H 'Content-Type: application/json' \
  -d '{"holdRequestMs":1500}'

# Return a login page with HTTP 200.
curl -X POST http://127.0.0.1:8995/__config \
  -H 'Content-Type: application/json' \
  -d '{"htmlStatus":200}'

curl http://127.0.0.1:8995/__events
curl -X POST http://127.0.0.1:8995/__reset
```

Point a browser at the proxy and open `http://xwing.test:8990/`. The proxy
rewrites the upstream host, so `xwing.test` does not need DNS.

The automated matrix is in `scripts/e2e/upload-fault.spec.ts` and runs under the
`chromium-upload` and `webkit-upload` Playwright projects.

## Soak and large-file checks

The fault proxy holds one configuration at a time. A repeated run must use one
worker per browser project, otherwise one test can change the fault mode while
another test is using it.

```bash
XWING_E2E_QUIET=1 npm --prefix scripts run test:e2e -- \
  --project=chromium-upload upload-fault.spec.ts \
  --repeat-each=100 --workers=1 --reporter=dot

XWING_E2E_QUIET=1 npm --prefix scripts run test:e2e -- \
  --project=webkit-upload upload-fault.spec.ts \
  --repeat-each=100 --workers=1 --reporter=dot
```

The proxy-cap test accepts a file size, body limit and optional per-request
hold from the environment:

```bash
XWING_E2E_QUIET=1 \
XWING_FAULT_CAP_BYTES=1073741824 \
XWING_FAULT_BODY_CAP=1048576 \
XWING_FAULT_CAP_HOLD_MS=0 \
npm --prefix scripts run test:e2e -- \
  --project=chromium-upload upload-fault.spec.ts \
  -g "body cap shrinks" --repeat-each=5 --workers=1 --reporter=line
```

Set `XWING_FAULT_BODY_CAP=0` for the direct baseline. The test prints
`[upload-perf]` with upload-only elapsed milliseconds.
