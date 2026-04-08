import hashlib
import secrets
import tempfile
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, model_validator

# Chunked upload defaults
DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024  # 10 GB
DEFAULT_MAX_CHUNK_SIZE = 100 * 1024 * 1024  # 100 MB per chunk
DEFAULT_MAX_CHUNKS = 10_000
DEFAULT_SESSION_TTL_SECONDS = 3600  # 1 hour
DEFAULT_CHUNK_READ_SIZE = 256 * 1024  # 256 KB


class Permission:
    """Permission model for access control.

    Permission hierarchy:
    - read: View files and directories (GET, HEAD, PROPFIND)
    - write: Upload files, create directories, copy (PUT, MKCOL, COPY)
    - admin: Delete and move files (DELETE, MOVE)

    Wildcard "*" allows access to all users.
    Usernames are compared case-insensitively.
    """

    def __init__(
        self,
        read_users: set[str] | None = None,
        write_users: set[str] | None = None,
        admin_users: set[str] | None = None,
    ):
        self.read_users = {
            u.lower() for u in (read_users if read_users is not None else {"*"})
        }
        self.write_users = {u.lower() for u in (write_users or set())}
        self.admin_users = {u.lower() for u in (admin_users or set())}

    def can_read(self, user: str) -> bool:
        if "*" in self.read_users:
            return True
        return user.lower() in self.read_users

    def can_write(self, user: str) -> bool:
        if not self.write_users:
            return False
        if "*" in self.write_users:
            return True
        return user.lower() in self.write_users

    def can_admin(self, user: str) -> bool:
        if not self.admin_users:
            return False
        if "*" in self.admin_users:
            return True
        return user.lower() in self.admin_users


class Settings(BaseModel):
    root_dir: Path
    listen_host: str = "127.0.0.1"
    listen_port: int = 8989
    tmp_dir: Optional[Path] = None
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES
    max_chunk_bytes: int = DEFAULT_MAX_CHUNK_SIZE
    max_chunks: int = DEFAULT_MAX_CHUNKS
    session_ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS
    chunk_read_size: int = DEFAULT_CHUNK_READ_SIZE
    require_auth: bool = False
    user_header: str = "X-Forwarded-User"
    read_users: set[str] = {"*"}  # Default: public read
    write_users: set[str] = set()
    admin_users: set[str] = set()

    @property
    def permission(self) -> Permission:
        return Permission(
            read_users=self.read_users,
            write_users=self.write_users,
            admin_users=self.admin_users,
        )

    @model_validator(mode="after")
    def set_tmp_dir(self) -> "Settings":
        if self.tmp_dir is None:
            salt = secrets.token_hex(4)
            root_str = str(self.root_dir.resolve())
            root_hash = hashlib.sha256((salt + root_str).encode()).hexdigest()[:12]
            self.tmp_dir = (
                Path(tempfile.gettempdir()) / f"xwing-{self.root_dir.name}-{root_hash}"
            )
        return self
