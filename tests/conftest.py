import pytest
import fastapi.testclient
from importlib.util import find_spec
from starlette.testclient import TestClient as StarletteTestClient

from xwing.app import create_app
from xwing.config import Settings


def TestClient(*args, **kwargs):
    """Create a TestClient with uvloop when available to avoid asyncio portal hangs."""
    if find_spec("uvloop"):
        kwargs.setdefault("backend_options", {"use_uvloop": True})
    return StarletteTestClient(*args, **kwargs)


fastapi.testclient.TestClient = TestClient

_ALL_PERMS_YAML = """\
users:
  "*":
    read: true
    write: true
    delete: true
"""


@pytest.fixture
def root(tmp_path):
    return tmp_path


@pytest.fixture
def tmp_dir(tmp_path):
    d = tmp_path / "tmp"
    d.mkdir()
    return d


@pytest.fixture
def users_yaml(tmp_path):
    f = tmp_path / "users.yaml"
    f.write_text(_ALL_PERMS_YAML)
    return f


@pytest.fixture
def settings(root, tmp_dir, users_yaml):
    return Settings(root_dir=root, tmp_dir=tmp_dir, users_config=users_yaml)


@pytest.fixture
def client(settings):
    app = create_app(settings)
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
