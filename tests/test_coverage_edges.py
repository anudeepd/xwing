import asyncio
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from starlette.requests import Request

from conftest import TestClient
from xwing import audit_store, config as config_module, files, trash_store, upload
from xwing.auth import get_user
from xwing.config import Settings, UserConfig
from xwing.upload_engine import (
    RangeTracker,
    UploadSink,
    UploadStore,
    UploadTarget,
    _clamp_chunk_size,
    _fsync_directory,
    _is_within_root,
    _remove_file,
    _valid_sha,
    stream_to_sink,
)
from xwing import webdav


def test_audit_init_survives_chmod_failure(monkeypatch, tmp_path):
    def deny_chmod(self, mode):
        raise OSError("chmod denied")

    monkeypatch.setattr(Path, "chmod", deny_chmod)
    path = tmp_path / "audit.db"
    audit_store.init_db(path)
    assert path.exists()


def test_get_user_uses_auth_state(monkeypatch, tmp_path):
    settings = Settings(root_dir=tmp_path)
    request = SimpleNamespace(
        state=SimpleNamespace(user="Alice"),
        headers={},
        client=None,
    )
    assert get_user(request, settings) == "alice"


def test_config_rejects_non_boolean_permission(tmp_path):
    path = tmp_path / "users.yaml"
    path.write_text("users:\n  alice:\n    read: 1\n")
    with pytest.raises(ValueError, match="must be true or false"):
        UserConfig(path)


def test_trusted_proxy_matching_covers_invalid_and_cidr_entries(tmp_path):
    settings = Settings(
        root_dir=tmp_path,
        trusted_auth_proxies=["not-an-ip", "10.0.0.0/8", "127.0.0.1", "bad/999"],
    )
    assert settings.is_trusted_auth_proxy("10.2.3.4")
    assert settings.is_trusted_auth_proxy("127.0.0.1")
    assert settings.is_trusted_auth_proxy("not-an-ip")
    assert not settings.is_trusted_auth_proxy("other-host")
    assert not settings.is_trusted_auth_proxy("192.168.1.1")
    assert config_module._ip_in_networks("bogus", ["10.0.0.0/8"]) is False


def test_users_config_stat_failure_keeps_cached_permissions(tmp_path):
    path = tmp_path / "users.yaml"
    path.write_text("users:\n  alice: rwd\n")
    settings = Settings(root_dir=tmp_path, users_config=path)
    path.unlink()
    assert settings.perms_for("alice").write is True


def test_safe_path_rejects_symlink_parent_escape(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    target = outside / "target.txt"
    target.write_text("x")
    (root / "linkdir").symlink_to(outside, target_is_directory=True)
    (outside / "linkfile").symlink_to(target)
    with pytest.raises(PermissionError):
        files.safe_path(root, "linkdir/linkfile", follow_final=False)


def test_files_system_and_binary_edges(tmp_path):
    assert files.is_ignored_system_file(Path("/")) is False
    assert files._looks_like_text(tmp_path / "missing") is False
    assert files.human_size(1024**5) == "1.0 PB"
    broken = tmp_path / "missing-link"
    broken.symlink_to(tmp_path / "nowhere")
    entries = files.list_dir(tmp_path)
    assert any(entry["name"] == "missing-link" for entry in entries)


class _FakeEntry:
    def __init__(self, name, *, stat_error=None, dir_error=None):
        self.name = name
        self.path = f"/tmp/{name}"
        self._stat_error = stat_error
        self._dir_error = dir_error
        self._dir_calls = 0

    def is_dir(self):
        self._dir_calls += 1
        if self._dir_error and self._dir_calls > 1:
            raise self._dir_error
        return False

    def stat(self, follow_symlinks=True):
        if self._stat_error and follow_symlinks:
            raise self._stat_error
        return SimpleNamespace(st_size=0, st_mtime=0)


def test_list_dir_permission_and_vanished_entries(monkeypatch, tmp_path):
    entries = [
        _FakeEntry("denied.txt", stat_error=PermissionError("no")),
        _FakeEntry("vanished.txt", dir_error=OSError("gone")),
        _FakeEntry("broken.txt", stat_error=OSError("broken")),
    ]
    class Scan:
        def __enter__(self):
            return entries

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(files.os, "scandir", lambda path: Scan())
    listed = files.list_dir(tmp_path)
    assert [entry["name"] for entry in listed] == ["broken.txt", "denied.txt"]


def test_list_dir_reraises_permission_denied(monkeypatch, tmp_path):
    monkeypatch.setattr(
        files.os,
        "scandir",
        lambda path: (_ for _ in ()).throw(PermissionError("denied")),
    )
    with pytest.raises(PermissionError):
        files.list_dir(tmp_path)


def test_list_dir_skips_non_utf8_names(tmp_path):
    raw_root = os.fsencode(tmp_path)
    try:
        fd = os.open(raw_root + b"/caf\xe9.txt", os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
    except (OSError, ValueError) as exc:
        pytest.skip(f"filesystem rejects a non-UTF-8 filename: {exc}")
    assert files.list_dir(tmp_path) == []


def test_list_dir_skips_a_surrogate_name(monkeypatch, tmp_path):
    entry = _FakeEntry("\udcff")
    class Scan:
        def __enter__(self):
            return [entry]
        def __exit__(self, *args):
            return False
    monkeypatch.setattr(files.os, "scandir", lambda path: Scan())
    assert files.list_dir(tmp_path) == []


def test_list_dir_reaps_stale_staging_survives_unlink_error(monkeypatch, tmp_path):
    stale = tmp_path / f".x.upload-part-{'a' * 32}"
    stale.write_text("x")
    old = 0
    os.utime(stale, (old, old))
    monkeypatch.setattr(files.os, "unlink", lambda path: (_ for _ in ()).throw(OSError("denied")))
    assert files.list_dir(tmp_path, stale_staging_after=1) == []


def test_trash_load_rejects_each_bad_shape(tmp_path):
    trash = tmp_path / ".xwing-trash"
    trash.mkdir()
    root = tmp_path
    index = trash / ".index.json"
    index.write_text(json.dumps({"not": "a list"}))
    assert trash_store.load_transactions(trash, root) == {}
    index.write_text(json.dumps([1, {"transaction_id": "x", "items": []}]))
    assert trash_store.load_transactions(trash, root) == {}
    records = [
        {"transaction_id": "", "items": []},
        {"transaction_id": "x", "items": [1]},
        {"transaction_id": "x", "items": [{"original": "relative", "trash_name": "a", "kind": "file"}]},
        {"transaction_id": "x", "items": [{"original": "/a", "trash_name": "a/b", "kind": "file"}]},
        {"transaction_id": "x", "items": [{"original": "/a", "trash_name": "a", "kind": "link"}]},
        {"transaction_id": "x", "items": [{"original": "/../escape", "trash_name": "a", "kind": "file"}]},
    ]
    index.write_text(json.dumps(records))
    assert trash_store.load_transactions(trash, root) == {}


def test_trash_save_skips_outside_paths_and_survives_chmod(tmp_path):
    trash = tmp_path / ".xwing-trash"
    root = tmp_path / "root"
    root.mkdir()

    def deny_chmod(self, mode):
        raise OSError("no chmod")

    old_chmod = Path.chmod
    Path.chmod = deny_chmod
    try:
        trash_store.save_transactions(
            trash,
            root,
            {
                "outside": {
                    "user": "a",
                    "created": 1,
                    "items": [{"original": str(tmp_path / "outside"), "trash": trash / "a", "kind": "file"}],
                }
            },
        )
    finally:
        Path.chmod = old_chmod
    assert (trash / ".index.json").read_text() == "[]\n"


def test_trash_save_cleans_temp_file_after_failure(monkeypatch, tmp_path):
    trash = tmp_path / ".xwing-trash"
    monkeypatch.setattr(trash_store.os, "replace", lambda *args: (_ for _ in ()).throw(OSError("replace")))
    monkeypatch.setattr(trash_store.os, "unlink", lambda *args: (_ for _ in ()).throw(OSError("unlink")))
    with pytest.raises(OSError):
        trash_store.save_transactions(
            trash,
            tmp_path,
            {"x": {"user": "a", "created": 1, "items": []}},
        )


def test_local_sink_short_writes_and_abort_errors(tmp_path, monkeypatch):
    truncate = tmp_path / "truncate"
    truncate.write_bytes(b"old")
    descriptor = upload._open_staging(truncate, truncate=True)
    os.close(descriptor)
    assert truncate.read_bytes() == b""

    with monkeypatch.context() as patch:
        patch.setattr(upload.os, "pwrite", lambda *args: 0)
        with pytest.raises(OSError, match="short write"):
            upload._pwrite_all(1, memoryview(b"x"), 0)

    sink = upload.LocalFileSink(tmp_path / "staged", tmp_path / "dest")
    asyncio.run(sink.write_at(0, b"data"))
    with monkeypatch.context() as patch:
        patch.setattr(upload.os, "close", lambda fd: (_ for _ in ()).throw(OSError("close")))
        asyncio.run(sink.abort())

    missing = upload.LocalFileSink(tmp_path / "missing", tmp_path / "dest")
    asyncio.run(missing.abort())

    directory = upload.LocalFileSink(tmp_path, tmp_path / "dest")
    asyncio.run(directory.abort())

    closed = upload.LocalFileSink(tmp_path / "closed", tmp_path / "dest")
    asyncio.run(closed.finalize())
    with pytest.raises(OSError, match="closed"):
        asyncio.run(closed.write_at(0, b"x"))


def test_upload_engine_filesystem_helpers_absorb_expected_errors(tmp_path, monkeypatch):
    from xwing import upload_engine

    with monkeypatch.context() as patch:
        patch.setattr(
            upload_engine.os,
            "open",
            lambda *args, **kwargs: (_ for _ in ()).throw(OSError("denied")),
        )
        _fsync_directory(tmp_path)

    with monkeypatch.context() as patch:
        patch.setattr(upload_engine.os, "open", lambda *args, **kwargs: 99)
        patch.setattr(
            upload_engine.os,
            "fsync",
            lambda fd: (_ for _ in ()).throw(OSError("denied")),
        )
        patch.setattr(upload_engine.os, "close", lambda fd: None)
        _fsync_directory(tmp_path)

    with monkeypatch.context() as patch:
        patch.setattr(
            Path,
            "resolve",
            lambda *args, **kwargs: (_ for _ in ()).throw(OSError("denied")),
        )
        assert not _is_within_root(tmp_path, tmp_path / "file")

    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.write_bytes(b"keep")
    _remove_file(outside, root)
    assert outside.exists()

    unlinkable = root / "unlinkable"
    unlinkable.write_bytes(b"x")
    with monkeypatch.context() as patch:
        patch.setattr(
            Path,
            "unlink",
            lambda self: (_ for _ in ()).throw(OSError("denied")),
        )
        _remove_file(unlinkable, root)

    assert _valid_sha(None) is None


def test_upload_init_rejects_non_string_dir(client):
    response = client.post(
        "/_upload/init",
        json={"filename": "ok.txt", "size": 1, "dir": 4},
    )
    assert response.status_code == 400
    assert "dir must be a string" in response.text


def test_upload_open_sink_rejects_directory_outside_root(monkeypatch, root, tmp_dir, users_yaml):
    from test_upload import init_upload, send_chunk

    outside = root.parent / "outside"
    outside.mkdir()
    original = upload.safe_path
    monkeypatch.setattr(upload, "safe_path", lambda *args, **kwargs: outside)
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    try:
        app = FastAPI()
        app.include_router(upload.create_upload_router(settings, upload.build_upload_store(settings)))
        with TestClient(app) as client:
            init = init_upload(client, "x.txt", 1)
            put = send_chunk(client, init["upload_id"], 0, b"x")
            assert put.status_code == 403
    finally:
        monkeypatch.setattr(upload, "safe_path", original)


def test_upload_open_sink_rejects_staging_path_outside_root(
    monkeypatch, root, tmp_dir, users_yaml
):
    from test_upload import init_upload, send_chunk

    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    store = upload.build_upload_store(settings)
    app = FastAPI()
    app.include_router(upload.create_upload_router(settings, store))
    outside = root.parent / "outside-staging"
    with TestClient(app) as client:
        init = init_upload(client, "x.txt", 1)
        store.get(init["upload_id"]).target.staged_path = outside
        response = send_chunk(client, init["upload_id"], 0, b"x")
        assert response.status_code == 403


def test_upload_audit_error_is_logged(monkeypatch, tmp_path):
    settings = Settings(root_dir=tmp_path, audit_db=tmp_path / "audit.db")
    async def fail(**kwargs):
        raise RuntimeError("db down")
    monkeypatch.setattr(upload.audit_store, "record_event_async", fail)
    asyncio.run(upload._record_upload_audit(
        settings=settings, user="alice", path="/x", total_bytes=1
    ))


def test_cleanup_stale_sessions_logs_and_stops(monkeypatch):
    class Store:
        def __init__(self):
            self.calls = 0
        async def sweep(self):
            self.calls += 1
            if self.calls == 1:
                return 1
            raise RuntimeError("sweep down")

    sleeps = 0
    async def fake_sleep(seconds):
        nonlocal sleeps
        sleeps += 1
        if sleeps > 2:
            raise asyncio.CancelledError
    monkeypatch.setattr(upload.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(upload.cleanup_stale_sessions(Store()))


def test_upload_engine_edges(tmp_path):
    tracker = RangeTracker([[10, 20]])
    tracker.add(1, 5)
    assert tracker.spans() == [(1, 5), (10, 20)]
    assert _clamp_chunk_size("bad", 16 * 1024 * 1024) == 4 * 1024 * 1024
    store = UploadStore(state_dir=tmp_path / "state", ttl_seconds=1)
    asyncio.run(store.drop("missing"))
    assert store.user_session_count(None) == 0


@pytest.mark.asyncio
async def test_upload_store_expiry_and_missing_drop(tmp_path):
    store = UploadStore(state_dir=tmp_path / "state", ttl_seconds=1)
    target = UploadTarget(
        session_id="a" * 32,
        user=None,
        directory=str(tmp_path),
        filename="x.txt",
        size=1,
        upload_key="expiry-key",
    )
    session = await store.register(target, user=None)
    session.updated_at = 0
    assert store.get(session.session_id) is None
    await store.drop("missing")


def _router_client(settings):
    store = upload.build_upload_store(settings)
    app = FastAPI()
    app.include_router(upload.create_upload_router(settings, store))
    return TestClient(app), store


def _call_asgi(app, path, *, headers, messages, query_string=b""):
    sent = []

    async def receive():
        if messages:
            return messages.pop(0)
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": query_string,
        "headers": headers,
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }
    asyncio.run(app(scope, receive, send))
    return next((item for item in sent if item["type"] == "http.response.start"), None)


def test_upload_diagnostics_rejects_invalid_content_length(tmp_path):
    users = tmp_path / "users.yaml"
    users.write_text("users:\n  '*': rwd\n")
    settings = Settings(root_dir=tmp_path, users_config=users)
    router = upload.create_upload_diagnostics_router(settings)
    endpoint = next(route.endpoint for route in router.routes if route.path == "/_upload/diagnostics")
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/_upload/diagnostics",
        "raw_path": b"/_upload/diagnostics",
        "root_path": "",
        "query_string": b"",
        "headers": [(b"content-length", b"not-a-number")],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }
    with pytest.raises(HTTPException) as exc:
        asyncio.run(endpoint(Request(scope)))
    assert exc.value.status_code == 400


def test_chunk_without_content_length_still_enforces_request_limit(
    root, tmp_dir, users_yaml
):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    client, store = _router_client(settings)
    with client:
        init = client.post(
            "/_upload/init",
            json={"upload_key": "no-length-key", "filename": "x.bin", "size": 4, "dir": "/"},
        )
        upload_id = init.json()["upload_id"]
        store.max_request_bytes = 1
        result = _call_asgi(
            client.app,
            f"/_upload/{upload_id}/chunk",
            headers=[(b"content-type", b"application/octet-stream")],
            messages=[{"type": "http.request", "body": b"xy", "more_body": False}],
            query_string=f"offset=0&sha256={'0' * 64}&length=2".encode(),
        )
    assert result is not None
    assert result["status"] == 413


def test_chunk_client_disconnect_returns_499(root, tmp_dir, users_yaml):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    client, _ = _router_client(settings)
    with client:
        init = client.post(
            "/_upload/init",
            json={"upload_key": "disconnect-key", "filename": "x.bin", "size": 4, "dir": "/"},
        )
        upload_id = init.json()["upload_id"]
        sha = "0" * 64
        result = _call_asgi(
            client.app,
            f"/_upload/{upload_id}/chunk",
            headers=[(b"content-type", b"application/octet-stream")],
            messages=[
                {"type": "http.request", "body": b"x", "more_body": True},
                {"type": "http.disconnect"},
            ],
            query_string=f"offset=0&sha256={sha}&length=1".encode(),
        )
    assert result is not None
    assert result["status"] == 499


def test_upload_router_closing_max_bytes_and_finalize_errors(
    root, tmp_dir, users_yaml
):
    from test_upload import send_chunk

    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    client, store = _router_client(settings)
    with client:
        init = client.post(
            "/_upload/init",
            json={"upload_key": "edge-key-one", "filename": "x.txt", "size": 1, "dir": "/"},
        )
        upload_id = init.json()["upload_id"]
        session = store.get(upload_id)
        session.closing = True
        assert send_chunk(client, upload_id, 0, b"x").status_code == 409
        session.closing = False

        store.max_request_bytes = 1
        assert send_chunk(client, upload_id, 0, b"xy").status_code == 413
        store.max_request_bytes = 16 * 1024 * 1024

        session.closing = True
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 409
        session.closing = False

        class Sink:
            async def write_at(self, offset, data):
                session.closing = True
            async def finalize(self):
                pass
            async def abort(self):
                pass
        session.sink = Sink()
        assert send_chunk(client, upload_id, 0, b"x").status_code == 409

        init = client.post(
            "/_upload/init",
            json={"upload_key": "edge-key-two", "filename": "none.txt", "size": 1, "dir": "/"},
        )
        upload_id = init.json()["upload_id"]
        session = store.get(upload_id)
        session.sink = None
        session.ranges.add(0, 1)
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 409


def test_upload_complete_http_and_internal_errors(root, tmp_dir, users_yaml, monkeypatch):
    from fastapi import HTTPException

    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    client, store = _router_client(settings)
    with client:
        for error, expected in ((HTTPException(status_code=409, detail="close"), 409), (OSError("finalize"), 500)):
            init = client.post(
                "/_upload/init",
                json={
                    "upload_key": f"edge-error-{expected}",
                    "filename": "bad.txt",
                    "size": 1,
                    "dir": "/",
                },
            )
            upload_id = init.json()["upload_id"]
            session = store.get(upload_id)
            class Sink:
                async def write_at(self, offset, data):
                    pass
                async def finalize(self):
                    raise error
                async def abort(self):
                    pass
            session.sink = Sink()
            session.ranges.add(0, 1)
            session.staged_path = None
            assert client.post(f"/_upload/{upload_id}/complete").status_code == expected

        init = client.post(
            "/_upload/init",
            json={"upload_key": "edge-empty", "filename": "empty.txt", "size": 0, "dir": "/"},
        )
        upload_id = init.json()["upload_id"]
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200

        init = client.post(
            "/_upload/init",
            json={"upload_key": "edge-outside", "filename": "outside.txt", "size": 0, "dir": "/"},
        )
        upload_id = init.json()["upload_id"]
        store.get(upload_id).target.directory = str(root.parent / "outside-empty")
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 403

        init = client.post(
            "/_upload/init",
            json={"upload_key": "edge-hook", "filename": "hook.txt", "size": 0, "dir": "/"},
        )
        upload_id = init.json()["upload_id"]
        async def fail(*args, **kwargs):
            raise RuntimeError("hook")
        monkeypatch.setattr(upload, "_record_upload_audit", fail)
        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200


@pytest.mark.asyncio
async def test_stream_to_sink_limits():
    class Request:
        def __init__(self, chunks):
            self.chunks = chunks
        async def stream(self):
            for chunk in self.chunks:
                yield chunk
    class Sink(UploadSink):
        async def write_at(self, offset, data):
            pass
        async def finalize(self):
            pass
        async def abort(self):
            pass
    with pytest.raises(Exception):
        await stream_to_sink(Request([b"long"]), Sink(), max_bytes=3)
    with pytest.raises(Exception):
        await stream_to_sink(Request([b"four"]), Sink(), max_bytes=10, expect_length=3)
    with pytest.raises(Exception):
        await stream_to_sink(Request([b"ab"]), Sink(), max_bytes=10, expect_length=3)


def test_upload_router_rejects_bad_json_and_offsets(client):
    assert client.post("/_upload/init", content=b"{bad", headers={"content-type": "application/json"}).status_code == 400
    assert client.post("/_upload/init", json=[]).status_code == 400
    init = client.post("/_upload/init", json={"filename": "x.txt", "size": 4, "dir": "/"})
    upload_id = init.json()["upload_id"]
    sha = hashlib.sha256(b"x").hexdigest()
    assert (
        client.post(
            f"/_upload/{upload_id}/chunk",
            params={"offset": "no", "sha256": sha},
            content=b"x",
        ).status_code
        == 400
    )
    assert (
        client.post(
            f"/_upload/{upload_id}/chunk",
            params={"offset": "9", "sha256": sha},
            content=b"x",
        ).status_code
        == 400
    )


def test_webdav_propfind_and_copy_edges(tmp_path, monkeypatch):
    root = tmp_path
    broken = root / "broken"
    broken.symlink_to(root / "missing")
    request = SimpleNamespace(headers={"depth": "bogus"})
    response = webdav.propfind_response(request, root, root)
    assert response.status_code == 207
    assert b"broken" in response.body

    class BadDatetime:
        @staticmethod
        def fromtimestamp(*args, **kwargs):
            raise OSError("time")
    monkeypatch.setattr(webdav, "datetime", BadDatetime)
    webdav._prop_response("/x", broken)

    src = root / "src.txt"
    src.write_text("x")
    bad_dest = root / "missing-parent" / "dest.txt"
    assert asyncio.run(webdav.copy_response(src, bad_dest, True)).status_code == 409
    assert asyncio.run(webdav.copy_response(root / "none", root / "x", True)).status_code == 404

    with monkeypatch.context() as patch:
        patch.setattr(webdav, "_temporary_copy_path", lambda *args: (_ for _ in ()).throw(OSError("temp")))
        assert asyncio.run(webdav.copy_response(src, root / "dest.txt", True)).status_code == 500

    with monkeypatch.context() as patch:
        patch.setattr(webdav, "_cleanup_path", lambda *args: (_ for _ in ()).throw(RuntimeError("cleanup")))
        patch.setattr(webdav.shutil, "copy2", lambda *args: (_ for _ in ()).throw(OSError("copy")))
        assert asyncio.run(webdav.copy_response(src, root / "dest2.txt", True)).status_code == 500

    assert asyncio.run(webdav.move_response(root / "missing", root / "dest", False)).status_code == 404
    assert asyncio.run(webdav.move_response(src, src, False)).status_code == 412
    assert asyncio.run(webdav.move_response(src, root / "missing" / "dest", True)).status_code == 409


@pytest.mark.asyncio
async def test_webdav_child_propfind_and_dispose(tmp_path, monkeypatch):
    root = tmp_path
    (root / "child.txt").write_text("x")
    original = webdav._prop_response
    def maybe_fail(href, path):
        if path != root:
            raise OSError("child")
        return original(href, path)
    monkeypatch.setattr(webdav, "_prop_response", maybe_fail)
    request = SimpleNamespace(headers={"depth": "1"})
    assert webdav.propfind_response(request, root, root).status_code == 207

    backup = root / "backup"
    backup.write_text("old")
    await webdav._dispose_backup(backup, None)
    assert not backup.exists()


def test_webdav_install_staged_path_rolls_back(tmp_path, monkeypatch):
    dest = tmp_path / "dest.txt"
    dest.write_text("old")
    staged = tmp_path / "staged.txt"
    staged.write_text("new")
    original_replace = type(staged).replace
    def replace(source, target):
        if str(source) == str(staged):
            Path(target).write_text("partial")
            raise OSError("install")
        return original_replace(source, target)
    monkeypatch.setattr(type(staged), "replace", replace)
    monkeypatch.setattr(webdav.shutil, "move", lambda *args: (_ for _ in ()).throw(OSError("move")))
    with pytest.raises(OSError):
        webdav._install_staged_path(staged, dest)
    assert dest.read_text() == "old"
