import errno
import stat
from contextlib import contextmanager
from pathlib import Path

import pytest

import xwing.app as app_module
import xwing.upload as upload_module
from conftest import TestClient
from xwing.app import create_app
from xwing.config import Settings
from xwing.files import filesystem_failure


ADMIN = {"X-Forwarded-User": "admin"}


@contextmanager
def path_mode(path: Path, mode: int):
    original = stat.S_IMODE(path.stat().st_mode)
    path.chmod(mode)
    try:
        yield
    finally:
        path.chmod(original)


@pytest.fixture
def fs_client(root, tmp_dir):
    users = root / "users.yaml"
    users.write_text('users:\n  "*": rwd\n  admin: rwd\n')
    settings = Settings(
        root_dir=root,
        tmp_dir=tmp_dir,
        users_config=users,
        admin_users=["admin"],
        trusted_auth_proxies=["testclient"],
    )
    with TestClient(create_app(settings), raise_server_exceptions=False) as client:
        yield client


def test_folder_delete_permission_is_403(fs_client, root):
    folder = root / "other-user-folder"
    folder.mkdir()
    (root / ".xwing-trash").mkdir()

    with path_mode(root, 0o555):
        response = fs_client.delete("/other-user-folder/")

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}
    assert folder.is_dir()


def test_delete_cannot_prepare_trash_is_403(fs_client, root):
    folder = root / "other-user-folder"
    folder.mkdir()

    with path_mode(root, 0o555):
        response = fs_client.delete("/other-user-folder/")

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}
    assert folder.is_dir()


def test_bulk_delete_permission_is_403(fs_client, root):
    folder = root / "other-user-folder"
    folder.mkdir()
    (root / ".xwing-trash").mkdir()

    with path_mode(root, 0o555):
        response = fs_client.post(
            "/_bulk/delete", json={"paths": ["/other-user-folder/"]}
        )

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}
    assert folder.is_dir()


def test_failed_trash_index_write_is_403_and_restores_the_file(
    fs_client, root, monkeypatch
):
    file = root / "kept.txt"
    file.write_text("keep")

    def deny(*args, **kwargs):
        raise PermissionError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(app_module.trash_store, "save_transactions", deny)
    response = fs_client.delete("/kept.txt")

    assert response.status_code == 403
    assert file.read_text() == "keep"


def test_mkcol_permission_is_403(fs_client, root):
    with path_mode(root, 0o555):
        response = fs_client.request("MKCOL", "/new-folder/")

    assert response.status_code == 403
    assert response.text == "Permission denied"
    assert not (root / "new-folder").exists()


def test_move_permission_is_403(fs_client, root):
    source = root / "source.txt"
    source.write_text("source")

    with path_mode(root, 0o555):
        response = fs_client.request(
            "MOVE", "/source.txt", headers={"Destination": "/moved.txt"}
        )

    assert response.status_code == 403
    assert response.text == "Permission denied"
    assert source.read_text() == "source"
    assert not (root / "moved.txt").exists()


def test_copy_permission_is_403(fs_client, root):
    source = root / "source.txt"
    source.write_text("source")

    with path_mode(root, 0o555):
        response = fs_client.request(
            "COPY", "/source.txt", headers={"Destination": "/copy.txt"}
        )

    assert response.status_code == 403
    assert response.text == "Permission denied"
    assert source.read_text() == "source"
    assert not (root / "copy.txt").exists()


def test_put_permission_is_403(fs_client, root):
    with path_mode(root, 0o555):
        response = fs_client.put("/blocked.txt", content=b"blocked")

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}
    assert not (root / "blocked.txt").exists()


def test_put_missing_parent_permission_is_403(fs_client, root):
    with path_mode(root, 0o555):
        response = fs_client.put("/missing/blocked.txt", content=b"blocked")

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}
    assert not (root / "missing").exists()


def test_ignored_system_delete_permission_is_403(fs_client, root):
    ignored = root / ".Trashes"
    ignored.mkdir()

    with path_mode(root, 0o555):
        response = fs_client.delete("/.Trashes")

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}
    assert ignored.is_dir()


def test_missing_ignored_system_delete_is_a_no_op(fs_client):
    response = fs_client.delete("/.DS_Store")

    assert response.status_code == 204


def test_put_out_of_space_is_507(fs_client, monkeypatch):
    def no_space(path):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(upload_module, "_open_staging", no_space)
    response = fs_client.put("/too-large.bin", content=b"x")

    assert response.status_code == 507
    assert response.json() == {"detail": "Not enough space on the server"}


def test_chunked_upload_permission_is_403(fs_client, root):
    from test_upload import init_upload, send_chunk

    upload_id = init_upload(fs_client, "blocked.bin", 1)["upload_id"]

    try:
        with path_mode(root, 0o555):
            response = send_chunk(fs_client, upload_id, 0, b"x")
        assert response.status_code == 403
        assert response.json() == {"detail": "Permission denied"}
    finally:
        fs_client.delete(f"/_upload/{upload_id}")


def test_chunked_upload_write_permission_is_403(fs_client, monkeypatch):
    from test_upload import init_upload, send_chunk

    upload_id = init_upload(fs_client, "blocked.bin", 1)["upload_id"]

    def deny(*args):
        raise PermissionError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(upload_module, "_pwrite_all", deny)
    try:
        response = send_chunk(fs_client, upload_id, 0, b"x")
        assert response.status_code == 403
        assert response.json() == {"detail": "Permission denied"}
    finally:
        fs_client.delete(f"/_upload/{upload_id}")


def test_upload_init_destination_stat_permission_is_403(
    fs_client, root, monkeypatch
):
    locked = root / "locked"
    locked.mkdir()
    original_stat = Path.stat

    def deny(self, *args, **kwargs):
        if self.name == "locked":
            raise PermissionError(errno.EACCES, "Permission denied")
        return original_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", deny)
    response = fs_client.post(
        "/_upload/init", json={"filename": "file.bin", "size": 1, "dir": "/locked"}
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}


def test_chunked_upload_finalize_permission_is_403(fs_client, root):
    from test_upload import init_upload, send_chunk

    upload_id = init_upload(fs_client, "blocked.bin", 1)["upload_id"]
    assert send_chunk(fs_client, upload_id, 0, b"x").status_code == 200

    try:
        with path_mode(root, 0o555):
            response = fs_client.post(f"/_upload/{upload_id}/complete")
        assert response.status_code == 403
        assert response.json()["detail"] == "Permission denied"
        assert not (root / "blocked.bin").exists()
    finally:
        fs_client.delete(f"/_upload/{upload_id}")


def test_restore_permission_is_403_and_keeps_the_transaction(fs_client, root):
    file = root / "restore-me.txt"
    file.write_text("restore")
    transaction = fs_client.delete("/restore-me.txt").json()["transaction_id"]

    with path_mode(root, 0o555):
        denied = fs_client.post(f"/api/restore/{transaction}")

    assert denied.status_code == 403
    assert not file.exists()

    restored = fs_client.post(f"/api/restore/{transaction}")
    assert restored.status_code == 200
    assert file.read_text() == "restore"


def test_unreadable_file_is_403_for_download_and_editor(fs_client, root):
    file = root / "secret.txt"
    file.write_text("secret")

    with path_mode(file, 0):
        download = fs_client.get("/secret.txt")
        editor = fs_client.get("/secret.txt?edit", headers={"Accept": "text/html"})

    assert download.status_code == 403
    assert download.json() == {"detail": "Permission denied"}
    assert editor.status_code == 403
    assert "Permission denied" in editor.text


def test_permission_details_explain_an_unreadable_file(fs_client, root):
    file = root / "secret.txt"
    file.write_text("secret")

    with path_mode(file, 0):
        response = fs_client.get(
            "/secret.txt",
            headers={"X-Xwing-Error-Details": "1"},
        )

    assert response.status_code == 403
    data = response.json()
    assert data["detail"] == "Permission denied"
    technical = data["technical"]
    assert technical["operation"] == "Read file or folder"
    assert "lacks read" in technical["reason"]
    assert technical["process"]["user"]
    target, parent = technical["nodes"][:2]
    assert target["path"] == "/secret.txt"
    assert target["mode"] == "0000"
    assert target["access"]["read"] is False
    assert parent["path"] == "/"
    assert parent["requires"] == ["execute"]


def test_permission_details_explain_a_delete_denial(fs_client, root):
    folder = root / "other-user-folder"
    folder.mkdir()
    (root / ".xwing-trash").mkdir()

    with path_mode(root, 0o555):
        response = fs_client.delete(
            "/other-user-folder/",
            headers={"X-Xwing-Error-Details": "1"},
        )

    assert response.status_code == 403
    technical = response.json()["technical"]
    assert technical["operation"] == "Delete"
    assert "lacks write" in technical["reason"]
    nodes = {node["role"]: node for node in technical["nodes"]}
    assert nodes["Target"]["mode"] == "0755"
    assert nodes["Parent"]["mode"] == "0555"
    assert nodes["Parent"]["access"]["write"] is False
    assert "xwing trash" in nodes


def test_permission_details_cover_bulk_delete_and_mkcol(fs_client, root):
    folder = root / "other-user-folder"
    folder.mkdir()

    with path_mode(root, 0o555):
        bulk = fs_client.post(
            "/_bulk/delete",
            json={"paths": ["/other-user-folder/"]},
            headers={"X-Xwing-Error-Details": "1"},
        )
        mkcol = fs_client.request(
            "MKCOL",
            "/new-folder/",
            headers={"X-Xwing-Error-Details": "1"},
        )

    assert bulk.status_code == 403
    assert bulk.json()["technical"]["operation"] == "Delete"
    assert mkcol.status_code == 403
    mkcol_details = mkcol.json()["technical"]
    assert mkcol_details["operation"] == "Create folder"
    assert mkcol_details["nodes"][0]["role"] == "Parent"


def test_permission_details_cover_put_move_and_copy(fs_client, root):
    source = root / "source.txt"
    source.write_text("source")

    with path_mode(root, 0o555):
        upload = fs_client.put(
            "/upload.txt",
            content=b"data",
            headers={"X-Xwing-Error-Details": "1"},
        )
        moved = fs_client.request(
            "MOVE",
            "/source.txt",
            headers={
                "Destination": "/moved.txt",
                "Overwrite": "F",
                "X-Xwing-Error-Details": "1",
            },
        )
        copied = fs_client.request(
            "COPY",
            "/source.txt",
            headers={
                "Destination": "/copied.txt",
                "Overwrite": "F",
                "X-Xwing-Error-Details": "1",
            },
        )

    assert upload.status_code == 403
    assert upload.json()["technical"]["nodes"][0]["role"] == "Destination folder"
    assert moved.status_code == 403
    assert moved.json()["technical"]["operation"] == "Move"
    assert copied.status_code == 403
    assert copied.json()["technical"]["operation"] == "Copy"
    assert copied.json()["technical"]["nodes"][-1]["role"] == "Destination parent"


def test_editor_read_permission_is_403(fs_client, root, monkeypatch):
    file = root / "secret.txt"
    file.write_text("secret")
    monkeypatch.setattr(app_module, "is_editable", lambda path: True)

    with path_mode(file, 0):
        response = fs_client.get("/secret.txt?edit", headers={"Accept": "text/html"})

    assert response.status_code == 403
    assert "Permission denied" in response.text
    assert "Technical details" in response.text
    assert "secret.txt" in response.text
    assert "xwing process" in response.text


class SurrogateEntry:
    def __init__(self, *, is_dir: bool) -> None:
        self._is_dir = is_dir

    def __str__(self) -> str:
        return "/\udcff"

    def is_dir(self) -> bool:
        return self._is_dir

    def is_symlink(self) -> bool:
        return False


def test_folder_zip_skips_a_non_utf8_entry(fs_client, root, monkeypatch):
    folder = root / "folder"
    folder.mkdir()
    original_rglob = Path.rglob

    def fake_rglob(self, pattern):
        if self == folder:
            return iter([SurrogateEntry(is_dir=True)])
        return original_rglob(self, pattern)

    monkeypatch.setattr(Path, "rglob", fake_rglob)
    response = fs_client.get("/folder/?zip")

    assert response.status_code == 200


def test_selection_zip_skips_a_non_utf8_entry(fs_client, root, monkeypatch):
    folder = root / "folder"
    folder.mkdir()
    original_rglob = Path.rglob

    def fake_rglob(self, pattern):
        if self == folder:
            return iter([SurrogateEntry(is_dir=False)])
        return original_rglob(self, pattern)

    monkeypatch.setattr(Path, "rglob", fake_rglob)
    response = fs_client.post("/_bulk/zip", json={"paths": ["/folder/"]})

    assert response.status_code == 200


def test_duplicate_bulk_paths_are_consumed_once(fs_client, root):
    file = root / "file.txt"
    file.write_text("x")

    response = fs_client.post(
        "/_bulk/zip", json={"paths": ["/file.txt", "/file.txt"]}
    )

    assert response.status_code == 200


def test_plain_download_skips_the_readability_probe_for_other_kinds(
    fs_client, root, monkeypatch
):
    file = root / "regular.txt"
    file.write_text("content")
    original_is_file = Path.is_file

    def is_file(self):
        if self == file:
            return False
        return original_is_file(self)

    monkeypatch.setattr(Path, "is_file", is_file)
    response = fs_client.get("/regular.txt")

    assert response.status_code == 200
    assert response.text == "content"


def test_folder_and_selection_zip_permission_is_403(fs_client, root):
    folder = root / "folder"
    folder.mkdir()
    file = folder / "secret.txt"
    file.write_text("secret")

    with path_mode(file, 0):
        folder_zip = fs_client.get("/folder/?zip")
        bulk_zip = fs_client.post("/_bulk/zip", json={"paths": ["/folder/"]})

    assert folder_zip.status_code == 403
    assert folder_zip.json() == {"detail": "Permission denied"}
    assert bulk_zip.status_code == 403
    assert bulk_zip.json() == {"detail": "Permission denied"}


def test_propfind_permission_is_403(fs_client, root):
    folder = root / "locked-folder"
    folder.mkdir()
    (folder / "child.txt").write_text("x")

    with path_mode(folder, 0):
        response = fs_client.request(
            "PROPFIND", "/locked-folder/", headers={"Depth": "1"}
        )

    assert response.status_code == 403
    assert response.text == "Permission denied"


def test_admin_trash_delete_permission_is_403(fs_client, root):
    file = root / "trashed.txt"
    file.write_text("x")
    transaction = fs_client.delete("/trashed.txt", headers=ADMIN).json()[
        "transaction_id"
    ]
    trash = root / ".xwing-trash"

    with path_mode(trash, 0o555):
        response = fs_client.delete(f"/api/admin/trash/{transaction}", headers=ADMIN)

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}


def test_admin_empty_trash_permission_is_403(fs_client, root):
    file = root / "trashed.txt"
    file.write_text("x")
    fs_client.delete("/trashed.txt", headers=ADMIN)
    trash = root / ".xwing-trash"

    with path_mode(trash, 0o555):
        response = fs_client.delete("/api/admin/trash", headers=ADMIN)

    assert response.status_code == 403
    assert response.json() == {"detail": "Permission denied"}


def test_admin_restore_permission_is_403_and_keeps_the_transaction(fs_client, root):
    file = root / "restore-me.txt"
    file.write_text("restore")
    transaction = fs_client.delete("/restore-me.txt", headers=ADMIN).json()[
        "transaction_id"
    ]

    with path_mode(root, 0o555):
        denied = fs_client.post(
            f"/api/admin/trash/{transaction}/restore", headers=ADMIN
        )

    assert denied.status_code == 403
    assert not file.exists()
    retried = fs_client.post(f"/api/admin/trash/{transaction}/restore", headers=ADMIN)
    assert retried.status_code == 200
    assert file.read_text() == "restore"


@pytest.mark.parametrize(
    ("error", "status", "detail"),
    [
        (PermissionError(errno.EACCES, "denied"), 403, "Permission denied"),
        (FileNotFoundError(errno.ENOENT, "gone"), 404, "File or folder no longer exists"),
        (
            NotADirectoryError(errno.ENOTDIR, "not a directory"),
            409,
            "A parent of that path is not a folder",
        ),
        (
            IsADirectoryError(errno.EISDIR, "is a directory"),
            409,
            "A folder already exists at that path",
        ),
        (
            FileExistsError(errno.EEXIST, "exists"),
            409,
            "A file or folder with that name already exists",
        ),
        (OSError(errno.EROFS, "read-only"), 403, "The storage is read-only"),
        (OSError(errno.ENOSPC, "full"), 507, "Not enough space on the server"),
        (OSError(errno.EDQUOT, "quota"), 507, "Not enough space on the server"),
        (OSError(errno.ENAMETOOLONG, "long"), 400, "That name is too long"),
        (OSError(errno.ELOOP, "loop"), 400, "That path contains a symlink loop"),
        (OSError(errno.EFBIG, "big"), 413, "File too large"),
        (OSError(errno.EIO, "io"), 500, "Delete failed"),
    ],
)
def test_filesystem_failure_maps_common_errors(error, status, detail):
    failure = filesystem_failure(error, fallback="Delete failed")

    assert failure.status_code == status
    assert failure.detail == detail
