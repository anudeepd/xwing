import os
import threading
import time
import webbrowser

from click.testing import CliRunner

from xwing import audit_store, cli


def _run(monkeypatch, tmp_path, *args, env=None):
    calls = []
    monkeypatch.setattr(cli.uvicorn, "run", lambda *a, **k: calls.append((a, k)))
    result = CliRunner().invoke(cli.main, list(args), env=env)
    return result, calls


def test_serve_removed_flags_and_log_file(monkeypatch, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    for flag in ("--read-users", "--write-users", "--admin-users"):
        result, _ = _run(monkeypatch, tmp_path, "serve", "--root", str(root), "--no-open", flag, "x")
        assert result.exit_code != 0
        assert "was removed" in result.output

    log = tmp_path / "logs" / "xwing.log"
    result, calls = _run(
        monkeypatch,
        tmp_path,
        "serve",
        "--root",
        str(root),
        "--no-open",
        "--log-file",
        str(log),
    )
    assert result.exit_code == 0, result.output
    assert log.exists()
    assert calls


def test_reload_exports_every_setting(monkeypatch, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    users = tmp_path / "users.yaml"
    users.write_text("users:\n  '*': rwd\n")
    ldap = tmp_path / "ldap.yaml"
    ldap.write_text("ldap: {}\n")
    audit = tmp_path / "audit.db"
    log = tmp_path / "xwing.log"
    monkeypatch.setattr(os, "environ", os.environ.copy())
    monkeypatch.setattr(threading.Thread, "start", lambda self: self.run())
    monkeypatch.setattr(time, "sleep", lambda seconds: None)
    opened = []
    monkeypatch.setattr(webbrowser, "open", lambda url: opened.append(url))
    result, _ = _run(
        monkeypatch,
        tmp_path,
        "serve",
        "--root",
        str(root),
        "--open",
        "--reload",
        "--max-upload-gb",
        "2",
        "--max-chunk-mb",
        "8",
        "--max-chunks",
        "9",
        "--session-ttl-minutes",
        "7",
        "--user-header",
        "X-User",
        "--trusted-auth-proxy",
        "127.0.0.1",
        "--users-config",
        str(users),
        "--ldap-config",
        str(ldap),
        "--admin-user",
        "admin",
        "--audit-db",
        str(audit),
        "--log-file",
        str(log),
    )
    assert result.exit_code == 0, result.output
    assert os.environ["XWING_MAX_UPLOAD_GB"] == "2.0"
    assert os.environ["XWING_MAX_CHUNK_MB"] == "8"
    assert os.environ["XWING_MAX_CHUNKS"] == "9"
    assert os.environ["XWING_SESSION_TTL_MINUTES"] == "7"
    assert os.environ["XWING_USER_HEADER"] == "X-User"
    assert os.environ["XWING_TRUSTED_AUTH_PROXIES"] == "127.0.0.1"
    assert os.environ["XWING_LDAP_CONFIG"] == str(ldap)
    assert os.environ["XWING_ADMIN_USERS"] == "admin"
    assert os.environ["XWING_AUDIT_DB"] == str(audit)
    assert os.environ["XWING_LOG_FILE"] == str(log)
    assert opened and opened[0].startswith("http://")


def test_serve_warns_without_users_config(monkeypatch, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    result, _ = _run(monkeypatch, tmp_path, "serve", "--root", str(root), "--no-open")
    assert result.exit_code == 0
    assert "all users are read-only" in result.output


def test_reload_without_users_config(monkeypatch, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    monkeypatch.delenv("XWING_USERS_CONFIG", raising=False)

    result, calls = _run(
        monkeypatch,
        tmp_path,
        "serve",
        "--root",
        str(root),
        "--reload",
        "--no-open",
    )

    assert result.exit_code == 0, result.output
    assert calls
    assert "XWING_USERS_CONFIG" not in os.environ


def test_audit_path_resolution_and_printing(monkeypatch, tmp_path):
    configured = tmp_path / "configured.db"
    monkeypatch.setenv("XWING_AUDIT_DB", str(configured))
    assert cli._audit_db_path(None) == configured
    monkeypatch.delenv("XWING_AUDIT_DB")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert cli._audit_db_path(None) == tmp_path / "xdg" / "xwing" / "audit.db"

    db = tmp_path / "audit.db"
    audit_store.init_db(db)
    audit_store.record_event(
        db_path=db,
        username="alice",
        method="PUT",
        path="/x",
        details="details",
        status_code=200,
        duration_ms=1,
    )
    audit_store.record_event(
        db_path=db,
        username="bob",
        method="DELETE",
        path="/y",
        details=None,
        status_code=200,
        duration_ms=1,
    )
    result = CliRunner().invoke(cli.main, ["audit", "--audit-db", str(db)])
    assert result.exit_code == 0
    assert "alice" in result.output
    assert "bob" in result.output
    assert "details" in result.output
