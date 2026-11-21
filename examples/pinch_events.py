"""Replace the print call with your team's application logic; no GUI or SSH needed."""

import time

from l_gesture.gestures.pinch import PinchDetector
from l_gesture.tracking.hands import HandsTracker


def main():
    detector = PinchDetector()
    with HandsTracker(port=9000) as tracker:
        while True:
            frame = tracker.latest()
            events = detector.update(frame) if frame is not None else detector.reset(time.time() * 1000)
            for event in events:
                print(event, flush=True)  # Route events to your game, UI or other solution here.
            time.sleep(0.02)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
