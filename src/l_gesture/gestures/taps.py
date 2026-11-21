"""Experimental single/double tap detection from thumb-to-index distance."""

from collections import deque


class TapDetector:
    def __init__(self):
        self.reset()

    def reset(self):
        self.recent = deque()
        self.last_sample = None
        self.low = None
        self.low_at = None
        self.rebound = None

    def update(self, now, distance):
        if distance is None or (self.last_sample is not None and now - self.last_sample > 0.25):
            self.reset()
        if distance is None:
            return None
        self.last_sample = now

        result = self.poll(now)
        self.last_sample = now
        while self.recent and now - self.recent[0][0] > 0.40:
            self.recent.popleft()
        self.recent.append((now, distance))

        if self.rebound is not None:
            self.rebound = max(self.rebound, distance)
            if self.rebound - distance >= 0.004 and distance <= self.low + 0.008:
                self.reset()
                return "double"
        elif self.low is None:
            peak = max(value for _, value in self.recent)
            if peak - distance >= max(0.013, 0.15 * peak):
                self.low, self.low_at = distance, now
        elif distance < self.low:
            self.low, self.low_at = distance, now
        elif distance - self.low >= 0.004:
            self.rebound = distance
        elif now - self.low_at > 0.35:
            # A stationary closed hand does not complete a tap.
            self.reset()
        return result

    def poll(self, now):
        if self.last_sample is not None and now - self.last_sample > 0.25:
            self.reset()
        if self.rebound is not None and now - self.low_at >= 0.35:
            self.reset()
            return "single"
        return None
