"""Behavioural tests for the shared chunked upload engine.

The engine is vendored into torrus unchanged, so these tests pin the contract
both applications depend on: byte-range accounting, resume after partial
writes, atomic publish, TTL reclamation and per-session ownership.
"""

import asyncio

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


def build_app(**store_kwargs):
    """Wire the engine onto a tiny app whose acting user the test can swap."""
    sink = RecordingSink()
    store = UploadStore(**store_kwargs)
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
def harness():
    app, store, sink, current = build_app()
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
            "/_upload/init", json={"filename": "a.bin", "size": -1, "dir": "/"}
        )
        assert response.status_code == 400

    def test_rejects_size_over_limit(self):
        app, _, _, _ = build_app(max_session_bytes=10)
        with TestClient(app) as client:
            response = client.post(
                "/_upload/init", json={"filename": "a.bin", "size": 11, "dir": "/"}
            )
        assert response.status_code == 413

    def test_policy_can_decline_an_upload(self, harness):
        client, _, _, _ = harness
        response = client.post(
            "/_upload/init", json={"filename": "skip.me", "size": 1, "dir": "/"}
        )
        assert response.json() == {"ignored": True}


class TestUploadLifecycle:
    def test_out_of_order_writes_assemble_the_file(self, harness):
        client, _, sink, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 8, "dir": "/"}
        ).json()["upload_id"]

        assert client.put(f"/_upload/{upload_id}?offset=4", content=b"efgh").status_code == 200
        assert client.put(f"/_upload/{upload_id}?offset=0", content=b"abcd").status_code == 200
        assert bytes(sink.data) == b"abcdefgh"

        result = client.post(f"/_upload/{upload_id}/complete")
        assert result.status_code == 200
        assert sink.finalized
        assert result.json() == {"path": "a.bin", "size": 8}

    def test_complete_rejects_a_hole_and_names_it(self, harness):
        client, _, sink, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 8, "dir": "/"}
        ).json()["upload_id"]
        client.put(f"/_upload/{upload_id}?offset=0", content=b"abcd")

        response = client.post(f"/_upload/{upload_id}/complete")
        assert response.status_code == 400
        assert "(4, 8)" in response.json()["detail"]
        assert not sink.finalized

        # The gap is the only thing left to send; the first four bytes are not resent.
        client.put(f"/_upload/{upload_id}?offset=4", content=b"efgh")
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200
        assert bytes(sink.data) == b"abcdefgh"

    def test_retrying_a_range_is_idempotent(self, harness):
        client, _, sink, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 4, "dir": "/"}
        ).json()["upload_id"]
        body = client.put(f"/_upload/{upload_id}?offset=0", content=b"abcd").json()
        assert body["received"] == 4
        assert body["ranges"] == [[0, 4]]

        again = client.put(f"/_upload/{upload_id}?offset=0", content=b"abcd").json()
        assert again["ranges"] == [[0, 4]]
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200
        assert bytes(sink.data) == b"abcd"

    def test_status_reports_resume_ranges(self, harness):
        client, _, _, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 10, "dir": "/"}
        ).json()["upload_id"]
        client.put(f"/_upload/{upload_id}?offset=2", content=b"xy")

        status = client.get(f"/_upload/{upload_id}").json()
        assert status["ranges"] == [[2, 4]]
        assert status["received"] == 2
        assert status["chunk_size"] > 0

    def test_rejects_offsets_beyond_the_declared_size(self, harness):
        client, _, _, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 4, "dir": "/"}
        ).json()["upload_id"]
        assert client.put(f"/_upload/{upload_id}?offset=5", content=b"x").status_code == 400
        assert client.put(f"/_upload/{upload_id}?offset=2", content=b"xyz").status_code == 413

    def test_cancel_aborts_the_sink_and_forgets_the_session(self, harness):
        client, store, sink, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 4, "dir": "/"}
        ).json()["upload_id"]
        client.put(f"/_upload/{upload_id}?offset=0", content=b"ab")

        assert client.delete(f"/_upload/{upload_id}").json() == {"ok": True}
        assert sink.aborted
        assert client.get(f"/_upload/{upload_id}").status_code == 404

    def test_unknown_session_is_404(self, harness):
        client, _, _, _ = harness
        assert client.get(f"/_upload/{'a' * 32}").status_code == 404
        assert client.get("/_upload/not-a-session-id").status_code == 404

    def test_foreign_owner_cannot_touch_a_session(self, harness):
        client, _, _, current = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 4, "dir": "/"}
        ).json()["upload_id"]

        current["user"] = "mallory"
        assert client.get(f"/_upload/{upload_id}").status_code == 403
        assert client.put(f"/_upload/{upload_id}?offset=0", content=b"abcd").status_code == 403
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 403

    @pytest.mark.asyncio
    async def test_sweep_aborts_and_forgets_expired_sessions(self, harness):
        client, store, sink, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 4, "dir": "/"}
        ).json()["upload_id"]
        client.put(f"/_upload/{upload_id}?offset=0", content=b"ab")

        store.ttl_seconds = 0
        assert await store.sweep() == 1
        assert sink.aborted
        assert store.get(upload_id) is None

    def test_rejects_more_sessions_than_a_user_may_hold(self):
        app, _, _, _ = build_app(max_sessions_per_user=1)
        with TestClient(app) as client:
            assert client.post(
                "/_upload/init", json={"filename": "a.bin", "size": 1, "dir": "/"}
            ).status_code == 200
            assert client.post(
                "/_upload/init", json={"filename": "b.bin", "size": 1, "dir": "/"}
            ).status_code == 429


class TestSinkErrors:
    def test_a_sink_error_keeps_the_application_error_code(self, harness):
        client, _, sink, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 4, "dir": "/"}
        ).json()["upload_id"]
        sink.failure = UploadSinkError(
            "SFTP tab is not available for this session.",
            code="PERMISSION_DENIED",
            status=403,
        )

        response = client.put(f"/_upload/{upload_id}?offset=0", content=b"abcd")
        assert response.status_code == 403
        assert response.json() == {
            "ok": False,
            "code": "PERMISSION_DENIED",
            "message": "SFTP tab is not available for this session.",
        }
        # Nothing was committed, so the client can retry the same range.
        assert client.get(f"/_upload/{upload_id}").json()["ranges"] == []

    def test_an_unexpected_sink_failure_is_a_retryable_502(self, harness):
        client, _, sink, _ = harness
        upload_id = client.post(
            "/_upload/init", json={"filename": "a.bin", "size": 4, "dir": "/"}
        ).json()["upload_id"]
        sink.failure = OSError("socket closed")

        response = client.put(f"/_upload/{upload_id}?offset=0", content=b"abcd")
        assert response.status_code == 502
        assert client.get(f"/_upload/{upload_id}").json()["ranges"] == []


class TestSessionTable:
    @pytest.mark.asyncio
    async def test_oldest_session_is_evicted_and_aborted_at_capacity(self):
        store = UploadStore(max_sessions=1, max_sessions_per_user=0)
        first = RecordingSink()

        def target(name: str) -> UploadTarget:
            return UploadTarget(
                session_id=store.new_session_id(),
                user="alice",
                directory="/",
                filename=name,
                size=1,
            )

        one = await store.register(target("a.bin"), user="alice")
        one.sink = first
        await asyncio.sleep(0.01)
        two = await store.register(target("b.bin"), user="alice")

        assert store.get(one.session_id) is None
        assert store.get(two.session_id) is two
        assert first.aborted

    @pytest.mark.asyncio
    async def test_close_aborts_every_sink(self):
        store = UploadStore()
        sink = RecordingSink()
        session = await store.register(
            UploadTarget(
                session_id=store.new_session_id(),
                user=None,
                directory="/",
                filename="a.bin",
                size=1,
            ),
            user=None,
        )
        session.sink = sink
        await store.close()
        assert sink.aborted
