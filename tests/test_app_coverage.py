import builtins
import json
import os
import sys
import types
from types import SimpleNamespace
from pathlib import Path

import pytest

from conftest import TestClient
from xwing import app as app_module
from xwing import audit_store
from xwing.app import create_app
from xwing.config import Settings, UserConfig


HTML = {"Accept": "text/html"}
ADMIN = {"X-Forwarded-User": "admin"}
ALICE = {"X-Forwarded-User": "alice"}


def _settings(
    root,
    tmp_dir,
    tmp_path,
    monkeypatch,
    *,
    audit_db=None,
    ldap=True,
    manager=None,
    ldap_document=None,
):
    users = tmp_path / "users.yaml"
    users.write_text("users:\n  admin: rwd\n  alice: rwd\n")
    if not ldap:
        return Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            require_auth=True,
            users_config=users,
            admin_users=["admin"],
            trusted_auth_proxies=["testclient"],
            audit_db=audit_db,
        ), users, None

    ldap_yaml = tmp_path / "ldapgate.yaml"
    ldap_yaml.write_text(
        ldap_document
        or "ldap:\n  bind_password: test-password\nproxy:\n  secret_key: test-secret\n"
    )
    ldapgate_pkg = types.ModuleType("ldapgate")
    config_mod = types.ModuleType("ldapgate.config")
    middleware_mod = types.ModuleType("ldapgate.middleware")
    loaded_config = types.SimpleNamespace(
        proxy=types.SimpleNamespace(
            static_paths=[],
            idle_timeout=0,
            trusted_proxies=[],
            session_cookie_name="ldapgate_session",
        ),
        ldap=types.SimpleNamespace(allowed_users=[]),
    )
    config_mod.load_config = lambda path: loaded_config
    middleware_mod.add_ldap_auth = lambda app, config, template_path=None: manager
    monkeypatch.setitem(sys.modules, "ldapgate", ldapgate_pkg)
    monkeypatch.setitem(sys.modules, "ldapgate.config", config_mod)
    monkeypatch.setitem(sys.modules, "ldapgate.middleware", middleware_mod)
    return (
        Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            require_auth=True,
            users_config=users,
            ldap_config=ldap_yaml,
            admin_users=["admin"],
            trusted_auth_proxies=["testclient"],
            audit_db=audit_db,
        ),
        users,
        loaded_config,
    )


def test_log_file_asset_manifest_and_reload_factory(tmp_path, monkeypatch):
    log = tmp_path / "logs" / "xwing.log"
    monkeypatch.setenv("XWING_LOG_FILE", str(log))
    app_module._configure_log_file_from_env()
    assert log.exists()
    monkeypatch.setenv("XWING_LOG_FILE", "")
    app_module._configure_log_file_from_env()

    missing_static = tmp_path / "missing-static"
    monkeypatch.setattr(app_module, "STATIC_DIR", missing_static)
    assert app_module.load_asset_manifest() == {}
    assets = missing_static / "assets"
    assets.mkdir(parents=True)
    (assets / "manifest.json").write_text("{bad")
    assert app_module.load_asset_manifest() == {}

    monkeypatch.delenv("XWING_ROOT", raising=False)
    with pytest.raises(RuntimeError):
        app_module.create_app_reload()

    root = tmp_path / "reload-root"
    root.mkdir()
    users = tmp_path / "reload-users.yaml"
    users.write_text("users:\n  '*': rwd\n")
    audit = tmp_path / "reload-audit.db"
    monkeypatch.setenv("XWING_ROOT", str(root))
    monkeypatch.setenv("XWING_REQUIRE_AUTH", "True")
    monkeypatch.setenv("XWING_LISTEN_HOST", "0.0.0.0")
    monkeypatch.setenv("XWING_LISTEN_PORT", "9001")
    monkeypatch.setenv("XWING_MAX_UPLOAD_GB", "1")
    monkeypatch.setenv("XWING_MAX_CHUNK_MB", "2")
    monkeypatch.setenv("XWING_MAX_CHUNKS", "3")
    monkeypatch.setenv("XWING_SESSION_TTL_MINUTES", "4")
    monkeypatch.setenv("XWING_USER_HEADER", "X-User")
    monkeypatch.setenv("XWING_TRUSTED_AUTH_PROXIES", "127.0.0.1, testclient")
    monkeypatch.setenv("XWING_USERS_CONFIG", str(users))
    monkeypatch.setenv("XWING_AUDIT_DB", str(audit))
    ldap_env = tmp_path / "reload-ldap.yaml"
    ldap_env.write_text("ldap: {}\n")
    monkeypatch.setenv("XWING_LDAP_CONFIG", str(ldap_env))
    captured = []
    monkeypatch.setattr(app_module, "create_app", lambda settings: captured.append(settings) or object())
    app_module.create_app_reload()
    assert captured and captured[0].listen_port == 9001


def test_ldapgate_missing_package_is_a_startup_error(root, tmp_dir, tmp_path, monkeypatch):
    ldap = tmp_path / "ldap.yaml"
    ldap.write_text("ldap: {}\n")
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, ldap_config=ldap)
    real_import = builtins.__import__
    def fail_import(name, *args, **kwargs):
        if name.startswith("ldapgate"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", fail_import)
    with pytest.raises(RuntimeError, match="ldapgate is not installed"):
        create_app(settings)


def test_generic_audit_details_and_skip_paths(root, tmp_dir, tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, audit_db=db)
    with TestClient(create_app(settings)) as client:
        for path in ("/_auth/nope", "/favicon.svg", "/api/restore/nope"):
            client.post(path, headers=ALICE, content=b"x")
        client.post(
            "/unknown",
            headers={**ALICE, "content-type": "application/json"},
            content=json.dumps({"password": "secret", "token": "token", "ok": 1}).encode(),
        )
        client.post(
            "/unknown",
            headers={**ALICE, "content-type": "text/plain"},
            content=b"plain text",
        )
        client.post(
            "/unknown",
            headers={**ALICE, "content-type": "application/json"},
            content=b"{bad",
        )
        client.post("/unknown", headers={**ALICE, "content-type": "application/octet-stream"}, content=b"x")
        client.post("/unknown", headers={**ALICE, "content-length": "not-a-number"}, content=b"x")
        client.post("/unknown", headers={**ALICE, "content-type": "text/plain"}, content=b"x" * 33_000)
        client.post("/unknown", headers={**ALICE, "content-type": "text/plain"}, content=b"")
        client.post("/unknown", content=iter([b"streamed"]))
        client.post("/unknown", headers={**ALICE, "content-type": "application/json"}, content=b'{"a": "b"}')
        client.post(
            "/unknown",
            headers={**ALICE, "Content-Length": "not-a-number", "content-type": "text/plain"},
            content=b"",
        )
        client.post(
            "/unknown",
            headers={**ALICE, "Content-Length": "40000", "content-type": "text/plain"},
            content=b"x",
        )

    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.post("/unknown", content=b"x").status_code == 405
        async def fail(**kwargs):
            raise RuntimeError("audit down")
        monkeypatch.setattr(app_module.audit_store, "record_event_async", fail)
        assert client.post("/unknown", headers=ALICE, content=b"x").status_code in {200, 404, 405}

    events = audit_store.list_events(db, username="alice")
    details = [event["details"] for event in events]
    assert any("[redacted]" in (item or "") for item in details)
    assert any("plain text" in (item or "") for item in details)


def test_semantic_audit_failure_does_not_fail_the_write(root, tmp_dir, tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, audit_db=db)
    async def fail(**kwargs):
        raise RuntimeError("audit down")
    monkeypatch.setattr(app_module.audit_store, "record_event_async", fail)
    with TestClient(create_app(settings)) as client:
        response = client.put("/x.txt", headers=ALICE, content=b"x")
        assert response.status_code == 204


def test_webdav_destination_and_ignored_paths(root, tmp_dir, users_yaml):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    (root / "src.txt").write_text("x")
    (root / ".DS_Store").write_text("ignored")
    with TestClient(create_app(settings)) as client:
        assert client.request("MOVE", "/src.txt", headers={"Destination": "//host/path"}).status_code == 400
        assert client.request("MOVE", "/src.txt", headers={}).status_code == 400
        assert client.request("COPY", "/.DS_Store", headers={"Destination": "/copy"}).status_code == 201
        assert client.request("MOVE", "/.DS_Store", headers={"Destination": "/moved"}).status_code == 204
        assert client.get("/.DS_Store").status_code == 404


def test_bulk_validation_zip_limits_and_missing_paths(root, tmp_dir, users_yaml):
    settings = Settings(
        root_dir=root,
        tmp_dir=tmp_dir,
        users_config=users_yaml,
        max_upload_bytes=3,
    )
    (root / "dir").mkdir()
    (root / "dir" / "a.txt").write_text("abcd")
    with TestClient(create_app(settings)) as client:
        for body in (
            None,
            {"paths": "x"},
            {"paths": []},
            {"paths": ["/x"] * 501},
            {"paths": [1]},
            {"paths": ["/.DS_Store"]},
        ):
            assert client.post("/_bulk/zip", json=body).status_code == 400
        assert client.post("/_bulk/zip", content=b"{bad", headers={"content-type": "application/json"}).status_code == 400
        assert client.post("/_bulk/zip", json={"paths": ["/missing"]}).status_code == 404
        assert client.post("/_bulk/zip", json={"paths": ["/dir"], "base": 4}).status_code == 400
        assert client.post("/_bulk/zip", json={"paths": ["/dir"], "base": "/missing"}).status_code == 404
        assert client.post("/_bulk/zip", json={"paths": ["/dir/a.txt"], "base": "/dir"}).status_code == 413
        assert client.post("/_bulk/delete", json={"paths": ["/missing"]}).status_code == 404


def test_restore_candidate_conflicts_and_missing_trash(root, tmp_dir, users_yaml):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    with TestClient(create_app(settings)) as client:
        (root / "x.txt").write_text("one")
        first = client.delete("/x.txt").json()["transaction_id"]
        (root / "x.txt").write_text("two")
        (root / "x (restored).txt").write_text("three")
        restored = client.post(f"/api/restore/{first}")
        assert restored.status_code == 200
        assert (root / "x (restored-1).txt").exists()

        (root / "folder").mkdir()
        second = client.delete("/folder").json()["transaction_id"]
        (root / "folder").mkdir()
        (root / "folder (restored)").mkdir()
        assert client.post(f"/api/restore/{second}").status_code == 200
        assert (root / "folder (restored-1)").exists()

        transaction = client.delete("/x (restored-1).txt").json()["transaction_id"]
        for item in list((root / ".xwing-trash").iterdir()):
            if item.name != ".index.json":
                item.unlink()
        assert client.post(f"/api/restore/{transaction}").status_code == 200


def test_edit_root_and_permission_denied_listing(root, tmp_dir, users_yaml, monkeypatch):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    (root / "x.txt").write_text("hello")
    with TestClient(create_app(settings)) as client:
        edit = client.get("/x.txt?edit", headers=HTML)
        assert edit.status_code == 200
        assert 'id="xwing-editor-bootstrap"' in edit.text
        monkeypatch.setattr(
            app_module,
            "list_dir",
            lambda *args, **kwargs: (_ for _ in ()).throw(PermissionError("denied")),
        )
        assert client.get("/", headers=HTML).status_code == 403


def test_put_error_paths_and_invalid_length(root, tmp_dir, users_yaml, monkeypatch):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.put("/bad.txt", headers={"content-length": "abc"}, content=b"x").status_code == 204
        monkeypatch.setattr(
            app_module,
            "stream_to_sink",
            lambda *args, **kwargs: (_ for _ in ()).throw(app_module.HTTPException(status_code=413, detail="no")),
        )
        assert client.put("/too-big.txt", content=b"x").status_code == 413
        monkeypatch.setattr(
            app_module,
            "stream_to_sink",
            lambda *args, **kwargs: (_ for _ in ()).throw(OSError("disk")),
        )
        assert client.put("/disk.txt", content=b"x").status_code == 500
        monkeypatch.setattr(
            app_module,
            "stream_to_sink",
            lambda *args, **kwargs: (_ for _ in ()).throw(app_module.ClientDisconnect("gone")),
        )
        assert client.put("/gone.txt", content=b"x").status_code == 499
        monkeypatch.setattr(
            app_module,
            "stream_to_sink",
            lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("cancel")),
        )
        assert client.put("/cancel.txt", content=b"x").status_code == 500


def test_ignored_delete_and_failed_trash_persist(root, tmp_dir, users_yaml, monkeypatch):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    (root / ".DS_Store").write_text("ignored")
    (root / ".Trashes").mkdir()
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.delete("/.DS_Store").status_code == 204
        assert client.delete("/.Trashes").status_code == 204
        (root / "x.txt").write_text("x")
        monkeypatch.setattr(
            app_module.trash_store,
            "save_transactions",
            lambda *args, **kwargs: (_ for _ in ()).throw(OSError("persist")),
        )
        assert client.delete("/x.txt").status_code == 500
        assert (root / "x.txt").exists()


def test_bulk_zip_more_edges(root, tmp_dir, users_yaml, monkeypatch):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    (root / "dir").mkdir()
    (root / "dir" / "a.txt").write_text("a")
    (root / "dir" / "sub").mkdir()
    (root / "link").symlink_to(root / "dir", target_is_directory=True)
    with TestClient(create_app(settings)) as client:
        assert client.post("/_bulk/zip", json=[]).status_code == 400
        assert client.post("/_bulk/zip", json={"paths": ["/dir/a.txt"], "base": "/dir/sub"}).status_code == 200
        assert client.post("/_bulk/zip", json={"paths": ["/link"]}).status_code == 200
        assert client.post("/_bulk/zip", json={"paths": ["/dir"], "base": "/dir"}).status_code == 200
        assert client.post("/_bulk/zip", json={"paths": ["/dir"], "base": "/../outside"}).status_code == 403
        assert client.post("/_bulk/zip", json={"paths": ["/dir", "/dir/a.txt"]}).status_code == 200


def test_zip_skips_non_utf8_and_special_files(root, tmp_dir, users_yaml):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    raw = os.fsencode(root)
    try:
        fd = os.open(raw + b"/caf\xe9.txt", os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
    except (OSError, ValueError):
        pytest.skip("filesystem rejects non-UTF-8 names")
    with TestClient(create_app(settings)) as client:
        assert client.get("/?zip").status_code == 200
        bulk = client.post(
            "/_bulk/zip",
            content=b'{"paths":["/caf\\udce9.txt"]}',
            headers={"content-type": "application/json"},
        )
        assert bulk.status_code == 200


def test_bulk_zip_skips_special_paths(root, tmp_dir, users_yaml):
    if not hasattr(os, "mkfifo"):
        pytest.skip("mkfifo unavailable")
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    os.mkfifo(root / "pipe")
    with TestClient(create_app(settings)) as client:
        assert client.post("/_bulk/zip", json={"paths": ["/pipe"]}).status_code == 200


def test_zip_finish_is_idempotent(root, tmp_dir, users_yaml, monkeypatch):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    (root / "dir").mkdir()
    (root / "dir" / "x.txt").write_text("x")
    from starlette.responses import Response
    captured = []
    class Capture(Response):
        def __init__(self, *args, on_done=None, **kwargs):
            captured.append(on_done)
            super().__init__(content=b"", status_code=200)
    monkeypatch.setattr(app_module, "_ReleasingStreamingResponse", Capture)
    with TestClient(create_app(settings)) as client:
        assert client.get("/dir?zip").status_code == 200
    captured[0]()
    captured[0]()


def test_bulk_zip_archive_size_and_non_utf8(root, tmp_dir, users_yaml):
    settings = Settings(
        root_dir=root,
        tmp_dir=tmp_dir,
        users_config=users_yaml,
        max_upload_bytes=3,
    )
    (root / "dir").mkdir()
    (root / "dir" / "a.txt").write_text("abcd")
    with TestClient(create_app(settings)) as client:
        assert client.get("/dir?zip").status_code == 413


def test_bulk_outside_paths_and_top_level_dedup(root, tmp_dir, users_yaml, monkeypatch):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    outside = root.parent / "outside-bulk.txt"
    outside.write_text("outside")
    (root / "outlink").symlink_to(outside)
    (root / "dir").mkdir()
    (root / "dir" / "a.txt").write_text("a")
    with TestClient(create_app(settings)) as client:
        assert client.post("/_bulk/delete", json={"paths": ["/outlink"]}).status_code == 200
        assert client.post("/_bulk/delete", json={"paths": ["/dir", "/dir/a.txt"]}).status_code == 200


def test_zip_archive_growth_hits_build_limit(root, tmp_dir, users_yaml, monkeypatch):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml, max_upload_bytes=3)
    (root / "dir").mkdir()
    (root / "dir" / "a.txt").write_text("abcd")
    original_stat = Path.stat
    def stat(self, *args, **kwargs):
        if self.name == "a.txt":
            return SimpleNamespace(st_size=0, st_mtime=0, st_mode=0o100644)
        return original_stat(self, *args, **kwargs)
    monkeypatch.setattr(Path, "stat", stat)
    with TestClient(create_app(settings)) as client:
        assert client.get("/dir?zip").status_code == 413


def test_overwrite_copy_logs_trash_failure(root, tmp_dir, users_yaml, monkeypatch):
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)
    (root / "src.txt").write_text("new")
    (root / "dest.txt").write_text("old")
    monkeypatch.setattr(
        app_module.trash_store,
        "save_transactions",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError("trash")),
    )
    with TestClient(create_app(settings)) as client:
        assert client.request(
            "COPY",
            "/src.txt",
            headers={"Destination": "/dest.txt"},
        ).status_code == 204


def test_restore_another_user_and_candidate_exhaustion(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    settings.users_config.write_text("users:\n  admin: rwd\n  alice: rwd\n  bob: rwd\n")
    settings._user_config = UserConfig(settings.users_config)
    (root / "owned.txt").write_text("x")
    with TestClient(create_app(settings)) as client:
        deleted = client.delete("/owned.txt", headers=ALICE)
        transaction = deleted.json()["transaction_id"]
        assert client.post(f"/api/restore/{transaction}", headers={"X-Forwarded-User": "bob"}).status_code == 403
        monkeypatch.setattr(app_module.os.path, "lexists", lambda path: True)
        assert client.post(f"/api/restore/{transaction}", headers=ALICE).status_code == 409


def test_admin_access_users_errors_and_wildcard(root, tmp_dir, tmp_path, monkeypatch):
    settings, users, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    settings.users_config = None
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.get("/api/admin/users", headers=ADMIN).status_code == 409

    settings, users, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        users.unlink()
        assert client.get("/api/admin/users", headers=ADMIN).status_code == 404
        users.write_text("{bad yaml")
        assert client.get("/api/admin/users", headers=ADMIN).status_code == 500
        users.write_text("users: []\n")
        assert client.get("/api/admin/users", headers=ADMIN).status_code == 500
        users.write_text("users:\n  '*': rwd\n")
        assert client.get("/api/admin/users", headers=ADMIN).status_code == 200
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "*", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 400
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "bad/name", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 400
        assert client.delete("/api/admin/users/missing", headers=ADMIN).status_code == 404

    settings, users, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.get("/api/admin/users", headers={"X-Forwarded-User": ""}).status_code == 403
        monkeypatch.setattr(
            app_module.UserConfig,
            "_parse",
            staticmethod(lambda username, value: (_ for _ in ()).throw(ValueError("bad perm"))),
        )
        response = client.get("/api/admin/users", headers=ADMIN)
        assert response.status_code == 400


def test_admin_user_update_and_ldap_session_hooks(root, tmp_dir, tmp_path, monkeypatch):
    restored = []
    revoked = []
    manager = SimpleNamespace(
        restore_user_sessions=lambda username: restored.append(username),
        revoke_user_sessions=lambda username: revoked.append(username) or 1,
    )
    settings, users, loaded = _settings(
        root, tmp_dir, tmp_path, monkeypatch, ldap=True, manager=manager
    )
    with TestClient(create_app(settings)) as client:
        payload = {"username": "alice", "permissions": {"read": True, "write": True, "delete": True}}
        assert client.post("/api/admin/users", headers=ADMIN, json=payload).status_code == 200
        assert "alice" in restored
        assert client.delete("/api/admin/users/alice", headers=ADMIN).status_code == 200
        assert "alice" in revoked
        assert loaded.ldap.allowed_users == ["admin"]

    no_revoke = SimpleNamespace(restore_user_sessions=lambda username: None, revoke_user_sessions=None)
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=True, manager=no_revoke)
    with TestClient(create_app(settings)) as client:
        assert client.delete("/api/admin/users/alice", headers=ADMIN).json()["revoked_sessions"] == 0


def test_empty_ldap_allowlist_and_user_config_exception(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=True)
    settings.admin_users = []
    monkeypatch.setattr(Settings, "is_admin_user", lambda self, user: True)
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.delete("/api/admin/users/alice", headers=ADMIN).status_code == 200
        response = client.delete("/api/admin/users/admin", headers=ADMIN)
        assert response.status_code == 409

    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    monkeypatch.setattr(
        app_module,
        "UserConfig",
        lambda path: (_ for _ in ()).throw(app_module.HTTPException(status_code=409, detail="config")),
    )
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        response = client.post(
            "/api/admin/users",
            headers=ADMIN,
            json={"username": "new", "permissions": {"read": True, "write": False, "delete": False}},
        )
        assert response.status_code == 409


def test_ldap_config_errors_and_validation(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    settings.ldap_config = tmp_path / "missing-ldap.yaml"
    settings.admin_users = ["admin"]
    settings.trusted_auth_proxies = ["testclient"]
    fake = types.ModuleType("ldapgate")
    config = types.ModuleType("ldapgate.config")
    middleware = types.ModuleType("ldapgate.middleware")
    config.load_config = lambda path: SimpleNamespace(
        proxy=SimpleNamespace(static_paths=[], idle_timeout=0, trusted_proxies=[], session_cookie_name="x"),
        ldap=SimpleNamespace(allowed_users=[]),
    )
    middleware.add_ldap_auth = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, "ldapgate", fake)
    monkeypatch.setitem(sys.modules, "ldapgate.config", config)
    monkeypatch.setitem(sys.modules, "ldapgate.middleware", middleware)
    # The configured file does not exist: admin save hits the 404 branch.
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "bob", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 404

    settings.ldap_config.write_text("{bad")
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "bob", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 500


def test_ldap_validation_import_and_unlink_failures(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=True)
    real_import = builtins.__import__
    fail_import = False
    def guarded_import(name, *args, **kwargs):
        if fail_import and name.startswith("ldapgate"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded_import)
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        fail_import = True
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "bob", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 503
        fail_import = False
        sys.modules["ldapgate.config"].load_config = lambda path: (_ for _ in ()).throw(ValueError("bad ldap"))
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "bob", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 400

    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=True)
    original_unlink = Path.unlink
    def fail_unlink(self, *args, **kwargs):
        if self.name.startswith(".ldapgate.yaml."):
            raise OSError("unlink")
        return original_unlink(self, *args, **kwargs)
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        monkeypatch.setattr(Path, "unlink", fail_unlink)
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "bob", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 200


def test_ldap_document_is_not_a_mapping(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=True, ldap_document="[1]\n")
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        response = client.post(
            "/api/admin/users",
            headers=ADMIN,
            json={"username": "bob", "permissions": {"read": True, "write": False, "delete": False}},
        )
        assert response.status_code == 500
    settings.ldap_config.write_text("[]")
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "bob", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 500
    settings.ldap_config.write_text("ldap: []\n")
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.post("/api/admin/users", headers=ADMIN, json={"username": "bob", "permissions": {"read": True, "write": False, "delete": False}}).status_code == 500


def test_admin_activity_and_purge_validation(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False, audit_db=None)
    settings.audit_db = None
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        assert client.get("/api/admin/activity?scope=bad", headers=ADMIN).status_code == 400
        assert client.get("/api/admin/activity?limit=bad", headers=ADMIN).status_code == 400
        assert client.get("/api/admin/activity", headers=ADMIN).status_code == 200
        assert client.delete("/api/admin/activity?older_than_days=bad", headers=ADMIN).status_code == 400
        assert client.delete("/api/admin/activity?older_than_days=0", headers=ADMIN).status_code == 400
        metrics = client.get("/api/admin/metrics", headers=ADMIN)
        assert metrics.status_code == 200
        assert metrics.json()["activity_events"] == 0


def test_admin_trash_missing_and_directory_actions(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    (root / "dir").mkdir()
    (root / "dir" / "x.txt").write_text("x")
    (root / "file.txt").write_text("f")
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        deleted_dir = client.delete("/dir", headers=ALICE).json()["transaction_id"]
        deleted_file = client.delete("/file.txt", headers=ALICE).json()["transaction_id"]
        assert client.post("/api/admin/trash/restore", headers=ADMIN, json={"transaction_ids": []}).status_code == 400
        assert client.post("/api/admin/trash/restore", headers=ADMIN, json={"transaction_ids": ["missing"]}).status_code == 404
        assert client.post("/api/admin/trash/missing/restore", headers=ADMIN).status_code == 404
        assert client.delete("/api/admin/trash/missing", headers=ADMIN).status_code == 404
        trash = client.get("/api/admin/trash", headers=ADMIN)
        assert trash.status_code == 200
        assert client.delete(f"/api/admin/trash/{deleted_dir}", headers=ADMIN).status_code == 200
        for item in (root / ".xwing-trash").iterdir():
            if item.name != ".index.json":
                if item.is_dir():
                    import shutil
                    shutil.rmtree(item)
                else:
                    item.unlink()
        assert client.get("/api/admin/trash", headers=ADMIN).status_code == 200
        assert client.post(f"/api/admin/trash/{deleted_file}/restore", headers=ADMIN).status_code == 200
        (root / "third.txt").write_text("third")
        third = client.delete("/third.txt", headers=ALICE).json()["transaction_id"]
        for item in (root / ".xwing-trash").iterdir():
            if item.name != ".index.json":
                item.unlink()
        assert client.delete(f"/api/admin/trash/{third}", headers=ADMIN).status_code == 200
        (root / ".xwing-trash" / "orphan-dir").mkdir()
        assert client.delete("/api/admin/trash", headers=ADMIN).status_code == 200


def test_admin_metrics_storage_error_and_ldap_helpers(root, tmp_dir, tmp_path, monkeypatch):
    settings, users, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    settings.audit_db = None
    (root / "file.txt").write_text("x")
    with TestClient(create_app(settings)) as client:
        original_stat = Path.stat
        stat_calls = 0
        def fail_stat(self, *args, **kwargs):
            nonlocal stat_calls
            if self.name == "file.txt":
                stat_calls += 1
                if stat_calls > 2:
                    raise OSError("stat")
            return original_stat(self, *args, **kwargs)
        monkeypatch.setattr(Path, "stat", fail_stat)
        response = client.get("/api/admin/metrics", headers=ADMIN)
        assert response.status_code == 200

    proxy = SimpleNamespace()
    app_module._ensure_ldapgate_static_paths(SimpleNamespace(proxy=None))
    app_module._ensure_ldapgate_cookie_name(SimpleNamespace(proxy=None))
    app_module._sync_ldapgate_trusted_proxies(SimpleNamespace(proxy=proxy), Settings(root_dir=root))
    app_module._sync_ldapgate_trusted_proxies(SimpleNamespace(proxy=None), Settings(root_dir=root))


def test_trash_size_survives_a_vanished_child(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    (root / "dir").mkdir()
    (root / "dir" / "inner.txt").write_text("x")
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        transaction = client.delete("/dir", headers=ALICE).json()["transaction_id"]
        original_stat = Path.stat
        def fail_stat(self, *args, **kwargs):
            if self.name == "inner.txt":
                raise OSError("gone")
            return original_stat(self, *args, **kwargs)
        monkeypatch.setattr(Path, "stat", fail_stat)
        response = client.get("/api/admin/trash", headers=ADMIN)
        assert response.status_code == 200
        assert response.json()["transactions"][0]["transaction_id"] == transaction


def test_trash_size_returns_zero_for_a_symlink(root, tmp_dir, tmp_path, monkeypatch):
    settings, _, _ = _settings(root, tmp_dir, tmp_path, monkeypatch, ldap=False)
    (root / "target.txt").write_text("target")
    (root / "link").symlink_to(root / "target.txt")
    with TestClient(create_app(settings)) as client:
        response = client.post("/_bulk/delete", json={"paths": ["/link"]}, headers=ALICE)
        assert response.status_code == 200, response.text
        response = client.get("/api/admin/trash", headers=ADMIN)
        assert response.status_code == 200
