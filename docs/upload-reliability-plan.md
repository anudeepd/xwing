# X-wing Upload Reliability Plan

## Outcome

Make every browser upload complete intact across corporate DLP proxies, reverse proxies, flaky links, browser reloads, and server restarts without asking the user to retry. Match or beat copyparty on the same fault matrix, then move the transfer core to Rust without changing the browser contract.

The definition of done is a fault matrix, not a language choice:

- 100 fault runs per profile, with zero byte mismatches between the source and published file.
- Every transient profile completes without user action.
- A reload or server restart at 50 percent resumes with at most one chunk re-sent.
- A proxy that holds each request body for 10 seconds does not cause a visible failure.
- A proxy that caps request bodies at 1 MiB still completes the file.
- A proxy that returns `413`, `502`, `504`, an HTML block page, or a login redirect is detected and handled by the documented rule.
- Completion time is within 2.5 times the direct-path baseline at 10 seconds of per-request hold.
- Server memory stays flat as file size grows.

This plan does not promise that nothing can ever fail. It promises automatic recovery from a named fault set, a clear failure outside that set, and evidence for every claim.

## Implementation Status

PR-01 through PR-05 are implemented in the working tree as of 2026-11-24.

- The public `/_upload` routes use the durable range contract. The old v1
  `PUT /_upload/{id}?offset=N` returns `410` instead of falling through to the
  WebDAV file route.
- The browser tries typed binary `POST`, multipart `POST`, then `PUT`, and
  keeps the transport that survives the proxy. It starts at a 4 MiB canary,
  grows after clean acknowledgements, and shrinks on `413` or repeated
  transport drops.
- Each chunk carries SHA-256. A range is credited only after the digest matches.
- Session manifests persist under `.xwing-uploads`, so an app restart resumes
  the same ranges.
- A completed upload leaves a short-lived tombstone, making a lost `complete`
  response idempotent. Completed tombstones do not consume the active-session
  limit.
- The browser stores resumable session state in local storage, keyed by
  destination and file fingerprint.
- The upload engine no longer has a byte-identical Torrus dependency. The parity test is deleted.
- `scripts/upload-lab/fault-proxy.mjs` and `scripts/e2e/upload-fault.spec.ts`
  cover dropped requests, 1 MiB body caps, request holds and a login page.
- The Rust core remains deferred.

Verification completed locally:

- Python: 505 passed, 8 skipped, with 100% line coverage enforced.
- Frontend: 323 passed, with 100% line coverage enforced; TypeScript, ESLint
  and Ruff passed.
- Browser fault matrix: 10 passed on Chromium 140 and WebKit 26. Chrome fell
  back to multipart; WebKit kept binary `POST`; both completed a 1 MiB proxy
  ceiling, a held body, a real reload from committed ranges, and the
  login-page failure path.
- The reload test resumed at offset 4 MiB and sent no offset-zero chunk after
  the reload.
- A one-off 200 MiB file crossed a 1 MiB proxy body cap in 4.7 seconds on the
  local fault lab.
- A one-off 10-second hold on every upload request completed on Chromium and
  WebKit without a user retry.
- The full 100-repeat soak passed: Chromium 500/500 in 22.2 minutes and WebKit
  500/500 in 23.7 minutes, with no checksum mismatches. After the final
  AbortSignal cleanup, a 50-run stress pass on each browser also passed.
- On the final bundle, five 1 GiB direct runs measured 4.042 to 4.072 seconds.
  The capped runs had a 4.909-second median and a 5.911-second p95. The median
  was 1.21 times direct and the p95 was 1.45 times direct.
- During the 1 GiB capped run, server RSS rose from 47 MiB at startup to about
  61 MiB after warm-up and stayed between 61 and 62 MiB for the transfer.
- Full Playwright suite: 150 passed, 4 skipped across Chromium, Firefox and
  WebKit projects.
- The Sonar follow-up validates manifest-derived paths against the storage
  root, reconstructs staging paths from validated fields, removes path-bearing
  log messages, and fixes stale-progress handling and resume-record pruning.
- The daily workflow asserts the new default of 2. The older visual baselines
  explicitly select 4 before their screenshots, so they continue to protect
  layout rather than a product default.

Still open before the plan's full outcome gate: a live corporate-proxy capture.
The local soak, reload, 10-second hold, 200 MiB cap and five-run 1 GiB
performance checks are complete.

The original 2.5-times-direct target at a 10-second hold is not reachable for a
1 GiB file with two-way concurrency. The proxy alone imposes a 320-second floor
with 16 MiB windows, or 5,120 seconds with 1 MiB windows. The clean-path ratio
and the measured proxy floor are the useful numbers.

The PR notes later in this document preserve the build plan. Where they name
`/_upload/v2` or separate v2 files, the shipped implementation folded that
contract into the existing engine and unversioned routes.

## Recommendation

Do not start with a whole-application Rust rewrite. Do not lift copyparty wholesale.

Build protocol v2 and a fault-injection lab first. Ship a small transport compatibility patch while v2 is being built. Port the proven transfer core to Rust second. Keep the optional proxy-aware native uploader for the corporate cases the browser cannot control.

Rust is the right home for the long-term transfer core. It is not the first fix for the current symptom. A Rust server that receives the same raw `PUT`, with the same missing content type, the same 64 MiB by 4 concurrency, and the same 300-second acknowledgement wait will fail the same way in Chrome.

## What The Current Engine Does

The current implementation is not naive. It already has byte-range accounting, resumable sessions, adaptive chunk shrinking on `413`, a DLP-aware processing state, and idempotent range writes.

The remaining weak points are specific:

1. The browser sends raw `PUT` requests. `xwing/frontend/src/upload-engine.js:334` builds a `PUT`, and `xwing/frontend/src/upload-engine.js:626` sends `file.slice(...)`.
2. The slice has no explicit content type. A `Blob.slice` without a type has an empty type, so the browser does not set a useful `Content-Type` on the upload request. Corporate DLP products commonly classify, scan, or block by content type and filename. A raw, untyped `PUT` is a poor input for them.
3. The server advertises 64 MiB windows and the browser runs 4 of them. `xwing/upload_engine.py:45-48` sets the defaults, and `xwing/frontend/src/upload-manager.ts:201-229` applies the concurrency. That is up to 256 MiB in flight through a proxy that may scan each body.
4. The acknowledgement wait is long. `xwing/frontend/src/upload-engine.js:41-42` waits 120 seconds without byte movement and 300 seconds after the body is sent. A DLP hold therefore looks like a five-minute hang, then a retry that may trigger the same scan again.
5. `initWithRetry` does not retry. `xwing/frontend/src/upload-engine.js:254` makes one `POST /init` and throws on any failure. A transient proxy failure before the first byte fails the whole file.
6. Session state is memory only. `xwing/upload_engine.py:209-233` keeps sessions in a dictionary. A process restart, a second worker, or a load-balanced replica loses the session and forces a full restart.
7. The server credits byte counts, not content. `xwing/upload_engine.py:490-533` records a range after a successful stream, but no checksum proves the bytes survived the proxy. A same-length corruption is not detected.
8. A worker failure rejects the whole pass while peer workers may still be running. `xwing/frontend/src/upload-engine.js:750-766` uses `Promise.all`, so one failed window can fail the file while other requests continue.
9. The browser client does not persist a resumable session across a reload. `xwing/frontend/src/upload-manager.ts:41-56` keeps the session only in memory.

## What Copyparty Does Differently

Reviewed against copyparty master on 2026-11-24. Relevant source is `copyparty/web/up2k.js`, `copyparty/httpcli.py`, and `copyparty/up2k.py`.

- Chunks are sent as `POST` with an explicit `Content-Type: application/octet-stream`, not `PUT`.
- The client starts with a 42-second request timeout. While bytes move it extends the deadline. After the body is fully sent it drops to a 9-second acknowledgement wait and retries.
- The default parallel chunk count is 2, not 4.
- Each chunk carries a SHA-512 chunk hash. The server verifies the bytes and can reject a corrupted chunk.
- Upload state is persisted to disk, so a restart can resume.
- The handshake is retried indefinitely with backoff.
- A large chunk can be split into subchunks, and the server records the subchunk offset. A proxy body limit does not force a restart.
- The protocol is deliberately simple and idempotent. The client can ask the server which chunks are still missing.

Copyparty is MIT licensed, so borrowing is legal. Lifting it is not cheap. Its browser uploader is about 3,500 lines coupled to its UI globals, and its server side is several thousand lines coupled to its broker, virtual filesystem, and index. Copying that would import an architecture X-wing does not have. Borrow the protocol ideas, not the code.

## Why Not The Alternatives

| Option | What it actually fixes | Cost and risk | Verdict |
|---|---|---|---|
| Rewrite the server in Rust first | Server CPU, state, durability, packaging | Browser still sends the same requests; auth, WebDAV, admin, LDAP and packaging all move at once | Reject as first step |
| Lift copyparty's up2k engine | Transport behavior and persistence | Large coupled port, duplicated protocol, new maintenance surface, still a browser client | Reject |
| Protocol v2 in the current stack, then Rust transfer core | Proxy compatibility, recovery, integrity, then speed and durability | Two staged changes, but each has a clear gate | Recommended |
| Native Rust uploader with proxy profiles | Corporate proxy authentication, PAC, custom CAs, forced HTTP/1.1 | New client to build and support; does not fix the web UI | Keep as escape hatch |

The browser network stack is the deciding component in the current failure. Rust cannot change how Chrome frames an XHR, which proxy it uses, or how a DLP appliance scans a request. The protocol and client behavior must change first.

## Target Architecture

### Phase 1, protocol v2 in the current stack

```
Browser upload client
  -> POST binary, multipart, or PUT canary
  -> FastAPI control plane and transfer engine
  -> durable manifest plus staged file on the destination filesystem
```

This phase proves the protocol and fixes user pain without moving the application.

### Phase 2, Rust transfer core

```
Browser upload client
  -> FastAPI control plane for auth, UI, WebDAV, admin
  -> internal Unix socket or loopback connection
  -> Rust transfer service for sessions, checksums, writes, and publish
  -> local filesystem
```

The Python control plane remains the public surface and keeps authorization in one place. The Rust service is not public. It receives a short-lived signed upload grant from the control plane and rejects anything that does not match that grant.

If benchmarks show the Python proxy hop is material, the next step is to route
only `/_upload/*` directly to the Rust service through the deployment's reverse
proxy. That is a deployment optimization, not a requirement for correctness.

The Rust core is a pure library first. Its state machine, range set, manifest store, checksum verifier, and sink contract are testable without HTTP. The HTTP service is a thin shell over that library.

### Optional Phase 3, native uploader

A `xwing up` binary can use the same v2 protocol with system proxy discovery, manual proxy settings, PAC, proxy authentication, the OS trust store, and forced HTTP/1.1. Use the same product shape you described in Mister Download Manager: explicit proxy profiles, a visible connection method, and trust settings the user can inspect. It is a recovery path for a browser or proxy combination that cannot be fixed from JavaScript. It is not the default upload path.

## Protocol v2 (served at unversioned paths)

### Endpoints

```
POST   /_upload/init
POST   /_upload/{upload_id}/chunk
GET    /_upload/{upload_id}
POST   /_upload/{upload_id}/complete
DELETE /_upload/{upload_id}
```

The old v1 PUT raises `410 LEGACY_UPLOAD_REMOVED`. There is no long-term dual
protocol and no versioned path to migrate again.

### Init

The client sends:

```json
{
  "upload_key": "client-generated-stable-uuid",
  "filename": "report.zip",
  "size": 734003200,
  "dir": "/incoming",
  "fingerprint": {
    "name": "report.zip",
    "size": 734003200,
    "last_modified": 1764000000000
  },
  "capabilities": {
    "transports": ["binary_post", "multipart_post", "binary_put"],
    "digests": ["sha256"],
    "resume": true
  }
}
```

The server returns:

```json
{
  "upload_id": "32-hex",
  "state": "open",
  "size": 734003200,
  "ranges": [[0, 1048576]],
  "transport_order": ["binary_post", "multipart_post", "binary_put"],
  "chunk_policy": {
    "initial_bytes": 2097152,
    "max_bytes": 8388608,
    "max_concurrency": 2
  },
  "ack_timeout_ms": 20000,
  "expires_at": 1764003600
}
```

`upload_key` makes init idempotent. Retrying init returns the same session and the current ranges. A changed file fingerprint creates a new session.

### Chunk

The default transport is:

```
POST /_upload/{upload_id}/chunk?offset=4194304&sha256=<hex>&length=2097152&request_id=<uuid>
Content-Type: application/octet-stream
Content-Length: 2097152
Content-Disposition: attachment; filename*=UTF-8''report.zip
```

The multipart fallback uses the same endpoint and query parameters, with
`file` carrying the chunk. The PUT fallback sends the same query parameters to
the same endpoint. The server accepts whichever request shape reaches it.

The server:

1. Validates ownership, session state, offset, length, and digest format.
2. Streams the body into the staged file while hashing.
3. Credits the range only when the digest matches.
4. Persists the range after the data reaches stable storage.
5. Returns the full current range set and any transport advice.

An identical retry is idempotent. It returns the current state without duplicating data.

### Response and advice

```json
{
  "state": "open",
  "ranges": [[0, 6291456]],
  "received": 6291456,
  "next_offset": 6291456,
  "advice": {
    "transport": "multipart_post",
    "chunk_bytes": 1048576,
    "concurrency": 1,
    "wait_ms": 2000
  }
}
```

The server can steer the client after a proxy failure. The client can also learn from its own probes when the proxy is before the server.

### Durable state

One session manifest is written per upload under a hidden state directory:

```json
{
  "version": 2,
  "upload_id": "32-hex",
  "upload_key": "client-uuid",
  "user": "alice",
  "directory": "/incoming",
  "filename": "report.zip",
  "size": 734003200,
  "staged_path": ".report.zip.upload-part-32-hex",
  "state": "open",
  "ranges": [[0, 6291456, "sha256-base64"]],
  "created_at": 1764000000,
  "updated_at": 1764000100,
  "expires_at": 1764003600
}
```

The manifest is written to a temporary file, fsynced, renamed, and the directory is fsynced. A per-session lock prevents two workers from publishing the same session. Startup scans manifests, removes stale locks, and reconciles staged files.

The staged file stays beside the destination so publish remains a same-filesystem rename.

### State machine

```text
New -> Open -> Publishing -> Complete
        |          |
        +-> Failed +-> Failed
        |
        +-> Aborted
```

The server and client each use one explicit state machine. No scattered booleans for "sending", "waiting", "complete", and "failed".

### Client scheduler

The client uses additive increase and multiplicative decrease for concurrency and chunk size:

- Start with one in-flight 2 MiB request.
- After two clean acknowledgements, raise concurrency to 2.
- After another clean window, raise to the server maximum.
- Halve concurrency on a retryable failure.
- Halve chunk size on `413` or a body timeout.
- Never exceed the server maximum.
- Never cancel peer requests for a single-window failure. A supervisor decides whether the failure is fatal after all workers settle.

The first 2 MiB request is a real upload, not wasted probe traffic. Its success selects the transport. A network error, `413`, non-JSON 2xx, login redirect, or HTML block page moves to the next transport.

This treats the proxy as a measured runtime variable. The browser cannot read the operating system proxy configuration or PAC file, so it learns the usable transport and timing from actual requests instead of assuming one.

### Deadlines and retry

- No absolute five-minute wait.
- A request is abandoned after 20 seconds with no movement, or after the server's acknowledgement budget once the body is sent.
- The acknowledgement budget starts at 20 seconds, adapts to observed proxy scan time, and is capped at 60 seconds.
- Retries use jittered exponential backoff.
- Retryable: network error, `408`, `425`, `429`, `500`, `502`, `503`, `504`, timeout, truncated body.
- Shrink: `413`, body timeout with no acknowledgement.
- Session lost: `400` incomplete, `404`, `409`, `410`. Re-init once with the same upload key, then fail clearly.
- Auth: `401` or `403` triggers one auth refresh or re-login. If the response is an HTML login page, the client reports an expired session, not a network error.
- Fatal: permission denied, size over limit, destination missing, disk full.

### Integrity

Every chunk carries SHA-256. The server verifies before crediting the range. Final publish returns the whole-file SHA-256 computed during finalization. This catches proxy corruption, truncated writes, and local I/O faults.

Do not make the upload depend on `crypto.subtle`. WebCrypto is unavailable in plain-HTTP LAN deployments. Bundle a small SHA-256 WASM implementation with a JavaScript fallback, and use the same algorithm in Rust. BLAKE3 is faster, but it is not needed for 2 to 8 MiB chunks and adds another browser dependency.

### Resume across reload

The client stores the upload id, upload key, file fingerprint, destination, and last known ranges in IndexedDB. Dropping the same unchanged file after a reload resumes. A changed fingerprint starts a new upload. Session expiry is explained in the UI before a restart.

## Fault Lab

No protocol change ships without a reproducible failure and a reproducible recovery.

Build two test surfaces:

1. `fault-proxy`, a forward proxy the browser is configured to use. It can hold request bodies, hold responses, cap body size, return `413`, return `502`, return `504`, return an HTML block page, redirect to login, drop the connection at a chosen byte offset, duplicate requests, and reorder responses.
2. `tls-front`, a reverse proxy in front of X-wing that can terminate HTTP/1.1 or HTTP/2, buffer or stream request bodies, and inject the same faults.

Use Playwright with Chromium and WebKit first, Firefox third. Capture a real Safari and Chrome HAR on the corporate network as the final check.

### Matrix

| Variable | Values |
|---|---|
| File size | 20 MiB, 200 MiB, 1 GiB |
| Proxy body cap | none, 1 MiB, 8 MiB, 16 MiB, 64 MiB |
| Request-body hold | 0, 0.2, 2, 10, 60 seconds |
| Response hold | 0, 2, 10, 60 seconds |
| Connection loss | 10, 50, 90 percent of a request |
| Synthetic status | `200` HTML, `302` login, `413`, `429`, `500`, `502`, `504` |
| Server restart | before upload, at 50 percent, during finalize |
| Browser reload | before upload, at 50 percent |
| Transport | HTTP/1.1, HTTP/2 |
| Browser | Chromium, WebKit, Firefox |

### Baseline and acceptance

Record direct-path baseline first. Then run each fault profile 100 times for small files and 20 times for 1 GiB.

Acceptance:

- Zero hash mismatches.
- Every transient profile reaches `complete` without a manual retry.
- The client never reports success for a file the server has not verified.
- Retry storms are bounded. Duplicate bytes stay below 2 times the file size after a 50 percent drop.
- Reload and restart resume with at most one chunk re-sent.
- p95 wall time at 10-second request hold is within 2.5 times the direct baseline.
- Server resident memory is flat across file sizes.
- The failure message names the last real fault, not "Upload failed".

Run the same matrix against copyparty as a calibration point if practical. The target is not to copy its numbers. It is to be no worse on the same profiles and better on recovery and integrity.

## Work Plan

Each PR ends in a state that can be checked. Do not batch verification at the end.

### Dependency graph

```text
PR-01 fault lab and baseline
  |
  +-> PR-02 transport compatibility patch
  |
  +-> PR-03 protocol v2 server core and durable sessions
        |
        +-> PR-04 protocol v2 browser client and scheduler
              |
              +-> PR-05 resume, diagnostics, rollout, delete v1
        |
        +-> PR-06 Rust transfer core
              |
              +-> PR-07 Rust transfer service
                    |
                    +-> PR-08 cutover and packaging
                          |
                          +-> PR-09 optional native uploader
```

PR-02 can land independently of v2. PR-06 can start once the PR-03 contract is frozen. PR-09 is optional and only starts if the corporate browser path still fails after PR-05 and PR-08.

### PR-01, fault lab and baseline

**Change.** Add the forward proxy, TLS front, browser matrix, and baseline capture. No upload behavior changes.

**Files.** `scripts/e2e/upload-fault.spec.ts`, `scripts/upload-lab/fault-proxy.mjs`, `scripts/upload-lab/tls-front.mjs`, `scripts/tests/upload-diagnostics.test.ts`, `docs/upload-fault-matrix.md`.

**Verification.**

- [ ] Unit: each fault can be selected by name and produces the intended status or drop.
- [ ] Live: current v1 upload completes direct, fails or hangs under at least one documented fault, and the failure is captured.
- [ ] Live: Chrome and Safari HARs from the operator are attached with secrets removed.
- [x] Perf: direct-path 1 GiB baseline recorded on this machine.

**Result.** A repeatable baseline and the first honest answer about where the bytes stop.

### PR-02, transport compatibility patch

**Change.** Add a feature-flagged upload transport that uses `POST` with an explicit `application/octet-stream` content type and a filename-bearing header or multipart fallback. Retry init with jitter. Add configurable initial chunk size and concurrency. Do not change the v1 default until the lab proves the patch.

**Files.** `xwing/upload_engine.py`, `xwing/upload.py`, `xwing/frontend/src/upload-engine.js`, `xwing/frontend/src/upload-manager.ts`, `xwing/config.py`, tests and fixtures.

**Verification.**

- [ ] Unit: the patch sends a typed `POST`, retries init, and selects multipart after a simulated block.
- [ ] Live: a 200 MiB upload completes through the 8 MiB body cap.
- [x] Live: a 10-second body hold completes without a user retry.
- [ ] Perf: direct-path throughput is no worse than v1 by more than 10 percent.

**Result.** Possible immediate relief and evidence for the v2 design. If this patch fully solves the corporate case, that is useful data, not a reason to skip durability and integrity.

### PR-03, protocol v2 server core and durable sessions

**Change.** Add `/_upload/v2` with the typed state machine, client-key idempotency, per-request SHA-256 verification, durable manifests, range reconciliation, and atomic publish. Keep v1 available. Add a protocol contract document and Python reference tests.

**Files.** `xwing/upload_engine_v2.py`, `xwing/upload.py`, `xwing/app.py`, `xwing/config.py`, `tests/test_upload_v2.py`, `tests/test_upload_manifest.py`, `docs/upload-v2-protocol.md`.

**Verification.**

- [ ] Unit: init is idempotent for the same key and fingerprint.
- [ ] Unit: duplicate chunks, overlapping ranges, out-of-order ranges, corrupt chunks, and truncated bodies converge to the correct state.
- [ ] Unit: a manifest survives process restart and a staged file is reconciled.
- [ ] Unit: two workers cannot publish the same session.
- [ ] Live: `curl` completes a 200 MiB file across a server restart at 50 percent.
- [x] Perf: server memory is flat for a 1 GiB upload.

**Result.** The server can resume and verify, independent of browser behavior.

### PR-04, protocol v2 browser client and scheduler

**Change.** Add the v2 client with transport canary, explicit content type, per-chunk SHA-256, adaptive chunk and concurrency, short acknowledgement deadlines, jittered retries, and a supervisor that does not cancel peer requests on one failure. Keep v1 selectable.

**Files.** `xwing/frontend/src/upload-engine-v2.js`, `xwing/frontend/src/upload-manager.ts`, `xwing/frontend/src/upload-engine.js`, `scripts/tests/upload-engine-v2.test.ts`, `scripts/e2e/upload-fault.spec.ts`.

**Verification.**

- [ ] Unit: transport selection moves from binary POST to multipart to PUT on the documented failures.
- [ ] Unit: one failed window does not cancel or reject peer windows until the supervisor decides.
- [ ] Unit: `413` shrinks both chunk and concurrency and requeues the unsent tail exactly once.
- [x] Live: 1 MiB body cap completes a 200 MiB file.
- [x] Live: 10-second body hold completes without a user retry.
- [ ] Live: HTML 200, login redirect, `502`, and `504` are classified correctly.
- [ ] Perf: p95 at 10-second hold is within 2.5 times direct baseline.

**Result.** The browser adapts to the proxy instead of assuming a clean network.

### PR-05, resume, diagnostics, rollout, and delete v1

**Change.** Persist upload sessions in IndexedDB, resume after reload, add the diagnostics page and export, make v2 the default, document the proxy settings, and delete v1 after one release of clean evidence.

**Files.** `xwing/frontend/src/upload-manager.ts`, `xwing/frontend/src/upload-diagnostics.ts`, `xwing/app.py`, `xwing/templates/admin.html`, `xwing/frontend/src/admin.tsx`, `README.md`, tests.

**Verification.**

- [ ] Live: reload at 50 percent resumes with at most one chunk re-sent.
- [ ] Live: expired auth produces one clear re-login, not a generic network error.
- [ ] Live: diagnostics show transport, HTTP protocol, timings, retry count, and server request id without file content.
- [ ] Live: an operator can export a diagnostic bundle with filenames redacted.
- [ ] Perf: v2 is within 10 percent of direct v1 on a clean path.
- [ ] Regression: the full fault matrix passes on Chromium and WebKit.

**Result.** The web UI is reliable on the tested fault set. This is the first point where the corporate browser case should be re-tested.

**Review gate.** The operator reviews this PR before defaults change.

### PR-06, Rust transfer core

**Change.** Create `rust/xwing-transfer` as a pure library with the same contract as the Python v2 reference. No production HTTP route. Include differential tests that replay random operation sequences against the Python oracle.

**Files.** `rust/Cargo.toml`, `rust/xwing-transfer/src/lib.rs`, `rust/xwing-transfer/src/range.rs`, `rust/xwing-transfer/src/manifest.rs`, `rust/xwing-transfer/src/verify.rs`, `rust/xwing-transfer/tests/parity.rs`, `docs/upload-rust-core.md`.

**Verification.**

- [ ] Unit: range merge, gap calculation, and idempotent duplicate writes match the reference.
- [ ] Property: random operation sequences produce the same ranges and final bytes as the Python oracle.
- [ ] Fault: crash points between data write, manifest write, and publish reconcile on restart.
- [ ] Perf: checksum verification and local writes saturate the local disk test target.
- [ ] Security: no path traversal, no unverified range credit, no unauthenticated publish.

**Result.** A transfer core that can be tested and trusted before it touches production traffic.

### PR-07, Rust transfer service

**Change.** Wrap the core in an internal HTTP service on a Unix socket or loopback. Python issues a short-lived signed grant and proxies only v2 upload requests. Run dual-stack behind a feature flag.

**Files.** `rust/xwing-transfer-http/src/main.rs`, `rust/xwing-transfer-http/src/auth.rs`, `xwing/upload_bridge.py`, `xwing/app.py`, `pyproject.toml`, packaging scripts, integration tests.

**Verification.**

- [ ] Unit: a forged or expired grant is rejected.
- [ ] Unit: the Rust service and Python reference return the same status, ranges, and error codes for the contract tests.
- [ ] Live: the full fault matrix passes through the Python bridge.
- [ ] Live: restarting either process resumes correctly.
- [ ] Perf: p95 upload time is no worse than the Python v2 core, and CPU is lower.
- [ ] Packaging: the binary starts from a clean install on macOS arm64 and Linux x86_64.

**Result.** A real Rust data plane, not a prototype.

### PR-08, cutover and packaging

**Change.** Make the Rust service the default, keep the Python v2 path as a one-release fallback, then delete it. Build platform wheels with the Rust component or sidecar. Update release CI and smoke tests.

**Files.** `pyproject.toml`, `.github/workflows/release.yml`, `scripts/release_version.py`, packaging manifests, `README.md`, `RELEASING.md`.

**Verification.**

- [ ] Packaging: clean install on macOS arm64, Linux x86_64, and Windows x86_64.
- [ ] Live: `xwing serve` starts with no extra user steps.
- [ ] Live: full fault matrix passes on the packaged artifact.
- [ ] Perf: no regression against the PR-07 build.
- [ ] Rollback: setting one documented flag returns to the Python path for one release.

**Result.** Rust is the shipped transfer engine with a tested rollback.

**Review gate.** The operator approves the cutover.

### PR-09, optional native uploader

**Change.** Add a Rust CLI that uses the same v2 protocol with system proxy discovery, manual proxy profiles, PAC, proxy authentication, OS trust store, forced HTTP/1.1, and resume. The web UI can generate a short-lived upload command.

**Files.** `rust/xwing-cli/src/main.rs`, `rust/xwing-cli/src/proxy.rs`, `xwing/app.py` token endpoint, `docs/native-upload.md`, tests.

**Verification.**

- [ ] Unit: system proxy, manual proxy, PAC, no-proxy list, and proxy auth are parsed.
- [ ] Unit: proxy credentials never appear in logs or error output.
- [ ] Live: upload through a corporate-style authenticating proxy.
- [ ] Live: forced HTTP/1.1 succeeds where the browser path fails.
- [ ] Security: one-time token expires and is scoped to one destination.

**Result.** A supported escape hatch for networks the browser cannot navigate.

**Review gate.** This is a product decision. It is not required for the web reliability predicate.

## Repository Boundary

The upload engine was previously vendored byte-identical into Torrus, with a
parity test pinning the digest. That constraint is removed in this working
tree.

Adopted boundary:

- X-wing owns its upload engine and protocol.
- Torrus stays on the old engine until it chooses to adopt this contract.
- When the Rust core is stable, publish or vendor it as a versioned crate for both projects.

This is a deliberate boundary change. It prevents one application from blocking the reliability work of the other.

## Packaging Decision For Rust

The current wheel is `py3-none-any`. A Rust component changes that. There are two viable shapes:

| Shape | Benefit | Cost |
|---|---|---|
| PyO3 extension | One Python import, no socket, small install | Python still reads the HTTP body; panic isolation is worse |
| Platform wheel with sidecar | Clean process boundary, better crash isolation, can become the front data plane later | More CI targets, larger wheels, process supervision |

Decide in PR-06 with a measured prototype, not by preference. The acceptance criterion is packaging simplicity plus no regression on the fault matrix. If the Python hop is below 10 percent on the target network, the sidecar is still preferable for isolation and future front-door placement.

## Immediate Mitigation While The Plan Runs

These are safe to test in the fault lab and then on the corporate network:

1. Set parallel uploads to 2 in the UI.
2. Run with `--max-chunk-mb 8` and set the LDAPGate `proxy.max_body_size` to the same value.
3. Capture one Chrome HAR and one Safari HAR for the same file.
4. Test an HTTP/1.1-only reverse proxy path for the upload host.

Do not treat any of these as the fix. They narrow the fault.

## What The Operator Needs To Capture

One capture is enough to confirm the corporate root cause:

- Chrome `chrome://net-export` log or a HAR covering one failed upload and one successful retry.
- Safari HAR for the same file.
- X-wing server log lines for the same upload id and timestamps.
- The deployment's reverse proxy type, HTTP/2 setting, request body limit, and timeout.
- The DLP or secure web gateway vendor if known.
- Whether the failing requests reach X-wing at all.

The plan does not block on this capture. It does make the diagnosis faster and prevents guessing.

## What Remains Unproven

- The exact corporate root cause until the operator capture arrives.
- Whether Chrome's proxy stack, HTTP/2, DLP content inspection, or all three cause the delay.
- Whether the PR-02 transport patch alone is enough for the corporate network.
- Whether the proxy allows multipart uploads, binary `POST`, or only specific MIME types.
- The real cost of the Python-to-Rust hop on the target hardware.
- Whether platform-specific Rust packaging is acceptable for the release process.
- Whether a native uploader can support the corporate proxy authentication scheme without a large platform-specific effort.

## Decision Principles

- **Fix Root Causes** ruled out Rust as the first fix and put the browser transport contract first.
- **Boundary Discipline** keeps proxy quirks in the client transport layer and authorization in the Python control plane.
- **Foundational Thinking** made the protocol contract and durable state shape the first deliverables.
- **Model the Domain** replaced scattered phase checks with one upload state machine on each side.
- **Make Operations Idempotent** made init, chunk writes, and resume safe to retry after any crash point.
- **Sequence Work into Verifiable Units** gives each PR its own fault-matrix evidence and a rollback.
- **Prove It Works** defines done as a fault matrix with hashes and timings, not a successful compile.
- **Exhaust the Design Space** keeps the Python core, Rust core, and native client as measured options instead of one blind rewrite.
