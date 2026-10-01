"""Regression tests for the backend hardening pass (WebDAV safety, hidden
internals, listing resilience, symlinks, zip, headers, file modes, ...)."""

import asyncio
import io
import json
import os
import sys
import types
import zipfile

import pytest

from xwing import audit_store
from xwing.app import _ReleasingStreamingResponse, create_app
from xwing.config import Settings

from conftest import TestClient
from test_upload import upload

HTML = {"Accept": "text/html"}
DIR_JSON = {"Accept": "application/vnd.xwing.directory+json"}


def make_client(root, tmp_dir, tmp_path, perms="rwd", *, raise_exc=True, **kwargs):
    users = tmp_path / f"users-{perms or 'none'}.yaml"
    users.write_text(f'users:\n  "*": "{perms}"\n')
    settings = Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users, **kwargs)
    return TestClient(create_app(settings), raise_server_exceptions=raise_exc)


def read_asgi(app, method, path, *, query=b"", messages=(), headers=(), send=None):
    """Drive one request through the ASGI app; return (status, body)."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": query,
        "headers": [(b"host", b"testserver"), *headers],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "scheme": "http",
        "root_path": "",
    }
    pending = list(messages)
    sent: list[dict] = []

    async def receive():
        if pending:
            return pending.pop(0)
        await asyncio.Event().wait()

    async def default_send(message):
        sent.append(message)

    async def run():
        await app(scope, receive, send or default_send)

    asyncio.run(asyncio.wait_for(run(), 10))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body


# ── B01: COPY / MOVE destination safety ──────────────────────────────────────


class TestTransferDestination:
    @pytest.mark.parametrize("verb", ["COPY", "MOVE"])
    def test_served_root_is_refused(self, client, root, verb):
        (root / "hello.txt").write_text("hi")
        r = client.request(verb, "/hello.txt", headers={"Destination": "/"})
        assert r.status_code == 403
        assert root.is_dir()
        assert (root / "hello.txt").read_text() == "hi"

    @pytest.mark.parametrize("verb", ["COPY", "MOVE"])
    def test_ancestor_of_source_is_refused(self, client, root, verb):
        (root / "a").mkdir()
        (root / "a" / "b.txt").write_text("b")
        r = client.request(verb, "/a/b.txt", headers={"Destination": "/a"})
        assert r.status_code == 403
        assert (root / "a" / "b.txt").read_text() == "b"

    @pytest.mark.parametrize("verb", ["COPY", "MOVE"])
    def test_source_onto_itself_is_refused(self, client, root, verb):
        (root / "x.txt").write_text("x")
        r = client.request(verb, "/x.txt", headers={"Destination": "/x.txt"})
        assert r.status_code == 403
        assert (root / "x.txt").read_text() == "x"

    @pytest.mark.parametrize("verb", ["COPY", "MOVE"])
    def test_directory_into_itself_is_refused(self, client, root, verb):
        (root / "d" / "sub").mkdir(parents=True)
        (root / "d" / "f.txt").write_text("f")
        for dest in ("/d/sub", "/d/new"):
            r = client.request(verb, "/d", headers={"Destination": dest})
            assert r.status_code == 403, dest
        assert (root / "d" / "f.txt").read_text() == "f"
        assert not (root / "d" / "new").exists()

    @pytest.mark.parametrize("verb", ["COPY", "MOVE"])
    def test_missing_parent_is_409(self, client, root, verb):
        (root / "x.txt").write_text("x")
        r = client.request(verb, "/x.txt", headers={"Destination": "/nodir/x.txt"})
        assert r.status_code == 409
        assert (root / "x.txt").read_text() == "x"

    @pytest.mark.parametrize("verb", ["COPY", "MOVE"])
    def test_file_as_destination_ancestor_is_409(self, client, root, verb):
        (root / "x.txt").write_text("x")
        (root / "plain.txt").write_text("p")
        r = client.request(verb, "/x.txt", headers={"Destination": "/plain.txt/x.txt"})
        assert r.status_code == 409

    def test_copy_overwrite_requires_delete(self, root, tmp_dir, tmp_path):
        (root / "src.txt").write_text("new")
        (root / "dst.txt").write_text("old")
        with make_client(root, tmp_dir, tmp_path, "rw") as rw:
            r = rw.request("COPY", "/src.txt", headers={"Destination": "/dst.txt"})
            assert r.status_code == 403
            assert (root / "dst.txt").read_text() == "old"
            # A fresh destination only needs write.
            r = rw.request("COPY", "/src.txt", headers={"Destination": "/fresh.txt"})
            assert r.status_code == 201
            # Overwrite: F never replaces, so it keeps answering 412.
            r = rw.request(
                "COPY",
                "/src.txt",
                headers={"Destination": "/dst.txt", "Overwrite": "F"},
            )
            assert r.status_code == 412

    @pytest.mark.parametrize("verb", ["COPY", "MOVE"])
    def test_replaced_destination_goes_to_undoable_trash(self, client, root, verb):
        (root / "src.txt").write_text("new")
        (root / "dst").mkdir()
        (root / "dst" / "old.txt").write_text("old")
        r = client.request(verb, "/src.txt", headers={"Destination": "/dst"})
        # Something was replaced: 204, not 201.
        assert r.status_code == 204
        assert (root / "dst").read_text() == "new"
        assert not [p for p in root.iterdir() if p.name.endswith(".bak")]
        index = json.loads((root / ".xwing-trash" / ".index.json").read_text())
        assert len(index) == 1 and index[0]["items"][0]["original"] == "/dst"
        restored = client.post(f"/api/restore/{index[0]['transaction_id']}")
        assert restored.status_code == 200
        assert (root / "dst (restored)" / "old.txt").read_text() == "old"

    def test_move_to_fresh_name_is_201(self, client, root):
        (root / "a.txt").write_text("a")
        r = client.request("MOVE", "/a.txt", headers={"Destination": "/b.txt"})
        assert r.status_code == 201


# ── B05: internal paths are hidden on every verb ────────────────────────────


@pytest.fixture
def internal_client(root, tmp_dir, tmp_path, monkeypatch):
    """App whose tmp dir, trash, users, ldap and audit files live in the root."""
    users = root / "users.yaml"
    users.write_text('users:\n  "*": rwd\n')
    ldap_yaml = root / "ldap.yaml"
    ldap_yaml.write_text("secret: ldap-secret\n")
    ldapgate_pkg = types.ModuleType("ldapgate")
    config_mod = types.ModuleType("ldapgate.config")
    middleware_mod = types.ModuleType("ldapgate.middleware")
    config_mod.load_config = lambda path: types.SimpleNamespace(
        proxy=types.SimpleNamespace(
            static_paths=[],
            idle_timeout=0,
            trusted_proxies=[],
            session_cookie_name="ldapgate_session",
        ),
        ldap=types.SimpleNamespace(allowed_users=[]),
    )
    middleware_mod.add_ldap_auth = lambda app, config, template_path=None: None
    monkeypatch.setitem(sys.modules, "ldapgate", ldapgate_pkg)
    monkeypatch.setitem(sys.modules, "ldapgate.config", config_mod)
    monkeypatch.setitem(sys.modules, "ldapgate.middleware", middleware_mod)
    settings = Settings(
        root_dir=root,
        tmp_dir=tmp_dir,
        users_config=users,
        ldap_config=ldap_yaml,
        audit_db=root / "audit.db",
    )
    (tmp_dir / "staging.bin").write_text("tmp-secret")
    (root / ".xwing-trash").mkdir()
    (root / ".xwing-trash" / "deleted.txt").write_text("trash-secret")
    (root / "hello.txt").write_text("hello")
    with TestClient(create_app(settings)) as c:
        yield c


INTERNAL_FILES = {
    "tmp": "/tmp/staging.bin",
    "trash": "/.xwing-trash/deleted.txt",
    "users": "/users.yaml",
    "ldap": "/ldap.yaml",
    "audit": "/audit.db",
}


class TestInternalPathsHidden:
    @pytest.mark.parametrize("which", INTERNAL_FILES)
    def test_get_put_delete_are_404(self, internal_client, root, which):
        path = INTERNAL_FILES[which]
        target = root / path.lstrip("/")
        before = target.read_bytes()
        assert internal_client.get(path).status_code == 404
        assert internal_client.head(path).status_code == 404
        assert internal_client.put(path, content=b"pwned").status_code == 404
        assert internal_client.delete(path).status_code == 404
        assert internal_client.request("PROPFIND", path).status_code == 404
        assert internal_client.request("MKCOL", path).status_code == 404
        assert target.read_bytes() == before

    @pytest.mark.parametrize("which", INTERNAL_FILES)
    def test_destination_header_is_404(self, internal_client, root, which):
        path = INTERNAL_FILES[which]
        target = root / path.lstrip("/")
        before = target.read_bytes()
        for verb in ("COPY", "MOVE"):
            r = internal_client.request(
                verb, "/hello.txt", headers={"Destination": path, "Overwrite": "T"}
            )
            assert r.status_code == 404, (verb, r.text)
        assert target.read_bytes() == before
        assert (root / "hello.txt").read_text() == "hello"

    @pytest.mark.parametrize("which", INTERNAL_FILES)
    def test_as_copy_move_source_is_404(self, internal_client, root, which):
        path = INTERNAL_FILES[which]
        for verb in ("COPY", "MOVE"):
            r = internal_client.request(
                verb, path, headers={"Destination": "/leak.txt"}
            )
            assert r.status_code == 404
        assert not (root / "leak.txt").exists()

    @pytest.mark.parametrize("which", INTERNAL_FILES)
    def test_bulk_endpoints_are_404(self, internal_client, root, which):
        path = INTERNAL_FILES[which]
        target = root / path.lstrip("/")
        assert (
            internal_client.post("/_bulk/delete", json={"paths": [path]}).status_code
            == 404
        )
        assert (
            internal_client.post("/_bulk/zip", json={"paths": [path]}).status_code
            == 404
        )
        assert target.exists()

    def test_upload_into_trash_dir_is_404(self, internal_client, root):
        r = internal_client.post(
            "/_upload/init", json={"filename": "x.txt", "size": 1, "dir": "/.xwing-trash/"}
        )
        assert r.status_code == 404
        r = internal_client.post(
            "/_upload/init", json={"filename": "x.txt", "size": 1, "dir": "/tmp/"}
        )
        assert r.status_code == 404
        assert not (root / ".xwing-trash" / "x.txt").exists()

    def test_upload_over_users_config_is_404(self, internal_client, root):
        before = (root / "users.yaml").read_text()
        r = internal_client.post(
            "/_upload/init", json={"filename": "users.yaml", "size": 1, "dir": "/"}
        )
        assert r.status_code == 404
        assert (root / "users.yaml").read_text() == before

    def test_ordinary_files_still_work(self, internal_client):
        assert internal_client.get("/hello.txt").text == "hello"


# ── B04: listing resilience ─────────────────────────────────────────────────


def _make_bad_entries(root):
    (root / "good.txt").write_text("ok")
    (root / "broken").symlink_to(root / "nowhere")
    with open(os.fsencode(root) + b"/caf\xe9.txt", "wb") as handle:
        handle.write(b"latin1")


class TestListingResilience:
    def test_json_listing_keeps_good_entries(self, client, root):
        _make_bad_entries(root)
        r = client.get("/", headers=DIR_JSON)
        assert r.status_code == 200
        names = {item["name"] for item in r.json()["files"]}
        assert "good.txt" in names
        assert "broken" in names

    def test_html_listing(self, client, root):
        _make_bad_entries(root)
        r = client.get("/", headers=HTML)
        assert r.status_code == 200
        assert "good.txt" in r.text

    def test_propfind(self, client, root):
        _make_bad_entries(root)
        r = client.request("PROPFIND", "/", headers={"Depth": "1"})
        assert r.status_code == 207
        assert "good.txt" in r.text

    def test_folder_zip_and_bulk_zip(self, client, root):
        _make_bad_entries(root)
        (root / "sub").mkdir()
        (root / "sub" / "good.txt").write_text("ok")
        with open(os.fsencode(root) + b"/sub/caf\xe9.txt", "wb") as handle:
            handle.write(b"latin1")
        r = client.get("/sub/?zip")
        assert r.status_code == 200
        assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["good.txt"]
        r = client.post("/_bulk/zip", json={"paths": ["/sub/"], "base": "/"})
        assert r.status_code == 200
        assert "sub/good.txt" in zipfile.ZipFile(io.BytesIO(r.content)).namelist()

    def test_unexpected_error_is_styled_and_leaks_no_paths(
        self, root, tmp_dir, tmp_path, monkeypatch
    ):
        def boom(*args, **kwargs):
            raise RuntimeError(f"secret location {root}")

        monkeypatch.setattr("xwing.app.list_dir", boom)
        with make_client(root, tmp_dir, tmp_path, raise_exc=False) as c:
            page = c.get("/", headers=HTML)
            assert page.status_code == 500
            assert "text/html" in page.headers["content-type"]
            assert str(root) not in page.text
            api = c.get("/", headers=DIR_JSON)
            assert api.status_code == 500
            assert api.json() == {"detail": "Internal Server Error"}


# ── B03: symlink semantics ──────────────────────────────────────────────────


class TestSymlinks:
    def test_delete_removes_the_link_not_the_target(self, client, root):
        (root / "hello.txt").write_text("hi")
        (root / "link").symlink_to(root / "hello.txt")
        assert client.delete("/link").status_code == 200
        assert not (root / "link").is_symlink()
        assert (root / "hello.txt").read_text() == "hi"
        # The listing must not turn into a 500.
        assert client.get("/", headers=DIR_JSON).status_code == 200

    def test_delete_dangling_link(self, client, root):
        (root / "dangling").symlink_to(root / "gone")
        assert client.delete("/dangling").status_code == 200
        assert not (root / "dangling").is_symlink()

    def test_bulk_delete_removes_the_link_not_the_folder(self, client, root):
        (root / "docs").mkdir()
        (root / "docs" / "a.txt").write_text("a")
        (root / "docs-link").symlink_to(root / "docs")
        r = client.post("/_bulk/delete", json={"paths": ["/docs-link/"]})
        assert r.status_code == 200
        assert not (root / "docs-link").is_symlink()
        assert (root / "docs" / "a.txt").read_text() == "a"

    def test_bulk_delete_link_and_folder_child_both_deleted(self, client, root):
        (root / "docs").mkdir()
        (root / "docs" / "a.txt").write_text("a")
        (root / "docs-link").symlink_to(root / "docs")
        r = client.post(
            "/_bulk/delete", json={"paths": ["/docs-link", "/docs/a.txt"]}
        )
        assert r.status_code == 200 and r.json()["count"] == 2
        assert not (root / "docs" / "a.txt").exists()

    def test_move_renames_the_link(self, client, root):
        (root / "hello.txt").write_text("hi")
        (root / "link").symlink_to(root / "hello.txt")
        r = client.request("MOVE", "/link", headers={"Destination": "/renamed"})
        assert r.status_code == 201
        assert (root / "renamed").is_symlink()
        assert not (root / "link").exists() and not (root / "link").is_symlink()
        assert (root / "hello.txt").read_text() == "hi"

    def test_copy_source_is_the_link(self, client, root):
        (root / "hello.txt").write_text("hi")
        (root / "link").symlink_to("hello.txt")
        r = client.request("COPY", "/link", headers={"Destination": "/copy"})
        assert r.status_code == 201
        assert (root / "copy").is_symlink()

    def test_get_and_put_still_follow_an_inside_link(self, client, root):
        (root / "hello.txt").write_text("hi")
        (root / "link").symlink_to(root / "hello.txt")
        assert client.get("/link").text == "hi"
        assert client.put("/link", content=b"changed").status_code == 204
        assert (root / "hello.txt").read_bytes() == b"changed"
        assert (root / "link").is_symlink()

    def test_escaping_parent_chain_is_still_refused(self, client, root, tmp_path_factory):
        outside = tmp_path_factory.mktemp("outside")
        (outside / "victim.txt").write_text("secret")
        (root / "escape").symlink_to(outside)
        assert client.delete("/escape/victim.txt").status_code == 403
        r = client.post("/_bulk/delete", json={"paths": ["/escape/victim.txt"]})
        assert r.status_code == 403
        r = client.request(
            "MOVE", "/escape/victim.txt", headers={"Destination": "/stolen.txt"}
        )
        assert r.status_code == 403
        assert (outside / "victim.txt").read_text() == "secret"

    def test_restore_brings_back_the_link_itself(self, client, root):
        (root / "hello.txt").write_text("hi")
        (root / "link").symlink_to("hello.txt")
        txid = client.delete("/link").json()["transaction_id"]
        assert client.post(f"/api/restore/{txid}").status_code == 200
        assert (root / "link").is_symlink()
        assert not (root / "link (restored)").exists()


# ── B02: folder zip releases its slot ───────────────────────────────────────


class TestZipSlotRelease:
    def test_response_runs_cleanup_when_client_goes_away(self):
        done = []

        async def body():
            yield b"x" * 10
            yield b"y" * 10

        async def send(message):
            if message["type"] == "http.response.body":
                raise RuntimeError("client gone")

        async def receive():
            await asyncio.Event().wait()

        response = _ReleasingStreamingResponse(body(), on_done=lambda: done.append(1))

        async def run():
            with pytest.raises(BaseException):
                await response({"type": "http", "method": "GET"}, receive, send)

        asyncio.run(asyncio.wait_for(run(), 5))
        assert done == [1]

    def test_next_zip_answers_after_an_aborted_download(self, root, tmp_dir, tmp_path):
        (root / "d").mkdir()
        (root / "d" / "big.bin").write_bytes(os.urandom(300_000))
        (root / "e").mkdir()
        (root / "e" / "f.txt").write_text("f")
        app = create_app(
            Settings(
                root_dir=root,
                tmp_dir=tmp_dir,
                users_config=make_users(tmp_path),
            )
        )

        async def dying_send(message):
            if message["type"] == "http.response.body":
                raise RuntimeError("client gone")

        try:
            read_asgi(app, "GET", "/d/", query=b"zip", send=dying_send)
        except BaseException:
            pass
        status, body = read_asgi(app, "GET", "/e/", query=b"zip")
        assert status == 200
        assert zipfile.ZipFile(io.BytesIO(body)).namelist() == ["f.txt"]


def make_users(tmp_path, perms="rwd"):
    users = tmp_path / "zip-users.yaml"
    users.write_text(f'users:\n  "*": "{perms}"\n')
    return users


# ── B07: uvicorn must not trust X-Forwarded-For ─────────────────────────────


class TestCli:
    def _invoke(self, monkeypatch, tmp_path, *extra):
        from click.testing import CliRunner

        from xwing import cli

        calls = []
        # --reload hands its settings to the child through os.environ.
        monkeypatch.setattr(os, "environ", os.environ.copy())
        monkeypatch.setattr(cli.uvicorn, "run", lambda *a, **k: calls.append(k))
        users = make_users(tmp_path)
        root = tmp_path / "served"
        root.mkdir()
        result = CliRunner().invoke(
            cli.main,
            [
                "serve",
                "--root",
                str(root),
                "--no-open",
                "--users-config",
                str(users),
                "--port",
                "9399",
                *extra,
            ],
        )
        return result, calls

    def test_uvicorn_proxy_headers_disabled(self, monkeypatch, tmp_path):
        result, calls = self._invoke(monkeypatch, tmp_path)
        assert result.exit_code == 0, result.output
        assert calls and calls[0]["proxy_headers"] is False

    def test_uvicorn_proxy_headers_disabled_in_reload_mode(self, monkeypatch, tmp_path):
        result, calls = self._invoke(monkeypatch, tmp_path, "--reload")
        assert result.exit_code == 0, result.output
        assert calls and calls[0]["proxy_headers"] is False

    def test_ipv6_host_url_is_bracketed(self, monkeypatch, tmp_path):
        result, _ = self._invoke(monkeypatch, tmp_path, "--host", "::")
        assert "http://[::]:9399" in result.output

    def test_audit_purge_honours_group_level_db(self, tmp_path):
        from click.testing import CliRunner

        from xwing import cli

        db = tmp_path / "audit.db"
        audit_store.init_db(db)
        audit_store.record_event(
            db_path=db,
            username="bob",
            method="PUT",
            path="/a",
            details=None,
            status_code=204,
            duration_ms=1.0,
        )
        xdg = tmp_path / "xdg-must-stay-empty"
        result = CliRunner().invoke(
            cli.main,
            ["audit", "--audit-db", str(db), "purge", "--older-than", "1"],
            env={"XDG_DATA_HOME": str(xdg)},
        )
        assert result.exit_code == 0, result.output
        # It must have used the group-level database, not created the default.
        assert not xdg.exists()
        assert audit_store.list_events(db, username="bob")


# ── B06: user files cannot script the app origin ────────────────────────────


class TestUserFileHeaders:
    @pytest.mark.parametrize(
        "name", ["a.html", "a.svg", "a.js", "a.xml", "a.xhtml", "a.xsl"]
    )
    def test_active_content_is_sandboxed(self, client, root, name):
        (root / name).write_text("<script>alert(1)</script>")
        r = client.get(f"/{name}")
        assert r.status_code == 200
        assert r.headers["x-content-type-options"] == "nosniff"
        csp = r.headers["content-security-policy"]
        assert csp.startswith("sandbox;")
        assert "allow-scripts" not in csp and "allow-same-origin" not in csp

    @pytest.mark.parametrize("name", ["a.txt", "a.png", "a.pdf", "a.mp4", "a.bin"])
    def test_passive_content_is_not_sandboxed(self, client, root, name):
        (root / name).write_bytes(b"data")
        r = client.get(f"/{name}")
        assert r.headers["x-content-type-options"] == "nosniff"
        assert "sandbox" not in r.headers["content-security-policy"]

    def test_app_pages_keep_the_app_csp(self, client, root):
        r = client.get("/", headers=HTML)
        assert "script-src 'self'" in r.headers["content-security-policy"]
        assert "sandbox" not in r.headers["content-security-policy"]


# ── B08: no built-in docs routes ────────────────────────────────────────────


class TestNoBuiltinDocsRoutes:
    def test_docs_and_openapi_are_user_paths(self, client, root):
        (root / "docs").mkdir()
        (root / "openapi.json").write_text('{"mine": true}')
        (root / "redoc").write_text("mine")
        assert client.get("/openapi.json").json() == {"mine": True}
        assert client.get("/redoc").text == "mine"
        r = client.get("/docs", headers=DIR_JSON)
        assert r.headers["content-type"].startswith("application/vnd.xwing.directory")

    def test_nothing_is_served_without_user_files(self, client):
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404


# ── B09: aborted uploads clean up ───────────────────────────────────────────


def _fd_count():
    return len(os.listdir("/proc/self/fd"))


@pytest.mark.skipif(not os.path.isdir("/proc/self/fd"), reason="needs /proc")
class TestAbortedPut:
    def _app(self, root, tmp_dir, tmp_path):
        return create_app(
            Settings(root_dir=root, tmp_dir=tmp_dir, users_config=make_users(tmp_path))
        )

    def test_client_disconnect_leaves_no_staging_file_or_fd(
        self, root, tmp_dir, tmp_path
    ):
        app = self._app(root, tmp_dir, tmp_path)
        before = _fd_count()
        for i in range(3):
            read_asgi(
                app,
                "PUT",
                f"/partial{i}.bin",
                headers=[(b"content-length", b"1000000")],
                messages=[
                    {"type": "http.request", "body": b"x" * 1000, "more_body": True},
                    {"type": "http.disconnect"},
                ],
            )
        assert sorted(p.name for p in root.iterdir() if "upload-part" in p.name) == []
        assert not (root / "partial0.bin").exists()
        assert _fd_count() <= before

    def test_unexpected_failure_aborts_the_sink(
        self, root, tmp_dir, tmp_path, monkeypatch
    ):
        from xwing.upload import LocalFileSink

        async def broken(self):
            raise RuntimeError("boom")

        monkeypatch.setattr(LocalFileSink, "finalize", broken)
        with TestClient(
            self._app(root, tmp_dir, tmp_path), raise_server_exceptions=False
        ) as c:
            assert c.put("/f.bin", content=b"data").status_code == 500
        assert [p.name for p in root.iterdir() if "upload-part" in p.name] == []


# ── B10: bad users.yaml keeps last good permissions ─────────────────────────


class TestUsersConfigReload:
    @pytest.mark.parametrize("bad", ['users:\n  "*": rwx\n', "users: [", ""])
    def test_invalid_edit_keeps_serving_last_good_permissions(
        self, root, tmp_dir, tmp_path, bad
    ):
        users = make_users(tmp_path, "rw")
        (root / "data.txt").write_text("x")
        with TestClient(
            create_app(Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users))
        ) as c:
            assert c.get("/data.txt").status_code == 200
            users.write_text(bad)
            os.utime(users, (1, 1))
            assert c.get("/data.txt").status_code == 200
            assert c.put("/new.txt", content=b"1").status_code == 204
            assert c.delete("/data.txt").status_code == 403
            # Fixing the file takes effect again.
            users.write_text('users:\n  "*": rwd\n')
            os.utime(users, (2, 2))
            assert c.delete("/data.txt").status_code == 200


# ── File modes ──────────────────────────────────────────────────────────────


def _umask():
    mask = os.umask(0o022)
    os.umask(mask)
    return mask


class TestFileModes:
    def test_put_new_file_follows_umask(self, client, root):
        assert client.put("/new.txt", content=b"x").status_code == 204
        assert (root / "new.txt").stat().st_mode & 0o777 == 0o666 & ~_umask()

    def test_put_overwrite_keeps_mode(self, client, root):
        script = root / "run.sh"
        script.write_text("#!/bin/sh\n")
        script.chmod(0o755)
        assert client.put("/run.sh", content=b"#!/bin/sh\necho hi\n").status_code == 204
        assert script.stat().st_mode & 0o777 == 0o755
        assert b"echo hi" in script.read_bytes()

    def test_chunked_upload_new_and_overwrite(self, client, root):
        upload(client, "fresh.bin", b"abc")
        assert (root / "fresh.bin").stat().st_mode & 0o777 == 0o666 & ~_umask()
        script = root / "tool.sh"
        script.write_text("old")
        script.chmod(0o750)
        upload(client, "tool.sh", b"new")
        assert script.read_bytes() == b"new"
        assert script.stat().st_mode & 0o777 == 0o750

    def test_empty_put_and_staging_does_not_linger(self, client, root):
        assert client.put("/empty.txt", content=b"").status_code == 204
        assert (root / "empty.txt").stat().st_mode & 0o777 == 0o666 & ~_umask()
        assert [p.name for p in root.iterdir() if "upload-part" in p.name] == []


# ── B12: status codes ───────────────────────────────────────────────────────


class TestStatusCodes:
    def test_mkcol_under_a_file_is_409(self, client, root):
        (root / "hello.txt").write_text("x")
        assert client.request("MKCOL", "/hello.txt/sub").status_code == 409

    def test_put_with_a_file_ancestor_is_409(self, client, root):
        (root / "hello.txt").write_text("x")
        assert client.put("/hello.txt/child.txt", content=b"y").status_code == 409
        assert (root / "hello.txt").read_text() == "x"

    @pytest.mark.parametrize(
        "method", ["GET", "HEAD", "PUT", "DELETE", "MKCOL", "PROPFIND", "LOCK"]
    )
    def test_nul_byte_in_path_is_400(self, client, method):
        kwargs = {"content": b"x"} if method == "PUT" else {}
        r = client.request(method, "/a%00b", **kwargs)
        assert r.status_code == 400

    def test_nul_byte_in_destination_and_bulk_and_upload(self, client, root):
        (root / "a.txt").write_text("a")
        for verb in ("COPY", "MOVE"):
            r = client.request(verb, "/a.txt", headers={"Destination": "/b%00c"})
            assert r.status_code == 400
        for url in ("/_bulk/delete", "/_bulk/zip"):
            assert client.post(url, json={"paths": ["/a\u0000b"]}).status_code == 400
        r = client.post(
            "/_upload/init", json={"filename": "x", "size": 1, "dir": "/a\u0000b"}
        )
        assert r.status_code == 400
        r = client.post(
            "/_upload/init", json={"filename": "x\u0000y", "size": 1, "dir": "/"}
        )
        assert r.status_code == 400
        assert (root / "a.txt").read_text() == "a"

    @pytest.mark.parametrize("size", ["Infinity", "-Infinity", "NaN", "1e999", "-5"])
    def test_absurd_upload_size_is_400(self, client, size):
        r = client.post(
            "/_upload/init",
            content=f'{{"filename": "a.bin", "size": {size}, "dir": "/"}}'.encode(),
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 400


# ── B14: zip edge cases ─────────────────────────────────────────────────────


class TestZipEdgeCases:
    def test_pre_1980_and_post_2107_timestamps_do_not_fail(self, client, root):
        (root / "old").mkdir()
        old = root / "old" / "epoch.txt"
        old.write_text("e")
        os.utime(old, (0, 0))
        future = root / "old" / "future.txt"
        future.write_text("f")
        os.utime(future, (5_000_000_000, 5_000_000_000))
        r = client.get("/old/?zip")
        assert r.status_code == 200
        assert sorted(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == [
            "epoch.txt",
            "future.txt",
        ]
        r = client.post("/_bulk/zip", json={"paths": ["/old/epoch.txt"], "base": "/"})
        assert r.status_code == 200

    def test_empty_folders_survive_the_round_trip(self, client, root):
        (root / "top" / "empty").mkdir(parents=True)
        (root / "top" / "full").mkdir()
        (root / "top" / "full" / "a.txt").write_text("a")
        names = zipfile.ZipFile(io.BytesIO(client.get("/top/?zip").content)).namelist()
        assert "empty/" in names and "full/a.txt" in names
        bulk = client.post("/_bulk/zip", json={"paths": ["/top/empty/"], "base": "/"})
        assert zipfile.ZipFile(io.BytesIO(bulk.content)).namelist() == ["top/empty/"]

    def test_bulk_zip_honours_the_size_limit(self, root, tmp_dir, tmp_path):
        (root / "big.bin").write_bytes(b"0" * 5000)
        with make_client(root, tmp_dir, tmp_path, max_upload_bytes=1000) as c:
            assert c.get("/", headers=HTML).status_code == 200
            r = c.post("/_bulk/zip", json={"paths": ["/big.bin"], "base": "/"})
            assert r.status_code == 413


# ── B17 / B19: undo permission, restart flag ────────────────────────────────


class TestPermissionsAndAdmin:
    def test_rd_user_can_undo_their_own_delete(self, root, tmp_dir, tmp_path):
        (root / "f.txt").write_text("f")
        with make_client(root, tmp_dir, tmp_path, "rd") as c:
            txid = c.delete("/f.txt").json()["transaction_id"]
            assert c.post(f"/api/restore/{txid}").status_code == 200
            assert (root / "f.txt").read_text() == "f"

    def test_user_without_delete_cannot_restore(self, root, tmp_dir, tmp_path):
        (root / "f.txt").write_text("f")
        with make_client(root, tmp_dir, tmp_path, "rwd") as c:
            txid = c.delete("/f.txt").json()["transaction_id"]
        with make_client(root, tmp_dir, tmp_path, "rw") as c:
            assert c.post(f"/api/restore/{txid}").status_code == 403

    def test_plain_users_yaml_edits_apply_live(self, root, tmp_dir, tmp_path):
        users = tmp_path / "admin-users.yaml"
        users.write_text("users:\n  admin: rwd\n")
        settings = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            users_config=users,
            require_auth=True,
            trusted_auth_proxies=["testclient"],
            admin_users=["admin"],
        )
        headers = {"X-Forwarded-User": "admin"}
        with TestClient(create_app(settings)) as c:
            created = c.post(
                "/api/admin/users",
                headers=headers,
                json={"username": "dave", "permissions": {"read": True, "write": True}},
            )
            assert created.status_code == 200
            assert created.json()["restart_required"] is False
            deleted = c.delete("/api/admin/users/dave", headers=headers)
            assert deleted.json()["restart_required"] is False


# ── B22 ─────────────────────────────────────────────────────────────────────


class TestMisc:
    def test_delete_losing_a_race_is_404(self, client, root, monkeypatch):
        (root / "x.txt").write_text("x")

        def vanished(src, dst):
            raise FileNotFoundError(src)

        monkeypatch.setattr("xwing.app.shutil.move", vanished)
        assert client.delete("/x.txt").status_code == 404

    def test_chunk_upload_of_a_folder_name_is_409_at_init(self, client, root):
        (root / "docs").mkdir()
        r = client.post(
            "/_upload/init", json={"filename": "docs", "size": 1, "dir": "/"}
        )
        assert r.status_code == 409

    def test_activity_username_filter_is_case_insensitive(self, tmp_path):
        db = tmp_path / "audit.db"
        audit_store.init_db(db)
        audit_store.record_event(
            db_path=db,
            username="bob",
            method="PUT",
            path="/a",
            details=None,
            status_code=204,
            duration_ms=1.0,
        )
        assert len(audit_store.list_events(db, username="BOB")) == 1


# ── B15 / editor ────────────────────────────────────────────────────────────


class TestEditorContent:
    def _edit(self, client, name):
        import re

        page = client.get(f"/{name}?edit", headers=HTML)
        match = re.search(
            r'<script type="application/json" id="xwing-editor-bootstrap">(.*?)</script>',
            page.text,
            re.DOTALL,
        )
        return json.loads(match.group(1))

    def test_crlf_survives_into_the_editor_bootstrap(self, client, root):
        (root / "win.txt").write_bytes(b"a\r\nb\r\n")
        boot = self._edit(client, "win.txt")
        assert boot["content"] == "a\r\nb\r\n"
        assert boot["totalSize"] == 6

    def test_lone_cr_survives(self, client, root):
        (root / "mac.txt").write_bytes(b"a\rb\r")
        assert self._edit(client, "mac.txt")["content"] == "a\rb\r"

    def test_binary_extensionless_file_is_not_editable(self, client, root):
        (root / "randbin").write_bytes(b"\x00\x01\x02binary\xff")
        listed = client.get("/", headers=DIR_JSON).json()["files"]
        assert listed[0]["editable"] is False
        # ?edit falls through to a plain download instead of the editor.
        assert client.get("/randbin?edit", headers=HTML).content.startswith(b"\x00\x01")
