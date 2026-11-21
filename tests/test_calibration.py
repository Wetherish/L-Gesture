import json
from pathlib import Path
import unittest
from unittest.mock import Mock
from l_gesture.calibration import App

from l_gesture.calibration import Session, distance_for, phase_at


class CalibrationTests(unittest.TestCase):
    def test_hold_release_and_repeat_key(self):
        app = App.__new__(App)
        app.root = Mock()
        app.release_job = None
        app.space_down = False
        app.reviewing = False
        app.start = Mock()
        app.end_capture = Mock()
        app.space_press(None)
        app.space_press(None)
        app.start.assert_called_once()
        app.end_capture.assert_not_called()
        app.space_release(None)
        app.release_space()
        app.end_capture.assert_called_once_with(app.released_at)
        self.assertFalse(app.space_down)
        app.reviewing = True
        app.space_press(None)
        app.start.assert_called_once()

    def test_retry_preserves_trial_and_accept_advances(self):
        app = App.__new__(App)
        app.reviewing = True
        app.trial_index = 2
        app.session = Mock()
        app.session.captures = [{"decision": "pending"}]
        app.show_next = Mock()
        app.progress = {}
        app.retry_capture()
        self.assertEqual(app.trial_index, 2)
        self.assertEqual(app.session.captures[-1]["decision"], "rejected")
        app.session.captures.append({"decision": "pending"})
        app.reviewing = True
        app.accept_capture()
        self.assertEqual(app.trial_index, 3)
        self.assertEqual(app.session.captures[-1]["decision"], "accepted")

    def test_manual_capture_boundaries_and_unlimited_wait(self):
        output = Path(__file__).resolve().parents[1] / "captures" / "calibration_tests"
        session = Session(output, "Right", 8765, 100, manual=True)
        message = {"timestamp_ms": 1000, "hands": []}
        session.captures.append({"phase": "single", "trial": 1, "start": 200, "end": 210})
        for stamp in (199, 200, 209, 210, 300):
            session.record(stamp, stamp*1000, message, 8765)
        session.captures.append({"phase": "double", "trial": 1, "start": 400, "end": None})
        session.record(401, 401000, message, 8765)
        session.finish("aborted")
        rows = [json.loads(line) for line in (session.folder / "telemetry.jsonl").read_text().splitlines()]
        self.assertEqual([r["elapsed_s"] for r in rows], [100, 109, 301])
        self.assertEqual([r["instructed_phase"] for r in rows], ["single", "single", "double"])

    def test_phase_boundaries(self):
        for stamp, expected in [(-1, ("countdown", 0)), (0, ("baseline", 0)),
                                (5, ("single", 1)), (28.99, ("single", 6)),
                                (29, ("double", 1)), (52.99, ("double", 6)),
                                (53, ("ordinary_movement", 0)), (63, ("finished", 0))]:
            self.assertEqual(phase_at(stamp), expected)

    def test_missing_and_ambiguous_are_not_closed(self):
        hand = {"handedness": "Right", "index_thumb_distance": .07}
        self.assertEqual(distance_for({"hands": [hand]}, "Right"), (.07, "valid"))
        self.assertEqual(distance_for({"hands": []}, "Right"), (None, "missing"))
        self.assertEqual(distance_for({"hands": [hand, hand]}, "Right"), (None, "ambiguous"))
        hand["index_thumb_distance"] = float("nan")
        self.assertEqual(distance_for({"hands": [hand]}, "Right"), (None, "invalid"))

    def test_records_all_updates_and_bounds_session(self):
        # Synthetic fixtures are kept separate from actual calibration sessions.
        output = Path(__file__).resolve().parents[1] / "captures" / "calibration_tests"
        session = Session(output, "Right", 8765, 100)
        message = {"type": "hand_telemetry", "timestamp_ms": 1000, "hands": [
            {"handedness": "Right", "index_thumb_distance": .07}]}
        session.record(99, 1000, message, 8765)
        session.record(105, 1000, message, 8765)
        session.record(105.033, 1033, dict(message, timestamp_ms=1033, hands=[]), 8765)
        session.record(163, 1000, message, 8765)
        session.finish("aborted")
        summary = json.loads((session.folder / "summary.json").read_text())
        self.assertEqual(summary["frames"], 2)
        self.assertEqual(summary["tracking_counts"]["missing"], 1)
        self.assertEqual(summary["outcome"], "aborted")
        rows = [json.loads(line) for line in (session.folder / "telemetry.jsonl").read_text().splitlines()]
        self.assertEqual(rows[0]["instructed_phase"], "single")
        self.assertEqual(rows[1]["telemetry"]["hands"], [])
