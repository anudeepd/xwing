"""CLI entry point for X-wing."""

import logging
import os

import click
import uvicorn

from .config import Settings


@click.group()
@click.version_option(package_name="xwing")
def main():
    """X-wing — simple file sharing server with WebDAV support."""


@main.command()
@click.option(
    "--root",
    required=True,
    type=click.Path(exists=True, file_okay=False),
    help="Root directory to serve.",
)
@click.option("--host", default="127.0.0.1", show_default=True, help="Bind host.")
@click.option("--port", default=8989, show_default=True, help="Bind port.")
@click.option(
    "--open/--no-open",
    "open_browser",
    default=True,
    show_default=True,
    help="Open browser on startup.",
)
@click.option(
    "--max-upload-gb",
    default=None,
    type=float,
    help="Max upload size in GB [default: 10].",
)
@click.option(
    "--max-chunk-mb",
    default=None,
    type=int,
    help="Max chunk size in MB [default: 100].",
)
@click.option(
    "--max-chunks",
    default=None,
    type=int,
    help="Max number of chunks per upload [default: 10000].",
)
@click.option(
    "--session-ttl-minutes",
    default=None,
    type=int,
    help="Session TTL in minutes [default: 60].",
)
@click.option(
    "--require-auth",
    is_flag=True,
    default=False,
    help="Require authentication header (403 if missing and require_auth enabled).",
)
@click.option(
    "--read-users",
    default=None,
    help="Comma-separated users who can read/browse (* for public, empty = default).",
)
@click.option(
    "--write-users",
    default=None,
    help="Comma-separated users who can upload (empty = read-only).",
)
@click.option(
    "--admin-users",
    default=None,
    help="Comma-separated users who can delete/move.",
)
@click.option(
    "--user-header",
    default=None,
    help="Header to read username from [default: X-Forwarded-User].",
)
@click.option(
    "--reload", is_flag=True, default=False, help="Auto-reload on code changes (dev)."
)
@click.option(
    "--ldap-config",
    "ldap_config",
    default=None,
    type=click.Path(exists=True, dir_okay=False, resolve_path=True),
    help="Path to ldapgate YAML config to enable LDAP authentication.",
)
def serve(
    root,
    host,
    port,
    open_browser,
    max_upload_gb,
    max_chunk_mb,
    max_chunks,
    session_ttl_minutes,
    require_auth,
    read_users,
    write_users,
    admin_users,
    user_header,
    reload,
    ldap_config,
):
    """Start the X-wing web server."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )

    url = f"http://{host}:{port}"

    if ldap_config:
        os.environ["XWING_LDAP_CONFIG"] = ldap_config
        click.echo(f"LDAP authentication enabled ({ldap_config})")

    click.echo(f"Starting X-wing at {url}")

    if open_browser:
        import threading
        import time
        import webbrowser

        def _open():
            time.sleep(1.5)
            webbrowser.open(url)

        threading.Thread(target=_open, daemon=True).start()

    kwargs = {
        "root_dir": root,
        "require_auth": require_auth,
        "listen_host": host,
        "listen_port": port,
    }
    if max_upload_gb is not None:
        kwargs["max_upload_bytes"] = int(max_upload_gb * 1024**3)
    if max_chunk_mb is not None:
        kwargs["max_chunk_bytes"] = max_chunk_mb * 1024**2
    if max_chunks is not None:
        kwargs["max_chunks"] = max_chunks
    if session_ttl_minutes is not None:
        kwargs["session_ttl_seconds"] = session_ttl_minutes * 60
    if user_header:
        kwargs["user_header"] = user_header
    if read_users is not None:
        kwargs["read_users"] = set(
            u.strip() for u in read_users.split(",") if u.strip()
        )
    if write_users is not None:
        kwargs["write_users"] = set(
            u.strip() for u in write_users.split(",") if u.strip()
        )
    if admin_users is not None:
        kwargs["admin_users"] = set(
            u.strip() for u in admin_users.split(",") if u.strip()
        )

    if reload:
        os.environ["XWING_ROOT"] = root
        os.environ["XWING_REQUIRE_AUTH"] = str(require_auth)
        os.environ["XWING_LISTEN_HOST"] = host
        os.environ["XWING_LISTEN_PORT"] = str(port)
        if max_upload_gb is not None:
            os.environ["XWING_MAX_UPLOAD_GB"] = str(max_upload_gb)
        if max_chunk_mb is not None:
            os.environ["XWING_MAX_CHUNK_MB"] = str(max_chunk_mb)
        if max_chunks is not None:
            os.environ["XWING_MAX_CHUNKS"] = str(max_chunks)
        if session_ttl_minutes is not None:
            os.environ["XWING_SESSION_TTL_MINUTES"] = str(session_ttl_minutes)
        if read_users is not None:
            os.environ["XWING_READ_USERS"] = read_users
        if write_users is not None:
            os.environ["XWING_WRITE_USERS"] = write_users
        if admin_users is not None:
            os.environ["XWING_ADMIN_USERS"] = admin_users
        if user_header:
            os.environ["XWING_USER_HEADER"] = user_header

        uvicorn.run(
            "xwing.app:create_app_reload",
            host=host,
            port=port,
            factory=True,
            reload=reload,
            log_level="info",
        )
    else:
        settings = Settings(**kwargs)
        from .app import create_app

        app = create_app(settings)
        uvicorn.run(
            app,
            host=host,
            port=port,
            reload=False,
            log_level="info",
        )
