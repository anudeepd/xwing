<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/nostromo/main/assets/logo.svg" alt="Nostromo" width="120"/>
</p>

<h1 align="center">Nostromo</h1>

<p align="center">A simple, self-contained file sharing server with WebDAV support, designed for use behind a reverse proxy with LDAPGate.</p>

## Features

- **WebDAV server** — mount as a drive on Windows, macOS, and Linux using native WebDAV clients
- **Resumable uploads** — chunked uploads with session recovery; supports large files (up to 10 GB)
- **Browser-based file browser** — drag-and-drop upload, directory creation, zip download, file delete
- **In-browser text editor** — CodeMirror-powered editor for text files (configurable via `_EDITABLE_EXTS`); files over 2 MB are not editable
- **WebDAV COPY / MOVE** — server-side file and directory copy/move via `Destination` header
- **LDAP / AD authentication** — optional, via [ldapgate](https://github.com/anudeepd/ldapgate)
- **Single self-contained wheel** — no external CDN dependencies; fonts embedded as base64 WOFF2

## Install

```bash
pip install nostromo
```

For LDAP/AD authentication:

```bash
pip install 'nostromo[ldap]'
```

## Usage

```bash
nostromo serve --root /path/to/serve
```

Opens the file browser at `http://127.0.0.1:8989` and launches your default browser.

Options:

```
--root PATH          Root directory to serve. [required]
--host TEXT          Bind host. [default: 127.0.0.1]
--port INTEGER       Bind port. [default: 8989]
--no-open            Don't open the browser automatically.
--max-upload-gb NUM  Max upload size in GB. [default: 10]
--require-auth       Require X-Forwarded-User header (403 if missing).
--user-header TEXT   Header to read username from. [default: X-Forwarded-User]
--reload             Auto-reload on code changes (dev only).
--ldap-config PATH   Path to ldapgate YAML config to enable LDAP authentication.
```

### WebDAV Mount Examples

**Linux (DAVfs2):**
```bash
sudo mount.davfs http://localhost:8989 /mnt/nostromo -o username=<user>
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

### Resumable Upload (Chunked)

For large files, use the chunked upload API:

```bash
# 1. Init session
curl -X POST http://localhost:8989/_upload/init \
  -H "Content-Type: application/json" \
  -d '{"filename": "big.iso", "total_chunks": 100, "dir": "/"}'

# 2. Upload each chunk
curl -X PUT http://localhost:8989/_upload/<session_id>/<chunk_index> \
  --data-binary @chunk.part

# 3. Complete
curl -X POST http://localhost:8989/_upload/<session_id>/complete
```

## LDAP Authentication

Nostromo can require login via LDAP/AD before accessing files. This uses [ldapgate](https://github.com/anudeepd/ldapgate) as FastAPI middleware — no separate proxy process needed.

```bash
pip install 'nostromo[ldap]'
nostromo serve --root /data --ldap-config /path/to/ldapgate.yaml
```

See the [ldapgate README](https://github.com/anudeepd/ldapgate) for config file documentation.

## Development

Requires [uv](https://github.com/astral-sh/uv).

```bash
git clone https://github.com/anudeepd/nostromo
cd nostromo
uv sync
uv run nostromo serve --root .
```

## License

MIT
