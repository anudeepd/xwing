"""Durable, checksum-verified chunk uploads.

The protocol is deliberately small:

``POST /init``
    Returns a stable upload id and the byte ranges the server already holds.
``POST /{upload_id}/chunk?offset=N&sha256=...``
    One verified byte window. A raw body, multipart body and PUT body all reach
    the same handler.
``GET /{upload_id}``
    Current ranges and policy.
``POST /{upload_id}/complete``
    Atomically publish a fully covered upload.
``DELETE /{upload_id}``
    Abandon an upload and remove its staged bytes.

The client chooses the transport. The server must accept the request shape
that survives the proxy, not assume the proxy will pass one particular shape.

The engine persists one manifest per upload. A manifest is updated only after
the corresponding bytes have been written and verified, so a server restart
can resume from what is actually on disk instead of restarting a large file.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.requests import ClientDisconnect

logger = logging.getLogger(__name__)

_SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CLIENT_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")

DEFAULT_INITIAL_CHUNK_SIZE = 4 * 1024 * 1024
DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024
MIN_CHUNK_SIZE = 64 * 1024
DEFAULT_CONCURRENCY = 2
DEFAULT_TTL_SECONDS = 3600
DEFAULT_MAX_SESSION_BYTES = 10 * 1024 * 1024 * 1024
DEFAULT_MAX_SESSIONS = 512
DEFAULT_MAX_SESSIONS_PER_USER = 16
DEFAULT_ACK_TIMEOUT_MS = 20_000
MULTIPART_OVERHEAD_ALLOWANCE = 128 * 1024

TRANSPORTS = ("binary_post", "multipart_post", "binary_put")

# Staged bytes live beside the destination so publish is a same-filesystem
# rename. Manifest files live under a hidden state directory at the served root.
STAGING_MARKER = ".upload-part-"
STATE_DIR_NAME = ".xwing-uploads"


def staging_name(filename: str, session_id: str) -> str:
    """Hidden staging filename for ``filename`` in its own destination directory."""
    return f".{filename}{STAGING_MARKER}{session_id}"


def is_staging_name(name: str) -> bool:
    """True for engine staging files, which are never user content."""
    return STAGING_MARKER in name


def _clamp_chunk_size(value: int, maximum: int) -> int:
    try:
        size = int(value)
    except (TypeError, ValueError):
        size = DEFAULT_INITIAL_CHUNK_SIZE
    top = max(1, int(maximum))
    return max(min(MIN_CHUNK_SIZE, top), min(top, size))


def _fsync_directory(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with temporary.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    _fsync_directory(path.parent)


def _is_within_root(root: Path, path: Path) -> bool:
    try:
        return path.resolve(strict=False).is_relative_to(root.resolve(strict=False))
    except (OSError, RuntimeError):
        return False


def _manifest_directory(root: Path, raw: object) -> Path:
    """Rebuild a destination from a manifest without probing the filesystem."""
    if not isinstance(raw, str) or "\x00" in raw:
        raise ValueError("manifest directory is not a path string")
    directory = Path(raw)
    if not directory.is_absolute() or ".." in directory.parts:
        raise ValueError("manifest directory is not an absolute path under the root")
    try:
        relative = directory.relative_to(root)
    except ValueError:
        raise ValueError("manifest destination is outside the storage root") from None
    return root.joinpath(*relative.parts)


def _remove_file(path: Path | None, root: Path) -> None:
    if path is None:
        return
    if not _is_within_root(root, path):
        logger.warning("refusing to remove upload artifact outside its storage root")
        return
    try:
        path.resolve(strict=False).unlink()
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("could not remove upload artifact", exc_info=True)


class RangeTracker:
    """Committed byte ranges as a sorted, merged, half-open interval list."""

    __slots__ = ("_spans",)

    def __init__(self, spans: list[list[int]] | None = None) -> None:
        self._spans: list[list[int]] = []
        for start, end in spans or ():
            self.add(int(start), int(end))

    def add(self, start: int, end: int) -> None:
        """Credit ``[start, end)``; adjacent and overlapping spans merge."""
        if end <= start:
            return
        lo, hi = int(start), int(end)
        merged: list[list[int]] = []
        placed = False
        for span in self._spans:
            if span[1] < lo:
                merged.append(span)
            elif span[0] > hi:
                if not placed:
                    merged.append([lo, hi])
                    placed = True
                merged.append(span)
            else:
                lo = min(lo, span[0])
                hi = max(hi, span[1])
        if not placed:
            merged.append([lo, hi])
        self._spans = merged

    def total(self) -> int:
        return sum(end - start for start, end in self._spans)

    def spans(self) -> list[tuple[int, int]]:
        return [(start, end) for start, end in self._spans]

    def to_json(self) -> list[list[int]]:
        return [[start, end] for start, end in self._spans]

    def covers(self, size: int) -> bool:
        """True when ``[0, size)`` is held exactly, with no holes or overflow."""
        if size == 0:
            return not self._spans
        return self._spans == [[0, int(size)]]

    def missing(self, size: int) -> list[tuple[int, int]]:
        """Gaps in ``[0, size)`` so a client can resume without a header scan."""
        gaps: list[tuple[int, int]] = []
        cursor = 0
        for start, end in self._spans:
            if start > cursor:
                gaps.append((cursor, min(start, size)))
            cursor = max(cursor, end)
        if cursor < size:
            gaps.append((cursor, size))
        return gaps


class UploadSinkError(Exception):
    """Raised by a sink when the destination rejects or fails the write."""

    def __init__(self, message: str, *, code: str = "SINK_ERROR", status: int = 502):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


class UploadSink(Protocol):
    """Destination for upload bytes. Implementations own their own locking."""

    async def write_at(self, offset: int, data: bytes) -> None: ...

    async def finalize(self) -> None:
        """Publish the staged bytes to the final path, atomically where possible."""
        ...

    async def abort(self) -> None:
        """Remove staged bytes. Must not raise."""
        ...


@dataclass(slots=True)
class UploadTarget:
    """Application-supplied destination description."""

    session_id: str
    user: str | None
    directory: str
    filename: str
    size: int
    staged_path: Path | None = None
    upload_key: str = ""
    fingerprint: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AuthContext:
    user: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class UploadSession:
    session_id: str
    user: str | None
    size: int
    target: UploadTarget
    upload_key: str
    created_at: float
    updated_at: float
    state: str = "open"
    ranges: RangeTracker = field(default_factory=RangeTracker)
    sink: UploadSink | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closing: bool = False
    staged_path: Path | None = None
    manifest_path: Path | None = None

    def expires_at(self, ttl: float) -> float:
        return self.updated_at + ttl


class UploadStore:
    """Durable session table.

    Each manifest is small and written atomically. The app currently runs one
    worker process; the per-session asyncio lock serialises credit and publish
    within that process. A manifest survives a restart, which is the failure the
    old in-memory table could not handle.
    """

    def __init__(
        self,
        *,
        state_dir: Path | None = None,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        max_request_bytes: int = DEFAULT_CHUNK_SIZE,
        max_session_bytes: int = DEFAULT_MAX_SESSION_BYTES,
        concurrency: int = DEFAULT_CONCURRENCY,
        max_sessions: int = DEFAULT_MAX_SESSIONS,
        max_sessions_per_user: int = DEFAULT_MAX_SESSIONS_PER_USER,
        storage_root: Path | None = None,
    ) -> None:
        self.ttl_seconds = float(ttl_seconds)
        self.max_request_bytes = max(MIN_CHUNK_SIZE, int(max_request_bytes))
        self.max_session_bytes = int(max_session_bytes)
        self.concurrency = max(1, int(concurrency))
        self.initial_chunk_size = min(
            DEFAULT_INITIAL_CHUNK_SIZE, self.max_request_bytes
        )
        self.max_sessions = int(max_sessions)
        self.max_sessions_per_user = int(max_sessions_per_user)
        self.state_dir = (
            state_dir or Path(tempfile.mkdtemp(prefix="xwing-upload-state-"))
        ).resolve()
        self.storage_root = (
            storage_root.resolve()
            if storage_root is not None
            else self.state_dir.parent
        )
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, UploadSession] = {}
        self._lock = asyncio.Lock()
        self._load_sessions()

    # -- lifecycle ---------------------------------------------------------

    def new_session_id(self) -> str:
        return uuid.uuid4().hex

    async def register(self, target: UploadTarget, *, user: str | None) -> UploadSession:
        now = time.time()
        session = UploadSession(
            session_id=target.session_id,
            user=user,
            size=int(target.size),
            target=target,
            upload_key=target.upload_key,
            created_at=now,
            updated_at=now,
            staged_path=target.staged_path,
            manifest_path=self.state_dir / f"{target.session_id}.json",
        )
        evicted: list[UploadSession] = []
        async with self._lock:
            while self.max_sessions > 0 and len(self._sessions) >= self.max_sessions:
                oldest = min(self._sessions.values(), key=lambda item: item.updated_at)
                self._sessions.pop(oldest.session_id, None)
                evicted.append(oldest)
            self._sessions[session.session_id] = session
        if target.staged_path is not None:
            # No manifest existed for this id, so any file with the staging name
            # is an orphan. Remove it before the first write.
            await anyio.to_thread.run_sync(
                _remove_file, target.staged_path, self.storage_root
            )
        await self.persist(session)
        for stale in evicted:
            await self._drop_session(stale, abort=True)
        return session

    def get(self, session_id: str) -> UploadSession | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        if time.time() - session.updated_at > self.ttl_seconds:
            return None
        return session

    def touch(self, session: UploadSession) -> None:
        session.updated_at = time.time()

    async def persist(self, session: UploadSession) -> None:
        if session.manifest_path is None:
            session.manifest_path = self.state_dir / f"{session.session_id}.json"
        payload = {
            "version": 2,
            "upload_id": session.session_id,
            "upload_key": session.upload_key,
            "user": session.user,
            "directory": session.target.directory,
            "filename": session.target.filename,
            "size": session.size,
            "staged_path": str(session.staged_path) if session.staged_path else None,
            "state": session.state,
            "ranges": session.ranges.to_json(),
            "fingerprint": session.target.fingerprint,
            "created_at": session.created_at,
            "updated_at": session.updated_at,
        }
        await anyio.to_thread.run_sync(_atomic_write_json, session.manifest_path, payload)

    async def drop(self, session_id: str, *, abort: bool = True) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is not None:
            await self._drop_session(session, abort=abort)

    async def sweep(self) -> int:
        """Abort and forget expired sessions. Returns the number reclaimed."""
        cutoff = time.time() - self.ttl_seconds
        async with self._lock:
            expired = [
                session
                for session in self._sessions.values()
                if session.updated_at <= cutoff
            ]
            for session in expired:
                self._sessions.pop(session.session_id, None)
        for session in expired:
            await self._drop_session(session, abort=True)
        return len(expired)

    async def close(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            await self._drop_session(session, abort=True)

    def user_session_count(self, user: str | None) -> int:
        if user is None:
            return 0
        return sum(
            1
            for session in self._sessions.values()
            if session.user == user and session.state == "open"
        )

    # -- internals ---------------------------------------------------------

    async def _drop_session(self, session: UploadSession, *, abort: bool) -> None:
        sink, session.sink = session.sink, None
        if sink is not None:
            try:
                await sink.abort()
            except Exception:
                logger.warning(
                    "upload sink abort failed session=%s", session.session_id, exc_info=True
                )
        if abort:
            await anyio.to_thread.run_sync(
                _remove_file, session.staged_path, self.storage_root
            )
        if session.manifest_path is not None:
            await anyio.to_thread.run_sync(
                _remove_file, session.manifest_path, self.state_dir
            )

    def _load_sessions(self) -> None:
        now = time.time()
        for path in sorted(self.state_dir.glob("*.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                state = payload.get("state")
                if payload.get("version") != 2 or state not in ("open", "complete"):
                    _remove_file(path, self.state_dir)
                    continue
                session_id = str(payload["upload_id"])
                if (
                    not _SESSION_ID_RE.fullmatch(session_id)
                    or path.name != f"{session_id}.json"
                ):
                    raise ValueError("manifest identity does not match its filename")
                directory = _manifest_directory(
                    self.storage_root, payload["directory"]
                )
                filename = str(payload["filename"])
                if (
                    not filename
                    or filename in (".", "..")
                    or any(char in filename for char in ("/", "\\", "\x00"))
                ):
                    raise ValueError("manifest filename is not a basename")
                staged_path = (
                    directory / staging_name(filename, session_id)
                    if state == "open"
                    else None
                )
                updated = float(payload.get("updated_at", 0))
                if now - updated > self.ttl_seconds:
                    _remove_file(path, self.state_dir)
                    _remove_file(staged_path, self.storage_root)
                    continue
                # The staged path is reconstructed from validated manifest fields.
                # This is local startup bookkeeping and never enters a response.
                if state == "open" and not staged_path.is_file():  # NOSONAR(S6549)
                    _remove_file(path, self.state_dir)
                    continue
                target = UploadTarget(
                    session_id=session_id,
                    user=payload.get("user"),
                    directory=str(directory),
                    filename=filename,
                    size=int(payload["size"]),
                    staged_path=staged_path if state == "open" else None,
                    upload_key=str(payload.get("upload_key", "")),
                    fingerprint=dict(payload.get("fingerprint") or {}),
                )
                session = UploadSession(
                    session_id=target.session_id,
                    user=target.user,
                    size=target.size,
                    target=target,
                    upload_key=target.upload_key,
                    created_at=float(payload.get("created_at", updated)),
                    updated_at=updated,
                    state=str(state),
                    ranges=RangeTracker(payload.get("ranges") or []),
                    staged_path=staged_path if state == "open" else None,
                    manifest_path=path,
                )
                self._sessions[session.session_id] = session
            except Exception:
                logger.warning("ignoring damaged upload manifest %r", path.name, exc_info=True)
                _remove_file(path, self.state_dir)


# ── Streaming helper for single-shot uploads (WebDAV PUT and friends) ─────────


async def stream_to_sink(
    request: Request,
    sink: UploadSink,
    *,
    max_bytes: int,
    offset: int = 0,
    expect_length: int | None = None,
) -> int:
    """Pipe a request body into ``sink`` from ``offset``. Returns bytes written."""
    written = 0
    async for chunk in request.stream():
        if not chunk:
            continue
        if written + len(chunk) > max_bytes:
            raise HTTPException(status_code=413, detail="Upload exceeds size limit")
        if expect_length is not None and written + len(chunk) > expect_length:
            raise HTTPException(status_code=400, detail="Body exceeds declared size")
        await sink.write_at(offset + written, chunk)
        written += len(chunk)
    if expect_length is not None and written != expect_length:
        raise HTTPException(status_code=400, detail="Body shorter than declared size")
    return written


def _session_id_for(user: str | None, body: dict[str, Any]) -> str:
    material = json.dumps(
        {
            "user": user or "",
            "key": str(body.get("upload_key", "")),
            "filename": str(body.get("filename", "")),
            "size": str(body.get("size", "")),
            "dir": str(body.get("dir", "")),
            "fingerprint": body.get("fingerprint") or {},
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


def _as_int(value: Any, field_name: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(status_code=400, detail=f"{field_name} must be an integer") from None


def _valid_sha(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip().lower()
    return candidate if _SHA256_RE.match(candidate) else None


# ── Router ────────────────────────────────────────────────────────────────────


def create_upload_router(
    *,
    store: UploadStore,
    authorize: Callable[[Request, str], Awaitable[AuthContext]],
    open_target: Callable[[Request, dict[str, Any]], Awaitable[UploadTarget]],
    open_sink: Callable[[UploadTarget], Awaitable[UploadSink]],
    on_complete: Callable[[UploadSession, str], Awaitable[None]] | None = None,
    prefix: str = "/_upload",
) -> APIRouter:
    """Build the chunked-upload routes."""
    router = APIRouter(prefix=prefix)

    def _load(session_id: str) -> UploadSession:
        if not _SESSION_ID_RE.match(session_id):
            raise HTTPException(
                status_code=404,
                detail={"code": "SESSION_LOST", "message": "Upload session not found"},
            )
        session = store.get(session_id)
        if session is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "SESSION_LOST", "message": "Upload session not found"},
            )
        return session

    def _check_owner(session: UploadSession, context: AuthContext) -> None:
        if session.user and session.user != context.user:
            raise HTTPException(
                status_code=403,
                detail={"code": "NOT_OWNER", "message": "Not session owner"},
            )

    def _payload(session: UploadSession, **extra: Any) -> dict[str, Any]:
        body: dict[str, Any] = {
            "upload_id": session.session_id,
            "state": session.state,
            "size": session.size,
            "ranges": session.ranges.to_json(),
            "received": session.ranges.total(),
            "chunk_policy": {
                "initial_bytes": store.initial_chunk_size,
                "max_bytes": store.max_request_bytes,
                "max_concurrency": store.concurrency,
            },
            "transport_order": list(TRANSPORTS),
            "ack_timeout_ms": DEFAULT_ACK_TIMEOUT_MS,
            "expires_at": session.expires_at(store.ttl_seconds),
        }
        body.update(extra)
        if session.state == "complete":
            body["path"] = session.target.filename
            body["verified"] = True
        return body

    @router.post("/init")
    async def upload_init(request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON") from None
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="JSON body must be an object")

        upload_key = body.get("upload_key")
        if not isinstance(upload_key, str) or not _CLIENT_KEY_RE.match(upload_key):
            upload_key = uuid.uuid4().hex
        body = dict(body)
        body["upload_key"] = upload_key

        session_id = _session_id_for(context.user, body)
        existing = store.get(session_id)
        if existing is not None:
            _check_owner(existing, context)
            return JSONResponse(_payload(existing))

        if (
            store.max_sessions_per_user
            and store.user_session_count(context.user) >= store.max_sessions_per_user
        ):
            raise HTTPException(status_code=429, detail="Too many concurrent uploads")

        body["session_id"] = session_id
        target = await open_target(request, body)
        if isinstance(target, dict):
            return JSONResponse(target)
        if target.size < 0:
            raise HTTPException(status_code=400, detail="size must not be negative")
        if target.size > store.max_session_bytes:
            raise HTTPException(status_code=413, detail="Upload exceeds size limit")

        session = await store.register(target, user=context.user)
        logger.info(
            "upload init user=%s session=%s size=%s target=%s",
            context.user,
            session.session_id,
            session.size,
            target.filename,
        )
        return JSONResponse(_payload(session))

    @router.get("/{session_id}")
    async def upload_status(session_id: str, request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        session = _load(session_id)
        _check_owner(session, context)
        return JSONResponse(_payload(session))

    @router.put("/{session_id}")
    async def legacy_upload_put(session_id: str, request: Request) -> JSONResponse:
        """Stop v1 PUTs before they can fall through to the WebDAV catch-all."""
        await authorize(request, "write")
        raise HTTPException(
            status_code=410,
            detail={
                "code": "LEGACY_UPLOAD_REMOVED",
                "message": (
                    "The old upload protocol is no longer supported. "
                    "Reload the page and start the upload again."
                ),
            },
        )

    @router.api_route("/{session_id}/chunk", methods=["POST", "PUT"])
    async def upload_chunk(session_id: str, request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        session = _load(session_id)
        _check_owner(session, context)
        if session.state == "complete":
            return JSONResponse(_payload(session))

        content_type = request.headers.get("content-type", "").lower()
        multipart = content_type.startswith("multipart/form-data")
        limit = store.max_request_bytes + (MULTIPART_OVERHEAD_ALLOWANCE if multipart else 0)
        raw_length = request.headers.get("content-length")
        if raw_length is not None:
            try:
                content_length = int(raw_length)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid Content-Length") from None
            if content_length > limit:
                raise HTTPException(
                    status_code=413,
                    detail={
                        "code": "CHUNK_TOO_LARGE",
                        "message": f"Request body exceeds {store.max_request_bytes} bytes",
                    },
                )

        form = None
        offset_value = request.query_params.get("offset")
        sha_value = request.query_params.get("sha256")
        request_id = request.query_params.get("request_id")
        declared_length = request.query_params.get("length")

        try:
            if multipart:
                form = await request.form(max_files=1, max_fields=8)
                offset_value = form.get("offset", offset_value)
                sha_value = form.get("sha256", sha_value)
                request_id = form.get("request_id", request_id)
                declared_length = form.get("length", declared_length)

            if offset_value is None:
                raise HTTPException(status_code=400, detail="offset is required")
            offset = _as_int(offset_value, "offset")
            if offset < 0 or offset > session.size:
                raise HTTPException(status_code=400, detail="offset out of range")

            sha256 = _valid_sha(sha_value)
            if sha256 is None:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "MISSING_DIGEST",
                        "message": "A SHA-256 digest is required for every chunk",
                    },
                )
            expected_length = (
                _as_int(declared_length, "length") if declared_length is not None else None
            )
            if expected_length is not None and expected_length < 0:
                raise HTTPException(status_code=400, detail="length must not be negative")

            async with session.lock:
                if session.closing:
                    raise HTTPException(status_code=409, detail="Upload session is closing")
                sink = session.sink
                if sink is None:
                    sink = await open_sink(session.target)
                    session.sink = sink

            remaining = session.size - offset
            hasher = hashlib.sha256()
            written = 0

            async def consume(data: bytes) -> None:
                nonlocal written
                if not data:
                    return
                if written + len(data) > remaining:
                    raise HTTPException(
                        status_code=413, detail="Chunk exceeds remaining upload size"
                    )
                if written + len(data) > store.max_request_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail={
                            "code": "CHUNK_TOO_LARGE",
                            "message": "Chunk exceeds the server request limit",
                        },
                    )
                await sink.write_at(offset + written, data)
                hasher.update(data)
                written += len(data)

            if multipart:
                upload = form.get("file") if form is not None else None
                if not isinstance(upload, UploadFile):
                    raise HTTPException(status_code=400, detail="multipart field 'file' is required")
                while True:
                    data = await upload.read(1024 * 1024)
                    if not data:
                        break
                    await consume(data)
            else:
                async for data in request.stream():
                    await consume(data)

            if written == 0:
                raise HTTPException(status_code=400, detail="Empty chunk")
            if expected_length is not None and written != expected_length:
                raise HTTPException(status_code=400, detail="Body length does not match declaration")
            if hasher.hexdigest() != sha256:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "DIGEST_MISMATCH",
                        "message": "The chunk did not survive the transfer intact",
                    },
                )

            async with session.lock:
                if session.closing:
                    raise HTTPException(status_code=409, detail="Upload session is closing")
                session.ranges.add(offset, offset + written)
                store.touch(session)
                await store.persist(session)
                body = _payload(
                    session,
                    received=written,
                    next_offset=offset + written,
                    request_id=str(request_id or ""),
                    transport=(
                        "multipart_post"
                        if multipart
                        else ("binary_put" if request.method == "PUT" else "binary_post")
                    ),
                )
            return JSONResponse(body)
        except HTTPException:
            raise
        except ClientDisconnect:
            return JSONResponse(status_code=499, content={"code": "CLIENT_DISCONNECTED"})
        except UploadSinkError as exc:
            logger.warning(
                "upload sink rejected data session=%s code=%s",
                session.session_id,
                exc.code,
            )
            return JSONResponse(
                status_code=exc.status,
                content={"ok": False, "code": exc.code, "message": exc.message},
            )
        except Exception as exc:
            logger.warning(
                "upload write failed session=%s", session.session_id, exc_info=True
            )
            return JSONResponse(
                status_code=502,
                content={
                    "ok": False,
                    "code": "WRITE_FAILED",
                    "message": f"Upload write failed: {exc}",
                },
            )
        finally:
            if form is not None:
                await form.close()

    @router.post("/{session_id}/complete")
    async def upload_complete(session_id: str, request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        session = _load(session_id)
        _check_owner(session, context)
        if session.state == "complete":
            return JSONResponse(_payload(session))

        async with session.lock:
            if session.closing:
                raise HTTPException(status_code=409, detail="Upload session is closing")
            if not session.ranges.covers(session.size):
                missing = session.ranges.missing(session.size)
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "UPLOAD_INCOMPLETE",
                        "message": f"Upload incomplete, missing ranges: {missing}",
                    },
                )
            session.closing = True
            sink = session.sink
            if sink is None:
                try:
                    sink = await open_sink(session.target)
                except HTTPException:
                    session.closing = False
                    raise
                session.sink = sink

        try:
            staged = session.staged_path
            if staged is not None and session.size > 0:
                try:
                    size = (await anyio.to_thread.run_sync(staged.stat)).st_size
                except FileNotFoundError:
                    session.closing = False
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "STAGED_FILE_TRUNCATED",
                            "message": "Staged upload is missing",
                        },
                    ) from None
                if size < session.size:
                    session.closing = False
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "STAGED_FILE_TRUNCATED",
                            "message": "Staged upload is shorter than its committed ranges",
                        },
                    )
            await sink.finalize()
        except HTTPException:
            session.closing = False
            raise
        except Exception as exc:
            session.closing = False
            session.sink = None
            logger.exception("upload finalize failed session=%s", session.session_id)
            raise HTTPException(
                status_code=500,
                detail={
                    "code": "FINALIZE_FAILED",
                    "message": f"Upload finalize failed: {exc}",
                },
            ) from exc

        destination = session.target.filename
        session.state = "complete"
        session.sink = None
        session.staged_path = None
        session.target.staged_path = None
        store.touch(session)
        await store.persist(session)
        if on_complete is not None:
            try:
                await on_complete(session, destination)
            except Exception:
                logger.exception("upload completion hook failed session=%s", session.session_id)
        return JSONResponse(
            {"path": destination, "size": session.size, "verified": True}
        )

    @router.delete("/{session_id}")
    async def upload_cancel(session_id: str, request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        session = _load(session_id)
        _check_owner(session, context)
        await store.drop(session_id)
        return JSONResponse({"ok": True})

    return router
