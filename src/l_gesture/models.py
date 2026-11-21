"""Immutable application-facing observations, independent of OpenCV and sockets."""

from dataclasses import dataclass
import math


def finite_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Expected a finite number")
    return float(value)


@dataclass(frozen=True)
class Point2D:
    x: float
    y: float

    @classmethod
    def from_dict(cls, data):
        x, y = finite_number(data["x"]), finite_number(data["y"])
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise ValueError("Hand coordinates must be normalized to [0, 1]")
        return cls(x, y)


@dataclass(frozen=True)
class HandObservation:
    handedness: str
    thumb_tip: Point2D
    index_tip: Point2D
    midpoint: Point2D
    pinch_distance: float

    @classmethod
    def from_dict(cls, data):
        distance = finite_number(data["index_thumb_distance"])
        if distance < 0:
            raise ValueError("Pinch distance must be nonnegative")
        label = data.get("handedness", "Unknown")
        if label not in ("Left", "Right", "Unknown"):
            label = "Unknown"
        return cls(label, Point2D.from_dict(data["thumb_tip"]),
                   Point2D.from_dict(data["index_tip"]),
                   Point2D.from_dict(data["index_thumb_midpoint"]), distance)


@dataclass(frozen=True)
class HandFrame:
    timestamp_ms: float
    hands: tuple[HandObservation, ...]

    @classmethod
    def from_dict(cls, data):
        if data.get("type") != "hand_telemetry" or not isinstance(data.get("hands"), list):
            raise ValueError("Expected a hand_telemetry message")
        if len(data["hands"]) > 2:
            raise ValueError("The tracker protocol supports at most two hands")
        return cls(finite_number(data["timestamp_ms"]),
                   tuple(HandObservation.from_dict(hand) for hand in data["hands"]))


@dataclass(frozen=True)
class GestureEvent:
    kind: str
    handedness: str
    timestamp_ms: float
    position: Point2D | None
