"""Pins the vendored copies of the shared upload engine.

``xwing/upload_engine.py``, ``xwing/frontend/src/upload-engine.js`` and
``xwing/frontend/src/drop-entries.js`` are duplicated verbatim into torrus.
When any of them changes, change both copies and update the digest here: the
digest is what keeps the two engines identical.

Recompute with:

    sha256sum xwing/upload_engine.py xwing/frontend/src/upload-engine.js \
        xwing/frontend/src/drop-entries.js
"""

import hashlib
from pathlib import Path

from xwing import upload_engine

ENGINE_SHA256 = "e33b231fab8e8eb5479e3a2a064e3c1d456221a4ae63933fabe36aec71857c8f"
CLIENT_SHA256 = "8e417c263d6b59587ee0adcda25300610bfb71b7f9989cf385c78445508a798b"
DROP_ENTRIES_SHA256 = "2377c6323ad1851e2737b5e4af4552b4b260d891a3ae55bc028d3150b5498c7c"

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_python_engine_matches_the_shared_digest():
    digest = hashlib.sha256(Path(upload_engine.__file__).read_bytes()).hexdigest()
    assert digest == ENGINE_SHA256, (
        "upload_engine.py drifted from the copy in torrus/src/torrus/upload_engine.py; "
        "update both files and this digest together"
    )


def test_client_engine_matches_the_shared_digest():
    client = REPO_ROOT / "xwing" / "frontend" / "src" / "upload-engine.js"
    digest = hashlib.sha256(client.read_bytes()).hexdigest()
    assert digest == CLIENT_SHA256, (
        "frontend upload-engine.js drifted from torrus/frontend/src/lib/upload-engine.js; "
        "update both files and this digest together"
    )


def test_drop_traversal_matches_the_shared_digest():
    traversal = REPO_ROOT / "xwing" / "frontend" / "src" / "drop-entries.js"
    digest = hashlib.sha256(traversal.read_bytes()).hexdigest()
    assert digest == DROP_ENTRIES_SHA256, (
        "frontend drop-entries.js drifted from torrus/frontend/src/lib/drop-entries.js; "
        "update both files and this digest together"
    )
