import asyncio
import io
import logging
import os
import secrets
import shutil
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import anyio
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .auth import get_user, require_perm
from .config import Settings
from .files import human_size, is_editable, is_within_root, list_dir, safe_path
from .upload import cleanup_stale_sessions, create_upload_router
from .webdav import (
    copy_response,
    lock_response,
    mkcol_response,
    move_response,
    propfind_response,
    unlock_response,
)

logger = logging.getLogger(__name__)

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"
APP_CSP = (
    "default-src 'self'; "
    "form-action 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data:; "
    "font-src 'self' data:"
)


def timestamped_selection_zip_name(now: datetime | None = None) -> str:
    dt = now or datetime.now(timezone.utc)
    return f"xwing-selection-{dt.astimezone(timezone.utc):%Y%m%d-%H%M%S}.zip"


def build_app_csp(style_nonce: str | None = None) -> str:
    style_src = "style-src 'self'"
    if style_nonce:
        style_src += f" 'nonce-{style_nonce}'"
    return (
        "default-src 'self'; "
        "form-action 'self'; "
        "script-src 'self'; "
        f"{style_src}; "
        "img-src 'self' data:; "
        "font-src 'self' data:"
    )


def create_app_reload() -> FastAPI:
    """Factory for uvicorn reload mode — reads settings from environment variables."""
    root = os.environ.get("XWING_ROOT")
    if not root:
        raise RuntimeError(
            "XWING_ROOT environment variable is required for reload mode"
        )

    kwargs: dict = {"root_dir": Path(root)}
    if os.environ.get("XWING_REQUIRE_AUTH") == "True":
        kwargs["require_auth"] = True
    kwargs["listen_host"] = os.environ.get("XWING_LISTEN_HOST", "127.0.0.1")
    kwargs["listen_port"] = int(os.environ.get("XWING_LISTEN_PORT", "8989"))
    if os.environ.get("XWING_MAX_UPLOAD_GB"):
        kwargs["max_upload_bytes"] = int(
            float(os.environ["XWING_MAX_UPLOAD_GB"]) * 1024**3
        )
    if os.environ.get("XWING_MAX_CHUNK_MB"):
        kwargs["max_chunk_bytes"] = int(os.environ["XWING_MAX_CHUNK_MB"]) * 1024**2
    if os.environ.get("XWING_MAX_CHUNKS"):
        kwargs["max_chunks"] = int(os.environ["XWING_MAX_CHUNKS"])
    if os.environ.get("XWING_SESSION_TTL_MINUTES"):
        kwargs["session_ttl_seconds"] = (
            int(os.environ["XWING_SESSION_TTL_MINUTES"]) * 60
        )
    if os.environ.get("XWING_USER_HEADER"):
        kwargs["user_header"] = os.environ["XWING_USER_HEADER"]
    if os.environ.get("XWING_TRUSTED_AUTH_PROXIES"):
        kwargs["trusted_auth_proxies"] = [
            p.strip()
            for p in os.environ["XWING_TRUSTED_AUTH_PROXIES"].split(",")
            if p.strip()
        ]
    if os.environ.get("XWING_USERS_CONFIG"):
        kwargs["users_config"] = Path(os.environ["XWING_USERS_CONFIG"])
    if os.environ.get("XWING_LDAP_CONFIG"):
        kwargs["ldap_config"] = Path(os.environ["XWING_LDAP_CONFIG"])
    settings = Settings(**kwargs)
    return create_app(settings)


def create_app(settings: Settings) -> FastAPI:
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(cleanup_stale_sessions(settings))
        yield
        task.cancel()

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def add_app_security_headers(request: Request, call_next):
        request.state.csp_style_nonce = (
            secrets.token_urlsafe(16) if "edit" in request.query_params else None
        )
        response = await call_next(request)
        if not request.url.path.startswith("/_auth/"):
            response.headers.setdefault(
                "Content-Security-Policy",
                build_app_csp(request.state.csp_style_nonce),
            )
        return response

    if settings.users_config:
        logger.info("Permissions loaded from %s", settings.users_config)
    else:
        logger.error(
            "No --users-config provided — all users are read-only. "
            "Pass --users-config <file> to grant write or delete access."
        )

    # LDAPGate middleware — enabled via Settings, XWING_LDAP_CONFIG, or --ldap-config
    # CLI flag. The env fallback keeps direct ASGI factory deployments simple.
    _ldap_config_path = settings.ldap_config or (
        Path(env_path) if (env_path := os.getenv("XWING_LDAP_CONFIG")) else None
    )
    if _ldap_config_path:
        try:
            from ldapgate.config import load_config  # type: ignore[import]
            from ldapgate.middleware import add_ldap_auth  # type: ignore[import]
        except ImportError as e:
            raise RuntimeError(
                "ldapgate is not installed but XWING_LDAP_CONFIG is set. "
                "Install it with: pip install 'xwing[ldap]' or pip install ldapgate"
            ) from e
        ldap_config = load_config(str(_ldap_config_path))
        _ensure_ldapgate_static_paths(ldap_config)
        _ensure_ldapgate_cookie_name(ldap_config)
        _sync_ldapgate_trusted_proxies(ldap_config, settings)
        _login_template = TEMPLATES_DIR / "login.html"
        add_ldap_auth(
            app,
            ldap_config,
            template_path=str(_login_template) if _login_template.exists() else None,
        )

    templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
    templates.env.filters["human_size"] = human_size

    app.include_router(create_upload_router(settings))
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # ── Helpers ───────────────────────────────────────────────────────────────

    def resolve(request: Request) -> Path:
        rel = request.path_params.get("path", "")
        try:
            return safe_path(settings.root_dir, rel)
        except PermissionError:
            raise HTTPException(status_code=403, detail="Forbidden")

    def dest_from_header(request: Request, root: Path) -> Path:
        raw = request.headers.get("destination", "")
        parsed = urlparse(raw)
        if parsed.scheme:
            path_part = unquote(parsed.path) if parsed.path else None
        elif raw.startswith("//"):
            path_part = None
        else:
            path_part = unquote(raw)
        if not path_part:
            raise HTTPException(
                status_code=400, detail="Missing or invalid Destination header"
            )
        try:
            return safe_path(root, path_part)
        except PermissionError:
            raise HTTPException(status_code=403, detail="Forbidden destination")

    def _to_rel_path(fspath: Path) -> str:
        rel = fspath.relative_to(settings.root_dir)
        if rel == Path("."):
            return "/"
        return "/" + rel.as_posix()

    def _to_url_path(fspath: Path, *, trailing_slash: bool = False) -> str:
        rel = fspath.relative_to(settings.root_dir)
        if rel == Path("."):
            return "/"
        encoded = "/" + "/".join(quote(part, safe="") for part in rel.parts)
        if trailing_slash and not encoded.endswith("/"):
            encoded += "/"
        return encoded

    def _is_sensitive_path(fspath: Path) -> bool:
        try:
            rel = fspath.resolve().relative_to(settings.root_dir.resolve())
        except ValueError:
            rel = Path(fspath.name)
        return any(part == ".env" or part.startswith(".env.") for part in rel.parts)

    def _reject_sensitive_path(fspath: Path) -> None:
        if _is_sensitive_path(fspath):
            raise HTTPException(status_code=403, detail="Forbidden: sensitive file")

    def _is_root_path(fspath: Path) -> bool:
        return fspath.resolve() == settings.root_dir.resolve()

    # ── Method handlers ───────────────────────────────────────────────────────

    async def _handle_put(fspath: Path, request: Request, user: str) -> Response:
        require_perm(user, "write", settings)
        _reject_sensitive_path(fspath)

        if fspath.is_dir():
            raise HTTPException(status_code=409, detail="Is a directory")

        # Check Content-Length early if provided
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=413, detail="Upload exceeds size limit"
                    )
            except ValueError:
                pass  # Invalid header, fall through to stream-based check

        fspath.parent.mkdir(parents=True, exist_ok=True)
        temp_handle = tempfile.NamedTemporaryFile(
            prefix=f".{fspath.name}.",
            suffix=".tmp",
            dir=fspath.parent,
            delete=False,
        )
        temp_file = Path(temp_handle.name)
        temp_handle.close()
        received_bytes = 0
        try:
            async with await anyio.open_file(temp_file, "wb") as f:
                async for chunk in request.stream():
                    received_bytes += len(chunk)
                    if received_bytes > settings.max_upload_bytes:
                        raise HTTPException(status_code=413, detail="Upload too large")
                    await f.write(chunk)
            await anyio.to_thread.run_sync(temp_file.replace, fspath)  # type: ignore[reportAttributeAccessIssue]
        except HTTPException:
            try:
                await anyio.to_thread.run_sync(temp_file.unlink)  # type: ignore[reportAttributeAccessIssue]
            except FileNotFoundError:
                pass
            raise
        except OSError as e:
            # Disk full or I/O error
            try:
                await anyio.to_thread.run_sync(temp_file.unlink)  # type: ignore[reportAttributeAccessIssue]
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=f"Write failed: {e}")
        return Response(status_code=204)

    async def _handle_delete(fspath: Path, user: str) -> Response:
        require_perm(user, "delete", settings)
        if _is_root_path(fspath):
            raise HTTPException(status_code=403, detail="Cannot delete root")
        _reject_sensitive_path(fspath)

        if not fspath.exists():
            raise HTTPException(status_code=404)
        if fspath.is_dir():
            await anyio.to_thread.run_sync(shutil.rmtree, fspath)  # type: ignore[reportAttributeAccessIssue]
        else:
            await anyio.to_thread.run_sync(fspath.unlink)  # type: ignore[reportAttributeAccessIssue]
        return Response(status_code=204)

    async def _handle_get(fspath: Path, request: Request, user: str) -> Response:
        if not fspath.exists():
            raise HTTPException(status_code=404)

        _reject_sensitive_path(fspath)

        if fspath.is_dir():
            return await _handle_get_dir(fspath, request, user)

        if "edit" in request.query_params and is_editable(fspath):
            return await _handle_edit(fspath, request, user)

        return FileResponse(fspath)

    async def _handle_get_dir(fspath: Path, request: Request, user: str) -> Response:
        rel_path = _to_rel_path(fspath)
        url_path = _to_url_path(fspath, trailing_slash=True)

        if "zip" in request.query_params:
            return await _zip_response(fspath, settings.root_dir)

        accept = request.headers.get("accept", "")
        if request.method == "GET" and "text/html" not in accept:
            return propfind_response(request, fspath, settings.root_dir)

        try:
            entries = list_dir(fspath)
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")

        parts = [p for p in rel_path.strip("/").split("/") if p]
        breadcrumbs = [{"name": "Home", "path": "/", "url_path": "/"}]
        cumulative_parts = []
        for part in parts:
            cumulative_parts.append(part)
            encoded = "/" + "/".join(quote(p, safe="") for p in cumulative_parts) + "/"
            breadcrumbs.append({"name": part, "path": encoded, "url_path": encoded})

        return templates.TemplateResponse(
            request,
            "index.html",
            {
                "entries": entries,
                "current_path": rel_path if rel_path.endswith("/") else rel_path + "/",
                "current_url_path": url_path,
                "breadcrumbs": breadcrumbs,
                "user": user,
                "perms": settings.perms_for(user),
            },
        )

    async def _handle_edit(fspath: Path, request: Request, user: str) -> Response:
        rel_path = _to_rel_path(fspath)
        url_path = _to_url_path(fspath)
        content = await anyio.Path(fspath).read_text(encoding="utf-8", errors="replace")
        dir_path = rel_path.rsplit("/", 1)[0] + "/"
        if dir_path == "//":
            dir_path = "/"
        dir_url_path = _to_url_path(fspath.parent, trailing_slash=True)
        return templates.TemplateResponse(
            request,
            "editor.html",
            {
                "file_path": rel_path,
                "file_url_path": url_path,
                "dir_path": dir_path,
                "dir_url_path": dir_url_path,
                "filename": fspath.name,
                "content": content,
                "ext": fspath.suffix.lstrip(".").lower(),
                "user": user,
                "perms": settings.perms_for(user),
                "csp_style_nonce": request.state.csp_style_nonce,
            },
        )

    async def _zip_response(fspath: Path, root: Path) -> Response:
        zip_name = (fspath.name or "archive") + ".zip"

        def _build() -> bytes:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for child in sorted(fspath.rglob("*")):
                    if (
                        child.is_file()
                        and is_within_root(root, child)
                        and not _is_sensitive_path(child)
                    ):
                        zf.write(child, child.relative_to(fspath))
            return buf.getvalue()

        zip_bytes = await anyio.to_thread.run_sync(_build)  # type: ignore[reportAttributeAccessIssue]
        return Response(
            zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(zip_name)}"
            },
        )

    async def _bulk_body(request: Request) -> dict:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON") from None
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="JSON body must be an object")
        return body

    def _resolve_bulk_paths(raw_paths: object) -> list[Path]:
        if not isinstance(raw_paths, list):
            raise HTTPException(status_code=400, detail="paths must be a list")
        if not raw_paths:
            raise HTTPException(status_code=400, detail="paths must not be empty")
        if len(raw_paths) > 500:
            raise HTTPException(status_code=400, detail="Too many paths")

        paths: list[Path] = []
        seen: set[Path] = set()
        for raw in raw_paths:
            if not isinstance(raw, str):
                raise HTTPException(status_code=400, detail="paths entries must be strings")
            try:
                fspath = safe_path(settings.root_dir, unquote(raw))
            except PermissionError:
                raise HTTPException(status_code=403, detail="Forbidden path") from None
            if _is_root_path(fspath):
                raise HTTPException(status_code=403, detail="Cannot select root")
            _reject_sensitive_path(fspath)
            if fspath not in seen:
                seen.add(fspath)
                paths.append(fspath)
        return paths

    def _zip_selected(paths: list[Path], base_path: Path) -> bytes:
        buf = io.BytesIO()
        written: set[str] = set()

        def arcname(path: Path) -> Path:
            try:
                return path.relative_to(base_path)
            except ValueError:
                return path.relative_to(settings.root_dir)

        def add_file(zf: zipfile.ZipFile, file_path: Path) -> None:
            if (
                not file_path.is_file()
                or not is_within_root(settings.root_dir, file_path)
                or _is_sensitive_path(file_path)
            ):
                return
            name = arcname(file_path).as_posix()
            if name in written:
                return
            written.add(name)
            zf.write(file_path, name)

        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(paths, key=lambda p: p.as_posix()):
                if not path.exists():
                    raise FileNotFoundError(path)
                if path.is_dir():
                    for child in sorted(path.rglob("*")):
                        add_file(zf, child)
                else:
                    add_file(zf, path)
        return buf.getvalue()

    @app.post("/_bulk/zip", include_in_schema=False)
    async def bulk_zip(request: Request):
        user = get_user(request, settings)
        require_perm(user, "read", settings)
        body = await _bulk_body(request)
        paths = _resolve_bulk_paths(body.get("paths"))
        base_raw = body.get("base", "/")
        if not isinstance(base_raw, str):
            raise HTTPException(status_code=400, detail="base must be a string")
        try:
            base_path = safe_path(settings.root_dir, unquote(base_raw))
        except PermissionError:
            raise HTTPException(status_code=403, detail="Forbidden base") from None
        if not base_path.exists() or not base_path.is_dir():
            raise HTTPException(status_code=404, detail="Base directory not found")

        try:
            zip_bytes = await anyio.to_thread.run_sync(_zip_selected, paths, base_path)  # type: ignore[reportAttributeAccessIssue]
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Selected path not found") from None
        return Response(
            zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(timestamped_selection_zip_name())}"
            },
        )

    @app.post("/_bulk/delete", include_in_schema=False)
    async def bulk_delete(request: Request):
        user = get_user(request, settings)
        require_perm(user, "delete", settings)
        body = await _bulk_body(request)
        paths = _resolve_bulk_paths(body.get("paths"))

        for fspath in sorted(paths, key=lambda p: len(p.parts), reverse=True):
            if not fspath.exists():
                raise HTTPException(status_code=404, detail="Selected path not found")
            if fspath.is_dir():
                await anyio.to_thread.run_sync(shutil.rmtree, fspath)  # type: ignore[reportAttributeAccessIssue]
            else:
                await anyio.to_thread.run_sync(fspath.unlink)  # type: ignore[reportAttributeAccessIssue]
        return JSONResponse({"deleted": len(paths)})

    # ── Catch-all route ───────────────────────────────────────────────────────

    @app.api_route(
        "/{path:path}",
        methods=[
            "GET",
            "HEAD",
            "PUT",
            "DELETE",
            "OPTIONS",
            "PROPFIND",
            "MKCOL",
            "COPY",
            "MOVE",
            "LOCK",
            "UNLOCK",
        ],
    )
    async def catch_all(request: Request, path: str = ""):
        method = request.method.upper()
        user = get_user(request, settings)
        fspath = resolve(request)

        # OPTIONS is exempt from auth: WebDAV clients (e.g. Windows, Finder) send
        # OPTIONS before credentials to discover supported methods (RFC 4918 §9.1).
        # Blocking it would prevent clients from negotiating the connection at all.
        if method != "OPTIONS":
            require_perm(user, "read", settings)

        if method == "OPTIONS":
            return Response(
                status_code=200,
                headers={
                    "Allow": "GET,HEAD,PUT,DELETE,OPTIONS,PROPFIND,MKCOL,COPY,MOVE,LOCK,UNLOCK",
                    "DAV": "1, 2",
                    "MS-Author-Via": "DAV",
                },
            )

        if method == "PROPFIND":
            if not fspath.exists():
                raise HTTPException(status_code=404)
            _reject_sensitive_path(fspath)
            return propfind_response(request, fspath, settings.root_dir)

        if method == "MKCOL":
            require_perm(user, "write", settings)
            _reject_sensitive_path(fspath)
            return mkcol_response(fspath)

        if method == "COPY":
            require_perm(user, "write", settings)
            dest = dest_from_header(request, settings.root_dir)
            _reject_sensitive_path(fspath)
            _reject_sensitive_path(dest)
            overwrite = request.headers.get("overwrite", "T").upper() != "F"
            return await copy_response(fspath, dest, overwrite)

        if method == "MOVE":
            require_perm(user, "delete", settings)
            require_perm(user, "write", settings)
            dest = dest_from_header(request, settings.root_dir)
            if _is_root_path(fspath):
                raise HTTPException(status_code=403, detail="Cannot move root")
            _reject_sensitive_path(fspath)
            _reject_sensitive_path(dest)
            overwrite = request.headers.get("overwrite", "T").upper() != "F"
            return await move_response(fspath, dest, overwrite)

        if method == "LOCK":
            return lock_response(fspath)

        if method == "UNLOCK":
            return unlock_response()

        if method == "PUT":
            return await _handle_put(fspath, request, user)

        if method == "DELETE":
            return await _handle_delete(fspath, user)

        # GET / HEAD
        return await _handle_get(fspath, request, user)

    return app


def _ensure_ldapgate_static_paths(config) -> None:
    """Allow login-page assets to load without triggering Basic auth."""
    proxy_config = getattr(config, "proxy", None)
    if proxy_config is None:
        return
    static_paths = list(getattr(proxy_config, "static_paths", []) or [])
    for path in ("/static", "/favicon.ico"):
        if path not in static_paths:
            static_paths.append(path)
    proxy_config.static_paths = static_paths


def _ensure_ldapgate_cookie_name(config) -> None:
    """Keep xwing auth cookies distinct from sibling localhost apps."""
    proxy_config = getattr(config, "proxy", None)
    if proxy_config is None:
        return
    if getattr(proxy_config, "session_cookie_name", "ldapgate_session") == "ldapgate_session":
        proxy_config.session_cookie_name = "xwing_session"


def _sync_ldapgate_trusted_proxies(config, settings: Settings) -> None:
    """Share xwing's trusted proxy list with embedded ldapgate when unset."""
    proxy_config = getattr(config, "proxy", None)
    if proxy_config is None:
        return
    if getattr(proxy_config, "trusted_proxies", None):
        return
    if settings.trusted_auth_proxies:
        proxy_config.trusted_proxies = list(settings.trusted_auth_proxies)
