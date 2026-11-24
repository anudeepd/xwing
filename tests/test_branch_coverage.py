import asyncio
from pathlib import Path

import pytest

import xwing.app as app_module
import xwing.upload as upload_module
from conftest import TestClient
from xwing.app import create_app
from xwing.config import Settings
from xwing.upload import LocalFileSink
from xwing.upload_engine import RangeTracker


ADMIN = {"X-Forwarded-User": "admin"}


def _admin_settings(root: Path, tmp_dir: Path, tmp_path: Path, **kwargs) -> Settings:
    users = tmp_path / "branch-users.yaml"
    users.write_text('users:\n  "*": rwd\n  admin: rwd\n')
    return Settings(
        root_dir=root,
        tmp_dir=tmp_dir,
        users_config=users,
        admin_users=["admin"],
        trusted_auth_proxies=["testclient"],
        **kwargs,
    )


def test_reload_reads_every_environment_setting(monkeypatch, tmp_path):
    captured = {}

    class FakeSettings:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    users = tmp_path / "users.yaml"
    users.write_text("users:\n  '*': r\n")
    ldap = tmp_path / "ldap.yaml"
    ldap.write_text("ldap: {}\n")
    audit = tmp_path / "audit.db"

    monkeypatch.setattr(app_module, "Settings", FakeSettings)
    monkeypatch.setattr(app_module, "create_app", lambda settings: settings)
    monkeypatch.setattr(app_module, "_configure_log_file_from_env", lambda: None)
    monkeypatch.delenv("XWING_LOG_FILE", raising=False)
    for key, value in {
        "XWING_ROOT": str(tmp_path),
        "XWING_REQUIRE_AUTH": "True",
        "XWING_MAX_UPLOAD_GB": "2",
        "XWING_MAX_CHUNK_MB": "8",
        "XWING_UPLOAD_CONCURRENCY": "3",
        "XWING_MAX_CHUNKS": "9",
        "XWING_SESSION_TTL_MINUTES": "7",
        "XWING_USER_HEADER": "X-User",
        "XWING_TRUSTED_AUTH_PROXIES": "127.0.0.1, 10.0.0.1",
        "XWING_USERS_CONFIG": str(users),
        "XWING_LDAP_CONFIG": str(ldap),
        "XWING_AUDIT_DB": str(audit),
    }.items():
        monkeypatch.setenv(key, value)

    app_module.create_app_reload()

    assert captured == {
        "root_dir": tmp_path,
        "require_auth": True,
        "listen_host": "127.0.0.1",
        "listen_port": 8989,
        "max_upload_bytes": 2 * 1024**3,
        "max_chunk_bytes": 8 * 1024**2,
        "upload_concurrency": 3,
        "max_chunks": 9,
        "session_ttl_seconds": 7 * 60,
        "user_header": "X-User",
        "trusted_auth_proxies": ["127.0.0.1", "10.0.0.1"],
        "users_config": users,
        "ldap_config": ldap,
        "audit_db": audit,
    }


def test_reload_uses_defaults_when_optional_environment_is_unset(
    monkeypatch, tmp_path
):
    captured = {}

    class FakeSettings:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(app_module, "Settings", FakeSettings)
    monkeypatch.setattr(app_module, "create_app", lambda settings: settings)
    monkeypatch.setattr(app_module, "_configure_log_file_from_env", lambda: None)
    monkeypatch.setenv("XWING_ROOT", str(tmp_path))
    for key in (
        "XWING_REQUIRE_AUTH",
        "XWING_MAX_UPLOAD_GB",
        "XWING_MAX_CHUNK_MB",
        "XWING_UPLOAD_CONCURRENCY",
        "XWING_MAX_CHUNKS",
        "XWING_SESSION_TTL_MINUTES",
        "XWING_USER_HEADER",
        "XWING_TRUSTED_AUTH_PROXIES",
        "XWING_USERS_CONFIG",
        "XWING_LDAP_CONFIG",
        "XWING_AUDIT_DB",
    ):
        monkeypatch.delenv(key, raising=False)

    app_module.create_app_reload()

    assert captured == {
        "root_dir": tmp_path,
        "listen_host": "127.0.0.1",
        "listen_port": 8989,
    }


def test_generic_audit_accepts_non_object_json(
    root, tmp_dir, tmp_path, monkeypatch
):
    recorded = []

    async def record(**kwargs):
        recorded.append(kwargs)

    settings = _admin_settings(
        root, tmp_dir, tmp_path, audit_db=tmp_path / "audit.db"
    )
    monkeypatch.setattr(app_module.audit_store, "record_event_async", record)

    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/not-a-route",
            json=[{"token": "secret"}],
            headers={"X-Forwarded-User": "alice"},
        )

    assert response.status_code == 405
    assert recorded[-1]["details"] == '[{"token": "secret"}]'


def test_admin_user_prefers_request_state(root, tmp_dir, tmp_path):
    settings = _admin_settings(root, tmp_dir, tmp_path)
    app = create_app(settings)

    @app.middleware("http")
    async def inject_user(request, call_next):
        request.state.user = "admin"
        return await call_next(request)

    with TestClient(app) as client:
        response = client.get("/api/admin/users")

    assert response.status_code == 200


def test_empty_trash_without_a_trash_directory(root, tmp_dir, tmp_path):
    settings = _admin_settings(root, tmp_dir, tmp_path)
    assert not settings.trash_dir.exists()

    with TestClient(create_app(settings)) as client:
        response = client.delete("/api/admin/trash", headers=ADMIN)

    assert response.status_code == 200
    assert response.json()["deleted"] == 0


def test_audit_purge_without_an_audit_database(root, tmp_dir, tmp_path):
    settings = _admin_settings(root, tmp_dir, tmp_path, audit_db=None)
    with TestClient(create_app(settings)) as client:
        response = client.delete(
            "/api/admin/activity?older_than_days=30", headers=ADMIN
        )

    assert response.status_code == 200
    assert response.json()["deleted"] == 0


def test_local_sink_concurrent_open_returns_the_first_descriptor(tmp_path):
    sink = LocalFileSink(tmp_path / "staged", tmp_path / "destination")

    async def run():
        try:
            return await asyncio.gather(sink._descriptor(), sink._descriptor())
        finally:
            await sink.abort()

    first, second = asyncio.run(run())
    assert first == second


def test_cleanup_stale_sessions_handles_an_empty_sweep(monkeypatch):
    class EmptyStore:
        async def sweep(self):
            return 0

    class StopLoop(Exception):
        pass

    calls = 0

    async def stop(_seconds):
        nonlocal calls
        calls += 1
        if calls > 1:
            raise StopLoop

    monkeypatch.setattr(upload_module.asyncio, "sleep", stop)
    with pytest.raises(StopLoop):
        asyncio.run(upload_module.cleanup_stale_sessions(EmptyStore()))


def test_range_tracker_merges_after_multiple_later_spans():
    tracker = RangeTracker([[5, 6], [7, 8]])
    tracker.add(1, 2)

    assert tracker.spans() == [(1, 2), (5, 6), (7, 8)]


def test_range_tracker_missing_is_empty_when_the_cursor_passes_size():
    tracker = RangeTracker([[0, 7]])

    assert tracker.missing(5) == []
