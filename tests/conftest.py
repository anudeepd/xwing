import pytest
from fastapi.testclient import TestClient

from xwing.app import create_app
from xwing.config import Settings


@pytest.fixture
def root(tmp_path):
    return tmp_path


@pytest.fixture
def tmp_dir(tmp_path):
    d = tmp_path / "tmp"
    d.mkdir()
    return d


@pytest.fixture
def settings(root, tmp_dir):
    return Settings(
        root_dir=root, tmp_dir=tmp_dir, write_users={"*"}, admin_users={"*"}
    )


@pytest.fixture
def client(settings):
    app = create_app(settings)
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
