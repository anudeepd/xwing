from xwing import audit_store
from xwing.app import create_app
from xwing.config import Settings

from conftest import TestClient


def test_audit_store_records_filters_and_purges(tmp_path):
    db_path = tmp_path / "audit.db"
    audit_store.init_db(db_path)
    audit_store.record_event(
        db_path=db_path, username="alice", method="PUT", path="/notes.txt",
        details="hello", status_code=204, duration_ms=1.5,
    )
    assert audit_store.list_events(db_path, username="alice")[0]["details"] == "hello"
    assert audit_store.purge_events(db_path, 0) == 1


def test_authenticated_text_write_is_audited(root, tmp_dir, users_yaml, tmp_path):
    db_path = tmp_path / "audit.db"
    settings = Settings(
        root_dir=root,
        tmp_dir=tmp_dir,
        users_config=users_yaml,
        require_auth=True,
        trusted_auth_proxies=["testclient"],
        audit_db=db_path,
    )
    with TestClient(create_app(settings)) as client:
        response = client.put(
            "/notes.txt",
            content="hello audit",
            headers={
                "X-Forwarded-User": "alice",
                "Content-Type": "text/plain; charset=utf-8",
            },
        )

    assert response.status_code == 204
    event = audit_store.list_events(db_path, username="alice")[0]
    assert event["path"] == "/notes.txt"
    assert event["details"] == "hello audit"
