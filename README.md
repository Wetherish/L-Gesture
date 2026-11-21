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

## Camera Snapshot Studio

A local camera studio for taking snapshots and pinning them over the live video feed.

### Getting started

Requires Node.js 22 or later. Run `npm start` and open [localhost:3000](http://localhost:3000). Allow camera access when prompted. Use the **Camera** menu to switch between connected cameras. Click **Take photo** or **Random photo**, then click **Pin photo**.

Click **Select area** and drag a rectangle over the camera feed. Click **Take photo** to capture that rectangle. **Reset area** restores the centered square. When selecting an area with the keyboard, use the arrow keys to move it, Shift+arrow keys to resize it, and Enter to confirm. The camera feed stays live while you review a snapshot. Drag pinned photos with a mouse or on a touchscreen to move or overlap them. Drag the lower-right corner handle to resize a photo while keeping its proportions.

With a photo focused, press the arrow keys to move it or Delete to remove it. With its resize handle focused, use the arrow keys to resize it. Hold Shift for larger steps.

Share the app window or browser tab during a meeting. The live video stays in the browser, and the server saves a snapshot only when you pin it. Pins are stored in `.data/board.json`. Set `DATA_DIR` to use a different data directory or `PORT` to change the server port.

### Move photos with your hand

Leave **Studio camera gestures** selected and click **Turn on gestures**. The studio downloads the MediaPipe runtime and model on first use and processes the camera frames locally. To use the external tracker, select **Logitech Hand Tracker** and start it with `l-gesture tracker start` on port 9000 before enabling gestures. Move an open hand until the cursor is over a pinned photo, pinch your thumb and index finger together, then move your hand. You can also select a photo first and pinch anywhere away from other photos to grab it. Release the pinch to save the position. The cursor maps the tracker’s hand coordinates to the entire preview, so follow the cursor when the two camera views differ.

### Keyboard and keypad

With the app tab focused, assign these shortcuts through [Logi Options+](https://www.logitech.com/en-us/shop/p/buy-mx-creative-console.920-012660) or send them from another programmable keypad.

| Shortcut | Action |
| --- | --- |
| Shift+N / Shift+B | Select the next / previous photo, including photos covered by others |
| Arrow keys | Move the selected photo |
| Shift+arrow keys | Move in larger steps |
| + / − | Enlarge / shrink the selected photo |
| Delete | Remove the selected photo |
| Shift+V | Toggle the camera |
| Shift+A | Enter or cancel capture area selection |
| Shift+C / Shift+R | Capture a photo / choose a random photo |
| Shift+P / Escape | Pin / discard the draft |

When the resize handle has keyboard focus, the arrow keys resize the photo. Use Shift+N or Shift+B to return focus to a photo and use the arrows for movement.

### Input adapters

A same-page adapter can import `dispatchAction` and `getInteractionState` from `/app.js`. The state includes the selected photo ID, preview bounds, and each photo's ID, position, and bounds. Bounds use viewport CSS pixels. Coordinates passed to `photo.selectAt` use the same units and select the topmost visible photo at that point.

```js
import { dispatchAction, getInteractionState } from '/app.js';

const { preview } = getInteractionState();
const selected = dispatchAction('photo.selectAt', { x: preview.x + 80, y: preview.y + 80 });
if (selected) dispatchAction('photo.move', { dx: 24, dy: -12 });
```

Use `photo.select` with an `id` to target a specific photo, or `photo.next` and `photo.previous` to cycle selection. `photo.move` accepts signed `dx` and `dy` in CSS pixels, and `photo.resize` accepts a signed `delta` in CSS pixels. Both target the current selection by default and accept an explicit `id`. `photo.remove` follows the same targeting rule. Use `crop.set` with normalized `x`, `y`, `width`, and `height` relative to the visible camera feed, or `crop.reset` to restore the default square. Read the current rectangle from `getInteractionState().captureArea`. Camera and draft actions are `camera.toggle`, `draft.capture`, `draft.random`, `draft.pin`, and `draft.discard`. Commands return a boolean or a promise of a boolean for asynchronous operations. For movement and resizing, `true` means the change was accepted locally and queued for persistence.

### API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/samples` | Lists the sample photos. Each entry has an `id`, `title`, and `image`. |
| GET | `/api/pins` | Lists pinned photos. |
| POST | `/api/pins` | Accepts a `sampleId` or an `image` as a JPEG data URL, plus optional `x`, `y`, `size`, and `title` fields. Returns the new pin with status 201. |
| PATCH | `/api/pins/{id}` | Updates any supplied `x`, `y`, or `size` fields and returns the updated pin. |
| DELETE | `/api/pins/{id}` | Removes the pin and returns status 204. |

Coordinates from 0 to 1 describe where the entire pin fits inside the preview. The `size` field is the photo width as a fraction of the preview's shorter side. It must be greater than 0 and at most 1. Error responses contain an `error` field.

The browser module at `/camera.js` exports `openCamera`, `captureSnapshot`, and `closeCamera`.

### Sample photos

- [Camera](https://images.unsplash.com/photo-1516035069371-29a1b244cc32)
- [Notes](https://images.unsplash.com/photo-1531346878377-a5be20888e57)
- [Plant](https://images.unsplash.com/photo-1485955900006-10f4d324d411)
