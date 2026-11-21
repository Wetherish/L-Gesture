# L-Gesture

A modular starting point for our LauzHack interaction project, built around the Logitech
LogiInsight webcam. Check the hardware with the provided previews, then build our own
application on the tracking and gesture APIs.

## Features

- **RGB capture:** OpenCV video selected by camera name, without hard-coded indices.
- **Face AI:** onboard face detection and optional 478-point mesh over SSH/SFTP.
- **Hand AI:** official Logitech Hand Tracker running MediaPipe on the computer, publishing
  thumb, index, midpoint and pinch-distance data over a local WebSocket.
- **Gesture events:** reusable `pinch_start` / `pinch_end` rules with hysteresis and hand-loss
  handling. No automatic clicks or other OS input side effects.
- **Optional UI:** RGB, face, hand-only and combined previews on the same APIs.

Windows x64 and macOS Apple Silicon/Intel use the same Python commands. Python 3.11 is
recommended; supported versions are 3.10-3.13. Git, Python and internet are required for
installation. The LogiInsight webcam is required for onboard face AI. First-time camera
permission and approval of the unsigned official app are manual OS steps.

## 1. Clone and install

```sh
git clone https://github.com/Wetherish/L-Gesture.git
cd L-Gesture
```

**macOS:**

```sh
python3 scripts/setup.py --with-tracker
source .venv/bin/activate
```

**Windows PowerShell:**

```powershell
py -3.11 scripts/setup.py --with-tracker
.\.venv\Scripts\Activate.ps1
```

If PowerShell prevents activation, use `.\.venv\Scripts\python.exe -m l_gesture` in
place of `l-gesture` below. On macOS, use `.venv/bin/python -m l_gesture`.
Activation is optional.

Using **uv**? Run `uv sync --python 3.11`, then use `uv run l-gesture tracker install`.
Prefix subsequent commands with `uv run`.

The installer selects the matching official app, verifies its pinned SHA-256 and installs
it under `tools/`. Application binaries and virtual environments are excluded from Git.
See [platform setup](docs/SETUP.md) for OS prompts and manual installation.

## 2. Check the camera

Connect using a USB 3 data cable:

```sh
l-gesture cameras
l-gesture preview
```

The default camera name is `LVNext Camera`. Use `--camera-name "Your Camera Name"` if
needed. `--device 0` is an explicit debugging override; indices change between machines
and reconnects. Close other camera previews. Press **q**, **Escape** or Ctrl+C to quit.

## 3. Start hands

```sh
l-gesture tracker start
l-gesture hands
```

Allow camera access for **Hand Tracker**. Its own window shows the video and skeleton;
our panel displays the published points, distance and a raw `PINCH` flag. It should say
`Connected`. Hands need no SSH credentials or USB-network configuration.

Edit [config/hand_tracker.json](config/hand_tracker.json), then quit Hand Tracker from
its tray/menu bar and restart it to apply changes. Defaults: `LVNext Camera`, full-frame
1280x720, port **9000**. The app is intended for `LVNext CPD Camera`; RGB is configured
as a fallback because CPD was unavailable on the development Mac. RGB detection quality
still needs a live hardware check.

If CPD is available, set `camera_name` to `LVNext CPD Camera` and remove
`camera_resolution` to restore its default IR crop. For another port, update config and
pass the same value, e.g. `l-gesture hands --port 9001`.

## 4. Start onboard face AI

Configure the webcam's **USB Ethernet/NCM adapter**, keeping Wi-Fi separate:

- Computer IP: `192.168.1.20`
- Subnet mask: `255.255.255.0`
- Router/gateway and DNS: empty
- Camera address: `192.168.1.10`

```sh
l-gesture check
l-gesture face
```

The CLI reads `LOGIWEBCAM_USER` and `LOGIWEBCAM_PASSWORD`. If missing, it prompts locally;
the password is hidden and neither value is saved to disk. Use the kit card values.
Never put credentials in source, shared files or chat. Each new command prompts again
unless the environment variables are set for your shell.

Face mesh is on by default. Use `l-gesture face --no-mesh` for boxes only. AI timestamps
update only while the **LogiInsight RGB** stream is being read, not the built-in webcam.

For both trackers, keep Hand Tracker running and use:

```sh
l-gesture combined
```

Hand coordinates use a separate panel because the camera/crop may differ from RGB.
If two apps cannot share RGB capture, use CPD for hands or run modes separately.
Simultaneous capture has not been validated on Windows hardware.

## 5. Build our solution

```sh
python examples/pinch_events.py
```

```python
from l_gesture.gestures.pinch import PinchDetector
from l_gesture.tracking.hands import HandsTracker

detector = PinchDetector()
with HandsTracker(port=9000) as tracker:
    frame = tracker.latest()  # Immutable HandFrame, or None when offline/stale
    if frame is not None:
        for event in detector.update(frame):
            print(event.kind, event.handedness, event.position)
```

The complete example polls continuously and resets active gestures on tracking loss.
Build application behavior in a new module consuming these events; keep camera and
protocol handling in the existing adapters.

## Repository layout

```text
src/l_gesture/
  devices/        Camera discovery and video lifecycle
  tracking/       Face SSH and reconnecting hand telemetry adapters
  gestures/       Gesture rules independent of cameras and UI
  ui/             Optional OpenCV renderers and preview orchestration
  vendor/         Logitech SDK and official WebSocket sample, with notices
  models.py       Immutable observations and gesture events
  tracker_app.py  Cross-platform official app installation/launch
  cli.py          Unified command-line entry point
config/           Camera settings and official release checksums
scripts/          Cross-platform Python environment setup
examples/         Custom gesture consumer and adapted SDK examples
tests/            Hardware-free protocol, gesture and platform tests
docs/             Team setup, architecture and upstream API reference
```

## Tests

```sh
python -m unittest discover -s tests -v
```

CI runs installation and hardware-free tests on Windows and macOS. It does not replace
camera permissions, USB networking or real hardware testing.

Read [architecture](docs/ARCHITECTURE.md), [platform setup](docs/SETUP.md), and
[third-party notices](THIRD_PARTY_NOTICES.md).
