"""Chunked upload engine shared by torrus and xwing.

This file is vendored verbatim into both repositories; keep the two copies
byte-identical (tests/test_upload_engine_parity.py pins the digest). It imports
nothing from either application, so it can be copied between packages unchanged.

Wire protocol
-------------
``POST {prefix}/init``            -> {upload_id, chunk_size, concurrency, size, expires_at}
``PUT  {prefix}/{upload_id}?offset=N`` raw body -> {received, ranges, next_offset}
``GET  {prefix}/{upload_id}``     -> {size, chunk_size, concurrency, ranges, received}
``POST {prefix}/{upload_id}/complete`` -> {path, size}
``DELETE {prefix}/{upload_id}``   -> {ok: true}

The server owns committed *byte ranges*, never chunk indices. A client may
shrink or grow its chunk size mid-upload and may retry a range from any offset
inside it: whatever the server durably holds is credited and never re-sent.
That is what makes a DLP/ForcePoint stall cheap instead of fatal.

There is deliberately no server-side per-request time limit. Slow bodies are
accepted; dead sessions are reclaimed by :meth:`UploadStore.sweep` on TTL.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

_SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")

DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024
MIN_CHUNK_SIZE = 1 * 1024 * 1024
MAX_CHUNK_SIZE = 64 * 1024 * 1024
DEFAULT_CONCURRENCY = 4
DEFAULT_TTL_SECONDS = 3600
DEFAULT_MAX_SESSION_BYTES = 10 * 1024 * 1024 * 1024
DEFAULT_MAX_SESSIONS = 512
DEFAULT_MAX_SESSIONS_PER_USER = 16

# Staged bytes live beside the destination so `finalize` can publish with
# `os.replace` on the same filesystem. Directory listings must skip these:
# callers filter with `is_staging_name`.
STAGING_MARKER = ".upload-part-"


def staging_name(filename: str, session_id: str) -> str:
    """Hidden staging filename for ``filename`` in its own destination directory."""
    return f".{filename}{STAGING_MARKER}{session_id}"


def is_staging_name(name: str) -> bool:
    """True for engine staging files, which are never user content."""
    return STAGING_MARKER in name


# ── Byte-range accounting ─────────────────────────────────────────────────────


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
        """Gaps in ``[0, size)``, so a client can resume without a header scan."""
        gaps: list[tuple[int, int]] = []
        cursor = 0
        for start, end in self._spans:
            if start > cursor:
                gaps.append((cursor, min(start, size)))
            cursor = max(cursor, end)
        if cursor < size:
            gaps.append((cursor, size))
        return gaps


# ── Sink contract ─────────────────────────────────────────────────────────────


class UploadSinkError(Exception):
    """Raised by a sink when the destination rejects or fails the write.

    Carries the application's own error code so the client keeps the specific
    message it had before the engines were unified.
    """

    def __init__(self, message: str, *, code: str = "SINK_ERROR", status: int = 502):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


class UploadSink(Protocol):
    """Destination for upload bytes.

    Implementations own their own concurrency control. ``LocalFileSink`` uses
    ``os.pwrite`` and serves parallel writers directly; ``SFTPSink`` serialises
    behind a single SFTP handle because the protocol has one write cursor.
    """

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
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AuthContext:
    user: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


# ── Session store ─────────────────────────────────────────────────────────────


@dataclass
class UploadSession:
    session_id: str
    user: str | None
    size: int
    chunk_size: int
    concurrency: int
    target: UploadTarget
    created_at: float
    updated_at: float
    ranges: RangeTracker = field(default_factory=RangeTracker)
    sink: UploadSink | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closing: bool = False

    def expires_at(self, ttl: float) -> float:
        return self.updated_at + ttl


class UploadStore:
    """In-memory session table with TTL reclamation.

    Sessions are deliberately not persisted: a session that outlives its
    process has no sink, and the staged bytes are removed by ``sweep`` on the
    next start. Clients re-init instead of resuming into a dead handle.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        concurrency: int = DEFAULT_CONCURRENCY,
        max_session_bytes: int = DEFAULT_MAX_SESSION_BYTES,
        max_sessions: int = DEFAULT_MAX_SESSIONS,
        max_sessions_per_user: int = DEFAULT_MAX_SESSIONS_PER_USER,
    ) -> None:
        self.ttl_seconds = float(ttl_seconds)
        self.chunk_size = _clamp_chunk_size(chunk_size)
        self.concurrency = max(1, int(concurrency))
        self.max_session_bytes = int(max_session_bytes)
        self.max_sessions = int(max_sessions)
        self.max_sessions_per_user = int(max_sessions_per_user)
        self._sessions: dict[str, UploadSession] = {}
        self._lock = asyncio.Lock()

    # -- lifecycle ---------------------------------------------------------

    def new_session_id(self) -> str:
        return uuid.uuid4().hex

    async def register(self, target: UploadTarget, *, user: str | None) -> UploadSession:
        now = time.time()
        session = UploadSession(
            session_id=target.session_id,
            user=user,
            size=int(target.size),
            chunk_size=self.chunk_size,
            concurrency=self.concurrency,
            target=target,
            created_at=now,
            updated_at=now,
        )
        async with self._lock:
            await self._evict_locked()
            self._sessions[session.session_id] = session
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

    async def drop(self, session_id: str, *, abort: bool = True) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return
        await _abort_session(session, enabled=abort)

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
            await _abort_session(session, enabled=True)
        return len(expired)

    async def close(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            await _abort_session(session, enabled=True)

    # -- internals ---------------------------------------------------------

    async def _evict_locked(self) -> None:
        """Make room for one more session. Caller holds ``self._lock``."""
        while len(self._sessions) >= self.max_sessions:
            oldest = min(self._sessions.values(), key=lambda item: item.updated_at)
            self._sessions.pop(oldest.session_id, None)
            await _abort_session(oldest, enabled=True)

    def user_session_count(self, user: str | None) -> int:
        if user is None:
            return 0
        return sum(1 for session in self._sessions.values() if session.user == user)


async def _abort_session(session: UploadSession, *, enabled: bool) -> None:
    if not enabled:
        return
    sink = session.sink
    session.sink = None
    if sink is None:
        return
    try:
        await sink.abort()
    except Exception:
        logger.warning("upload sink abort failed session=%s", session.session_id, exc_info=True)


def _clamp_chunk_size(value: int) -> int:
    try:
        size = int(value)
    except (TypeError, ValueError):
        return DEFAULT_CHUNK_SIZE
    return max(MIN_CHUNK_SIZE, min(MAX_CHUNK_SIZE, size))


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
    """Build the chunked-upload routes.

    ``authorize`` runs before every request and may raise ``HTTPException``.
    ``open_target`` validates the init body against application policy and
    returns the destination. ``open_sink`` creates the destination writer.
    """
    router = APIRouter(prefix=prefix)

    def _load(session_id: str) -> UploadSession:
        if not _SESSION_ID_RE.match(session_id):
            raise HTTPException(status_code=404, detail="Upload session not found")
        session = store.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Upload session not found")
        return session

    def _check_owner(session: UploadSession, context: AuthContext) -> None:
        if session.user and session.user != context.user:
            raise HTTPException(status_code=403, detail="Not session owner")

    def _payload(session: UploadSession, **extra: Any) -> dict[str, Any]:
        body: dict[str, Any] = {
            "size": session.size,
            "chunk_size": session.chunk_size,
            "concurrency": session.concurrency,
            "ranges": session.ranges.to_json(),
            "received": session.ranges.total(),
            "expires_at": session.expires_at(store.ttl_seconds),
        }
        body.update(extra)
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

        if (
            store.max_sessions_per_user
            and store.user_session_count(context.user) >= store.max_sessions_per_user
        ):
            raise HTTPException(status_code=429, detail="Too many concurrent uploads")

        body = dict(body)
        body["session_id"] = store.new_session_id()
        target = await open_target(request, body)
        if isinstance(target, dict):
            # Application policy declined the upload (ignored system file, and
            # so on). Passthrough keeps the caller's UI copy unchanged.
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
        return JSONResponse(
            {
                "upload_id": session.session_id,
                "chunk_size": session.chunk_size,
                "concurrency": session.concurrency,
                "size": session.size,
                "expires_at": session.expires_at(store.ttl_seconds),
            }
        )

    @router.get("/{session_id}")
    async def upload_status(session_id: str, request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        session = _load(session_id)
        _check_owner(session, context)
        return JSONResponse(_payload(session))

    @router.put("/{session_id}")
    async def upload_put(session_id: str, request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        session = _load(session_id)
        _check_owner(session, context)

        raw_offset = request.query_params.get("offset", "0")
        try:
            offset = int(raw_offset)
        except ValueError:
            raise HTTPException(status_code=400, detail="offset must be an integer") from None
        if offset < 0 or offset > session.size:
            raise HTTPException(status_code=400, detail="offset out of range")

        async with session.lock:
            if session.closing:
                raise HTTPException(status_code=409, detail="Upload session is closing")
            sink = session.sink
            if sink is None:
                sink = await open_sink(session.target)
                session.sink = sink

        remaining = session.size - offset
        written = 0
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                if written + len(chunk) > remaining:
                    raise HTTPException(
                        status_code=413, detail="Chunk exceeds remaining upload size"
                    )
                if session.ranges.total() + written + len(chunk) > store.max_session_bytes:
                    raise HTTPException(status_code=413, detail="Upload exceeds size limit")
                await sink.write_at(offset + written, chunk)
                written += len(chunk)
        except HTTPException:
            raise
        except UploadSinkError as exc:
            logger.warning(
                "upload sink rejected data session=%s offset=%s code=%s",
                session.session_id,
                offset,
                exc.code,
            )
            return JSONResponse(
                status_code=exc.status,
                content={"ok": False, "code": exc.code, "message": exc.message},
            )
        except Exception as exc:
            logger.warning(
                "upload write failed session=%s offset=%s written=%s",
                session.session_id,
                offset,
                written,
                exc_info=True,
            )
            raise HTTPException(status_code=502, detail=f"Upload write failed: {exc}") from exc

        async with session.lock:
            if session.closing:
                raise HTTPException(status_code=409, detail="Upload session is closing")
            session.ranges.add(offset, offset + written)
            store.touch(session)
            payload = _payload(session, received=written, next_offset=offset + written)
        return JSONResponse(payload)

    @router.post("/{session_id}/complete")
    async def upload_complete(session_id: str, request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        session = _load(session_id)
        _check_owner(session, context)

        async with session.lock:
            if not session.ranges.covers(session.size):
                missing = session.ranges.missing(session.size)
                raise HTTPException(
                    status_code=400,
                    detail=f"Upload incomplete, missing ranges: {missing}",
                )
            session.closing = True
            sink = session.sink
            if sink is None:
                session.closing = False
                raise HTTPException(status_code=400, detail="Upload session has no data")

        try:
            await sink.finalize()
        except HTTPException:
            session.closing = False
            raise
        except Exception as exc:
            session.closing = False
            logger.exception("upload finalize failed session=%s", session.session_id)
            await store.drop(session.session_id)
            raise HTTPException(status_code=500, detail=f"Upload finalize failed: {exc}") from exc

        destination = session.target.filename
        await store.drop(session.session_id, abort=False)
        if on_complete is not None:
            try:
                await on_complete(session, destination)
            except Exception:
                logger.exception("upload completion hook failed session=%s", session.session_id)
        return JSONResponse({"path": destination, "size": session.size})

    @router.delete("/{session_id}")
    async def upload_cancel(session_id: str, request: Request) -> JSONResponse:
        context = await authorize(request, "write")
        session = _load(session_id)
        _check_owner(session, context)
        await store.drop(session_id)
        return JSONResponse({"ok": True})

    return router
