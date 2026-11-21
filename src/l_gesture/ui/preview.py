"""Optional OpenCV windows; application logic can use trackers without this module."""

from contextlib import ExitStack
import time

import cv2

from l_gesture.devices.camera import CameraStream
from l_gesture.tracking.face import FaceTracker
from l_gesture.tracking.hands import HandsTracker
from l_gesture.ui.face import draw_overlays
from l_gesture.ui.hands import append_hands_panel, draw_hands_panel


def run_preview(args):
    title = "L-Gesture - q/ESC to quit"
    try:
        with ExitStack() as stack:
            hands = stack.enter_context(HandsTracker(args.port)) if args.command in ("hands", "combined") else None
            face = stack.enter_context(FaceTracker(args.ip, args.mesh)) if args.command in ("face", "combined") else None
            camera = None
            if args.command != "hands":
                camera = stack.enter_context(CameraStream(args.camera_name, args.device,
                                                         args.width, args.height,
                                                         pixel_format=args.format))
                print(f"Camera: {camera.info}", flush=True)
            cv2.namedWindow(title, cv2.WINDOW_NORMAL)
            previous = time.monotonic()
            last_frame = previous
            while True:
                if camera is None:
                    frame = draw_hands_panel(hands)
                else:
                    frame = camera.read()
                    if frame is None:
                        if time.monotonic() - last_frame > 15:
                            raise RuntimeError("No camera frames for 15 seconds. Check the USB link and other camera apps.")
                        if cv2.waitKey(10) & 255 in (ord("q"), 27):
                            break
                        continue
                    last_frame = time.monotonic()
                    if face is not None:
                        data, warning = face.latest()
                        if warning:
                            print(f"WARNING: {warning}", flush=True)
                        h, w = frame.shape[:2]
                        draw_overlays(frame, data, w, h, args.mesh)
                    now = time.monotonic()
                    fps = 1 / max(now - previous, 1e-6)
                    previous = now
                    cv2.putText(frame, f"FPS: {fps:.1f}", (10, frame.shape[0] - 15),
                                cv2.FONT_HERSHEY_SIMPLEX, .6, (0, 255, 255), 2)
                    if hands is not None:
                        frame = append_hands_panel(frame, hands)
                cv2.imshow(title, frame)
                if cv2.waitKey(30 if camera is None else 1) & 255 in (ord("q"), 27):
                    break
    finally:
        cv2.destroyAllWindows()
