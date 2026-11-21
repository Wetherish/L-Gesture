"""Pinch transitions with hysteresis; no OS input or application side effects."""

from collections import Counter

from l_gesture.models import GestureEvent


class PinchDetector:
    def __init__(self, press_distance=0.05, release_distance=0.08):
        if not 0 <= press_distance < release_distance:
            raise ValueError("Expected 0 <= press distance < release distance")
        self.press_distance = press_distance
        self.release_distance = release_distance
        self._pressed = set()

    def reset(self, timestamp_ms):
        events = [GestureEvent("pinch_end", label, timestamp_ms, None)
                  for label in sorted(self._pressed)]
        self._pressed.clear()
        return events

    def update(self, frame):
        counts = Counter(hand.handedness for hand in frame.hands)
        # Labels are the only identity field. Ignore ambiguous/unknown labels.
        hands = {hand.handedness: hand for hand in frame.hands
                 if counts[hand.handedness] == 1 and hand.handedness in ("Left", "Right")}
        events = []
        for label in sorted(self._pressed - hands.keys()):
            self._pressed.remove(label)
            events.append(GestureEvent("pinch_end", label, frame.timestamp_ms, None))
        for label, hand in hands.items():
            if label not in self._pressed and hand.pinch_distance < self.press_distance:
                self._pressed.add(label)
                events.append(GestureEvent("pinch_start", label, frame.timestamp_ms, hand.midpoint))
            elif label in self._pressed and hand.pinch_distance > self.release_distance:
                self._pressed.remove(label)
                events.append(GestureEvent("pinch_end", label, frame.timestamp_ms, hand.midpoint))
        return events
