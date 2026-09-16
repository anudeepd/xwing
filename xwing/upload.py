"""Xwing's adapter over the shared chunked upload engine.

Everything protocol-level (sessions, byte ranges, retry semantics, resume)
lives in :mod:`xwing.upload_engine`, which is vendored byte-identical into
torrus. This module only supplies what is xwing-specific:

* :class:`LocalFileSink` - staged writes to the destination filesystem via
  ``os.pwrite``, published with ``os.replace``.
* the init policy - filename sanitising, ``.env`` rejection, destination
  directory validation, ignored system files.
* audit recording on completion.
"""

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import anyio
from fastapi import APIRouter, HTTPException, Request

from . import audit_store
from .auth import get_user, require_perm
from .config import Settings
from .files import is_ignored_system_file, is_within_root, safe_path
from .upload_engine import (
    AuthContext,
    UploadSink,
    UploadStore,
    UploadTarget,
    create_upload_router as create_engine_router,
    staging_name,
)

logger = logging.getLogger(__name__)


def _open_staging(path: Path) -> int:
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)


def _fsync_and_close(fd: int) -> None:
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _pwrite_all(fd: int, data: memoryview, offset: int) -> None:
    view = data
    while view:
        written = os.pwrite(fd, view, offset)
        if written <= 0:
            raise OSError("short write")
        offset += written
        view = view[written:]


class LocalFileSink:
    """Staged writes to a local destination, published atomically.

    ``os.pwrite`` is offset-addressed, so parallel chunk writers never contend
    and never need a shared cursor. The staging file sits beside the
    destination so the publish is a same-filesystem ``os.replace``.
    """

    def __init__(self, staged: Path, destination: Path) -> None:
        self._staged = staged
        self._destination = destination
        self._fd: int | None = None
        self._open_lock = asyncio.Lock()
        self._closed = False

    async def _descriptor(self) -> int:
        if self._fd is not None:
            return self._fd
        async with self._open_lock:
            if self._fd is None:
                self._fd = await anyio.to_thread.run_sync(_open_staging, self._staged)
        return self._fd

    async def write_at(self, offset: int, data: bytes) -> None:
        if self._closed:
            raise OSError("upload sink is closed")
        fd = await self._descriptor()
        await anyio.to_thread.run_sync(_pwrite_all, fd, memoryview(data), offset)

    def _take_descriptor(self) -> int | None:
        fd, self._fd = self._fd, None
        self._closed = True
        return fd

    async def finalize(self) -> None:
        fd = self._take_descriptor()
        if fd is None:
            # An empty upload never wrote, so the staging file does not exist yet.
            fd = await anyio.to_thread.run_sync(_open_staging, self._staged)
        await anyio.to_thread.run_sync(_fsync_and_close, fd)
        await anyio.to_thread.run_sync(self._staged.replace, self._destination)

    async def abort(self) -> None:
        fd = self._take_descriptor()
        if fd is not None:
            try:
                await anyio.to_thread.run_sync(os.close, fd)
            except OSError:
                pass
        try:
            await anyio.to_thread.run_sync(self._staged.unlink)
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning("could not remove staging file %s", self._staged)


def build_upload_store(settings: Settings) -> UploadStore:
    """Session table sized from application settings."""
    return UploadStore(
        ttl_seconds=settings.session_ttl_seconds,
        chunk_size=settings.max_chunk_bytes,
        max_session_bytes=settings.max_upload_bytes,
    )


def create_upload_router(settings: Settings, store: UploadStore) -> APIRouter:
    """Engine routes wired to xwing's authorisation, policy and audit."""

    async def authorize(request: Request, action: str) -> AuthContext:
        user = get_user(request, settings)
        require_perm(user, action or "write", settings)
        return AuthContext(user=user)

    async def open_target(
        request: Request, body: dict[str, Any]
    ) -> UploadTarget | dict[str, Any]:
        raw_name = body.get("filename", "upload")
        if not isinstance(raw_name, str):
            raise HTTPException(status_code=400, detail="Invalid filename")
        # Strip path components: only the bare filename is accepted.
        filename = Path(raw_name).name
        if not filename or filename in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid filename")
        if is_ignored_system_file(filename):
            return {"ignored": True}
        if filename == ".env" or filename.startswith(".env."):
            raise HTTPException(
                status_code=400, detail="Uploading .env files is not allowed"
            )

        try:
            size = int(body.get("size", 0))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="size must be an integer") from None

        raw_dir = body.get("dir", "")
        if not isinstance(raw_dir, str):
            raise HTTPException(status_code=400, detail="dir must be a string")
        try:
            dest_dir = safe_path(settings.root_dir, unquote(raw_dir))
        except PermissionError:
            raise HTTPException(status_code=403, detail="Forbidden destination") from None
        if not dest_dir.exists() or not dest_dir.is_dir():
            raise HTTPException(status_code=404, detail="Destination directory not found")

        return UploadTarget(
            session_id=str(body["session_id"]),
            user=None,
            directory=str(dest_dir),
            filename=filename,
            size=size,
            extra={"dest_dir": str(dest_dir)},
        )

    async def open_sink(target: UploadTarget) -> UploadSink:
        dest_dir = Path(target.directory)
        destination = dest_dir / target.filename
        if not is_within_root(settings.root_dir, destination):
            raise HTTPException(status_code=403, detail="Forbidden destination")
        staged = dest_dir / staging_name(target.filename, target.session_id)
        return LocalFileSink(staged, destination)

    async def on_complete(session, destination: str) -> None:
        # Audit paths are root-relative with a leading slash, matching the
        # WebDAV PUT path so both upload routes are greppable the same way.
        relative = Path(session.target.directory, destination).relative_to(
            settings.root_dir
        )
        await _record_upload_audit(
            settings=settings,
            user=session.user or "anonymous",
            path="/" + relative.as_posix(),
            total_bytes=session.ranges.total(),
        )

    return create_engine_router(
        store=store,
        authorize=authorize,
        open_target=open_target,
        open_sink=open_sink,
        on_complete=on_complete,
    )


async def _record_upload_audit(
    *,
    settings: Settings,
    user: str,
    path: str,
    total_bytes: int,
) -> None:
    started = time.monotonic()
    details = json.dumps({"bytes": total_bytes}, ensure_ascii=False)
    logger.info(
        "file operation user=%s operation=upload path=%s status=204 details=%s",
        user,
        path,
        details,
    )
    if not settings.audit_db or user == "anonymous":
        return
    try:
        await audit_store.record_event_async(
            db_path=settings.audit_db,
            username=user,
            method="upload",
            path=path,
            details=details,
            status_code=204,
            duration_ms=round((time.monotonic() - started) * 1000, 2),
        )
    except Exception:
        logger.exception("Failed to record upload audit event")


async def cleanup_stale_sessions(store: UploadStore) -> None:
    """Background task: abort and forget sessions that outlived their TTL."""
    while True:
        await asyncio.sleep(300)
        try:
            reclaimed = await store.sweep()
            if reclaimed:
                logger.info("reclaimed %s stale upload sessions", reclaimed)
        except Exception:
            logger.exception("upload session sweep failed")
