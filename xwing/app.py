import asyncio
import io
import os
import shutil
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import anyio
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .auth import get_user
from .config import Settings
from .files import human_size, is_editable, list_dir, safe_path
from .upload import cleanup_stale_sessions, create_upload_router
from .webdav import (
    copy_response,
    lock_response,
    mkcol_response,
    move_response,
    propfind_response,
    unlock_response,
)

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"


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
    if os.environ.get("XWING_READ_USERS"):
        kwargs["read_users"] = set(
            u.strip() for u in os.environ["XWING_READ_USERS"].split(",") if u.strip()
        )
    if os.environ.get("XWING_WRITE_USERS"):
        kwargs["write_users"] = set(
            u.strip() for u in os.environ["XWING_WRITE_USERS"].split(",") if u.strip()
        )
    if os.environ.get("XWING_ADMIN_USERS"):
        kwargs["admin_users"] = set(
            u.strip() for u in os.environ["XWING_ADMIN_USERS"].split(",") if u.strip()
        )
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

    # LDAPGate middleware — enabled via XWING_LDAP_CONFIG env var or --ldap-config CLI flag
    _ldap_config_path = os.getenv("XWING_LDAP_CONFIG")
    if _ldap_config_path:
        try:
            from ldapgate.config import load_config  # type: ignore[import]
            from ldapgate.middleware import add_ldap_auth  # type: ignore[import]
        except ImportError as e:
            raise RuntimeError(
                "ldapgate is not installed but XWING_LDAP_CONFIG is set. "
                "Install it with: pip install ldapgate"
            ) from e
        _login_template = TEMPLATES_DIR / "login.html"
        add_ldap_auth(
            app,
            load_config(_ldap_config_path),
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

    def _check_read_permission(user: str) -> None:
        if not settings.permission.can_read(user):
            raise HTTPException(status_code=403, detail="Read permission denied")

    def _check_write_permission(user: str) -> None:
        if not settings.permission.can_write(user):
            raise HTTPException(status_code=403, detail="Write permission denied")

    def _check_admin_permission(user: str) -> None:
        if not settings.permission.can_admin(user):
            raise HTTPException(status_code=403, detail="Admin permission denied")

    # ── Method handlers ───────────────────────────────────────────────────────

    async def _handle_put(fspath: Path, request: Request, user: str) -> Response:
        _check_write_permission(user)

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
        temp_file = fspath.with_suffix(fspath.suffix + ".tmp")
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
        _check_admin_permission(user)

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

        if fspath.name == ".env" or fspath.name.startswith(".env."):
            raise HTTPException(status_code=403, detail="Forbidden: secrets file")

        if fspath.is_dir():
            return await _handle_get_dir(fspath, request, user)

        if "edit" in request.query_params and is_editable(fspath):
            return await _handle_edit(fspath, request, user)

        return FileResponse(fspath)

    async def _handle_get_dir(fspath: Path, request: Request, user: str) -> Response:
        rel_path = _to_rel_path(fspath)

        if "zip" in request.query_params:
            return await _zip_response(fspath)

        accept = request.headers.get("accept", "")
        if request.method == "GET" and "text/html" not in accept:
            return propfind_response(request, fspath, settings.root_dir)

        try:
            entries = list_dir(fspath)
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")

        parts = [p for p in rel_path.strip("/").split("/") if p]
        breadcrumbs = [{"name": "Home", "path": "/"}]
        cumulative = ""
        for part in parts:
            cumulative += f"/{part}"
            breadcrumbs.append({"name": part, "path": cumulative + "/"})

        return templates.TemplateResponse(
            request,
            "index.html",
            {
                "entries": entries,
                "current_path": rel_path if rel_path.endswith("/") else rel_path + "/",
                "breadcrumbs": breadcrumbs,
                "user": user,
            },
        )

    async def _handle_edit(fspath: Path, request: Request, user: str) -> Response:
        rel_path = _to_rel_path(fspath)
        content = await anyio.Path(fspath).read_text(encoding="utf-8", errors="replace")
        dir_path = rel_path.rsplit("/", 1)[0] + "/"
        if dir_path == "//":
            dir_path = "/"
        return templates.TemplateResponse(
            request,
            "editor.html",
            {
                "file_path": rel_path,
                "dir_path": dir_path,
                "filename": fspath.name,
                "content": content,
                "ext": fspath.suffix.lstrip(".").lower(),
                "user": user,
            },
        )

    async def _zip_response(fspath: Path) -> Response:
        zip_name = (fspath.name or "archive") + ".zip"

        def _build() -> bytes:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for child in sorted(fspath.rglob("*")):
                    if child.is_file():
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

        # Check read permission for all operations (except OPTIONS)
        if method != "OPTIONS":
            _check_read_permission(user)

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
            return propfind_response(request, fspath, settings.root_dir)

        if method == "MKCOL":
            _check_write_permission(user)
            return mkcol_response(fspath)

        if method == "COPY":
            _check_write_permission(user)
            dest = dest_from_header(request, settings.root_dir)
            overwrite = request.headers.get("overwrite", "T").upper() != "F"
            return await copy_response(fspath, dest, overwrite)

        if method == "MOVE":
            _check_admin_permission(user)
            dest = dest_from_header(request, settings.root_dir)
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
