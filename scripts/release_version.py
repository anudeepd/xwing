#!/usr/bin/env python3
"""Read, calculate, and synchronize X-wing release versions."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")


def section_value(contents: str, section: str, key: str) -> str:
    header = re.search(rf"(?m)^\[{re.escape(section)}\]\s*$", contents)
    if header is None:
        raise SystemExit(f"Missing TOML section [{section}]")
    section_contents = contents[header.end() :]
    next_header = re.search(r"(?m)^\[", section_contents)
    if next_header is not None:
        section_contents = section_contents[: next_header.start()]
    match = re.search(rf'(?m)^{re.escape(key)}\s*=\s*"([^"]+)"\s*$', section_contents)
    if match is None:
        raise SystemExit(f"Missing quoted {key} in [{section}]")
    return match.group(1)


def _manifest_text(root: Path) -> tuple[str, str, str, str]:
    return (
        (root / "pyproject.toml").read_text(encoding="utf-8"),
        (root / "xwing/__init__.py").read_text(encoding="utf-8"),
        (root / "uv.lock").read_text(encoding="utf-8"),
        (root / "scripts/package.json").read_text(encoding="utf-8"),
    )


def _read(root: Path) -> tuple[str, dict, dict]:
    pyproject_text, init_text, lock_text, package_text = _manifest_text(root)
    project_name = section_value(pyproject_text, "project", "name")
    version = section_value(pyproject_text, "project", "version")
    if project_name != "xwing":
        raise SystemExit(f"Expected Python distribution 'xwing', got {project_name!r}")
    if not VERSION_RE.fullmatch(version):
        raise SystemExit(f"Expected a stable MAJOR.MINOR.PATCH version, got {version!r}")

    init_matches = re.findall(r"(?m)^__version__\s*=\s*['\"]([^'\"]+)['\"]\s*$", init_text)
    lock_versions = re.findall(
        r'(?m)^\[\[package\]\]\r?\nname = "xwing"\r?\nversion = "([^"]+)"\s*$',
        lock_text,
    )
    package = json.loads(package_text)
    package_lock = json.loads((root / "scripts/package-lock.json").read_text(encoding="utf-8"))
    lock_root = package_lock.get("packages", {}).get("", {})
    versions = {
        "xwing/__init__.py": init_matches[0] if len(init_matches) == 1 else init_matches,
        "uv.lock": lock_versions[0] if len(lock_versions) == 1 else lock_versions,
        "scripts/package.json": package.get("version"),
        "scripts/package-lock.json": package_lock.get("version"),
        "scripts/package-lock.json packages root": lock_root.get("version"),
    }
    names = {
        "scripts/package.json": package.get("name"),
        "scripts/package-lock.json": package_lock.get("name"),
        "scripts/package-lock.json packages root": lock_root.get("name"),
    }
    wrong_names = {name: value for name, value in names.items() if value != "xwing-frontend"}
    mismatches = {name: value for name, value in versions.items() if value != version}
    if wrong_names:
        raise SystemExit(f"Unexpected package names: {wrong_names}")
    if mismatches:
        raise SystemExit(f"Release versions are not synchronized with {version!r}: {mismatches}")
    return version, package, package_lock


def current_version(root: Path = ROOT) -> str:
    return _read(root)[0]


def next_version(root: Path = ROOT, bump: str = "patch") -> str:
    major, minor, patch = map(int, current_version(root).split("."))
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise SystemExit(f"Unsupported version bump: {bump!r}")


def _replace_section_value(contents: str, section: str, key: str, value: str) -> str:
    header = re.search(rf"(?m)^\[{re.escape(section)}\]\s*$", contents)
    if header is None:
        raise SystemExit(f"Missing TOML section [{section}]")
    section_contents = contents[header.end() :]
    next_header = re.search(r"(?m)^\[", section_contents)
    section_end = header.end() + (next_header.start() if next_header is not None else len(section_contents))
    updated, count = re.subn(
        rf'(?m)^({re.escape(key)}\s*=\s*)"[^"]+"\s*$',
        lambda match: f'{match.group(1)}"{value}"',
        contents[header.end() : section_end],
    )
    if count != 1:
        raise SystemExit(f"Expected one {key} in [{section}], found {count}")
    return contents[: header.end()] + updated + contents[section_end:]


def set_version(root: Path, version: str) -> None:
    if not VERSION_RE.fullmatch(version):
        raise SystemExit(f"Expected a stable MAJOR.MINOR.PATCH version, got {version!r}")
    previous, package, package_lock = _read(root)
    pyproject_text, init_text, lock_text, _ = _manifest_text(root)

    pyproject_text = _replace_section_value(pyproject_text, "project", "version", version)
    init_text, init_count = re.subn(
        r"(?m)^(__version__\s*=\s*['\"])[^'\"]+(['\"]\s*)$",
        lambda match: f"{match.group(1)}{version}{match.group(2)}",
        init_text,
    )
    if init_count != 1:
        raise SystemExit(f"Expected one __version__ in xwing/__init__.py, found {init_count}")
    lock_text, lock_count = re.subn(
        r'(?m)(^\[\[package\]\]\r?\nname = "xwing"\r?\nversion = ")[^"]+("\s*$)',
        lambda match: f"{match.group(1)}{version}{match.group(2)}",
        lock_text,
    )
    if lock_count != 1:
        raise SystemExit(f"Expected one xwing version in uv.lock, found {lock_count}")

    package["version"] = version
    package_lock["version"] = version
    package_lock.setdefault("packages", {}).setdefault("", {})["version"] = version
    updated = {
        root / "pyproject.toml": pyproject_text,
        root / "xwing/__init__.py": init_text,
        root / "uv.lock": lock_text,
        root / "scripts/package.json": json.dumps(package, indent=2) + "\n",
        root / "scripts/package-lock.json": json.dumps(package_lock, indent=2) + "\n",
    }
    for path, contents in updated.items():
        path.write_text(contents, encoding="utf-8")

    if current_version(root) != version:
        raise SystemExit(f"Version update failed: {previous!r} -> {version!r}")
    print(f"Synchronized X-wing release version {previous} -> {version}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("current", help="print and validate the synchronized current version")
    next_command = commands.add_parser("next", help="print the next semantic version")
    next_command.add_argument("--bump", choices=("patch", "minor", "major"), default="patch")
    set_command = commands.add_parser("set", help="synchronize all package version files")
    set_command.add_argument("version")
    args = parser.parse_args()
    if args.command == "current":
        print(current_version())
    elif args.command == "next":
        print(next_version(bump=args.bump))
    else:
        set_version(ROOT, args.version)


if __name__ == "__main__":
    main()
