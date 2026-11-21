"""Hand telemetry panel; its coordinate space is independent from RGB."""

import cv2
import numpy as np


def screen_point(point, width, height):
    """Protocol x is already mirrored; y grows from bottom to top."""
    x = min(1.0, max(0.0, float(point["x"])))
    y = min(1.0, max(0.0, float(point["y"])))
    return round(x * (width - 1)), round((1 - y) * (height - 1))


def draw_hands_panel(tracker, width=400, height=720):
    panel = np.full((height, width, 3), (28, 25, 22), dtype=np.uint8)
    message, status = tracker.snapshot()

    def label(text, y, color=(220, 220, 220)):
        cv2.putText(panel, text, (14, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

    label("Logitech Hands Tracker", 26)
    label(status, 51)
    if message is None:
        label(f"Start Hand Tracker (port {tracker.port})", 82)
        return panel
    hands = message["hands"]
    label(f"Hands: {len(hands)}  |  pinch distance < 0.06", 78)
    image = message.get("image", {})
    iw, ih = image.get("width", 1024), image.get("height", 768)
    if not isinstance(iw, (int, float)) or not isinstance(ih, (int, float)) or iw <= 0 or ih <= 0:
        iw, ih = 1024, 768
    area_w = width - 28
    area_h = min(height - 235, round(area_w * ih / iw))
    area_w = min(area_w, round(area_h * iw / ih))
    left, top = (width - area_w) // 2, 100
    cv2.rectangle(panel, (left, top), (left + area_w, top + area_h), (90, 90, 90), 1)
    for index, hand in enumerate(hands[:2]):
        try:
            name = hand.get("handedness", "Unknown")
            color = (100, 220, 120) if name == "Left" else (255, 180, 100)
            points = []
            for key, caption in (("thumb_tip", "Thumb"), ("index_tip", "Index"),
                                 ("index_thumb_midpoint", "Mid")):
                x, y = screen_point(hand[key], area_w, area_h)
                point = (left + x, top + y)
                points.append(point)
                cv2.circle(panel, point, 5, color, -1)
                cv2.putText(panel, caption, (point[0] + 7, point[1] - 7),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
            cv2.line(panel, points[0], points[1], color, 2)
            distance = float(hand["index_thumb_distance"])
            pinch = " PINCH" if distance < 0.06 else ""
            label(f"{name}: {distance:.3f}{pinch}", top + area_h + 30 + index * 25, color)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    label("Independent hand-camera coordinates", height - 18)
    return panel


def append_hands_panel(frame, tracker):
    return np.concatenate((frame, draw_hands_panel(tracker, height=frame.shape[0])), axis=1)
