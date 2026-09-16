"""Xwing-side behaviour of the chunked upload protocol.

Protocol mechanics (range accounting, resume, TTL) are covered in
``test_upload_engine.py``; this file covers what xwing adds on top: init policy,
permission checks, session ownership and the on-disk result.
"""

import pytest
from fastapi.testclient import TestClient

from xwing.app import create_app
from xwing.config import Settings
from xwing.upload import LocalFileSink
from xwing.upload_engine import staging_name


def upload(client, name, body, dir="/", headers=None):
    """Drive one complete upload through the protocol and return the response."""
    init = client.post(
        "/_upload/init",
        json={"filename": name, "size": len(body), "dir": dir},
        headers=headers,
    )
    assert init.status_code == 200, init.text
    payload = init.json()
    if payload.get("ignored"):
        return payload
    upload_id = payload["upload_id"]
    put = client.put(
        f"/_upload/{upload_id}?offset=0", content=body, headers=headers
    )
    assert put.status_code == 200, put.text
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
            "/_upload/init", json={"filename": name, "size": 1, "dir": "/"}
        )
        assert response.status_code == 400

    def test_non_string_filename_rejected(self, client):
        response = client.post(
            "/_upload/init", json={"filename": 123, "size": 1, "dir": "/"}
        )
        assert response.status_code == 400

    @pytest.mark.parametrize("name", [".env", ".env.local", ".env."])
    def test_env_files_rejected(self, client, name):
        response = client.post(
            "/_upload/init", json={"filename": name, "size": 1, "dir": "/"}
        )
        assert response.status_code == 400
        assert "env" in response.json()["detail"].lower()

    @pytest.mark.parametrize(
        "name", [".DS_Store", "Thumbs.db", "desktop.ini", "._notes.txt"]
    )
    def test_os_metadata_files_are_ignored(self, client, root, name):
        response = client.post(
            "/_upload/init", json={"filename": name, "size": 1, "dir": "/"}
        )
        assert response.json() == {"ignored": True}
        assert not (root / name).exists()

    def test_missing_destination_rejected(self, client):
        response = client.post(
            "/_upload/init",
            json={"filename": "x.txt", "size": 1, "dir": "/nonexistent"},
        )
        assert response.status_code == 404

    def test_destination_that_is_a_file_rejected(self, client, root):
        (root / "file.txt").write_text("existing")
        response = client.post(
            "/_upload/init", json={"filename": "x.txt", "size": 1, "dir": "/file.txt"}
        )
        assert response.status_code == 404

    def test_traversal_destination_rejected(self, client):
        response = client.post(
            "/_upload/init",
            json={"filename": "x.txt", "size": 1, "dir": "/../outside"},
        )
        assert response.status_code == 403

    def test_encoded_destination_is_decoded(self, client, root):
        (root / "hash#dir?").mkdir()
        response = client.post(
            "/_upload/init",
            json={"filename": "x.txt", "size": 1, "dir": "/hash%23dir%3F/"},
        )
        assert response.status_code == 200


class TestUploadResults:
    def test_upload_replaces_the_file_atomically(self, client, root):
        (root / "doc.txt").write_bytes(b"old contents")
        result = upload(client, "doc.txt", b"new contents")
        assert result["path"] == "doc.txt"
        assert (root / "doc.txt").read_bytes() == b"new contents"

    def test_zero_byte_upload_publishes_an_empty_file(self, client, root):
        result = upload(client, "empty.txt", b"")
        assert result["size"] == 0
        assert (root / "empty.txt").read_bytes() == b""

    def test_multi_gigabyte_shaped_upload_assembles_from_ranges(self, client, root):
        # Two out-of-order ranged writes plus a resend of an already-committed
        # range: exactly the pattern a stalled chunk produces in the browser.
        size = 4096
        init = client.post(
            "/_upload/init", json={"filename": "big.bin", "size": size, "dir": "/"}
        ).json()
        upload_id = init["upload_id"]
        assert init["size"] == size

        second = b"b" * (size // 2)
        first = b"a" * (size // 2)
        assert client.put(
            f"/_upload/{upload_id}?offset={size // 2}", content=second
        ).status_code == 200
        assert client.put(f"/_upload/{upload_id}?offset=0", content=first).status_code == 200
        assert client.put(f"/_upload/{upload_id}?offset=0", content=first).status_code == 200

        assert client.post(f"/_upload/{upload_id}/complete").status_code == 200
        assert (root / "big.bin").read_bytes() == first + second

    def test_cancelled_upload_leaves_no_staging_file(self, client, root):
        upload_id = client.post(
            "/_upload/init", json={"filename": "gone.bin", "size": 8, "dir": "/"}
        ).json()["upload_id"]
        client.put(f"/_upload/{upload_id}?offset=0", content=b"partial")
        assert list(root.glob("*gone.bin*")), "staging file should exist mid-upload"

        client.delete(f"/_upload/{upload_id}")

        assert not (root / "gone.bin").exists()
        assert not list(root.glob("*gone.bin*"))

    def test_staging_file_is_hidden_from_directory_listings(self, client, root):
        upload_id = client.post(
            "/_upload/init", json={"filename": "busy.bin", "size": 8, "dir": "/"}
        ).json()["upload_id"]
        client.put(f"/_upload/{upload_id}?offset=0", content=b"in flight")

        assert list(root.iterdir()), "staging file should exist on disk"
        listing = client.get("/")
        assert "busy.bin" not in listing.text


class TestUploadAuth:
    def test_init_blocked_when_require_auth(self, root, tmp_dir):
        settings = Settings(root_dir=root, tmp_dir=tmp_dir, require_auth=True)
        with TestClient(create_app(settings)) as c:
            response = c.post(
                "/_upload/init", json={"filename": "x.txt", "size": 1, "dir": "/"}
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
                json={"filename": "x.txt", "size": 1, "dir": "/"},
                headers={"X-Forwarded-User": "alice"},
            )
        assert response.status_code == 200

    def test_write_blocked_when_require_auth(self, root, tmp_dir):
        settings = Settings(root_dir=root, tmp_dir=tmp_dir, require_auth=True)
        with TestClient(create_app(settings)) as c:
            assert c.put("/_upload/" + "a" * 32 + "?offset=0", content=b"x").status_code == 403
            assert c.post("/_upload/" + "a" * 32 + "/complete").status_code == 403
            assert c.get("/_upload/" + "a" * 32).status_code == 403


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
        upload_id = alice_only.post(
            "/_upload/init",
            json={"filename": "x.txt", "size": 8, "dir": "/"},
            headers=alice,
        ).json()["upload_id"]

        put = alice_only.put(
            f"/_upload/{upload_id}?offset=0", content=b"attacker", headers=bob
        )
        assert put.status_code == 403

    def test_another_user_cannot_complete_the_session(self, alice_only):
        alice = {"X-Forwarded-User": "alice"}
        bob = {"X-Forwarded-User": "bob"}
        upload_id = alice_only.post(
            "/_upload/init",
            json={"filename": "x.txt", "size": 4, "dir": "/"},
            headers=alice,
        ).json()["upload_id"]
        alice_only.put(f"/_upload/{upload_id}?offset=0", content=b"data", headers=alice)

        done = alice_only.post(f"/_upload/{upload_id}/complete", headers=bob)
        assert done.status_code == 403


class TestStaleSessionCleanup:
    @pytest.mark.asyncio
    async def test_sweep_removes_staged_bytes_of_an_abandoned_upload(
        self, settings, root
    ):
        from xwing.upload import build_upload_store
        from xwing.upload_engine import UploadTarget

        store = build_upload_store(settings)
        sink = LocalFileSink(
            root / staging_name("abandoned.bin", "a" * 32), root / "abandoned.bin"
        )
        session = await store.register(
            UploadTarget(
                session_id="a" * 32,
                user=None,
                directory=str(root),
                filename="abandoned.bin",
                size=1024,
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
