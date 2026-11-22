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

ENGINE_SHA256 = "a2770d86463b7937cd9b203fb72d866aca3a268c2520923dedf7673cd475552b"
CLIENT_SHA256 = "e0b64efd8cc492ecbe556e32919b80a4c37a058aee8adb03763074af39524182"
DROP_ENTRIES_SHA256 = "d7cac4d083628bc81c63215f46663ef9757ddaf5b3ef6908965f9cabd996105d"

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
