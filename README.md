<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/xwing/main/assets/logo.svg" alt="X-wing" width="120"/>
</p>

<h1 align="center">X-wing</h1>

<p align="center">A self-contained file sharing server with WebDAV support. Works out of the box or integrates with LDAPGate for corporate LDAP/AD authentication.</p>

## Features

- **WebDAV server** — mount as a drive on Windows, macOS, and Linux using native WebDAV clients
- **Resumable uploads** — chunked uploads with session recovery; supports large files (up to 10 GB by default)
- **Browser-based file browser** — drag-and-drop upload, directory creation, zip download, file delete
- **In-browser text editor** — CodeMirror-powered editor for common text and code file types
- **WebDAV COPY / MOVE** — server-side file and directory copy/move via `Destination` header
- **Per-user access control** — YAML config grants each user independent `read`, `write`, and `delete` permissions; reloaded at runtime without restart
- **Optional LDAP / AD authentication** — via [LDAPGate](https://github.com/anudeepd/ldapgate)
- **Single self-contained wheel** — no external CDN dependencies; fonts embedded as base64 WOFF2

## Install

```bash
pip install xwing
```

For LDAP/AD authentication:

```bash
pip install 'xwing[ldap]'
```

## Usage

```bash
xwing serve --root /path/to/serve
```

Opens the file browser at `http://127.0.0.1:8989` and launches your default browser.

### Options

```
--root PATH                Root directory to serve. [required]
--host TEXT                Bind host. [default: 127.0.0.1]
--port INTEGER             Bind port. [default: 8989]
--open / --no-open         Open browser on startup. [default: open]
--max-upload-gb FLOAT      Max upload size in GB. [default: 10]
--max-chunk-mb INTEGER     Maximum upload window in MB. [default: 16]
--upload-concurrency INT   Max parallel windows per file. [default: 2]
--max-chunks INTEGER       Max chunks per upload session. [default: 10000]
--session-ttl-minutes INT  Upload session expiry in minutes. [default: 60]
--require-auth             Require authentication header (403 if missing).
--users-config FILE        Path to YAML file with per-user permissions.
--user-header TEXT         Header to read username from. [default: X-Forwarded-User]
--trusted-auth-proxy TEXT  Trusted proxy IP/CIDR allowed to supply --user-header.
--reload                   Auto-reload on code changes (dev only).
--ldap-config FILE         Path to LDAPGate YAML config to enable LDAP authentication.
```

### WebDAV Mount Examples

**Linux (DAVfs2):**
```bash
sudo mount.davfs http://localhost:8989 /mnt/xwing -o username=<user>
```

**macOS:**
```bash
open http://localhost:8989
# Or mount: Finder → Go → Connect to Server → http://localhost:8989
```

**Windows (native WebDAV):**
```
net use Z: \\localhost@8989\DavWWWRoot /persistent:yes
```

Windows' built-in WebDAV client is limited by the WebClient service policy. By
default, `BasicAuthLevel` is `1`, which allows Basic authentication only for
HTTPS WebDAV sites. With X-wing behind HTTPS and LDAPGate enabled, Windows
Explorer can use the normal username/password prompt because LDAPGate provides
the Basic auth challenge Windows expects.

Without LDAPGate, Windows Explorer can still connect only as anonymous. That
works for read-only access, or for writes only if your `users.yaml` grants write
permission to `"*"`. X-wing does not provide its own username/password Basic
auth prompt in no-LDAP mode.

Setting `BasicAuthLevel` to `2` enables Basic authentication over HTTP too, but
that requires administrator access to
`HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters` and sends
credentials in clear text. For Windows users, prefer HTTPS with LDAPGate or a
WebDAV-capable client such as [WinSCP](https://winscp.net/).

### Resumable Upload (Chunked)

The protocol tracks **committed byte ranges**, not chunk indices, so a client
may change its window size mid-upload and may retry any range. Every chunk
carries a SHA-256 digest. The server credits a range only after the bytes
match, and a staged manifest survives a server restart.

The browser starts with a 4 MiB typed `POST` canary. If a corporate proxy drops
that request, the same bytes are retried as a multipart upload and then as a
WebDAV `PUT`. The transport that works is kept for the rest of the file. Clean
canaries grow the window to the configured ceiling; a 413 or repeated transport
drop shrinks both the window and concurrency instead of failing the file.

```bash
# 1. Init session. upload_key makes a retry return the same session.
curl -X POST http://localhost:8989/_upload/init \
  -H "Content-Type: application/json" \
  -d '{"upload_key": "client-stable-key", "filename": "big.iso", "size": 3221225472, "dir": "/", "fingerprint": {"name": "big.iso", "size": 3221225472, "last_modified": 0}}'
# -> {"upload_id": "...", "ranges": [], "chunk_policy": {"initial_bytes": 4194304, "max_bytes": 16777216, "max_concurrency": 2}, ...}

# 2. Upload one verified window. Repeat for every missing range.
SHA=$(sha256sum range.part | cut -d' ' -f1)
LEN=$(wc -c < range.part)
curl -X POST "http://localhost:8989/_upload/<upload_id>/chunk?offset=0&sha256=$SHA&length=$LEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @range.part
# -> {"received": 4194304, "ranges": [[0, 4194304]], "next_offset": 4194304}

# The same endpoint accepts multipart/form-data when a proxy rejects raw bodies.
curl -X POST "http://localhost:8989/_upload/<upload_id>/chunk?offset=4194304" \
  -F offset=4194304 -F length=$LEN -F sha256=$SHA -F file=@range.part

# 3. Ask what is still missing (for a resume)
curl "http://localhost:8989/_upload/<upload_id>"

# 4. Publish the file (only succeeds when [0, size) is complete)
curl -X POST http://localhost:8989/_upload/<upload_id>/complete

# 5. Or abandon the upload and remove the staged bytes
curl -X DELETE http://localhost:8989/_upload/<upload_id>
```

Staged bytes live beside the destination as `.<name>.upload-part-<upload_id>`
and are hidden from directory listings. Session manifests live in the hidden
`.xwing-uploads` directory at the served root, so a process restart can resume
from the bytes already committed. The destination only changes when `complete`
succeeds. Abandoned sessions are reclaimed after `--session-ttl-minutes`, and a
staging file whose owner is gone is removed the next time its directory is
listed. Limits: `--max-upload-gb`, `--max-chunk-mb`, `--upload-concurrency`,
`--max-chunks`, `--session-ttl-minutes`.

Behind LDAPGate, keep `proxy.max_body_size` at or above the window: the gate
rejects any larger request body with a bare 413 before it reaches the upload
router. Its default is 10 MB, so with the 16 MiB default ceiling set:

```yaml
proxy:
    max_body_size: 16777216   # 16 MiB, matching --max-chunk-mb 16
```

X-wing caps the window at that limit on startup and logs a warning, so uploads
still work, they just shift less data per request. Raise both together, or
lower both to 8 MiB if you would rather retry smaller windows on a flaky link.
Any reverse proxy in front of LDAPGate needs a limit at least as large
(`client_max_body_size 16m` on nginx, whose default is 1 MB).

The browser abandons a request only after a bounded period with no byte
movement, or after the server acknowledges the body. A DLP scan shows as
"waiting for server" while it runs, not as a five-minute hang. Proxy drops,
proxy body caps, HTML login pages, browser reloads and server restarts have
explicit recovery paths. The repeatable fault matrix is documented in
[`docs/upload-reliability-plan.md`](docs/upload-reliability-plan.md).

## Access Control

Without `--users-config`, local/no-auth mode is read-only. When a users config is present, unlisted users are denied unless you configure the `"*"` fallback.

```bash
xwing serve --root /data --users-config users.yaml
```

**`users.yaml` — compact format:**
```yaml
users:
  alice: rwd     # read + write + delete
  bob: rw        # read + write, no delete
  charlie: r     # read only
  "*": r         # fallback for any unlisted user (omit to deny unlisted users)
```

**`users.yaml` — verbose format:**

```yaml
users:
  alice:
    read: true
    write: true
    delete: true
```

Verbose field defaults when omitted: `read: true`, `write: false`, `delete: false`.
Values must be `true` or `false`.

Permission levels:

| Flag | Grants |
|------|--------|
| `r`  | Browse directories, download files (GET, HEAD, PROPFIND) |
| `w`  | Upload files, create directories, copy (PUT, MKCOL, COPY) |
| `d`  | Delete files and undo a delete (DELETE, restore); MOVE needs `w` and `d`, and COPY/MOVE onto an existing item also needs `d` (the replaced item goes to the trash) |

The config file is reloaded automatically when it changes on disk — no restart needed.

### Admin console

Configure admin identities separately from `users.yaml`:

```bash
xwing serve --root /data \
  --users-config users.yaml \
  --ldap-config ldapgate.yaml \
  --admin-user alice \
  --admin-user ops
```

Admin access requires an authenticated LDAPGate session (embedded middleware or a
trusted LDAPGate reverse proxy) and a username listed with `--admin-user` or
`XWING_ADMIN_USERS`. User permission files cannot grant administrator access.

For standalone LDAPGate reverse-proxy mode, use the same `--trusted-auth-proxy`
boundary instead of `--ldap-config`:

```bash
xwing serve --root /data --require-auth \
  --users-config users.yaml \
  --trusted-auth-proxy 127.0.0.1 \
  --admin-user alice
```

Admin configuration is not editable from the console. LDAP authentication remains configured in
`ldapgate.yaml`; the Users screen synchronizes each explicit user entry to both `users.yaml`
permissions and `ldap.allowed_users`. Restart X-wing after adding or removing LDAP users.

Console provides:

- Per-user read/write/delete access management.
- LDAP user allowlist synchronization when embedded LDAPGate is enabled.
- Audit activity with user/date filters, status, paths, timing, current active-user counts, and retention purge.
- Storage and usage summary.
- Persistent recoverable trash with restore and permanent deletion controls.

## LDAP / Active Directory Authentication

X-wing supports two modes for LDAP/AD auth:

**Mode 1 — Standalone proxy:** Run LDAPGate as a reverse proxy in front of xwing. Authenticated requests get an `X-Forwarded-User` header that xwing reads only from trusted proxy IPs.

```
Browser → LDAPGate → xwing
```

```bash
ldapgate serve --config ldapgate.yaml
xwing serve --root /data --require-auth --users-config users.yaml --trusted-auth-proxy 127.0.0.1
```

**Mode 2 — Built-in middleware:** Inject LDAPGate directly into xwing as FastAPI middleware:

```bash
pip install 'xwing[ldap]'
xwing serve --root /data --ldap-config ldapgate.yaml --users-config users.yaml
```

Use `ldapgate.yaml` in this repository as the starting template for X-wing.
`proxy.session_ttl` is the absolute lifetime of the LDAP cookie and token. `proxy.idle_timeout` is the inactivity limit and must not exceed it. The sample uses 24 hours and 4 hours; the longer cap leaves room for large transfers. Restart and sign in again after changing either value so the browser receives the new cookie lifetime.
See the [LDAPGate README](https://github.com/anudeepd/ldapgate) for config file documentation.

### Audit log

LDAP-enabled and `--require-auth` deployments retain authenticated activity in
`~/.local/share/xwing/audit.db` by default. The log records the user, method,
path, status, and timing. Text and JSON request input is retained up to 16 KiB;
large or binary upload bodies are metadata-only. Set `XWING_AUDIT_DB` (or pass
`--audit-db`) to choose another location.

```bash
xwing audit --user alice
xwing audit purge --older-than 90
```

## Development

Requires [uv](https://github.com/astral-sh/uv).

```bash
git clone https://github.com/anudeepd/xwing
cd xwing
uv sync
uv run xwing serve --root .
```

Frontend source lives in `xwing/frontend/src`; shipped browser assets are the
bundled files under `xwing/static/assets`. Rebuild them after frontend changes:

```bash
cd scripts
npm install
npm run build:app
```

## License

MIT
