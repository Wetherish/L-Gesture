#!/usr/bin/env python3
"""Verify or restore the exact MediaPipe assets recorded in the checked-in manifest.

Usage:
  python3 scripts/vendor-mediapipe.py --check
  python3 scripts/vendor-mediapipe.py --fetch

No package installation is required. Fetch only restores missing files; a changed
existing file fails verification rather than being silently overwritten. Updating
the SDK/models requires a deliberate manifest update and browser verification.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import urllib.request


ROOT = Path(__file__).resolve().parents[1] / "dist" / "vendor" / "mediapipe"


def download(url: str) -> bytes:
    if not url.startswith("https://"):
        raise ValueError("Vendor downloads must use HTTPS")
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def verify(data: bytes, entry: dict) -> None:
    if len(data) != entry["bytes"]:
        raise ValueError(f"Wrong size: {entry['path']}")
    if hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise ValueError(f"SHA-256 mismatch: {entry['path']}")


def destination(entry: dict) -> Path:
    path = (ROOT / entry["path"]).resolve()
    if ROOT.resolve() not in path.parents:
        raise ValueError("Manifest file path leaves the vendor directory")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="Verify local files without network access")
    action.add_argument("--fetch", action="store_true", help="Restore missing files from pinned, verified sources")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text())
    archive = None
    bundles = {}
    checked = 0
    total = 0
    for entry in manifest["files"]:
        path = destination(entry)
        if path.exists():
            data = path.read_bytes()
        elif args.check:
            raise FileNotFoundError(f"Missing {path}; restore with --fetch")
        elif "bundle" in entry:
            name = entry["bundle"]
            source = manifest["bundles"][name]
            if name not in bundles:
                payload = download(source["url"])
                verify(payload, source)
                bundles[name] = payload
            offset = entry["offset"]
            if not isinstance(offset, int) or offset < 0:
                raise ValueError(f"Invalid bundle offset: {entry['path']}")
            data = bundles[name][offset:offset + entry["bytes"]]
        elif "archive_member" in entry:
            if archive is None:
                runtime = manifest["runtime"]
                payload = download(runtime["url"])
                integrity = "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode()
                if integrity != runtime["integrity"] or hashlib.sha256(payload).hexdigest() != runtime["sha256"]:
                    raise ValueError("MediaPipe package archive integrity check failed")
                archive = tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz")
            member = archive.extractfile(entry["archive_member"])
            if member is None:
                raise ValueError(f"Missing package member: {entry['archive_member']}")
            data = member.read()
        else:
            data = download(entry["url"])
        verify(data, entry)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            # Verify in memory first, then atomically expose the complete asset.
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_bytes(data)
            temporary.replace(path)
        checked += 1
        total += len(data)
    if archive is not None:
        archive.close()
    # Offline checking also proves that the chunks reconstruct the exact
    # upstream task. No transformed or separately converted weights are used.
    for name, source in manifest.get("bundles", {}).items():
        parts = sorted((entry for entry in manifest["files"] if entry.get("bundle") == name),
                       key=lambda entry: entry["offset"])
        payload = bytearray()
        for entry in parts:
            if entry["offset"] != len(payload):
                raise ValueError(f"Non-contiguous bundle parts: {name}")
            payload.extend(destination(entry).read_bytes())
        verify(payload, source)
    print(f"Verified {checked} MediaPipe files ({total:,} bytes), runtime {manifest['runtime']['version']}.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        print(f"MediaPipe assets: {error}", file=sys.stderr)
        raise SystemExit(1)
