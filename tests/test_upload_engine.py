"""Behavioural tests for the durable upload engine."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from xwing.upload_engine import (
    AuthContext,
    RangeTracker,
    UploadSink,
    UploadSinkError,
    UploadStore,
    UploadTarget,
    create_upload_router,
    staging_name,
)


class RecordingSink:
    """In-memory sink: records writes, tracks publish/abort."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.finalized = False
        self.aborted = False
        self.failure: Exception | None = None

    async def write_at(self, offset: int, data: bytes) -> None:
        if self.failure is not None:
            raise self.failure
        end = offset + len(data)
        if end > len(self.data):
            self.data.extend(b"\x00" * (end - len(self.data)))
        self.data[offset:end] = data

    async def finalize(self) -> None:
        self.finalized = True

    async def abort(self) -> None:
        self.aborted = True


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def init_upload(
    client: TestClient,
    name: str,
    size: int,
    *,
    directory: str = "/",
    upload_key: str | None = None,
    headers: dict[str, str] | None = None,
) -> dict:
    return client.post(
        "/_upload/init",
        json={
            "upload_key": upload_key or uuid.uuid4().hex,
            "filename": name,
            "size": size,
            "dir": directory,
            "fingerprint": {"name": name, "size": size, "last_modified": 1},
        },
        headers=headers,
    ).json()


def send_chunk(
    client: TestClient,
    upload_id: str,
    offset: int,
    body: bytes,
    *,
    headers: dict[str, str] | None = None,
    sha: str | None = None,
    length: int | None = None,
):
    return client.post(
        f"/_upload/{upload_id}/chunk",
        params={
            "offset": offset,
            "sha256": sha or digest(body),
            "length": len(body) if length is None else length,
        },
        content=body,
        headers={"Content-Type": "application/octet-stream", **(headers or {})},
    )


def build_app(state_dir: Path, **store_kwargs):
    """Wire the engine onto a tiny app whose acting user the test can swap."""
    sink = RecordingSink()
    store = UploadStore(state_dir=state_dir, **store_kwargs)
    current = {"user": "alice"}

    async def authorize(request: Request, action: str) -> AuthContext:
        return AuthContext(user=current["user"])

    async def open_target(request: Request, body: dict) -> UploadTarget | dict:
        if body.get("filename") == "skip.me":
            return {"ignored": True}
        return UploadTarget(
            session_id=body["session_id"],
            user=current["user"],
            directory="/",
            filename=str(body.get("filename", "file.bin")),
            size=int(body.get("size", 0)),
            upload_key=str(body.get("upload_key", "")),
            fingerprint=dict(body.get("fingerprint") or {}),
        )

    async def open_sink(target: UploadTarget) -> UploadSink:
        return sink

    app = FastAPI()
    app.include_router(
        create_upload_router(
            store=store,
            authorize=authorize,
            open_target=open_target,
            open_sink=open_sink,
        )
    )
    return app, store, sink, current


@pytest.fixture
def harness(tmp_path):
    app, store, sink, current = build_app(tmp_path / "state")
    with TestClient(app) as client:
        yield client, store, sink, current


class TestRangeTracker:
    def test_merges_overlapping_and_adjacent_spans(self):
        tracker = RangeTracker()
        for start, end in ((10, 20), (0, 10), (30, 40), (20, 30)):
            tracker.add(start, end)
        assert tracker.spans() == [(0, 40)]
        assert tracker.total() == 40
        assert tracker.covers(40)
        assert not tracker.covers(41)

    def test_reports_gaps_in_order(self):
        tracker = RangeTracker([[0, 10], [30, 40]])
        assert tracker.missing(50) == [(10, 30), (40, 50)]
        assert not tracker.covers(50)

    def test_empty_file_is_covered_by_no_spans(self):
        assert RangeTracker().covers(0)

    def test_ignores_empty_and_inverted_spans(self):
        tracker = RangeTracker()
        tracker.add(5, 5)
        tracker.add(9, 4)
        assert tracker.spans() == []


class TestInit:
    def test_rejects_non_object_body(self, harness):
        client, _, _, _ = harness
        assert client.post("/_upload/init", json=["nope"]).status_code == 400

    def test_rejects_negative_size(self, harness):
        client, _, _, _ = harness
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "negative-key",
                "filename": "a.bin",
                "size": -1,
                "dir": "/",
            },
        )
        assert response.status_code == 400

    def test_rejects_size_over_limit(self, tmp_path):
        app, _, _, _ = build_app(tmp_path / "state", max_session_bytes=10)
        with TestClient(app) as client:
            response = client.post(
                "/_upload/init",
                json={
                    "upload_key": "too-big-key",
                    "filename": "a.bin",
                    "size": 11,
                    "dir": "/",
                },
            )
        assert response.status_code == 413

    def test_policy_can_decline_an_upload(self, harness):
        client, _, _, _ = harness
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "skip-key-1234",
                "filename": "skip.me",
                "size": 1,
                "dir": "/",
            },
        )
        assert response.json() == {"ignored": True}

    def test_init_is_idempotent_for_the_same_key_and_file(self, harness):
        client, _, _, _ = harness
        key = "stable-upload-key"
        first = init_upload(client, "a.bin", 8, upload_key=key)
        second = init_upload(client, "a.bin", 8, upload_key=key)
        assert first["upload_id"] == second["upload_id"]
        assert first["chunk_policy"]["initial_bytes"] == 4 * 1024 * 1024
        assert first["chunk_policy"]["max_concurrency"] == 2

    def test_a_different_key_creates_a_different_session(self, harness):
        client, _, _, _ = harness
        first = init_upload(client, "a.bin", 8, upload_key="key-one-1234")
        second = init_upload(client, "a.bin", 8, upload_key="key-two-1234")
        assert first["upload_id"] != second["upload_id"]


class TestUploadLifecycle:
    def test_out_of_order_writes_assemble_the_file(self, harness):
        client, _, sink, _ = harness
        upload_id = init_upload(client, "a.bin", 8)["upload_id"]

        assert send_chunk(client, upload_id, 4, b"efgh").status_code == 200
        assert send_chunk(client, upload_id, 0, b"abcd").status_code == 200
        assert bytes(sink.data) == b"abcdefgh"

        result = client.post(f"/_upload/{upload_id}/complete")
        assert result.status_code == 200
        assert sink.finalized
        assert result.json() == {"path": "a.bin", "size": 8, "verified": True}

    def test_complete_rejects_a_hole_and_names_it(self, harness):
        client, _, sink, _ = harness
        upload_id = init_upload(client, "a.bin", 8)["upload_id"]
        send_chunk(client, upload_id, 0, b"abcd")

        response = client.post(f"/_upload/{upload_id}/complete")
        assert response.status_code == 400
        detail = response.json()["detail"]
        assert detail["code"] == "UPLOAD_INCOMPLETE"
        assert "(4, 8)" in detail["message"]
        assert not sink.finalized

        send_chunk(client, upload_id, 4, b"efgh")
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200
        assert bytes(sink.data) == b"abcdefgh"

    def test_retrying_a_range_is_idempotent(self, harness):
        client, _, sink, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        body = send_chunk(client, upload_id, 0, b"abcd").json()
        assert body["received"] == 4
        assert body["ranges"] == [[0, 4]]

        again = send_chunk(client, upload_id, 0, b"abcd").json()
        assert again["ranges"] == [[0, 4]]
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200
        assert bytes(sink.data) == b"abcd"

    def test_complete_and_init_are_idempotent_after_a_lost_response(self, harness):
        client, _, _, _ = harness
        key = "lost-complete-key"
        upload_id = init_upload(client, "a.bin", 4, upload_key=key)["upload_id"]
        send_chunk(client, upload_id, 0, b"abcd")
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200

        again = client.post(f"/_upload/{upload_id}/complete")
        assert again.status_code == 200
        assert again.json()["path"] == "a.bin"

        resumed = init_upload(client, "a.bin", 4, upload_key=key)
        assert resumed["upload_id"] == upload_id
        assert resumed["state"] == "complete"
        assert resumed["path"] == "a.bin"

    def test_status_reports_resume_ranges(self, harness):
        client, _, _, _ = harness
        upload_id = init_upload(client, "a.bin", 10)["upload_id"]
        send_chunk(client, upload_id, 2, b"xy")

        status = client.get(f"/_upload/{upload_id}").json()
        assert status["ranges"] == [[2, 4]]
        assert status["received"] == 2
        assert status["chunk_policy"]["max_bytes"] > 0

    def test_rejects_offsets_beyond_the_declared_size(self, harness):
        client, _, _, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        assert send_chunk(client, upload_id, 5, b"x").status_code == 400
        assert send_chunk(client, upload_id, 2, b"xyz").status_code == 413

    def test_a_digest_mismatch_is_not_credited(self, harness):
        client, _, _, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        response = send_chunk(client, upload_id, 0, b"abcd", sha="0" * 64)
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "DIGEST_MISMATCH"
        assert client.get(f"/_upload/{upload_id}").json()["ranges"] == []

    def test_a_declared_length_mismatch_is_not_credited(self, harness):
        client, _, _, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        response = send_chunk(client, upload_id, 0, b"abcd", length=3)
        assert response.status_code == 400
        assert client.get(f"/_upload/{upload_id}").json()["ranges"] == []

    def test_multipart_chunk_is_accepted(self, harness):
        client, _, sink, _ = harness
        upload_id = init_upload(client, "m.bin", 8)["upload_id"]
        body = b"abcdefgh"
        response = client.post(
            f"/_upload/{upload_id}/chunk",
            data={
                "offset": "0",
                "length": "8",
                "sha256": digest(body),
                "request_id": "multipart-test",
            },
            files={"file": ("m.bin", body, "application/octet-stream")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["transport"] == "multipart_post"
        assert bytes(sink.data) == body

    def test_cancel_aborts_the_sink_and_forgets_the_session(self, harness):
        client, _, sink, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        send_chunk(client, upload_id, 0, b"ab")

        assert client.delete(f"/_upload/{upload_id}").json() == {"ok": True}
        assert sink.aborted
        assert client.get(f"/_upload/{upload_id}").status_code == 404

    def test_unknown_session_is_404(self, harness):
        client, _, _, _ = harness
        assert client.get(f"/_upload/{'a' * 32}").status_code == 404
        assert client.get("/_upload/not-a-session-id").status_code == 404

    def test_foreign_owner_cannot_touch_a_session(self, harness):
        client, _, _, current = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]

        current["user"] = "mallory"
        assert client.get(f"/_upload/{upload_id}").status_code == 403
        assert send_chunk(client, upload_id, 0, b"abcd").status_code == 403
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 403

    @pytest.mark.asyncio
    async def test_sweep_aborts_and_forgets_expired_sessions(self, harness):
        client, store, sink, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        send_chunk(client, upload_id, 0, b"ab")

        store.ttl_seconds = 0
        assert await store.sweep() == 1
        assert sink.aborted
        assert store.get(upload_id) is None

    def test_rejects_more_sessions_than_a_user_may_hold(self, tmp_path):
        app, _, _, _ = build_app(tmp_path / "state", max_sessions_per_user=1)
        with TestClient(app) as client:
            assert init_upload(client, "a.bin", 1)["upload_id"]
            response = client.post(
                "/_upload/init",
                json={
                    "upload_key": "second-key",
                    "filename": "b.bin",
                    "size": 1,
                    "dir": "/",
                },
            )
            assert response.status_code == 429

    def test_completed_tombstones_do_not_count_against_the_session_cap(self, tmp_path):
        app, _, _, _ = build_app(tmp_path / "state", max_sessions_per_user=1)
        with TestClient(app) as client:
            first = init_upload(client, "done.bin", 0)["upload_id"]
            assert client.post(f"/_upload/{first}/complete").status_code == 200
            response = client.post(
                "/_upload/init",
                json={
                    "upload_key": "after-tombstone",
                    "filename": "next.bin",
                    "size": 0,
                    "dir": "/",
                },
            )
            assert response.status_code == 200
            assert response.json()["state"] == "open"

    def test_chunk_requests_after_completion_are_idempotent(self, harness):
        client, _, _, _ = harness
        upload_id = init_upload(client, "done.bin", 4)["upload_id"]
        assert send_chunk(client, upload_id, 0, b"done").status_code == 200
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200
        response = send_chunk(client, upload_id, 0, b"done")
        assert response.status_code == 200
        assert response.json()["state"] == "complete"

    @pytest.mark.parametrize(
        "query, body, expected",
        [
            ("", b"x", 400),
            ("offset=0", b"x", 400),
            ("offset=0&sha256=" + "0" * 64 + "&length=-1", b"x", 400),
            ("offset=0&sha256=" + "0" * 64, b"", 400),
        ],
    )
    def test_chunk_rejects_missing_or_invalid_metadata(
        self, harness, query, body, expected
    ):
        client, _, _, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        response = client.post(
            f"/_upload/{upload_id}/chunk?{query}",
            content=body,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert response.status_code == expected

    def test_multipart_chunk_requires_the_file_part(self, harness):
        client, _, _, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        response = client.post(
            f"/_upload/{upload_id}/chunk",
            data={"offset": "0", "sha256": "0" * 64, "length": "1"},
            files={"other": ("other.txt", b"y")},
        )
        assert response.status_code == 400

    def test_non_numeric_content_length_is_rejected(self, harness):
        client, _, _, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        response = client.post(
            f"/_upload/{upload_id}/chunk?offset=0&sha256={'0' * 64}",
            content=b"x",
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": "not-a-number",
            },
        )
        assert response.status_code == 400


class TestSinkErrors:
    def test_a_sink_error_keeps_the_application_error_code(self, harness):
        client, _, sink, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        sink.failure = UploadSinkError(
            "SFTP tab is not available for this session.",
            code="PERMISSION_DENIED",
            status=403,
        )

        response = send_chunk(client, upload_id, 0, b"abcd")
        assert response.status_code == 403
        assert response.json() == {
            "ok": False,
            "code": "PERMISSION_DENIED",
            "message": "SFTP tab is not available for this session.",
        }
        assert client.get(f"/_upload/{upload_id}").json()["ranges"] == []

    def test_an_unexpected_sink_failure_is_a_retryable_502(self, harness):
        client, _, sink, _ = harness
        upload_id = init_upload(client, "a.bin", 4)["upload_id"]
        sink.failure = OSError("socket closed")

        response = send_chunk(client, upload_id, 0, b"abcd")
        assert response.status_code == 502
        assert client.get(f"/_upload/{upload_id}").json()["ranges"] == []


class TestSessionTable:
    @pytest.mark.asyncio
    async def test_oldest_session_is_evicted_and_aborted_at_capacity(self, tmp_path):
        store = UploadStore(
            state_dir=tmp_path / "state",
            max_sessions=1,
            max_sessions_per_user=0,
        )
        first = RecordingSink()

        def target(name: str) -> UploadTarget:
            return UploadTarget(
                session_id=store.new_session_id(),
                user="alice",
                directory="/",
                filename=name,
                size=1,
                upload_key=uuid.uuid4().hex,
            )

        one = await store.register(target("a.bin"), user="alice")
        one.sink = first
        await asyncio.sleep(0.01)
        two = await store.register(target("b.bin"), user="alice")

        assert store.get(one.session_id) is None
        assert store.get(two.session_id) is two
        assert first.aborted

    @pytest.mark.asyncio
    async def test_close_aborts_every_sink(self, tmp_path):
        store = UploadStore(state_dir=tmp_path / "state")
        sink = RecordingSink()
        session = await store.register(
            UploadTarget(
                session_id=store.new_session_id(),
                user=None,
                directory="/",
                filename="a.bin",
                size=1,
                upload_key=uuid.uuid4().hex,
            ),
            user=None,
        )
        session.sink = sink
        await store.close()
        assert sink.aborted

    @pytest.mark.asyncio
    async def test_manifest_survives_a_store_restart(self, tmp_path):
        state_dir = tmp_path / "state"
        store = UploadStore(state_dir=state_dir)
        session_id = store.new_session_id()
        staged = tmp_path / staging_name("a.bin", session_id)
        target = UploadTarget(
            session_id=session_id,
            user="alice",
            directory=str(tmp_path),
            filename="a.bin",
            size=4,
            staged_path=staged,
            upload_key="persistent-key",
            fingerprint={"name": "a.bin", "size": 4},
        )
        session = await store.register(target, user="alice")
        staged.write_bytes(b"abcd")
        session.ranges.add(0, 4)
        await store.persist(session)

        reloaded = UploadStore(state_dir=state_dir)
        restored = reloaded.get(session.session_id)
        assert restored is not None
        assert restored.ranges.to_json() == [[0, 4]]
        assert restored.target.filename == "a.bin"
        assert restored.staged_path == staged
        assert json.loads((state_dir / f"{session.session_id}.json").read_text())[
            "version"
        ] == 2

    @pytest.mark.asyncio
    async def test_persist_creates_a_missing_manifest_path(self, tmp_path):
        store = UploadStore(state_dir=tmp_path / "state")
        target = UploadTarget(
            session_id=store.new_session_id(),
            user="alice",
            directory=str(tmp_path),
            filename="a.bin",
            size=0,
            upload_key="persist-key",
        )
        session = await store.register(target, user="alice")
        session.manifest_path = None
        await store.persist(session)
        assert session.manifest_path is not None
        assert session.manifest_path.is_file()

    @pytest.mark.asyncio
    async def test_sink_abort_failure_does_not_block_drop(self, tmp_path):
        class FailingSink(RecordingSink):
            async def abort(self) -> None:
                raise RuntimeError("abort failed")

        store = UploadStore(state_dir=tmp_path / "state")
        session = await store.register(
            UploadTarget(
                session_id=store.new_session_id(),
                user=None,
                directory=str(tmp_path),
                filename="a.bin",
                size=1,
                upload_key="abort-key",
            ),
            user=None,
        )
        session.sink = FailingSink()
        await store.drop(session.session_id)
        assert store.get(session.session_id) is None

    def test_manifest_validation_discards_untrusted_paths(self, tmp_path):
        root = tmp_path / "root"
        root.mkdir()
        state = root / ".xwing-uploads"
        state.mkdir()
        session_id = "a" * 32
        staged = root / staging_name("a.bin", session_id)
        staged.write_bytes(b"")
        outside = tmp_path / "outside"
        outside.write_bytes(b"keep")
        now = time.time()
        payload = {
            "version": 2,
            "upload_id": session_id,
            "upload_key": "manifest-key",
            "user": "alice",
            "directory": str(root),
            "filename": "a.bin",
            "size": 0,
            "staged_path": str(outside),
            "state": "open",
            "ranges": [],
            "fingerprint": {},
            "created_at": now,
            "updated_at": now,
        }
        manifest = state / f"{session_id}.json"
        manifest.write_text(json.dumps(payload), encoding="utf-8")

        store = UploadStore(state_dir=state, storage_root=root)
        restored = store.get(session_id)
        assert restored is not None
        assert restored.staged_path == staged
        assert outside.exists()

    @pytest.mark.parametrize(
        "patch",
        [
            {"version": 1},
            {"upload_id": "b" * 32},
            {"directory": "/"},
            {"filename": "../a.bin"},
        ],
    )
    def test_damaged_manifests_are_removed(self, tmp_path, patch):
        state = tmp_path / "state"
        state.mkdir()
        session_id = "a" * 32
        payload = {
            "version": 2,
            "upload_id": session_id,
            "upload_key": "manifest-key",
            "user": "alice",
            "directory": str(tmp_path),
            "filename": "a.bin",
            "size": 0,
            "staged_path": None,
            "state": "open",
            "ranges": [],
            "fingerprint": {},
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        payload.update(patch)
        manifest = state / f"{session_id}.json"
        manifest.write_text(json.dumps(payload), encoding="utf-8")

        store = UploadStore(state_dir=state, storage_root=tmp_path)
        assert store.get(session_id) is None
        assert not manifest.exists()

    def test_expired_and_missing_staged_manifests_are_removed(self, tmp_path):
        state = tmp_path / "state"
        state.mkdir()
        now = time.time()
        for session_id, staged_exists, age in (
            ("a" * 32, True, 10),
            ("b" * 32, False, 0),
        ):
            staged = tmp_path / staging_name("a.bin", session_id)
            if staged_exists:
                staged.write_bytes(b"")
            manifest = state / f"{session_id}.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "upload_id": session_id,
                        "upload_key": "manifest-key",
                        "user": "alice",
                        "directory": str(tmp_path),
                        "filename": "a.bin",
                        "size": 0,
                        "staged_path": str(staged),
                        "state": "open",
                        "ranges": [],
                        "fingerprint": {},
                        "created_at": now - age,
                        "updated_at": now - age,
                    }
                ),
                encoding="utf-8",
            )
            UploadStore(state_dir=state, storage_root=tmp_path, ttl_seconds=1)
            assert not manifest.exists()
            assert not staged.exists()

    def test_damaged_json_manifest_is_removed(self, tmp_path):
        state = tmp_path / "state"
        state.mkdir()
        manifest = state / f"{'a' * 32}.json"
        manifest.write_text("{bad", encoding="utf-8")
        UploadStore(state_dir=state, storage_root=tmp_path)
        assert not manifest.exists()
