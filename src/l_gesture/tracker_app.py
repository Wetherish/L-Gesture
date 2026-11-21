"""Install and launch the official app with project-local, cross-platform settings."""

import hashlib
import json
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import tempfile
from urllib.request import Request, urlopen


def asset_key(system=None, machine=None):
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    if system == "Darwin":
        return "mac-arm64" if machine in ("arm64", "aarch64") else "mac-x64"
    if system == "Windows" and machine in ("amd64", "x86_64"):
        return "win-x64"
    raise RuntimeError("Official app installation supports macOS Apple Silicon/Intel and Windows x64")


def _app_path(root):
    if platform.system() == "Darwin":
        return root / "tools" / "Hand Tracker.app"
    if platform.system() == "Windows":
        return root / "tools" / "Hand Tracker" / "Hand Tracker.exe"
    raise RuntimeError("The official Hand Tracker app supports Windows and macOS")


def install_tracker(root):
    root = Path(root)
    destination = _app_path(root)
    if destination.exists():
        print(f"Already installed: {destination}")
        return
    manifest = json.loads((root / "config" / "tracker_release.json").read_text())
    asset = manifest["assets"][asset_key()]
    with tempfile.TemporaryDirectory(prefix="l-gesture-") as temp:
        temporary = Path(temp)
        download = temporary / asset["name"]
        print(f"Downloading official Hand Tracker {manifest['version']}...", flush=True)
        digest = hashlib.sha256()
        request = Request(asset["url"], headers={"User-Agent": "L-Gesture/0.1"})
        with urlopen(request, timeout=60) as response, download.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != asset["sha256"]:
            raise RuntimeError("Downloaded app checksum differs from the pinned official release")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if platform.system() == "Darwin":
            mount = temporary / "mount"
            mount.mkdir()
            subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint",
                            str(mount), str(download)], check=True)
            try:
                subprocess.run(["ditto", str(mount / "Hand Tracker.app"), str(destination)], check=True)
            finally:
                subprocess.run(["hdiutil", "detach", str(mount)], check=True)
        else:
            # NSIS requires an unquoted /D tail, even with spaces. A normal argument
            # list would quote it. This is a direct Windows CreateProcess call, no shell.
            command = subprocess.list2cmdline([str(download), "/S"])
            subprocess.run(command + f" /D={destination.parent}", check=True)
        if not destination.exists():
            raise RuntimeError(f"Installer did not create {destination}. See docs/SETUP.md for manual installation.")
    print(f"Installed: {destination}")


def start_tracker(root):
    root = Path(root)
    app = _app_path(root)
    if not app.exists():
        raise RuntimeError("Hand Tracker is missing. Run: l-gesture tracker install")
    source = root / "config" / "hand_tracker.json"
    config = json.loads(source.read_text())
    port = config["websocket_port"]
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            raise RuntimeError(f"Port {port} is occupied. If Hand Tracker is already running, use l-gesture hands. "
                               "Otherwise change websocket_port in config/hand_tracker.json and pass --port to previews.") from None
    if platform.system() == "Darwin":
        data = root / ".hands-tracker-data"
        data.mkdir(exist_ok=True)
        shutil.copy2(source, data / "config.json")
        subprocess.run(["open", "-a", str(app), "--args", f"--user-data-dir={data}"], check=True)
    else:
        shutil.copy2(source, app.parent / "config.json")
        subprocess.Popen([str(app)], cwd=str(app.parent))
    print(f"Starting Hand Tracker: camera={config['camera_name']}, port={port}")
    print("Allow camera access. If macOS blocks the unsigned app, use Privacy & Security > Open Anyway.")
    print("The app needs internet for MediaPipe assets on first use; the tray/menu bar has a Quit action.")
