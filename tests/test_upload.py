"""X-wing-specific upload behaviour on top of the durable engine."""

from __future__ import annotations

import hashlib
import uuid

import pytest
from fastapi.testclient import TestClient

from xwing.app import create_app
from xwing.config import Settings
from xwing.upload import LocalFileSink
from xwing.upload_engine import UploadTarget, staging_name


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def init_upload(
    client: TestClient,
    name: str,
    size: int,
    *,
    directory: str = "/",
    headers: dict[str, str] | None = None,
    upload_key: str | None = None,
) -> dict:
    response = client.post(
        "/_upload/init",
        json={
            "upload_key": upload_key or uuid.uuid4().hex,
            "filename": name,
            "size": size,
            "dir": directory,
            "fingerprint": {"name": name, "size": size, "last_modified": 1},
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def send_chunk(
    client: TestClient,
    upload_id: str,
    offset: int,
    body: bytes,
    *,
    headers: dict[str, str] | None = None,
):
    return client.post(
        f"/_upload/{upload_id}/chunk",
        params={
            "offset": offset,
            "sha256": digest(body),
            "length": len(body),
        },
        content=body,
        headers={"Content-Type": "application/octet-stream", **(headers or {})},
    )


def upload(
    client: TestClient,
    name: str,
    body: bytes,
    directory: str = "/",
    headers: dict[str, str] | None = None,
) -> dict:
    """Drive one complete upload through the protocol and return the response."""
    init = init_upload(
        client,
        name,
        len(body),
        directory=directory,
        headers=headers,
    )
    if init.get("ignored"):
        return init
    upload_id = init["upload_id"]
    if body:
        chunk = send_chunk(client, upload_id, 0, body, headers=headers)
        assert chunk.status_code == 200, chunk.text
    done = client.post(f"/_upload/{upload_id}/complete", headers=headers)
    assert done.status_code == 200, done.text
    return done.json()


class TestInitPolicy:
    def test_filename_traversal_is_stripped(self, client, root):
        result = upload(client, "../../evil.txt", b"payload")
        assert result["path"] == "evil.txt"
        assert (root / "evil.txt").read_bytes() == b"payload"

    @pytest.mark.parametrize("name", ["/", ".", ".."])
    def test_empty_and_directory_names_rejected(self, client, name):
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "invalid-name-key",
                "filename": name,
                "size": 1,
                "dir": "/",
            },
        )
        assert response.status_code == 400

    def test_non_string_filename_rejected(self, client):
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "bad-filename-key",
                "filename": 123,
                "size": 1,
                "dir": "/",
            },
        )
        assert response.status_code == 400

    @pytest.mark.parametrize("name", [".env", ".env.local", ".env."])
    def test_env_files_rejected(self, client, name):
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "env-key-1234",
                "filename": name,
                "size": 1,
                "dir": "/",
            },
        )
        assert response.status_code == 400
        assert "env" in response.text.lower()

    @pytest.mark.parametrize(
        "name", [".DS_Store", "Thumbs.db", "desktop.ini", "._notes.txt"]
    )
    def test_os_metadata_files_are_ignored(self, client, root, name):
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "metadata-key-1234",
                "filename": name,
                "size": 1,
                "dir": "/",
            },
        )
        assert response.json() == {"ignored": True}
        assert not (root / name).exists()

    def test_missing_destination_rejected(self, client):
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "missing-dir-key",
                "filename": "x.txt",
                "size": 1,
                "dir": "/nonexistent",
            },
        )
        assert response.status_code == 404

    def test_destination_that_is_a_file_rejected(self, client, root):
        (root / "file.txt").write_text("existing")
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "file-dest-key",
                "filename": "x.txt",
                "size": 1,
                "dir": "/file.txt",
            },
        )
        assert response.status_code == 404

    def test_traversal_destination_rejected(self, client):
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "traversal-key",
                "filename": "x.txt",
                "size": 1,
                "dir": "/../outside",
            },
        )
        assert response.status_code == 403

    def test_encoded_destination_is_decoded(self, client, root):
        (root / "hash#dir?").mkdir()
        response = client.post(
            "/_upload/init",
            json={
                "upload_key": "encoded-key-1234",
                "filename": "x.txt",
                "size": 1,
                "dir": "/hash%23dir%3F/",
            },
        )
        assert response.status_code == 200

    def test_state_directory_is_hidden(self, client, root):
        response = client.get("/", headers={"Accept": "text/html"})
        assert response.status_code == 200
        assert ".xwing-uploads" not in response.text
        assert (root / ".xwing-uploads").is_dir()


class TestUploadResults:
    def test_upload_replaces_the_file_atomically(self, client, root):
        (root / "doc.txt").write_bytes(b"old contents")
        result = upload(client, "doc.txt", b"new contents")
        assert result["path"] == "doc.txt"
        assert result["verified"] is True
        assert (root / "doc.txt").read_bytes() == b"new contents"

    def test_zero_byte_upload_publishes_an_empty_file(self, client, root):
        result = upload(client, "empty.txt", b"")
        assert result["size"] == 0
        assert (root / "empty.txt").read_bytes() == b""

    def test_multi_gigabyte_shaped_upload_assembles_from_ranges(self, client, root):
        size = 4096
        init = init_upload(client, "big.bin", size)
        upload_id = init["upload_id"]

        second = b"b" * (size // 2)
        first = b"a" * (size // 2)
        assert send_chunk(client, upload_id, size // 2, second).status_code == 200
        assert send_chunk(client, upload_id, 0, first).status_code == 200
        assert send_chunk(client, upload_id, 0, first).status_code == 200

        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200
        assert (root / "big.bin").read_bytes() == first + second

    def test_cancelled_upload_leaves_no_staging_file(self, client, root):
        upload_id = init_upload(client, "gone.bin", 8)["upload_id"]
        client.post(
            f"/_upload/{upload_id}/chunk",
            params={"offset": 0, "sha256": digest(b"partial"), "length": 7},
            content=b"partial",
        )
        assert list(root.glob("*gone.bin*")), "staging file should exist mid-upload"

        client.delete(f"/_upload/{upload_id}")

        assert not (root / "gone.bin").exists()
        assert not list(root.glob("*gone.bin*"))
        assert not list((root / ".xwing-uploads").glob(f"{upload_id}*"))

    def test_legacy_v1_put_is_rejected_before_the_webdav_catch_all(self, client, root):
        upload_id = init_upload(client, "legacy.bin", 4)["upload_id"]
        response = client.put(
            f"/_upload/{upload_id}",
            params={"offset": 0},
            content=b"abcd",
        )

        assert response.status_code == 410
        assert response.json()["detail"]["code"] == "LEGACY_UPLOAD_REMOVED"
        assert not (root / "_upload").exists()
        assert not (root / upload_id).exists()

    def test_staging_file_is_hidden_from_directory_listings(self, client, root):
        upload_id = init_upload(client, "busy.bin", 9)["upload_id"]
        client.post(
            f"/_upload/{upload_id}/chunk",
            params={"offset": 0, "sha256": digest(b"in flight"), "length": 9},
            content=b"in flight",
        )

        assert list(root.glob("*busy.bin*")), "staging file should exist on disk"
        listing = client.get("/")
        assert "busy.bin" not in listing.text

    def test_resume_survives_an_app_restart(self, root, tmp_dir):
        users = tmp_dir / "users.yaml"
        users.write_text('users:\n  "*": rwd\n')
        settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users)
        key = "restart-resume-key"
        first = b"a" * 4
        second = b"b" * 4

        with TestClient(create_app(settings)) as client:
            init = init_upload(client, "resume.bin", 8, upload_key=key)
            upload_id = init["upload_id"]
            assert send_chunk(client, upload_id, 0, first).status_code == 200

        with TestClient(create_app(settings)) as client:
            resumed = init_upload(client, "resume.bin", 8, upload_key=key)
            assert resumed["upload_id"] == upload_id
            assert resumed["ranges"] == [[0, 4]]
            assert send_chunk(client, upload_id, 4, second).status_code == 200
            assert client.post(f"/_upload/{upload_id}/complete").status_code == 200

        assert (root / "resume.bin").read_bytes() == first + second

    def test_completed_tombstone_survives_an_app_restart(self, root, tmp_dir):
        users = tmp_dir / "users.yaml"
        users.write_text('users:\n  "*": rwd\n')
        settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users)
        key = "completed-restart-key"

        with TestClient(create_app(settings)) as client:
            init = init_upload(client, "done.bin", 4, upload_key=key)
            upload_id = init["upload_id"]
            assert send_chunk(client, upload_id, 0, b"done").status_code == 200
            assert client.post(f"/_upload/{upload_id}/complete").status_code == 200

        with TestClient(create_app(settings)) as client:
            resumed = init_upload(client, "done.bin", 4, upload_key=key)
            assert resumed["upload_id"] == upload_id
            assert resumed["state"] == "complete"
            assert resumed["path"] == "done.bin"
            again = client.post(f"/_upload/{upload_id}/complete")
            assert again.status_code == 200
            assert again.json()["verified"] is True


class TestUploadAuth:
    def test_init_blocked_when_require_auth(self, root, tmp_dir):
        settings = Settings(root_dir=root, tmp_dir=tmp_dir, require_auth=True)
        with TestClient(create_app(settings)) as c:
            response = c.post(
                "/_upload/init",
                json={
                    "upload_key": "auth-key-1234",
                    "filename": "x.txt",
                    "size": 1,
                    "dir": "/",
                },
            )
        assert response.status_code == 403

    def test_init_allowed_with_user_header(self, root, tmp_dir, users_yaml):
        settings = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            require_auth=True,
            users_config=users_yaml,
            trusted_auth_proxies=["testclient"],
        )
        with TestClient(create_app(settings)) as c:
            response = c.post(
                "/_upload/init",
                json={
                    "upload_key": "auth-key-5678",
                    "filename": "x.txt",
                    "size": 1,
                    "dir": "/",
                },
                headers={"X-Forwarded-User": "alice"},
            )
        assert response.status_code == 200

    def test_write_blocked_when_require_auth(self, root, tmp_dir):
        settings = Settings(root_dir=root, tmp_dir=tmp_dir, require_auth=True)
        with TestClient(create_app(settings)) as c:
            assert c.post(
                f"/_upload/{'a' * 32}/chunk",
                params={"offset": 0, "sha256": "0" * 64},
                content=b"x",
            ).status_code == 403
            assert c.post(f"/_upload/{'a' * 32}/complete").status_code == 403
            assert c.get(f"/_upload/{'a' * 32}").status_code == 403


class TestSessionIsolation:
    @pytest.fixture
    def alice_only(self, root, tmp_dir, tmp_path):
        users_yaml = tmp_path / "users.yaml"
        users_yaml.write_text(
            "users:\n  alice:\n    read: true\n    write: true\n    delete: true\n"
        )
        settings = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            require_auth=True,
            users_config=users_yaml,
            trusted_auth_proxies=["testclient"],
        )
        with TestClient(create_app(settings)) as c:
            yield c

    def test_another_user_cannot_write_to_the_session(self, alice_only):
        alice = {"X-Forwarded-User": "alice"}
        bob = {"X-Forwarded-User": "bob"}
        upload_id = init_upload(
            alice_only,
            "x.txt",
            8,
            headers=alice,
        )["upload_id"]

        response = send_chunk(alice_only, upload_id, 0, b"attacker", headers=bob)
        assert response.status_code == 403

    def test_another_user_cannot_complete_the_session(self, alice_only):
        alice = {"X-Forwarded-User": "alice"}
        bob = {"X-Forwarded-User": "bob"}
        upload_id = init_upload(
            alice_only,
            "x.txt",
            4,
            headers=alice,
        )["upload_id"]
        send_chunk(alice_only, upload_id, 0, b"data", headers=alice)

        done = alice_only.post(f"/_upload/{upload_id}/complete", headers=bob)
        assert done.status_code == 403


class TestStaleSessionCleanup:
    @pytest.mark.asyncio
    async def test_sweep_removes_staged_bytes_of_an_abandoned_upload(
        self, settings, root
    ):
        from xwing.upload import build_upload_store

        store = build_upload_store(settings)
        staged = root / staging_name("abandoned.bin", "a" * 32)
        sink = LocalFileSink(staged, root / "abandoned.bin")
        session = await store.register(
            UploadTarget(
                session_id="a" * 32,
                user=None,
                directory=str(root),
                filename="abandoned.bin",
                size=1024,
                staged_path=staged,
                upload_key="abandoned-key",
            ),
            user=None,
        )
        session.sink = sink
        await sink.write_at(0, b"half written")

        assert list(root.glob("*abandoned.bin*"))
        store.ttl_seconds = 0
        assert await store.sweep() == 1
        assert not list(root.glob("*abandoned.bin*"))


class TestUploadAudit:
    def test_completed_upload_audits_the_final_path(self, root, tmp_dir, users_yaml, tmp_path):
        from xwing import audit_store

        db_path = tmp_path / "audit.db"
        settings = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            users_config=users_yaml,
            require_auth=True,
            trusted_auth_proxies=["testclient"],
            audit_db=db_path,
        )
        headers = {"X-Forwarded-User": "alice"}
        with TestClient(create_app(settings)) as c:
            result = upload(c, "final.txt", b"hello", headers=headers)
        assert result["path"] == "final.txt"

        events = audit_store.list_events(db_path, username="alice")
        assert [event["path"] for event in events] == ["/final.txt"]


class TestLdapBodyLimit:
    """ldapgate 413s any request over proxy.max_body_size before the router runs."""

    def _stub_ldapgate(self, monkeypatch, max_body_size):
        import sys
        import types

        pkg = types.ModuleType("ldapgate")
        config_mod = types.ModuleType("ldapgate.config")
        middleware_mod = types.ModuleType("ldapgate.middleware")
        proxy = types.SimpleNamespace(static_paths=[], max_body_size=max_body_size)
        config = types.SimpleNamespace(proxy=proxy)
        config_mod.load_config = lambda path: config
        middleware_mod.add_ldap_auth = lambda app, cfg, template_path=None: None
        monkeypatch.setitem(sys.modules, "ldapgate", pkg)
        monkeypatch.setitem(sys.modules, "ldapgate.config", config_mod)
        monkeypatch.setitem(sys.modules, "ldapgate.middleware", middleware_mod)

    def _window(self, root, tmp_dir):
        ldap_yaml = tmp_dir / "ldapgate.yaml"
        ldap_yaml.write_text("ldap: {}\nproxy: {}\n")
        users_yaml = tmp_dir / "users.yaml"
        users_yaml.write_text(
            "users:\n  alice:\n    read: true\n    write: true\n    delete: true\n"
        )
        settings = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            ldap_config=ldap_yaml,
            users_config=users_yaml,
            require_auth=True,
            trusted_auth_proxies=["testclient"],
        )
        with TestClient(create_app(settings)) as c:
            init = c.post(
                "/_upload/init",
                json={
                    "upload_key": "ldap-window-key",
                    "filename": "a.bin",
                    "size": 1,
                    "dir": "/",
                },
                headers={"X-Forwarded-User": "alice"},
            )
        assert init.status_code == 200, init.text
        return settings, init.json()["chunk_policy"]["max_bytes"]

    def test_window_is_capped_at_the_gateway_body_limit(
        self, root, tmp_dir, monkeypatch
    ):
        self._stub_ldapgate(monkeypatch, 10 * 1024 * 1024)
        settings, window = self._window(root, tmp_dir)
        assert settings.max_chunk_bytes == 10 * 1024 * 1024
        assert window == 10 * 1024 * 1024

    def test_window_is_kept_when_the_gateway_allows_it(
        self, root, tmp_dir, monkeypatch
    ):
        self._stub_ldapgate(monkeypatch, 128 * 1024 * 1024)
        settings, window = self._window(root, tmp_dir)
        assert settings.max_chunk_bytes == 16 * 1024 * 1024
        assert window == 16 * 1024 * 1024


class TestAbandonedStaging:
    """A crash leaves staging files nobody tracks; listing reaps the stale ones."""

    SESSION_ID = "0123456789abcdef0123456789abcdef"

    def _age(self, path, seconds):
        import os
        import time

        old = time.time() - seconds
        os.utime(path, (old, old))

    def test_stale_staging_file_is_removed_and_a_live_one_kept(self, client, root):
        stale = root / f".old.bin.upload-part-{self.SESSION_ID}"
        live = root / f".live.bin.upload-part-{'b' * 32}"
        lookalike = root / ".notes.upload-part-backup"
        for path in (stale, live, lookalike):
            path.write_bytes(b"x")
        self._age(stale, 7 * 3600)
        self._age(lookalike, 7 * 3600)

        assert client.get("/", headers={"Accept": "text/html"}).status_code == 200

        assert not stale.exists()
        assert live.exists()
        assert lookalike.exists()


def test_diagnostics_report_is_bounded_and_admin_readable(client):
    created = client.post(
        "/_upload/diagnostics",
        json={
            "event": "failed",
            "filename": "secret.txt",
            "message": "The proxy dropped the upload request",
            "transport": "binary_post",
            "protocol": "h2",
            "nested": {"not": "kept"},
        },
    )
    assert created.status_code == 200
    assert created.json() == {"ok": True}
    # The default test user is not an admin.
    assert client.get("/_upload/diagnostics").status_code == 403


def test_admin_can_read_upload_diagnostics(root, tmp_dir, users_yaml):
    settings = Settings(
        root_dir=root,
        tmp_dir=tmp_dir,
        users_config=users_yaml,
        require_auth=True,
        trusted_auth_proxies=["testclient"],
        admin_users=["alice"],
    )
    headers = {"X-Forwarded-User": "alice"}
    with TestClient(create_app(settings)) as c:
        assert c.post(
            "/_upload/diagnostics",
            json={
                "event": "failed",
                "transport": "binary_post",
                "code": "TRANSPORT_DROPPED",
            },
            headers=headers,
        ).status_code == 200
        response = c.get("/_upload/diagnostics", headers=headers)
    assert response.status_code == 200
    assert response.json()["reports"][0]["code"] == "TRANSPORT_DROPPED"
