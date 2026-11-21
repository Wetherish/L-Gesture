"""Guided, local-only recording of the official Hand Tracker's telemetry.

No camera capture, inference, or OS-input injection. Standard library only.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import queue
import statistics
import threading
import time
import uuid

from l_gesture.gestures.taps import TapDetector
from l_gesture.vendor.hand_tracker_client import WebSocketClient


def phase_at(elapsed):
    """Return instructed phase/trial, not a claim about the gesture performed."""
    if elapsed < 0:
        return "countdown", 0
    if elapsed < 5:
        return "baseline", 0
    if elapsed < 29:
        return "single", int((elapsed - 5) // 4) + 1
    if elapsed < 53:
        return "double", int((elapsed - 29) // 4) + 1
    if elapsed < 63:
        return "ordinary_movement", 0
    return "finished", 0


def distance_for(message, label):
    matches = [h for h in message.get("hands", []) if h.get("handedness") == label]
    if not matches:
        return None, "missing"
    if len(matches) != 1:
        return None, "ambiguous"
    value = matches[0].get("index_thumb_distance")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, "invalid"
    if not math.isfinite(value) or value < 0:
        return None, "invalid"
    return float(value), "valid"


class Session:
    def __init__(self, output, hand, port, start, manual=False):
        self.start = start
        self.manual = manual
        self.captures = []
        self.hand = hand
        self.port = port
        name = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
        self.folder = Path(output) / name
        self.folder.mkdir(parents=True)
        self.raw = (self.folder / "telemetry.jsonl").open("w", encoding="utf-8", buffering=1)
        self.table = (self.folder / "distances.csv").open("w", newline="", encoding="utf-8")
        self.csv = csv.writer(self.table)
        self.csv.writerow(["elapsed_s", "tracker_timestamp_ms", "received_unix_ms",
                           "instructed_phase", "trial", "selected_hand", "distance",
                           "tracking_status", "right_distance", "left_distance", "port"])
        self.rows = []
        self.last_stamp = None
        self.duplicates = 0
        self.closed = False
        self.write_summary("recording")

    def record(self, received, unix_ms, message, port):
        elapsed = received - self.start
        if self.manual:
            capture = next((c for c in reversed(self.captures)
                            if received >= c['start'] and (c['end'] is None or received < c['end'])), None)
            if capture is None:
                return
            phase, trial = capture['phase'], capture['trial']
        else:
            if elapsed < 0 or elapsed >= 63:
                return
            phase, trial = phase_at(elapsed)
        distance, status = distance_for(message, self.hand)
        stamp = message.get("timestamp_ms")
        if stamp == self.last_stamp:
            self.duplicates += 1
        self.last_stamp = stamp
        self.raw.write(json.dumps({"elapsed_s": elapsed, "received_unix_ms": unix_ms,
                                   "instructed_phase": phase, "trial": trial,
                                   "port": port, "telemetry": message}) + "\n")
        self.csv.writerow([elapsed, stamp, unix_ms, phase, trial, self.hand,
                           distance, status, distance_for(message, "Right")[0],
                           distance_for(message, "Left")[0], port])
        self.table.flush()
        self.rows.append((elapsed, distance, status, stamp))

    def write_summary(self, outcome):
        intervals = [b[0] - a[0] for a, b in zip(self.rows, self.rows[1:]) if b[0] > a[0]]
        source_intervals = [(b[3] - a[3]) / 1000 for a, b in zip(self.rows, self.rows[1:])
                            if isinstance(a[3], (int, float)) and isinstance(b[3], (int, float))
                            and b[3] > a[3]]
        counts = {s: sum(r[2] == s for r in self.rows)
                  for s in ("valid", "missing", "ambiguous", "invalid")}
        summary = {"outcome": outcome, "saved_utc": datetime.now(timezone.utc).isoformat(),
                   "selected_tracker_label_for_actual_right_hand": self.hand,
                   "initial_port": self.port, "frames": len(self.rows), "tracking_counts": counts,
                   "consecutive_duplicate_timestamps": self.duplicates,
                   "median_receive_interval_ms": statistics.median(intervals)*1000 if intervals else None,
                   "median_tracker_interval_ms": statistics.median(source_intervals)*1000 if source_intervals else None,
                   "receive_gaps_over_200ms": sum(x > .2 for x in intervals),
                   "largest_receive_gap_ms": max(intervals)*1000 if intervals else None,
                   "protocol": "Hold Space to capture; release to review; accept or retry; 6 single and 6 double captures" if self.manual else "5s baseline; 6 single trials of 4s; 6 double trials of 4s; 10s ordinary movement",
                   "capture_windows": [{**c, 'start': c['start']-self.start,
                                        'end': c['end']-self.start if c['end'] is not None else None}
                                       for c in self.captures],
                   "gaps_include_user_pauses": self.manual,
                   "notes": ["Trial labels describe prompts, not verified gesture ground truth.",
                             "Distance is the published 2D normalized value; existing tracker smoothing is retained.",
                             "Missing/ambiguous hands are not converted to zero; no resampling or interpolation.",
                             "All received telemetry, including both hands, is preserved in telemetry.jsonl."]}
        (self.folder / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    def finish(self, outcome):
        if not self.closed:
            self.raw.close()
            self.table.close()
            self.write_summary(outcome)
            self.closed = True


class Receiver:
    def __init__(self, ports):
        self.ports = ports
        self.events = queue.Queue()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        while not self.stop.is_set():
            for port in self.ports:
                client = WebSocketClient("127.0.0.1", port, timeout=1)
                try:
                    client.connect()
                    client.sock.settimeout(2)
                    for raw in client.messages():
                        received, unix_ms = time.monotonic(), time.time()*1000
                        if self.stop.is_set():
                            return
                        try:
                            message = json.loads(raw)
                            if not isinstance(message, dict) or message.get("type") != "hand_telemetry":
                                continue
                            if not isinstance(message.get("hands"), list) or not all(isinstance(h, dict) for h in message["hands"]):
                                continue
                            stamp = message.get("timestamp_ms")
                            if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
                                continue
                            self.events.put((received, unix_ms, message, port))
                        except (ValueError, TypeError):
                            continue
                except (OSError, ConnectionError):
                    pass
                finally:
                    client.close()
            self.stop.wait(.5)


class App:
    def __init__(self, root, ports, output):
        import tkinter as tk
        from tkinter import ttk
        self.root, self.output = root, output
        self.receiver = Receiver(ports)
        self.session = None
        self.latest = None
        self.history = []
        self.last_phase = None
        self.saved = None
        self.trial_index = 0
        self.capturing = False
        self.space_down = False
        self.release_job = None
        self.reviewing = False
        self.capture_events = []
        self.tap_detector = TapDetector()
        self.tap_source = None
        self.light_reset = None
        root.title("L-Gesture - gesture calibration")
        root.geometry("900x660")
        root.minsize(760, 600)
        frame = ttk.Frame(root, padding=20)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Calibrate your right-hand gesture", font=("Segoe UI", 20, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Keep Hands Tracker running. This window records coordinates only, not video.").pack(anchor="w", pady=5)
        self.status = tk.StringVar(value="Waiting for tracker on ports " + ", ".join(map(str, ports)))
        ttk.Label(frame, textvariable=self.status).pack(anchor="w")
        row = ttk.Frame(frame)
        row.pack(fill="x", pady=10)
        ttk.Label(row, text="Tracker label for your actual RIGHT hand:").pack(side="left")
        self.hand = tk.StringVar(value="Right")
        self.selector = ttk.Combobox(row, textvariable=self.hand, values=("Right", "Left"), state="readonly", width=8)
        self.selector.pack(side="left", padx=10)
        ttk.Label(frame, text="Before starting: move only your right thumb/index. Choose the label whose distance changes.").pack(anchor="w")
        self.values = tk.StringVar(value="Right: --    Left: --")
        ttk.Label(frame, textvariable=self.values, font=("Consolas", 14)).pack(anchor="w", pady=7)
        lights = tk.Canvas(frame, height=46, width=300, highlightthickness=0)
        lights.pack(anchor="w")
        self.tap_lights = lights
        self.lamp_ids = {
            "single": lights.create_oval(5, 5, 37, 37, fill="#234135"),
            "double": lights.create_oval(151, 5, 183, 37, fill="#502b30"),
        }
        lights.create_text(45, 21, anchor="w", text="Single tap")
        lights.create_text(191, 21, anchor="w", text="Double tap")
        self.prompt = tk.StringVar(value="Next: SINGLE closure - 1 / 6")
        ttk.Label(frame, textvariable=self.prompt, font=("Segoe UI", 17, "bold"), wraplength=840).pack(anchor="w", pady=10)
        self.detail = tk.StringVar(value="HOLD SPACE while performing the gesture. Release to see the captured pattern, then accept or retry.")
        ttk.Label(frame, textvariable=self.detail, wraplength=840).pack(anchor="w")
        self.graph = tk.Canvas(frame, bg="#101827", height=220, highlightthickness=0)
        self.progress = ttk.Progressbar(frame, maximum=12)
        self.progress.pack(fill="x")
        controls = ttk.Frame(frame)
        controls.pack(fill="x", pady=12)
        self.start_button = ttk.Button(controls, text="Accept and next", command=self.accept_capture, state="disabled", takefocus=False)
        self.start_button.pack(side="left")
        self.retry_button = ttk.Button(controls, text="Retry this trial", command=self.retry_capture, state="disabled", takefocus=False)
        self.retry_button.pack(side="left", padx=10)
        self.stop_button = ttk.Button(controls, text="Stop and save partial", command=lambda: self.finish("aborted"), state="disabled")
        self.stop_button.pack(side="left", padx=10)
        self.path_text = tk.StringVar(value="Files stay in captures/calibration/ within this repository.")
        ttk.Label(frame, textvariable=self.path_text, wraplength=840).pack(anchor="w")
        self.graph.pack(fill="both", expand=True, pady=12)
        root.bind_class("CaptureKeys", "<KeyPress-space>", self.space_press)
        root.bind_class("CaptureKeys", "<KeyRelease-space>", self.space_release)
        def bind_keys(widget):
            widget.bindtags(("CaptureKeys",) + widget.bindtags())
            for child in widget.winfo_children():
                bind_keys(child)
        bind_keys(root)
        root.bind("<FocusOut>", self.focus_lost)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(30, self.tick)

    def space_press(self, event):
        if self.release_job:
            self.root.after_cancel(self.release_job)
            self.release_job = None
        if not self.space_down:
            self.space_down = True
            if not self.reviewing:
                self.start()
        return "break"

    def space_release(self, event):
        self.released_at = time.monotonic()
        self.release_job = self.root.after_idle(self.release_space)
        return "break"

    def release_space(self):
        self.space_down = False
        self.release_job = None
        self.end_capture(getattr(self, "released_at", time.monotonic()))

    def focus_lost(self, event):
        # A release outside this app may never arrive. End safely if focus leaves it.
        self.root.after_idle(self.check_focus)

    def check_focus(self):
        if self.root.focus_displayof() is None and self.capturing:
            self.space_down = False
            self.end_capture(time.monotonic())
            self.detail.set("Window lost focus: capture stopped. Review it or Retry.")

    def end_capture(self, ended):
        if not self.capturing:
            return
        self.session.captures[-1]["end"] = ended
        self.capturing = False
        self.reviewing = True
        self.drain_events()
        self.prompt.set(f"Review: {self.session.captures[-1]['phase'].upper()} - {self.trial_index % 6 + 1} / 6")
        self.detail.set("Captured pattern is frozen below. Accept and next, or Retry this trial.")
        self.start_button.configure(state="normal")
        self.retry_button.configure(state="normal")
        self.session.write_summary("recording")

    def accept_capture(self):
        if not self.reviewing:
            return
        self.session.captures[-1]["decision"] = "accepted"
        self.reviewing = False
        self.trial_index += 1
        self.progress["value"] = self.trial_index
        if self.trial_index == 12:
            self.finish("complete")
        else:
            self.show_next()
            self.session.write_summary("recording")

    def retry_capture(self):
        if not self.reviewing:
            return
        self.session.captures[-1]["decision"] = "rejected"
        self.reviewing = False
        self.session.write_summary("recording")
        self.show_next()

    def show_next(self):
        phase = "SINGLE" if self.trial_index < 6 else "DOUBLE"
        trial = self.trial_index % 6 + 1
        self.prompt.set(f"Next: {phase} closure - {trial} / 6")
        self.detail.set("HOLD SPACE to capture this gesture; RELEASE to review. No time limit.")
        self.start_button.configure(state="disabled")
        self.retry_button.configure(state="disabled")

    def drain_events(self):
        while True:
            try:
                event = self.receiver.events.get_nowait()
            except queue.Empty:
                break
            self.latest = event
            self.history.append(event)
            received, _, message, port = event
            hand = self.hand.get()
            source = (port, hand)
            if source != self.tap_source:
                self.tap_detector.reset()
                self.tap_source = source
            self.flash_tap(self.tap_detector.update(received, distance_for(message, hand)[0]))
            if self.session:
                self.session.record(*event)
                if self.session.captures:
                    capture = self.session.captures[-1]
                    if event[0] >= capture["start"] and (capture["end"] is None or event[0] < capture["end"]):
                        self.capture_events.append(event)

    def start(self):
        if not self.latest or time.monotonic() - self.latest[0] > .5:
            self.detail.set("No fresh telemetry. Start Hands Tracker and keep your hand visible.")
            return
        if abs(self.latest[1] - self.latest[2]["timestamp_ms"]) > 2000:
            self.detail.set("Tracker timestamps are stale. Restart Hands Tracker before recording.")
            return
        if distance_for(self.latest[2], self.hand.get())[1] != "valid":
            self.detail.set("The selected hand must be visible and unambiguous before starting.")
            return
        try:
            if self.session is None:
                self.trial_index = 0
                self.progress["value"] = 0
                self.session = Session(self.output, self.hand.get(), self.latest[3], time.monotonic(), manual=True)
        except OSError as error:
            self.detail.set(f"Cannot create recording: {error}")
            return
        self.selector.configure(state="disabled")
        phase = "single" if self.trial_index < 6 else "double"
        trial = self.trial_index % 6 + 1
        self.session.captures.append({"phase": phase, "trial": trial, "start": time.monotonic(), "end": None, "attempt": len(self.session.captures)+1, "decision": "pending"})
        self.capture_events = []
        self.capturing = True
        self.prompt.set(f"RECORDING: {phase.upper()} - {trial} / 6")
        self.detail.set("Keep holding SPACE. Close-open ONCE, then release SPACE." if phase == "single" else "Keep holding SPACE. Close-open-close-open TWICE, then release SPACE.")
        self.start_button.configure(state="disabled")
        self.retry_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.last_phase = None
        self.path_text.set(str(self.session.folder))

    def finish(self, outcome):
        if self.session:
            if self.capturing:
                self.session.captures[-1]["end"] = time.monotonic()
                self.capturing = False
            self.drain_events()
            self.session.finish(outcome)
            self.saved = self.session.folder
            self.prompt.set("Recording saved" if outcome == "complete" else "Partial recording saved")
            counts = len(self.session.rows)
            self.detail.set(f"Saved {counts} tracker updates. Tell ChatGPT 'done' to analyze them.")
            self.path_text.set(str(self.saved))
            self.session = None
            self.selector.configure(state="readonly")
            self.reviewing = False
            self.start_button.configure(state="disabled")
            self.retry_button.configure(state="disabled")
            self.stop_button.configure(state="disabled")

    def clear_tap_lights(self):
        self.light_reset = None
        self.tap_lights.itemconfigure(self.lamp_ids["single"], fill="#234135")
        self.tap_lights.itemconfigure(self.lamp_ids["double"], fill="#502b30")

    def flash_tap(self, result):
        if result is None:
            return
        if self.light_reset is not None:
            self.root.after_cancel(self.light_reset)
        self.clear_tap_lights()
        color = "#20dc72" if result == "single" else "#ff404b"
        self.tap_lights.itemconfigure(self.lamp_ids[result], fill=color)
        self.light_reset = self.root.after(500, self.clear_tap_lights)

    def tick(self):
        try:
            self.drain_events()
        except OSError as error:
            self.detail.set(f"Cannot save data: {error}. Stop recording and check disk space.")
        now = time.monotonic()
        self.flash_tap(self.tap_detector.poll(now))
        self.history = [e for e in self.history if now-e[0] < 8]
        fresh = self.latest and now-self.latest[0] < .5
        if fresh:
            self.status.set(f"Connected to Hands Tracker on port {self.latest[3]}")
            parts = []
            for label in ("Right", "Left"):
                value, status = distance_for(self.latest[2], label)
                parts.append(f"{label}: {value:.4f}" if value is not None else f"{label}: {status}")
            self.values.set("     ".join(parts))
        else:
            self.status.set("Waiting for fresh tracker data - check that Hands Tracker is running")
            self.values.set("Right: --    Left: -- (no fresh data)")
        self.draw(now)
        self.root.after(30, self.tick)

    def draw(self, now):
        canvas = self.graph
        canvas.delete("all")
        w, h = max(100, canvas.winfo_width()), max(80, canvas.winfo_height())
        frozen = self.reviewing or (self.saved is not None and self.session is None)
        events = self.capture_events if frozen or self.capturing else self.history
        if (frozen or self.capturing) and self.session and self.session.captures:
            capture = self.session.captures[-1]
            left, right = capture["start"], capture["end"] or now
        elif frozen and events:
            left, right = events[0][0], events[-1][0]
        else:
            left, right = now-8, now
        span = max(.001, right-left)
        values = [distance_for(e[2], self.hand.get())[0] for e in events]
        top = max(.15, max((v for v in values if v is not None), default=0)*1.15)
        canvas.create_text(10, 12, anchor="nw", fill="white", text=f"{'Captured pattern' if frozen else 'Recording' if self.capturing else 'Live preview'} | {span:.2f}s | distance 0 to {top:.3f}")
        previous = None
        canvas.create_text(20, h-5, anchor="sw", fill="white", text="0 s")
        canvas.create_text(w-15, h-5, anchor="se", fill="white", text=f"{span:.2f} s")
        if not any(v is not None for v in values):
            canvas.create_text(w/2, h/2, fill="white", text="No valid hand samples - keep your hand visible and retry")
        for e, value in zip(events, values):
            if value is None:
                previous = None
                continue
            point = (20+(e[0]-left)/span*(w-35), h-20-value/top*(h-55))
            if previous and e[0]-previous[0] < .2:
                canvas.create_line(*previous[1], *point, fill="#40d8bc", width=2)
            previous = (e[0], point)

    def close(self):
        self.finish("aborted")
        self.receiver.stop.set()
        self.root.destroy()


def main():
    import tkinter as tk
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, help="Use a specific local tracker port; otherwise try 8765 and 9000")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2]/"captures"/"calibration")
    args = parser.parse_args()
    root = tk.Tk()
    App(root, [args.port] if args.port else [8765, 9000], args.output)
    root.mainloop()


if __name__ == "__main__":
    main()
