# Architecture and extension points

`devices.camera` owns camera enumeration, selection and capture. It prefers DirectShow
on Windows and AVFoundation on macOS. Names map to backend-specific indices through
`cv2-enumerate-cameras`; it never silently falls back to the built-in webcam.

`tracking.face.FaceTracker` owns the SSH/SFTP client for onboard AI. It configures the
mesh, reads the upstream JSON and reports staleness. Callers must independently keep
`CameraStream.read()` running. Credentials are read from environment variables.

`tracking.hands.HandsTracker` consumes the official local app's WebSocket in a background
thread. It validates messages, reconnects, clears disconnected state and rejects results
older than two seconds. `latest()` returns immutable `HandFrame` data. `snapshot()` returns
the protocol dictionary and status for the diagnostic UI. This module imports neither
OpenCV nor NumPy. The official app owns hand-camera capture and inference.

`models` contains `Point2D`, `HandObservation`, `HandFrame` and `GestureEvent`. Hand x is
already mirrored; y grows bottom-to-top. The official protocol publishes no full 21-point
hand skeleton. Face landmarks belong to the separate RGB pixel coordinate space.

`gestures.pinch.PinchDetector` emits events without I/O. Defaults: press below 0.05,
release above 0.08; values in between preserve state. The UI's `PINCH < 0.06` flag is a
raw diagnostic rather than the stateful event detector. Empty frames end active gestures.
Unknown/duplicate labels cannot identify stable hands and are excluded from gesture
tracking. On `latest() is None`, call `reset()` to cancel active gestures.

`ui` draws face overlays and a separate hand panel. `ui.preview` wires resources using
context managers so cameras/sockets close on exceptions. A headless application can
import trackers and gestures without importing the UI.

`vendor` preserves upstream code and notices: LogiInsight SDK 1.5.2 and the official
Hands Tracker sample. Keep custom behavior outside this directory.

## Add our application

1. Create a module such as `src/l_gesture/apps/our_app.py` with a `main()` function.
2. Import only the adapters and models needed by the application.
3. Route `GestureEvent` objects into its state machine or interaction layer.
4. Keep gesture rules pure and test them with synthetic `HandFrame` observations.
5. Treat hand loss and `pinch_end` with `position=None` as cancellation/release.

Start with `examples/pinch_events.py`, which polls and handles lost tracking. For face
gestures, consume `FaceTracker.latest()` while reading `CameraStream`. Face output stays
the documented SDK dictionary; see [the upstream API](LOGIINSIGHT_API.md).

## Lifecycle

Use `with CameraStream() as camera`, `with FaceTracker() as face` and
`with HandsTracker() as hands`. Construct a new HandsTracker after closing it; it is
single-use. Face AI returns one face; hand telemetry supports up to two hands.

The official tracker is a separate process. A Python preview does not start/stop it.
Use `l-gesture tracker start`, then quit through its tray/menu bar to release the camera.
Hand AI runs on the computer, separate from the webcam's onboard face AI.
