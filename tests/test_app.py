import io
import sys
import types
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from xwing.app import create_app
from xwing.config import Settings


HTML = {"Accept": "text/html"}


class TestDirectoryListing:
    def test_root_listing(self, client, root):
        (root / "hello.txt").write_text("hi")
        (root / "subdir").mkdir()
        r = client.get("/", headers=HTML)
        assert r.status_code == 200
        assert "hello.txt" in r.text
        assert "subdir" in r.text

    def test_subdir_listing(self, client, root):
        d = root / "docs"
        d.mkdir()
        (d / "readme.md").write_text("docs")
        r = client.get("/docs/", headers=HTML)
        assert r.status_code == 200
        assert "readme.md" in r.text

    def test_listing_url_encodes_special_filename_segments(self, client, root):
        (root / "hash#file?.txt").write_text("special")
        r = client.get("/", headers=HTML)
        assert r.status_code == 200
        assert 'href="/hash%23file%3F.txt"' in r.text
        assert 'data-path="/hash%23file%3F.txt"' in r.text

    def test_listing_url_encodes_current_directory(self, client, root):
        d = root / "hash#dir?"
        d.mkdir()
        (d / "child#file.txt").write_text("special")
        r = client.get("/hash%23dir%3F/", headers=HTML)
        assert r.status_code == 200
        assert 'href="/hash%23dir%3F/child%23file.txt"' in r.text
        assert 'data-current-path="/hash%23dir%3F/"' in r.text

    def test_missing_dir_returns_404(self, client):
        r = client.get("/nonexistent/", headers=HTML)
        assert r.status_code == 404


class TestFileDownload:
    def test_download_file(self, client, root):
        (root / "data.txt").write_text("content here")
        r = client.get("/data.txt")
        assert r.status_code == 200
        assert r.text == "content here"

    def test_download_special_filename(self, client, root):
        (root / "hash#file?.txt").write_text("special")
        r = client.get("/hash%23file%3F.txt")
        assert r.status_code == 200
        assert r.text == "special"

    def test_missing_file_returns_404(self, client):
        r = client.get("/nope.txt")
        assert r.status_code == 404


class TestAuth:
    def test_require_auth_blocks_anonymous(self, root, tmp_dir):
        s = Settings(root_dir=root, tmp_dir=tmp_dir, require_auth=True)
        with TestClient(create_app(s)) as c:
            r = c.get("/")
        assert r.status_code == 403

    def test_require_auth_passes_with_header(self, root, tmp_dir):
        s = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            require_auth=True,
            trusted_auth_proxies=["testclient"],
        )
        with TestClient(create_app(s)) as c:
            r = c.get("/", headers={**HTML, "X-Forwarded-User": "alice"})
        assert r.status_code == 200

    def test_authenticated_listing_uses_post_logout_form(self, root, tmp_dir):
        s = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            require_auth=True,
            trusted_auth_proxies=["testclient"],
        )
        with TestClient(create_app(s)) as c:
            r = c.get("/", headers={**HTML, "X-Forwarded-User": "alice"})
        assert r.status_code == 200
        assert 'method="post" action="/_auth/logout"' in r.text
        assert 'href="/_auth/logout"' not in r.text

    def test_listing_csp_uses_external_assets_only(self, client):
        r = client.get("/", headers=HTML)
        assert r.status_code == 200
        csp = r.headers["content-security-policy"]
        assert "script-src 'self'" in csp
        assert "font-src 'self'" in csp
        assert "'unsafe-inline'" not in csp

    def test_read_only_listing_warns_and_disables_write_controls(self, root, tmp_dir, tmp_path):
        users_yaml = tmp_path / "users.yaml"
        users_yaml.write_text("users:\n  alice: r\n")
        s = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            users_config=users_yaml,
            trusted_auth_proxies=["testclient"],
        )
        with TestClient(create_app(s)) as c:
            r = c.get("/", headers={**HTML, "X-Forwarded-User": "alice"})
        assert r.status_code == 200
        assert "Read-only access. Uploads and folder creation are disabled." in r.text
        assert 'data-can-write="false"' in r.text
        assert 'id="upload-btn" disabled title="Read-only access"' in r.text
        assert 'id="mkdir-btn" disabled title="Read-only access"' in r.text

    def test_require_auth_rejects_untrusted_header(self, root, tmp_dir):
        s = Settings(root_dir=root, tmp_dir=tmp_dir, require_auth=True)
        with TestClient(create_app(s)) as c:
            r = c.get("/", headers={**HTML, "X-Forwarded-User": "alice"})
        assert r.status_code == 403

    def test_no_auth_returns_anonymous(self, client, root):
        r = client.get("/", headers=HTML)
        assert r.status_code == 200
        assert "anonymous" in r.text

    def test_custom_user_header(self, root, tmp_dir):
        s = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            user_header="X-Remote-User",
            trusted_auth_proxies=["testclient"],
        )
        with TestClient(create_app(s)) as c:
            r = c.get("/", headers={**HTML, "X-Remote-User": "bob"})
        assert r.status_code == 200
        assert "bob" in r.text

    def test_untrusted_header_ignored_when_auth_optional(self, root, tmp_dir):
        s = Settings(root_dir=root, tmp_dir=tmp_dir)
        with TestClient(create_app(s)) as c:
            r = c.get("/", headers={**HTML, "X-Forwarded-User": "alice"})
        assert r.status_code == 200
        assert "anonymous" in r.text

    def test_ldap_config_adds_ldapgate_middleware(self, root, tmp_dir, monkeypatch):
        calls = {}

        ldapgate_pkg = types.ModuleType("ldapgate")
        config_mod = types.ModuleType("ldapgate.config")
        middleware_mod = types.ModuleType("ldapgate.middleware")
        proxy_config = types.SimpleNamespace(static_paths=["/assets"])
        loaded_config = types.SimpleNamespace(proxy=proxy_config)

        def load_config(path):
            calls["config_path"] = path
            return loaded_config

        def add_ldap_auth(app, config, template_path=None):
            calls["app"] = app
            calls["config"] = config
            calls["template_path"] = template_path

        config_mod.load_config = load_config
        middleware_mod.add_ldap_auth = add_ldap_auth
        monkeypatch.setitem(sys.modules, "ldapgate", ldapgate_pkg)
        monkeypatch.setitem(sys.modules, "ldapgate.config", config_mod)
        monkeypatch.setitem(sys.modules, "ldapgate.middleware", middleware_mod)

        ldap_yaml = tmp_dir / "ldapgate.yaml"
        ldap_yaml.write_text("ldap: {}\nproxy: {}\n")
        settings = Settings(root_dir=root, tmp_dir=tmp_dir, ldap_config=ldap_yaml)

        app = create_app(settings)

        assert calls["app"] is app
        assert calls["config_path"] == str(ldap_yaml)
        assert calls["config"] is loaded_config
        assert calls["template_path"].endswith("templates/login.html")
        assert calls["config"].proxy.static_paths == [
            "/assets",
            "/static",
            "/favicon.ico",
        ]


class TestPut:
    def test_put_creates_file(self, client, root):
        r = client.put("/newfile.txt", content=b"hello")
        assert r.status_code == 204
        assert (root / "newfile.txt").read_bytes() == b"hello"

    def test_put_overwrites_file(self, client, root):
        (root / "existing.txt").write_text("old")
        r = client.put("/existing.txt", content=b"new")
        assert r.status_code == 204
        assert (root / "existing.txt").read_bytes() == b"new"

    def test_put_on_directory_returns_409(self, client, root):
        (root / "adir").mkdir()
        r = client.put("/adir", content=b"data")
        assert r.status_code == 409

    def test_put_env_file_rejected(self, client, root):
        r = client.put("/.env", content=b"SECRET=hunter2")
        assert r.status_code == 403
        assert not (root / ".env").exists()

    def test_put_env_variant_rejected(self, client, root):
        r = client.put("/.env.local", content=b"SECRET=local")
        assert r.status_code == 403
        assert not (root / ".env.local").exists()

    def test_put_exceeds_max_upload_bytes_returns_413(self, root, tmp_dir, users_yaml):
        s = Settings(root_dir=root, tmp_dir=tmp_dir, max_upload_bytes=10, users_config=users_yaml)
        with TestClient(create_app(s)) as c:
            r = c.put("/large.txt", content=b"x" * 100)
        assert r.status_code == 413
        assert not (root / "large.txt").exists()

    def test_put_does_not_clobber_sibling_tmp_file(self, client, root):
        (root / "newfile.txt.tmp").write_text("keep me")
        r = client.put("/newfile.txt", content=b"hello")
        assert r.status_code == 204
        assert (root / "newfile.txt").read_bytes() == b"hello"
        assert (root / "newfile.txt.tmp").read_text() == "keep me"

    def test_editor_uses_encoded_save_and_download_paths(self, client, root):
        (root / "hash#file?.txt").write_text("special")
        r = client.get("/hash%23file%3F.txt?edit")
        assert r.status_code == 200
        assert 'href="/hash%23file%3F.txt"' in r.text
        assert 'data-file-path="/hash%23file%3F.txt"' in r.text


class TestHead:
    def test_head_on_file_returns_headers(self, client, root):
        (root / "data.txt").write_text("content")
        r = client.head("/data.txt")
        assert r.status_code == 200

    def test_head_on_dir_returns_200(self, client, root):
        (root / "subdir").mkdir()
        r = client.head("/")
        assert r.status_code == 200

    def test_head_does_not_return_body(self, client, root):
        (root / "data.txt").write_text("content")
        r = client.head("/data.txt")
        assert r.content == b""


class TestZip:
    def test_zip_directory(self, client, root):
        (root / "a.txt").write_text("hello")
        (root / "sub").mkdir()
        (root / "sub" / "b.txt").write_text("world")
        r = client.get("/?zip")
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/zip"
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        names = zf.namelist()
        assert "a.txt" in names
        assert "sub/b.txt" in names

    def test_zip_nested_files(self, client, root):
        (root / "deep").mkdir()
        (root / "deep" / "nested.txt").write_text("deep content")
        r = client.get("/deep/?zip")
        assert r.status_code == 200
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        assert "nested.txt" in zf.namelist()

    def test_zip_empty_directory(self, client, root):
        (root / "empty").mkdir()
        r = client.get("/empty/?zip")
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/zip"
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        assert len(zf.namelist()) == 0

    def test_zip_skips_symlink_outside_root(self, client, root, tmp_path):
        outside = tmp_path.parent / f"{tmp_path.name}-outside-secret.txt"
        outside.write_text("secret")
        (root / "leak.txt").symlink_to(outside)
        r = client.get("/?zip")
        assert r.status_code == 200
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        assert "leak.txt" not in zf.namelist()

    def test_zip_skips_env_files_and_directories(self, client, root):
        (root / "safe.txt").write_text("safe")
        (root / ".env").write_text("SECRET=hunter2")
        (root / ".env.d").mkdir()
        (root / ".env.d" / "secret.txt").write_text("nested")
        r = client.get("/?zip")
        assert r.status_code == 200
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        assert "safe.txt" in zf.namelist()
        assert ".env" not in zf.namelist()
        assert ".env.d/secret.txt" not in zf.namelist()


class TestCopy:
    def test_copy_file(self, client, root):
        (root / "src.txt").write_text("source")
        r = client.request("COPY", "/src.txt", headers={"Destination": "/dst.txt"})
        assert r.status_code == 201
        assert (root / "src.txt").read_text() == "source"
        assert (root / "dst.txt").read_text() == "source"

    def test_copy_file_overwrite_t(self, client, root):
        (root / "src.txt").write_text("source")
        (root / "dst.txt").write_text("old")
        r = client.request(
            "COPY", "/src.txt", headers={"Destination": "/dst.txt", "Overwrite": "T"}
        )
        assert r.status_code == 201
        assert (root / "dst.txt").read_text() == "source"

    def test_copy_file_overwrite_failure_preserves_destination(
        self, client, root, monkeypatch
    ):
        (root / "src.txt").write_text("source")
        (root / "dst.txt").write_text("old")

        def fail_copy2(src, dst):
            raise OSError("simulated copy failure")

        import xwing.webdav

        monkeypatch.setattr(xwing.webdav.shutil, "copy2", fail_copy2)
        r = client.request(
            "COPY", "/src.txt", headers={"Destination": "/dst.txt", "Overwrite": "T"}
        )
        assert r.status_code == 500
        assert (root / "dst.txt").read_text() == "old"

    def test_copy_file_overwrite_f_returns_412(self, client, root):
        (root / "src.txt").write_text("source")
        (root / "dst.txt").write_text("old")
        r = client.request(
            "COPY", "/src.txt", headers={"Destination": "/dst.txt", "Overwrite": "F"}
        )
        assert r.status_code == 412

    def test_copy_missing_source_returns_404(self, client):
        r = client.request("COPY", "/ghost.txt", headers={"Destination": "/dst.txt"})
        assert r.status_code == 404

    def test_copy_to_env_file_rejected(self, client, root):
        (root / "src.txt").write_text("source")
        r = client.request("COPY", "/src.txt", headers={"Destination": "/.env"})
        assert r.status_code == 403
        assert not (root / ".env").exists()

    def test_copy_from_env_file_rejected(self, client, root):
        (root / ".env").write_text("SECRET=hunter2")
        r = client.request("COPY", "/.env", headers={"Destination": "/leak.txt"})
        assert r.status_code == 403
        assert not (root / "leak.txt").exists()

    def test_copy_does_not_clobber_sibling_tmp_file(self, client, root):
        (root / "src.txt").write_text("source")
        (root / "dst.txt.tmp").write_text("keep me")
        r = client.request("COPY", "/src.txt", headers={"Destination": "/dst.txt"})
        assert r.status_code == 201
        assert (root / "dst.txt").read_text() == "source"
        assert (root / "dst.txt.tmp").read_text() == "keep me"

    def test_copy_directory_preserves_external_symlink(self, client, root, tmp_path):
        outside = tmp_path.parent / f"{tmp_path.name}-outside-secret.txt"
        outside.write_text("secret")
        (root / "src").mkdir()
        (root / "src" / "leak.txt").symlink_to(outside)
        r = client.request("COPY", "/src", headers={"Destination": "/dst"})
        assert r.status_code == 201
        assert (root / "dst" / "leak.txt").is_symlink()

    def test_copy_directory_overwrite_failure_restores_destination(
        self, client, root, monkeypatch
    ):
        (root / "src").mkdir()
        (root / "src" / "new.txt").write_text("new")
        (root / "dst").mkdir()
        (root / "dst" / "old.txt").write_text("old")

        original_replace = type(root / "src").replace

        def fail_final_replace(self, dest):
            if (
                self.name.startswith(".dst.")
                and self.name.endswith(".tmp")
                and Path(dest).name == "dst"
            ):
                raise OSError("simulated final replace failure")
            return original_replace(self, dest)

        def fail_move(src, dst):
            raise OSError("simulated fallback move failure")

        import xwing.webdav

        monkeypatch.setattr(type(root / "src"), "replace", fail_final_replace)
        monkeypatch.setattr(xwing.webdav.shutil, "move", fail_move)
        r = client.request(
            "COPY", "/src", headers={"Destination": "/dst", "Overwrite": "T"}
        )
        assert r.status_code == 500
        assert (root / "dst" / "old.txt").read_text() == "old"
        assert not (root / "dst" / "new.txt").exists()


class TestMove:
    def test_move_file(self, client, root):
        (root / "src.txt").write_text("source")
        r = client.request("MOVE", "/src.txt", headers={"Destination": "/dst.txt"})
        assert r.status_code == 201
        assert not (root / "src.txt").exists()
        assert (root / "dst.txt").read_text() == "source"

    def test_move_file_overwrite_f_returns_412(self, client, root):
        (root / "src.txt").write_text("source")
        (root / "dst.txt").write_text("old")
        r = client.request(
            "MOVE", "/src.txt", headers={"Destination": "/dst.txt", "Overwrite": "F"}
        )
        assert r.status_code == 412
        assert (root / "src.txt").read_text() == "source"

    def test_move_file_overwrite_failure_preserves_destination(
        self, client, root, monkeypatch
    ):
        (root / "src.txt").write_text("source")
        (root / "dst.txt").write_text("old")

        def fail_replace(self, dest):
            raise OSError("simulated replace failure")

        def fail_move(src, dst):
            raise OSError("simulated move failure")

        import xwing.webdav

        monkeypatch.setattr(type(root / "src.txt"), "replace", fail_replace)
        monkeypatch.setattr(xwing.webdav.shutil, "move", fail_move)
        r = client.request(
            "MOVE", "/src.txt", headers={"Destination": "/dst.txt", "Overwrite": "T"}
        )
        assert r.status_code == 500
        assert (root / "src.txt").read_text() == "source"
        assert (root / "dst.txt").read_text() == "old"

    def test_move_root_rejected(self, client, root):
        (root / "keep.txt").write_text("keep")
        r = client.request("MOVE", "/", headers={"Destination": "/dst"})
        assert r.status_code == 403
        assert (root / "keep.txt").read_text() == "keep"
        assert not (root / "dst").exists()

    def test_move_directory_overwrite_failure_restores_destination(
        self, client, root, monkeypatch
    ):
        (root / "src").mkdir()
        (root / "src" / "new.txt").write_text("new")
        (root / "dst").mkdir()
        (root / "dst" / "old.txt").write_text("old")

        original_replace = type(root / "src").replace

        def fail_final_replace(self, dest):
            if self.name == "src" and Path(dest).name == "dst":
                raise OSError("simulated final replace failure")
            return original_replace(self, dest)

        def fail_move(src, dst):
            raise OSError("simulated fallback move failure")

        import xwing.webdav

        monkeypatch.setattr(type(root / "src"), "replace", fail_final_replace)
        monkeypatch.setattr(xwing.webdav.shutil, "move", fail_move)
        r = client.request(
            "MOVE", "/src", headers={"Destination": "/dst", "Overwrite": "T"}
        )
        assert r.status_code == 500
        assert (root / "src" / "new.txt").read_text() == "new"
        assert (root / "dst" / "old.txt").read_text() == "old"
        assert not (root / "dst" / "new.txt").exists()

    def test_move_to_env_file_rejected(self, client, root):
        (root / "src.txt").write_text("source")
        r = client.request("MOVE", "/src.txt", headers={"Destination": "/.env"})
        assert r.status_code == 403
        assert (root / "src.txt").read_text() == "source"
        assert not (root / ".env").exists()

    def test_move_from_env_file_rejected(self, client, root):
        (root / ".env").write_text("SECRET=hunter2")
        r = client.request("MOVE", "/.env", headers={"Destination": "/leak.txt"})
        assert r.status_code == 403
        assert (root / ".env").read_text() == "SECRET=hunter2"
        assert not (root / "leak.txt").exists()

    def test_move_requires_write_permission(self, root, tmp_dir, tmp_path):
        users_yaml = tmp_path / "users.yaml"
        users_yaml.write_text("users:\n  alice: rd\n")
        s = Settings(
            root_dir=root,
            tmp_dir=tmp_dir,
            require_auth=True,
            users_config=users_yaml,
            trusted_auth_proxies=["testclient"],
        )
        (root / "src.txt").write_text("source")
        with TestClient(create_app(s)) as c:
            r = c.request(
                "MOVE",
                "/src.txt",
                headers={
                    "Destination": "/dst.txt",
                    "X-Forwarded-User": "alice",
                },
            )
        assert r.status_code == 403
        assert (root / "src.txt").read_text() == "source"
        assert not (root / "dst.txt").exists()


class TestEnvFile:
    def test_env_file_not_downloadable(self, client, root):
        (root / ".env").write_text("SECRET=hunter2")
        r = client.get("/.env")
        assert r.status_code == 403

    def test_env_file_variant_not_downloadable(self, client, root):
        (root / ".env.local").write_text("SECRET=local")
        r = client.get("/.env.local")
        assert r.status_code == 403


class TestSymlinkInsideRoot:
    def test_symlink_inside_root_allowed(self, root):
        target = root / "actual.txt"
        target.write_text("hello")
        link = root / "link.txt"
        link.symlink_to(target)
        from xwing.files import safe_path

        result = safe_path(root, "link.txt")
        assert result.resolve() == target.resolve()


class TestDelete:
    def test_delete_file(self, client, root):
        f = root / "todelete.txt"
        f.write_text("bye")
        r = client.delete("/todelete.txt")
        assert r.status_code == 204
        assert not f.exists()

    def test_delete_directory(self, client, root):
        d = root / "rmdir"
        d.mkdir()
        (d / "child.txt").write_text("x")
        r = client.delete("/rmdir/")
        assert r.status_code == 204
        assert not d.exists()

    def test_delete_missing_returns_404(self, client):
        r = client.delete("/ghost.txt")
        assert r.status_code == 404

    def test_delete_root_rejected(self, client, root):
        (root / "keep.txt").write_text("keep")
        r = client.delete("/")
        assert r.status_code == 403
        assert (root / "keep.txt").read_text() == "keep"

    def test_delete_env_file_rejected(self, client, root):
        (root / ".env").write_text("SECRET=hunter2")
        r = client.delete("/.env")
        assert r.status_code == 403
        assert (root / ".env").read_text() == "SECRET=hunter2"


class TestOptions:
    def test_options_returns_dav_headers(self, client):
        r = client.options("/")
        assert r.status_code == 200
        assert "DAV" in r.headers
        assert "PROPFIND" in r.headers.get("Allow", "")


class TestMkcol:
    def test_mkcol_creates_directory(self, client, root):
        r = client.request("MKCOL", "/newdir")
        assert r.status_code == 201
        assert (root / "newdir").is_dir()

    def test_mkcol_existing_returns_405(self, client, root):
        (root / "exists").mkdir()
        r = client.request("MKCOL", "/exists")
        assert r.status_code == 405

    def test_mkcol_missing_parent_returns_409(self, client, root):
        r = client.request("MKCOL", "/parent/child")
        assert r.status_code == 409

    def test_mkcol_env_directory_rejected(self, client, root):
        r = client.request("MKCOL", "/.env.d")
        assert r.status_code == 403
        assert not (root / ".env.d").exists()


class TestPropfind:
    def test_propfind_root(self, client, root):
        (root / "a.txt").write_text("a")
        r = client.request("PROPFIND", "/", headers={"Depth": "1"})
        assert r.status_code == 207
        assert "a.txt" in r.text
        assert "<D:href>/</D:href>" in r.text
        assert "<D:href>/./</D:href>" not in r.text

    def test_propfind_url_encodes_href_segments(self, client, root):
        (root / "hash#file?.txt").write_text("a")
        (root / "hash#dir?").mkdir()
        r = client.request("PROPFIND", "/", headers={"Depth": "1"})
        assert r.status_code == 207
        assert "<D:href>/hash%23file%3F.txt</D:href>" in r.text
        assert "<D:href>/hash%23dir%3F/</D:href>" in r.text

    def test_propfind_env_file_rejected(self, client, root):
        (root / ".env").write_text("SECRET=hunter2")
        r = client.request("PROPFIND", "/.env")
        assert r.status_code == 403

    def test_get_nested_env_path_rejected(self, client, root):
        (root / ".env.d").mkdir()
        (root / ".env.d" / "secret.txt").write_text("SECRET=nested")
        r = client.get("/.env.d/secret.txt")
        assert r.status_code == 403

    def test_propfind_depth0(self, client, root):
        r = client.request("PROPFIND", "/", headers={"Depth": "0"})
        assert r.status_code == 207

    def test_propfind_infinity_rejected(self, client):
        r = client.request("PROPFIND", "/", headers={"Depth": "infinity"})
        assert r.status_code == 403

    def test_propfind_missing_returns_404(self, client):
        r = client.request("PROPFIND", "/ghost")
        assert r.status_code == 404


class TestLock:
    def test_lock_returns_501(self, client, root):
        (root / "file.txt").write_text("x")
        r = client.request("LOCK", "/file.txt")
        assert r.status_code == 501


class TestPathTraversal:
    def test_traversal_in_url_path_normalized_by_http(self, client):
        # HTTP normalises ../../ in URLs before routing — the path arrives
        # as the normalised form, which simply won't exist under root → 404.
        r = client.get("/../../etc/passwd")
        assert r.status_code == 404

    def test_traversal_in_destination_rejected(self, client, root):
        (root / "src.txt").write_text("src")
        r = client.request(
            "COPY",
            "/src.txt",
            headers={"Destination": "http://localhost/../../etc/passwd"},
        )
        assert r.status_code == 403
