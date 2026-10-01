"""WebDAV method handlers (PROPFIND, MKCOL, COPY, MOVE, LOCK, UNLOCK)."""

import os
import shutil
import tempfile
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import anyio
from fastapi import Request, Response

DAV_NS = "DAV:"

ET.register_namespace("D", DAV_NS)


def _dav(tag: str) -> str:
    return f"{{{DAV_NS}}}{tag}"


def _prop_response(href: str, path: Path) -> ET.Element:
    try:
        stat = path.stat()
    except OSError:
        # Broken symlink: describe the link itself (raises if truly gone).
        stat = path.lstat()
    response = ET.Element(_dav("response"))
    ET.SubElement(response, _dav("href")).text = href

    propstat = ET.SubElement(response, _dav("propstat"))
    prop = ET.SubElement(propstat, _dav("prop"))

    if path.is_dir():
        ET.SubElement(prop, _dav("resourcetype")).append(ET.Element(_dav("collection")))
        ET.SubElement(prop, _dav("getcontenttype")).text = "httpd/unix-directory"
        ET.SubElement(prop, _dav("getcontentlength")).text = "0"
    else:
        ET.SubElement(prop, _dav("resourcetype"))
        ET.SubElement(prop, _dav("getcontenttype")).text = "application/octet-stream"
        ET.SubElement(prop, _dav("getcontentlength")).text = str(stat.st_size)

    try:
        dt = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        ET.SubElement(prop, _dav("getlastmodified")).text = dt.strftime(
            "%a, %d %b %Y %H:%M:%S GMT"
        )
    except (OSError, OverflowError, ValueError):
        pass

    ET.SubElement(propstat, _dav("status")).text = "HTTP/1.1 200 OK"
    return response


def _href_for_path(path: Path, root: Path) -> str:
    rel = path.relative_to(root)
    if rel == Path("."):
        return "/"
    href = "/" + "/".join(quote(part, safe="") for part in rel.parts)
    if path.is_dir():
        href += "/"
    return href


def propfind_response(request: Request, path: Path, root: Path) -> Response:
    depth_header = request.headers.get("depth", "1")

    # Sanitize depth header - only accept "0", "1", or "infinity"
    if depth_header not in ("0", "1", "infinity"):
        depth_header = "1"

    # Reject Depth: infinity — not supported, per RFC 4918 §9.1
    if depth_header == "infinity":
        return Response(status_code=403, content="Depth: infinity not supported")

    rel = _href_for_path(path, root)

    multistatus = ET.Element(_dav("multistatus"))
    multistatus.append(_prop_response(rel, path))

    if depth_header != "0" and path.is_dir():
        for child in sorted(path.iterdir()):
            try:
                multistatus.append(_prop_response(_href_for_path(child, root), child))
            except (OSError, UnicodeEncodeError):
                # Vanished entry or a name that cannot be sent as UTF-8: skip it
                # rather than failing the whole listing.
                continue

    xml_bytes = ET.tostring(multistatus, encoding="utf-8", xml_declaration=True)
    return Response(
        content=xml_bytes,
        status_code=207,
        media_type="application/xml; charset=utf-8",
        headers={"DAV": "1, 2"},
    )


def mkcol_response(path: Path) -> Response:
    if path.exists():
        # RFC 4918 keeps 405 for an existing collection; the body is only a
        # human-readable hint because WebDAV clients ignore it.
        return Response(
            status_code=405, content="A folder or file with that name already exists."
        )
    try:
        path.mkdir(parents=False)
    except (FileNotFoundError, NotADirectoryError):
        return Response(status_code=409, content="Parent does not exist")
    return Response(status_code=201)


def _cleanup_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


def _unique_hidden_path(parent: Path, name: str, suffix: str) -> Path:
    return parent / f".{name}.{uuid.uuid4().hex}{suffix}"


def _install_staged_path(staged: Path, dest: Path) -> Path | None:
    """Move ``staged`` onto ``dest``; return the displaced old destination.

    The old destination is renamed to a hidden ``.bak`` first so a failed
    install can put it back. On success the caller owns the returned backup.
    """
    backup = None
    try:
        if os.path.lexists(dest):
            backup = _unique_hidden_path(dest.parent, dest.name, ".bak")
            dest.replace(backup)
        try:
            staged.replace(dest)
        except OSError:
            shutil.move(str(staged), str(dest))
    except Exception:
        if backup is not None and os.path.lexists(backup):
            if os.path.lexists(dest):
                _cleanup_path(dest)
            backup.replace(dest)
        raise
    return backup


async def _dispose_backup(backup: Path | None, dispose) -> None:
    if backup is None:
        return
    if dispose is not None:
        await dispose(backup)
    else:
        await anyio.to_thread.run_sync(_cleanup_path, backup)  # type: ignore[reportAttributeAccessIssue]


async def copy_response(
    src: Path, dest: Path, overwrite: bool, dispose=None
) -> Response:
    """COPY ``src`` to ``dest``.

    An existing destination is displaced (hidden ``.bak``) while the new copy is
    installed and then handed to ``dispose(backup)``; without one it is deleted.
    Returns 204 when something was replaced, 201 otherwise. The caller has
    already validated that ``dest`` is a legal target.
    """
    if not os.path.lexists(src):
        return Response(status_code=404)
    if os.path.lexists(dest) and not overwrite:
        return Response(status_code=412, content="Destination exists")

    # Copy to a unique temp path first, then rename into place.
    try:
        if src.is_symlink() or src.is_dir():
            temp_dest = Path(
                tempfile.mkdtemp(
                    prefix=f".{dest.name}.", suffix=".tmp", dir=dest.parent
                )
            )
            shutil.rmtree(temp_dest)
        else:
            temp_handle = tempfile.NamedTemporaryFile(
                prefix=f".{dest.name}.",
                suffix=".tmp",
                dir=dest.parent,
                delete=False,
            )
            temp_dest = Path(temp_handle.name)
            temp_handle.close()
    except (FileNotFoundError, NotADirectoryError):
        return Response(status_code=409, content="Destination parent does not exist")
    except OSError:
        return Response(status_code=500, content="Copy failed")
    try:
        if src.is_symlink():
            # Copy the link itself, never what it points to.
            os.symlink(os.readlink(src), temp_dest)
        elif src.is_dir():
            await anyio.to_thread.run_sync(
                lambda: shutil.copytree(src, temp_dest, symlinks=True)
            )  # type: ignore[reportAttributeAccessIssue]
        else:
            await anyio.to_thread.run_sync(lambda: shutil.copy2(src, temp_dest))  # type: ignore[reportAttributeAccessIssue]
        backup = await anyio.to_thread.run_sync(_install_staged_path, temp_dest, dest)  # type: ignore[reportAttributeAccessIssue]
    except OSError:
        try:
            _cleanup_path(temp_dest)
        except Exception:
            pass
        return Response(status_code=500, content="Copy failed")
    await _dispose_backup(backup, dispose)
    return Response(status_code=201 if backup is None else 204)


async def move_response(
    src: Path, dest: Path, overwrite: bool, dispose=None
) -> Response:
    """MOVE ``src`` to ``dest``; same replace/dispose contract as COPY."""
    if not os.path.lexists(src):
        return Response(status_code=404)
    if os.path.lexists(dest) and not overwrite:
        return Response(status_code=412, content="Destination exists")

    try:
        backup = await anyio.to_thread.run_sync(_install_staged_path, src, dest)  # type: ignore[reportAttributeAccessIssue]
    except (FileNotFoundError, NotADirectoryError):
        return Response(status_code=409, content="Destination parent does not exist")
    except OSError:
        return Response(status_code=500, content="Move failed")
    await _dispose_backup(backup, dispose)
    return Response(status_code=201 if backup is None else 204)


def lock_response(path: Path) -> Response:
    """Return a minimal exclusive write lock response for Finder-style clients."""
    token = f"opaquelocktoken:{uuid.uuid4()}"
    prop = ET.Element(_dav("prop"))
    lockdiscovery = ET.SubElement(prop, _dav("lockdiscovery"))
    activelock = ET.SubElement(lockdiscovery, _dav("activelock"))
    ET.SubElement(activelock, _dav("locktype")).append(ET.Element(_dav("write")))
    ET.SubElement(activelock, _dav("lockscope")).append(ET.Element(_dav("exclusive")))
    ET.SubElement(activelock, _dav("depth")).text = "infinity"
    ET.SubElement(activelock, _dav("timeout")).text = "Second-3600"
    locktoken = ET.SubElement(activelock, _dav("locktoken"))
    ET.SubElement(locktoken, _dav("href")).text = token
    xml_bytes = ET.tostring(prop, encoding="utf-8", xml_declaration=True)
    return Response(
        content=xml_bytes,
        status_code=200,
        media_type="application/xml; charset=utf-8",
        headers={
            "DAV": "1, 2",
            "Lock-Token": f"<{token}>",
        },
    )


def unlock_response() -> Response:
    return Response(status_code=204)
