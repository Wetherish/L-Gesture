"""Reconnectable local Logitech Hands Tracker telemetry adapter.

Protocol: https://logitech.github.io/hackathons/logi-hands-tracker/
The hand camera may differ from RGB, so points are never overlaid on RGB pixels.
"""

import json
import socket
import threading
import time

from l_gesture.vendor.hand_tracker_client import WebSocketClient
from l_gesture.models import HandFrame


class HandsTracker:
    def __init__(self, port=9000):
        self.port = port
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._message = None
        self._received = 0.0
        self._status = "Connecting to Hand Tracker"
        self._client = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def _run(self):
        while not self._stop.is_set():
            client = WebSocketClient("127.0.0.1", self.port, timeout=1.0)
            with self._lock:
                self._client = client
            try:
                client.connect()
                # Silence should expire and reconnect, rather than block forever.
                client.sock.settimeout(2.0)
                for raw in client.messages():
                    if self._stop.is_set():
                        break
                    try:
                        message = json.loads(raw)
                    except (ValueError, TypeError):
                        continue
                    if not isinstance(message, dict) or message.get("type") != "hand_telemetry":
                        continue
                    if not isinstance(message.get("hands"), list):
                        continue
                    try:
                        HandFrame.from_dict(message)
                    except (KeyError, ValueError, TypeError):
                        continue
                    with self._lock:
                        self._message = message
                        self._received = time.monotonic()
                        self._status = "Connected"
            except (ConnectionError, OSError) as error:
                with self._lock:
                    self._status = ("Wrong service on this port"
                                    if "WebSocket upgrade refused:" in str(error)
                                    else f"Offline: {type(error).__name__}")
            finally:
                client.close()
                with self._lock:
                    self._client = None
                    self._message = None
                    if self._status == "Connected":
                        self._status = "Disconnected; reconnecting"
            self._stop.wait(1.0)

    def snapshot(self):
        with self._lock:
            if self._message is None:
                return None, self._status
            stamp = self._message.get("timestamp_ms", 0)
            if (time.monotonic() - self._received > 2.0
                    or not isinstance(stamp, (int, float))
                    or abs(time.time() - stamp / 1000) > 2.0):
                return None, "Stale telemetry; waiting"
            return self._message, self._status

    def latest(self):
        """Return an immutable HandFrame, or None when disconnected/stale."""
        message, _ = self.snapshot()
        return HandFrame.from_dict(message) if message is not None else None

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.close()

    def close(self):
        self._stop.set()
        with self._lock:
            client = self._client
            active_socket = client.sock if client is not None else None
            if active_socket is not None:
                try:
                    active_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        if self._thread.ident is not None:
            self._thread.join(timeout=3.0)
