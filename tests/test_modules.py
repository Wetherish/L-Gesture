import io
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import cv2

from l_gesture.devices.camera import CameraDevice, CameraStream, preferred_backend, select_camera
from l_gesture.gestures.pinch import PinchDetector
from l_gesture.models import HandFrame, HandObservation, Point2D
from l_gesture import tracker_app


def hand(distance, label="Right"):
    point = Point2D(.5, .5)
    return HandObservation(label, point, point, point, distance)


class GestureTests(unittest.TestCase):
    def test_hysteresis_and_hand_loss_release(self):
        detector = PinchDetector()
        self.assertEqual(detector.update(HandFrame(1, (hand(.04),)))[0].kind, "pinch_start")
        self.assertEqual(detector.update(HandFrame(2, (hand(.06),))), [])
        self.assertEqual(detector.update(HandFrame(3, (hand(.09),)))[0].kind, "pinch_end")
        detector.update(HandFrame(4, (hand(.04),)))
        event = detector.update(HandFrame(5, ()))[0]
        self.assertEqual(event.kind, "pinch_end")
        self.assertIsNone(event.position)

    def test_duplicate_labels_cancel_and_unknown_labels_do_not_trigger(self):
        detector = PinchDetector()
        detector.update(HandFrame(1, (hand(.04),)))
        events = detector.update(HandFrame(2, (hand(.04), hand(.04))))
        self.assertEqual([event.kind for event in events], ["pinch_end"])
        self.assertEqual(detector.update(HandFrame(3, (hand(.04, "Unknown"),))), [])

    def test_reset_cancels_pressed_gesture_once(self):
        detector = PinchDetector()
        detector.update(HandFrame(1, (hand(.04),)))
        self.assertEqual(len(detector.reset(2)), 1)
        self.assertEqual(detector.reset(3), [])

    def test_rejects_nonfinite_coordinates_and_timestamp(self):
        with self.assertRaises(ValueError):
            Point2D.from_dict({"x": float("nan"), "y": .5})
        with self.assertRaises(ValueError):
            HandFrame.from_dict({"type": "hand_telemetry", "timestamp_ms": True, "hands": []})


class CameraTests(unittest.TestCase):
    def test_backends_are_platform_specific(self):
        for platform, backend in (("win32", cv2.CAP_DSHOW), ("darwin", cv2.CAP_AVFOUNDATION)):
            with self.subTest(platform=platform), patch("l_gesture.devices.camera.sys.platform", platform):
                self.assertEqual(preferred_backend(), backend)

    def test_named_selection_ignores_builtin_index(self):
        cameras = [CameraDevice(0, "FaceTime Camera", 1200), CameraDevice(2, "LVNext Camera", 1200)]
        with patch("l_gesture.devices.camera.list_cameras", return_value=cameras):
            self.assertEqual(select_camera().index, 2)
            with self.assertRaises(RuntimeError):
                select_camera("Missing Camera")

    def test_capture_is_released_on_failure(self):
        capture = Mock()
        with patch("l_gesture.devices.camera.select_camera", return_value=CameraDevice(0, "LVNext Camera", 1200)), patch("l_gesture.devices.camera.open_camera", return_value=(capture, {})):
            with self.assertRaises(ValueError):
                with CameraStream():
                    raise ValueError("Application error")
        capture.release.assert_called_once()


class PlatformTests(unittest.TestCase):
    def test_official_asset_selection(self):
        self.assertEqual(tracker_app.asset_key("Darwin", "arm64"), "mac-arm64")
        self.assertEqual(tracker_app.asset_key("Darwin", "x86_64"), "mac-x64")
        self.assertEqual(tracker_app.asset_key("Windows", "AMD64"), "win-x64")
        with self.assertRaises(RuntimeError):
            tracker_app.asset_key("Windows", "ARM64")

    def test_launch_paths_and_config_on_both_platforms(self):
        for system in ("Darwin", "Windows"):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "config").mkdir()
                config = {"websocket_port": 9000, "camera_name": "LVNext Camera"}
                (root / "config/hand_tracker.json").write_text(json.dumps(config))
                app = root / ("tools/Hand Tracker.app" if system == "Darwin" else "tools/Hand Tracker/Hand Tracker.exe")
                app.parent.mkdir(parents=True)
                app.touch()
                with patch.object(tracker_app.platform, "system", return_value=system), patch.object(tracker_app.socket, "socket") as socket_mock, patch.object(tracker_app.subprocess, "run") as run, patch.object(tracker_app.subprocess, "Popen") as popen:
                    socket_mock.return_value.__enter__.return_value.bind.return_value = None
                    tracker_app.start_tracker(root)
                    if system == "Darwin":
                        self.assertEqual(run.call_args.args[0][:3], ["open", "-a", str(app)])
                        copied = root / ".hands-tracker-data/config.json"
                    else:
                        popen.assert_called_once_with([str(app)], cwd=str(app.parent))
                        copied = app.parent / "config.json"
                    self.assertEqual(json.loads(copied.read_text()), config)

    def test_busy_port_does_not_launch_or_kill_other_services(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config").mkdir()
            (root / "config/hand_tracker.json").write_text('{"websocket_port": 9000}')
            app = root / "tools/Hand Tracker.app"
            app.parent.mkdir()
            app.touch()
            with patch.object(tracker_app.platform, "system", return_value="Darwin"), patch.object(tracker_app.socket, "socket") as sock, patch.object(tracker_app.subprocess, "run") as run:
                sock.return_value.__enter__.return_value.bind.side_effect = OSError("occupied")
                with self.assertRaisesRegex(RuntimeError, "occupied"):
                    tracker_app.start_tracker(root)
                run.assert_not_called()

    def test_installer_verifies_digest_before_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config").mkdir()
            manifest = {"version": "test", "assets": {"win-x64": {
                "name": "setup.exe", "url": "https://example.invalid/setup.exe", "sha256": "bad"
            }}}
            (root / "config/tracker_release.json").write_text(json.dumps(manifest))
            with patch.object(tracker_app.platform, "system", return_value="Windows"), patch.object(tracker_app.platform, "machine", return_value="AMD64"), patch.object(tracker_app, "urlopen", return_value=io.BytesIO(b"not the installer")), patch.object(tracker_app.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    tracker_app.install_tracker(root)
                run.assert_not_called()

    def test_installer_commands_on_windows_and_macos(self):
        payload = b"mock official installer"
        for system in ("Darwin", "Windows"):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "config").mkdir()
                key = "mac-arm64" if system == "Darwin" else "win-x64"
                suffix = ".dmg" if system == "Darwin" else ".exe"
                manifest = {"version": "test", "assets": {key: {
                    "name": "setup" + suffix, "url": "https://example.invalid/setup" + suffix,
                    "sha256": hashlib.sha256(payload).hexdigest()
                }}}
                (root / "config/tracker_release.json").write_text(json.dumps(manifest))
                destination = root / ("tools/Hand Tracker.app" if system == "Darwin" else "tools/Hand Tracker/Hand Tracker.exe")

                def simulate_install(command, **kwargs):
                    if command[0] == "ditto" or command[0].endswith("setup.exe"):
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.touch()

                with patch.object(tracker_app.platform, "system", return_value=system), patch.object(tracker_app.platform, "machine", return_value="arm64" if system == "Darwin" else "AMD64"), patch.object(tracker_app, "urlopen", return_value=io.BytesIO(payload)), patch.object(tracker_app.subprocess, "run", side_effect=simulate_install) as run:
                    tracker_app.install_tracker(root)
                    commands = [call.args[0] for call in run.call_args_list]
                    if system == "Darwin":
                        self.assertEqual([command[0] for command in commands], ["hdiutil", "ditto", "hdiutil"])
                        self.assertIn("-readonly", commands[0])
                    else:
                        self.assertEqual(commands[0][1:], ["/S", f"/D={destination.parent}"])

    def test_cli_help_and_headless_import(self):
        result = subprocess.run([sys.executable, "-m", "l_gesture", "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("combined", result.stdout)
        result = subprocess.run([sys.executable, "-c", "import sys; from l_gesture.tracking.hands import HandsTracker; assert 'cv2' not in sys.modules"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
