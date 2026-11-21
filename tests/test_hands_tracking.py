"""Protocol integration checks using a local WebSocket server, no camera."""

import base64
import hashlib
import json
import socketserver
import struct
import threading
import time
import unittest

from l_gesture.vendor.hand_tracker_client import WS_GUID
from l_gesture.tracking.hands import HandsTracker
from l_gesture.ui.hands import draw_hands_panel, screen_point


class TelemetryServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self):
        self.payload = {"type": "hand_telemetry", "hands": []}
        self.guard = threading.Lock()
        self.connections = 0
        super().__init__(("127.0.0.1", 0), TelemetryHandler)


class TelemetryHandler(socketserver.BaseRequestHandler):
    def handle(self):
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            request += chunk
        key = next(line.split(":", 1)[1].strip() for line in request.decode().split("\r\n")
                   if line.lower().startswith("sec-websocket-key:"))
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.request.sendall(("HTTP/1.1 101 Switching Protocols\r\n"
                              f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        with self.server.guard:
            self.server.connections += 1
        # Intentionally close each connection to exercise client reconnects.
        try:
            for _ in range(30):
                with self.server.guard:
                    message = dict(self.server.payload)
                message.setdefault("timestamp_ms", time.time() * 1000)
                raw = json.dumps(message).encode()
                header = bytes([0x81, len(raw)]) if len(raw) < 126 else b"\x81\x7e" + struct.pack(">H", len(raw))
                self.request.sendall(header + raw)
                time.sleep(0.02)
        except OSError:
            pass


class HandsTests(unittest.TestCase):
    def test_normalized_mirrored_coordinates(self):
        self.assertEqual(screen_point({"x": 0, "y": 1}, 101, 81), (0, 0))
        self.assertEqual(screen_point({"x": 1, "y": 0}, 101, 81), (100, 80))

    def test_telemetry_empty_hands_stale_and_reconnect(self):
        server = TelemetryServer()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        tracker = HandsTracker(server.server_address[1]).start()

        def wait_for(predicate):
            end = time.monotonic() + 4
            while time.monotonic() < end:
                if predicate():
                    return
                time.sleep(0.02)
            self.fail("Timed out waiting for telemetry condition")

        hand = {"handedness": "Right", "thumb_tip": {"x": .3, "y": .4},
                "index_tip": {"x": .31, "y": .41},
                "index_thumb_midpoint": {"x": .305, "y": .405},
                "index_thumb_distance": .014}
        try:
            wait_for(lambda: tracker.snapshot()[0] is not None)
            self.assertEqual(tracker.snapshot()[0]["hands"], [])
            with server.guard:
                server.payload["hands"] = [hand, hand]  # duplicate labels are legal
            wait_for(lambda: len((tracker.snapshot()[0] or {}).get("hands", [])) == 2)
            self.assertEqual(draw_hands_panel(tracker).shape, (720, 400, 3))
            with server.guard:
                server.payload["hands"] = []
            wait_for(lambda: tracker.snapshot()[0] is not None and tracker.snapshot()[0]["hands"] == [])
            wait_for(lambda: server.connections >= 2 and tracker.snapshot()[0] is not None)
            with server.guard:
                server.payload["timestamp_ms"] = (time.time() - 20) * 1000
            wait_for(lambda: tracker.snapshot()[1] == "Stale telemetry; waiting")
            self.assertIsNone(tracker.snapshot()[0])
        finally:
            tracker.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.assertFalse(tracker._thread.is_alive())


if __name__ == "__main__":
    unittest.main()
