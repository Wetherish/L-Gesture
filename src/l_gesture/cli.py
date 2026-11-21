"""One CLI on Windows and macOS; adapters remain importable without the UI."""

import argparse
import getpass
import json
import os
from pathlib import Path
import sys


def build_parser():
    parser = argparse.ArgumentParser(description="L-Gesture face and hand interaction toolkit")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("cameras", help="List camera names and backend-specific indices")
    for name in ("preview", "face", "hands", "combined"):
        command = sub.add_parser(name, help="Open RGB preview" if name == "preview" else f"Open {name} preview")
        command.add_argument("--camera-name", default="LVNext Camera")
        command.add_argument("--device", type=int, default=None, help="Explicit index overrides camera name")
        command.add_argument("--width", type=int, default=1280)
        command.add_argument("--height", type=int, default=720)
        command.add_argument("--format", choices=("NV12", "MJPG", "YUY2"), default="NV12")
        command.add_argument("--ip", default="192.168.1.10")
        command.add_argument("--mesh", action=argparse.BooleanOptionalAction, default=True)
        command.add_argument("--port", type=int, default=9000)
    check = sub.add_parser("check", help="Check camera SSH and print current AI status")
    check.add_argument("--ip", default="192.168.1.10")
    tracker = sub.add_parser("tracker", help="Install or start the official Hands Tracker app")
    tracker.add_argument("action", choices=("install", "start"))
    tracker.add_argument("--root", type=Path, default=Path.cwd(), help="Project folder containing config/hand_tracker.json")
    return parser


def _credentials():
    # Prompts are local, are never stored, and avoid shell-specific credential commands.
    if not os.environ.get("LOGIWEBCAM_USER"):
        if not sys.stdin.isatty():
            raise RuntimeError("Set LOGIWEBCAM_USER and LOGIWEBCAM_PASSWORD in this process environment")
        os.environ["LOGIWEBCAM_USER"] = input("Camera username: ").strip()
    if not os.environ.get("LOGIWEBCAM_PASSWORD"):
        if not sys.stdin.isatty():
            raise RuntimeError("Set LOGIWEBCAM_PASSWORD in this process environment")
        os.environ["LOGIWEBCAM_PASSWORD"] = getpass.getpass("Camera password (hidden): ")


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.command == "cameras":
            from l_gesture.devices.camera import list_cameras
            for camera in list_cameras():
                print(f"{camera.index}: {camera.name} (backend {camera.backend})")
        elif args.command == "tracker":
            from l_gesture.tracker_app import install_tracker, start_tracker
            (install_tracker if args.action == "install" else start_tracker)(args.root.resolve())
        elif args.command == "check":
            _credentials()
            from l_gesture.vendor.logiinsight.logiwebcam import LogiWebcamClient
            with LogiWebcamClient(ip=args.ip) as camera:
                print(f"Connected. Firmware: {camera.get_firmware_version()}")
                data = camera.get_latest_ai_data()
                print(json.dumps({key: data.get(key) for key in ("plugin_loaded", "timestamp_ms")}) if data else "No AI data yet; open RGB preview.")
        else:
            if args.command in ("face", "combined"):
                _credentials()
            from l_gesture.ui.preview import run_preview
            run_preview(args)
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0
