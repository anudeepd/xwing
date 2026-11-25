import codecs
import errno
import os
import re
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

try:
    import grp
    import pwd
except ImportError:  # pragma: no cover - the server targets POSIX hosts
    grp = None  # type: ignore[assignment]
    pwd = None  # type: ignore[assignment]

from .upload_engine import is_staging_name

_IGNORED_SYSTEM_NAMES = {
    ".ds_store",
    "thumbs.db",
    "desktop.ini",
    "ehthumbs.db",
    "__macosx",
    ".spotlight-v100",
    ".temporaryitems",
    ".trashes",
    ".fseventsd",
    ".xwing-uploads",
}

PERMISSION_DENIED = "Permission denied"


@dataclass(frozen=True, slots=True)
class FilesystemFailure:
    status_code: int
    detail: str


def _user_name(identifier: int) -> str:
    if pwd is not None:
        try:
            return str(pwd.getpwuid(identifier).pw_name)
        except (KeyError, OSError):
            pass
    return str(identifier)


def _group_name(identifier: int) -> str:
    if grp is not None:
        try:
            return str(grp.getgrgid(identifier).gr_name)
        except (KeyError, OSError):
            pass
    return str(identifier)


def _effective_identity() -> dict[str, Any]:
    uid = os.geteuid() if hasattr(os, "geteuid") else os.getuid()
    gid = os.getegid() if hasattr(os, "getegid") else os.getgid()
    groups = os.getgroups() if hasattr(os, "getgroups") else [gid]
    return {
        "user": _user_name(uid),
        "group": _group_name(gid),
        "groups": [_group_name(group) for group in groups],
    }


def _can_access(path: Path, bit: int) -> bool:
    try:
        return os.access(path, bit, effective_ids=True)
    except (NotImplementedError, TypeError):
        return os.access(path, bit)
    except OSError:
        return False


def _display_path(root: Path, path: Path) -> str:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return path.name
    return "/" if relative == Path(".") else f"/{relative.as_posix()}"


def _permission_node(
    root: Path,
    role: str,
    path: Path,
    requires: tuple[str, ...],
) -> dict[str, Any]:
    node: dict[str, Any] = {
        "role": role,
        "path": _display_path(root, path),
        "requires": list(requires),
        "exists": False,
    }
    try:
        info = path.lstat()
    except OSError:
        return node
    if stat.S_ISLNK(info.st_mode):
        kind = "symlink"
    elif stat.S_ISDIR(info.st_mode):
        kind = "directory"
    elif stat.S_ISREG(info.st_mode):
        kind = "file"
    else:
        kind = "other"
    node.update(
        {
            "exists": True,
            "kind": kind,
            "owner": _user_name(info.st_uid),
            "group": _group_name(info.st_gid),
            "uid": info.st_uid,
            "gid": info.st_gid,
            "mode": format(stat.S_IMODE(info.st_mode), "04o"),
            "symbolic": stat.filemode(info.st_mode),
            "access": {
                "read": _can_access(path, os.R_OK),
                "write": _can_access(path, os.W_OK),
                "execute": _can_access(path, os.X_OK),
            },
        }
    )
    return node


def _permission_reason(
    nodes: list[dict[str, Any]], process_user: str
) -> str:
    for node in nodes:
        if not node.get("exists"):
            continue
        access = node.get("access", {})
        missing = [
            bit for bit in node.get("requires", []) if not access.get(bit, False)
        ]
        if missing:
            permissions = " and ".join(missing)
            return (
                f"The xwing process account {process_user!r} lacks {permissions} "
                f"permission on the {node['role'].lower()} {node['path']}."
            )
    return (
        "The operating system denied the operation despite the reported mode "
        "bits. An ACL, mount option, immutable flag, or another security layer "
        "may apply."
    )


def filesystem_permission_context(
    root: Path,
    *,
    operation: str,
    requirement: str,
    nodes: Iterable[tuple[str, Path, tuple[str, ...]]],
) -> dict[str, Any]:
    """Facts an administrator needs to explain a filesystem permission denial."""
    process = _effective_identity()
    details = [
        _permission_node(root, role, path, requires)
        for role, path, requires in nodes
    ]
    return {
        "operation": operation,
        "requirement": requirement,
        "reason": _permission_reason(details, str(process["user"])),
        "process": process,
        "nodes": details,
    }


_ERRNO_FAILURES: dict[int, tuple[int, str]] = {
    errno.EACCES: (403, PERMISSION_DENIED),
    errno.EPERM: (403, PERMISSION_DENIED),
    errno.EROFS: (403, "The storage is read-only"),
    errno.ENOENT: (404, "File or folder no longer exists"),
    errno.ENOTDIR: (409, "A parent of that path is not a folder"),
    errno.EISDIR: (409, "A folder already exists at that path"),
    errno.EEXIST: (409, "A file or folder with that name already exists"),
    errno.ENOTEMPTY: (409, "That folder is not empty"),
    errno.EBUSY: (409, "That file or folder is in use"),
    errno.ENAMETOOLONG: (400, "That name is too long"),
    errno.ELOOP: (400, "That path contains a symlink loop"),
    errno.EFBIG: (413, "File too large"),
    errno.ENOSPC: (507, "Not enough space on the server"),
    errno.EDQUOT: (507, "Not enough space on the server"),
}


def filesystem_failure(
    exc: OSError, fallback: str = "The file operation failed"
) -> FilesystemFailure:
    """Translate an OS error into the status and copy an HTTP client should see."""
    if isinstance(exc, PermissionError):
        return FilesystemFailure(403, PERMISSION_DENIED)
    if isinstance(exc, FileNotFoundError):
        return FilesystemFailure(404, "File or folder no longer exists")
    if isinstance(exc, NotADirectoryError):
        return FilesystemFailure(409, "A parent of that path is not a folder")
    if isinstance(exc, IsADirectoryError):
        return FilesystemFailure(409, "A folder already exists at that path")
    if isinstance(exc, FileExistsError):
        return FilesystemFailure(
            409, "A file or folder with that name already exists"
        )
    status, detail = _ERRNO_FAILURES.get(exc.errno or -1, (500, fallback))
    return FilesystemFailure(status, detail)


def is_within_root(root: Path, path: Path) -> bool:
    """True if path resolves under root."""
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


class InvalidPath(ValueError):
    """A user-supplied path that can never name a file (e.g. a NUL byte)."""


def safe_path(root: Path, rel: str, *, follow_final: bool = True) -> Path:
    """Resolve a user-supplied relative path under root, rejecting traversal.

    With ``follow_final=False`` a symlink in the *last* component is returned
    as itself (lstat semantics) so delete/rename/copy act on the link, not its
    target. The parent chain is always resolved and must stay inside root.
    """
    if "\x00" in rel:
        raise InvalidPath("Path contains a NUL byte")
    # Strip leading slashes so Path doesn't treat it as absolute
    cleaned = rel.lstrip("/")
    candidate = root / cleaned
    if (
        not follow_final
        and candidate.name not in ("", ".", "..")
        and candidate.is_symlink()
    ):
        parent = candidate.parent.resolve()
        if not is_within_root(root, parent):
            raise PermissionError(f"Path escapes root: {rel!r}")
        return parent / candidate.name
    resolved = candidate.resolve()
    if not is_within_root(root, resolved):
        raise PermissionError(f"Path escapes root: {rel!r}")
    return resolved


def is_ignored_system_file(path: Path | str) -> bool:
    """True for OS metadata files that should not be stored or shown."""
    name = Path(path).name
    if not name:
        return False
    lowered = name.lower()
    return lowered in _IGNORED_SYSTEM_NAMES or name.startswith("._")


# A crash or restart leaves the hidden staging file of an upload the server no
# longer tracks in its destination directory, where nothing else removes it. A
# live session rewrites its file continuously and expires after the session TTL,
# so one untouched for longer than that belongs to nobody.
_STAGING_FILE_RE = re.compile(r"^\..+\.upload-part-[0-9a-f]{32}$")
DEFAULT_STALE_STAGING_SECONDS = 6 * 3600


def _reap_stale_staging(child: os.DirEntry, stale_after: float) -> None:
    """Delete an abandoned upload staging file; never fails the listing."""
    try:
        if not _STAGING_FILE_RE.match(child.name) or not child.is_file(
            follow_symlinks=False
        ):
            return
        if time.time() - child.stat(follow_symlinks=False).st_mtime < stale_after:
            return
        os.unlink(child.path)
    except OSError:
        pass


def list_dir(
    path: Path, stale_staging_after: float = DEFAULT_STALE_STAGING_SECONDS
) -> list[dict]:
    """Return sorted directory entries as dicts suitable for templates.

    Abandoned upload staging files older than ``stale_staging_after`` seconds
    are removed as a side effect.

    Raises:
        PermissionError: If directory cannot be accessed
        FileNotFoundError: If directory doesn't exist
    """
    try:
        entries = []
        # DirEntry caches metadata supplied by the directory scan. Keeping the
        # complete snapshot in this synchronous function also makes it safe to
        # run the whole operation in a worker thread from the request handler.
        with os.scandir(path) as scan:
            children = list(scan)
        children.sort(key=lambda entry: (not entry.is_dir(), entry.name.lower()))
        for child in children:
            if is_staging_name(child.name):
                _reap_stale_staging(child, stale_staging_after)
                continue
            if is_ignored_system_file(child.name):
                continue
            try:
                child.name.encode("utf-8")
            except UnicodeEncodeError:
                # A non-UTF-8 name cannot be addressed over HTTP or encoded in
                # a response, so it is left out rather than failing the listing.
                continue
            try:
                try:
                    stat = child.stat()
                except OSError as exc:
                    if isinstance(exc, PermissionError):
                        raise
                    # Broken symlink: list the link itself, never fail the page.
                    stat = child.stat(follow_symlinks=False)
                is_dir = child.is_dir()
                child_path = Path(child.path)
                entries.append(
                    {
                        "name": child.name,
                        "url_name": quote(child.name, safe=""),
                        "is_dir": is_dir,
                        "size": stat.st_size,
                        "size_human": "" if is_dir else human_size(stat.st_size),
                        "mtime": stat.st_mtime,
                        "editable": (not is_dir) and is_editable(child_path),
                    }
                )
            except PermissionError:
                # Skip files we can't access - still include directory itself
                entries.append(
                    {
                        "name": child.name,
                        "url_name": quote(child.name, safe=""),
                        "is_dir": child.is_dir(),
                        "size": 0,
                        "size_human": "",
                        "mtime": 0,
                        "editable": False,
                    }
                )
            except OSError:
                # The entry vanished or is unreadable mid-scan: skip it.
                continue
        return entries
    except PermissionError:
        raise


_EDITABLE_EXTS = {
    ".txt",
    ".md",
    ".rst",
    ".csv",
    ".py",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".less",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".conf",
    ".cfg",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".sql",
    ".xml",
    ".dockerfile",
    ".nginx",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".log",
}


# Files at or under this size open fully editable in the browser editor.
# Larger files open as a read-only preview of the first EDITOR_PREVIEW_BYTES
# so a huge file can't OOM the server worker or freeze the browser tab.
EDITOR_FULL_EDIT_MAX = 32 * 1024 * 1024  # 32 MB
EDITOR_PREVIEW_BYTES = 1024 * 1024  # 1 MB


# A file whose head holds a NUL byte or is not valid UTF-8 is binary, whatever
# its name says, and saving it from the text editor would corrupt it.
_BINARY_SNIFF_BYTES = 8192


def _looks_like_text(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            head = handle.read(_BINARY_SNIFF_BYTES)
    except OSError:
        return False
    if b"\x00" in head:
        return False
    try:
        # Incremental so a multi-byte character cut by the sniff window is fine.
        codecs.getincrementaldecoder("utf-8")().decode(head, final=False)
    except UnicodeDecodeError:
        return False
    return True


def is_editable(path: Path) -> bool:
    """True if the file should be opened in the browser editor."""
    if path.name == ".env" or path.name.startswith(".env."):
        return False
    if path.suffix.lower() not in _EDITABLE_EXTS and path.suffix:
        return False
    return _looks_like_text(path)


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n:.1f} PB"
