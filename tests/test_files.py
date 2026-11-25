import os
import pytest

from xwing import files as files_module
from xwing.files import (
    InvalidPath,
    filesystem_permission_context,
    human_size,
    is_editable,
    is_ignored_system_file,
    safe_path,
)


class TestSafePath:
    def test_valid_subpath(self, tmp_path):
        result = safe_path(tmp_path, "subdir/file.txt")
        assert result == tmp_path / "subdir" / "file.txt"

    def test_empty_path_returns_root(self, tmp_path):
        assert safe_path(tmp_path, "") == tmp_path

    def test_leading_slash_stripped(self, tmp_path):
        assert safe_path(tmp_path, "/file.txt") == tmp_path / "file.txt"

    def test_traversal_rejected(self, tmp_path):
        with pytest.raises(PermissionError):
            safe_path(tmp_path, "../../etc/passwd")

    def test_traversal_with_leading_slash_rejected(self, tmp_path):
        with pytest.raises(PermissionError):
            safe_path(tmp_path, "/../../../etc/passwd")

    def test_double_dot_in_middle_rejected(self, tmp_path):
        with pytest.raises(PermissionError):
            safe_path(tmp_path, "subdir/../../etc/passwd")

    def test_double_slash_prefix_stays_within_root(self, tmp_path):
        # //etc stripped to etc — resolves within root, not to /etc
        result = safe_path(tmp_path, "//etc")
        assert result == tmp_path / "etc"
        assert str(result).startswith(str(tmp_path))

    def test_symlink_outside_root_rejected(self, tmp_path):
        outside = tmp_path.parent / "outside.txt"
        outside.write_text("secret")
        link = tmp_path / "link.txt"
        link.symlink_to(outside)
        with pytest.raises(PermissionError):
            safe_path(tmp_path, "link.txt")


class TestHumanSize:
    def test_bytes(self):
        assert human_size(0) == "0 B"
        assert human_size(500) == "500 B"
        assert human_size(1023) == "1023 B"

    def test_kilobytes(self):
        assert human_size(1024) == "1.0 KB"
        assert human_size(1536) == "1.5 KB"

    def test_megabytes(self):
        assert human_size(1024 * 1024) == "1.0 MB"

    def test_gigabytes(self):
        assert human_size(1024**3) == "1.0 GB"


class TestIgnoredSystemFiles:
    def test_ignores_os_metadata_names(self):
        for name in (
            ".DS_Store",
            "Thumbs.db",
            "desktop.ini",
            "._notes.txt",
            "__MACOSX",
        ):
            assert is_ignored_system_file(name)

    def test_does_not_ignore_normal_dotfiles(self):
        for name in (".gitignore", ".npmrc", "notes.txt"):
            assert not is_ignored_system_file(name)


class TestIsEditable:
    def test_python_file(self, tmp_path):
        f = tmp_path / "script.py"
        f.write_text("print('hi')")
        assert is_editable(f)

    def test_markdown_file(self, tmp_path):
        f = tmp_path / "README.md"
        f.write_text("# hello")
        assert is_editable(f)

    def test_env_file_not_editable(self, tmp_path):
        f = tmp_path / ".env"
        f.write_text("SECRET=hunter2")
        assert not is_editable(f)

    def test_binary_extension_not_editable(self, tmp_path):
        f = tmp_path / "image.png"
        f.write_bytes(b"\x89PNG\r\n")
        assert not is_editable(f)

    def test_large_text_file_is_editable(self, tmp_path):
        f = tmp_path / "big.txt"
        f.write_bytes(b"x" * (2 * 1024 * 1024 + 1))
        assert is_editable(f)

    def test_extensionless_small_file_editable(self, tmp_path):
        f = tmp_path / "Makefile"
        f.write_text("all:\n\techo hi")
        assert is_editable(f)

    def test_extensionless_large_file_is_editable(self, tmp_path):
        f = tmp_path / "Makefile"
        f.write_bytes(b"x" * (2 * 1024 * 1024 + 1))
        assert is_editable(f)

    def test_nul_byte_means_binary_even_with_a_text_suffix(self, tmp_path):
        f = tmp_path / "notes.txt"
        f.write_bytes(b"text\x00more")
        assert not is_editable(f)

    def test_invalid_utf8_is_not_editable(self, tmp_path):
        f = tmp_path / "latin1"
        f.write_bytes(b"caf\xe9\n")
        assert not is_editable(f)

    def test_multibyte_char_cut_by_the_sniff_window_is_still_text(self, tmp_path):
        f = tmp_path / "wide.txt"
        # 8191 ASCII bytes then a 3-byte character straddling the 8 KiB window.
        f.write_bytes(b"a" * 8191 + "€".encode() + b"tail")
        assert is_editable(f)


class TestSafePathFinalComponent:
    def test_final_symlink_is_followed_by_default(self, tmp_path):
        (tmp_path / "real.txt").write_text("x")
        (tmp_path / "link").symlink_to(tmp_path / "real.txt")
        assert safe_path(tmp_path, "link") == tmp_path / "real.txt"

    def test_final_symlink_is_kept_when_not_following(self, tmp_path):
        (tmp_path / "real.txt").write_text("x")
        (tmp_path / "link").symlink_to(tmp_path / "real.txt")
        assert safe_path(tmp_path, "link", follow_final=False) == tmp_path / "link"

    def test_escaping_final_symlink_can_still_be_addressed_as_itself(self, tmp_path):
        root = tmp_path / "root"
        root.mkdir()
        (root / "out").symlink_to(tmp_path)
        assert safe_path(root, "out", follow_final=False) == root / "out"
        with pytest.raises(PermissionError):
            safe_path(root, "out")

    def test_escaping_parent_chain_is_rejected_when_not_following(self, tmp_path):
        root = tmp_path / "root"
        root.mkdir()
        (root / "out").symlink_to(tmp_path)
        with pytest.raises(PermissionError):
            safe_path(root, "out/file", follow_final=False)

    def test_nul_byte_is_invalid(self, tmp_path):
        with pytest.raises(InvalidPath):
            safe_path(tmp_path, "a\x00b")


class TestFilesystemPermissionContext:
    def test_records_nodes_and_skips_missing_entries(self, tmp_path):
        target = tmp_path / "target.txt"
        target.write_text("x")
        link = tmp_path / "link"
        link.symlink_to(target)
        fifo = tmp_path / "pipe"
        os.mkfifo(fifo)

        context = filesystem_permission_context(
            tmp_path,
            operation="Inspect",
            requirement="Read access.",
            nodes=[
                ("Missing", tmp_path / "missing", ("read",)),
                ("Target", target, ("read",)),
                ("Link", link, ()),
                ("Pipe", fifo, ()),
            ],
        )

        assert context["operation"] == "Inspect"
        assert context["process"]["user"]
        assert context["nodes"][0]["exists"] is False
        assert context["nodes"][1]["mode"] == "0644"
        assert context["nodes"][1]["access"]["read"] is True
        assert context["nodes"][2]["kind"] == "symlink"
        assert context["nodes"][3]["kind"] == "other"

    def test_account_lookup_falls_back_to_the_numeric_id(self, monkeypatch):
        monkeypatch.setattr(
            files_module.pwd,
            "getpwuid",
            lambda _uid: (_ for _ in ()).throw(KeyError()),
        )
        assert files_module._user_name(12345) == "12345"

    def test_group_lookup_falls_back_to_the_numeric_id(self, monkeypatch):
        monkeypatch.setattr(
            files_module.grp,
            "getgrgid",
            lambda _gid: (_ for _ in ()).throw(KeyError()),
        )
        assert files_module._group_name(12345) == "12345"

    def test_access_falls_back_when_effective_ids_are_unsupported(
        self, monkeypatch, tmp_path
    ):
        calls = []

        def access(path, bit, effective_ids=False):
            calls.append(effective_ids)
            if effective_ids:
                raise NotImplementedError
            return True

        monkeypatch.setattr(files_module.os, "access", access)
        assert files_module._can_access(tmp_path, os.R_OK) is True
        assert calls == [True, False]

    def test_access_failure_is_reported_as_denied(self, monkeypatch, tmp_path):
        def deny(*_args, **_kwargs):
            raise OSError("denied")

        monkeypatch.setattr(files_module.os, "access", deny)
        assert files_module._can_access(tmp_path, os.R_OK) is False
