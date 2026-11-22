# Roofcat local services

Run this bridge on the computer that has the cameras connected. It serves the
same Roofcat web app at **http://127.0.0.1:9040** and adds native video and
LogiInsight face data. Your ordinary MacBook camera also works directly in the
web app without a bridge or Logitech credentials.

## Optional NVIDIA GPU segmentation

The GPU service is independent of the camera bridge. It runs on **127.0.0.1:9041**,
never opens a camera, and supports gaze-guided **SAM 2.1 Tiny, Base+ and Large**.
The browser sends one frozen search image and point, then receives an actual mask.
The app keeps RGB playback and all existing live pins running independently.

### Windows quick start

1. Extract the complete kit. Install 64-bit Python **3.11, 3.12 or 3.13**, with the
   Python launcher, if it is not already available.
2. Double-click **`bridge/start-gpu-windows.cmd`**. Leave its window open.
3. Return to the live Roofcat app, click the **eye icon → Check GPU**, then choose
   **SAM 2.1 Base+** or another installed model. Allow the browser's local-network
   permission if requested. The displayed GPU name comes from the running service.

The launcher creates a separate **`.venv-gpu`** and installs PyTorch **2.9.1**,
torchvision **0.24.1** from the official CUDA **12.8** wheel index, and Transformers
**4.57.3**. The wheel includes the required CUDA runtime; install/update the NVIDIA
driver if the actual device check fails. This workflow uses the native Transformers
image implementation, so it does not require WSL or building a custom CUDA extension.

First setup downloads all three public Meta models by default: Tiny **156 MB**,
Base+ **323 MB**, and Large **898 MB**, plus several GB of Python/CUDA dependencies.
No Hugging Face account or API key is required. Models are cached in
`%LOCALAPPDATA%/Roofcat/models` on Windows or `~/.cache/roofcat/models` elsewhere,
outside the repository and ZIP. Rerunning setup reuses verified files.

From PowerShell in the extracted project folder, a targeted installation is:

```powershell
py -3.12 bridge/setup_gpu.py --model base-plus
```

Replace `base-plus` with `tiny`, `large`, or `all`. Add `--setup-only` to install
without starting the service, or `--models-only` to download verified model files
without installing packages. After setup, start the service directly with:

```powershell
.\.venv-gpu\Scripts\python.exe bridge/gpu_server.py
```

The default origin allowlist includes the hosted Roofcat app and the local camera
bridge app. For another deployment, add `--allow-origin https://your-exact-origin`
to the server command. Binding remains loopback-only. The service rejects unrelated
Origin and Host headers; it has no wildcard CORS setting. Browser versions may
block HTTPS-to-loopback access; in that case use the local app at port 9040, whose
saved captures belong to that separate origin.

### Model integrity and lifecycle

Official Meta SAM 2.1 weights use the Apache 2.0 license. Every model revision,
weight hash and configuration hash is pinned in `gpu_models.py`. Setup verifies
downloads before accepting them, and the service verifies model files before
loading. Inference uses local safetensors only, with remote code disabled and
Hugging Face in offline mode. An HTTP request cannot install a model.

`GET /api/segmentation/status` reports actual CUDA availability, device name, free
and total GPU memory, installed models, the loaded model and busy state.
`POST /api/segmentation/segment` accepts a bounded PNG plus normalized point and
returns a matching request ID/model/revision, a row-major binary RLE mask, actual
predicted mask IoU and measured latency. Predicted IoU describes mask quality;
it is neither an object-category confidence nor a gaze-accuracy score.

Only one model and one image job are resident at a time, with no waiting image
queue. Changing models unloads the old model first. Requests have bounded sizes
and deadlines; a timed-out or disconnected HTTP request does not free a still-running
GPU worker. CUDA memory failures unload the model and report an actionable error.
Explicitly selecting a GPU model never silently uses CPU or another model.
Automatic may report a browser fallback after a local service failure.

No input images or masks are saved, logged or uploaded. The service receives only
requested frozen images and cannot enumerate the user's camera devices. Stop it
with **Ctrl+C**. On macOS use the browser model; `start-gpu-macos.command` explains
the NVIDIA requirement without installing CUDA.

References: [Meta SAM 2](https://github.com/facebookresearch/sam2),
[official Large model](https://huggingface.co/facebook/sam2.1-hiera-large),
[Transformers image API](https://huggingface.co/docs/transformers/v4.57.3/model_doc/sam2),
[official PyTorch wheels](https://pytorch.org/get-started/previous-versions/).

## Start the camera bridge on macOS

Unzip the complete kit, then double-click **`bridge/start-macos.command`**. It
creates an isolated `.venv` inside that folder and installs the bridge dependencies,
including the macOS camera inventory adapter. Python 3.10 or newer must already
be installed; the launcher gives a clear error if it cannot find it. The first
dependency installation and the optional object-model download need internet access.
The launcher restores the object model from its pinned source and verifies its SHA-256.
If that optional download fails, the native bridge still starts and the hosted app remains usable.
Retry `python scripts/vendor-mediapipe.py --fetch` from the activated environment to enable local object capture.

Keep its Terminal open, return to your **existing hosted Aperture tab**, open
**Camera**, and click **Discover**. The advanced **Find native streams** button in
Controls also runs native discovery. The launcher allows the exact hosted origin
`https://aperture-camera-lab.batikanor.chatgpt.site`; it does not open another tab
by default. Your browser board and captures remain in the same origin. No kit
credentials are required for camera inventory or video, and the launcher never
asks for them. To open a tab deliberately, run `bash bridge/start-macos.command --open`.
If double-clicking the script does not launch Terminal, run
`bash bridge/start-macos.command` from the unzipped project folder.

For another deployment, set `APERTURE_APP_ORIGIN` to its exact HTTP(S) origin
before launching. No wildcard or remote listening interface is enabled. If an
older bridge is already running, the launcher identifies it and leaves it alone;
stop that Terminal with Control-C before starting the updated kit.

### Manual setup

Keep the `bridge` and `dist` directories next to each other, then run from the
project directory:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r bridge/requirements.txt
python scripts/vendor-mediapipe.py --fetch
python bridge/bridge.py --allow-origin https://aperture-camera-lab.batikanor.chatgpt.site
```

Return to the hosted app to retain its saved board. You can also open
**http://127.0.0.1:9040** as a separate local workspace; browser storage is separate
for that origin. Allow the browser to use your camera.
For native capture, macOS must also allow the terminal that starts Python under
**System Settings → Privacy & Security → Camera**. No device is opened until you
request a preview or a probe. Ctrl+C stops the bridge and releases its cameras.

The named macOS inventory reads AVFoundation device names, unique IDs, advertised
dimensions, media subtypes and frame-rate ranges without opening a camera. It
also reports the Terminal/Python camera permission as authorized, not determined,
denied or restricted. Inventory availability does **not** establish that frames
can be read. If the first OS permission prompt outlasts a capture timeout, grant
the permission and retry. A failed request from the browser can also mean CORS or
local-network access was blocked; it does not prove that the bridge is stopped.

Python 3.10 or newer is required. The bridge defaults to DirectShow on Windows,
AVFoundation on macOS, and V4L2 on Linux.

## Start on Windows

Open PowerShell in the unzipped project folder and run these commands. They use
the isolated environment directly, so no PowerShell activation-policy change is
needed:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r bridge\requirements.txt
.\.venv\Scripts\python.exe bridge\bridge.py --allow-origin https://aperture-camera-lab.batikanor.chatgpt.site
```

Install Python 3.10 or newer first if `py` is unavailable. Keep this terminal
open, return to the existing hosted Roofcat tab, then choose **Camera → Discover**.
This retains that tab's saved captures. Allow the browser's local-network access
prompt when it requests access to the bridge. Windows must also allow desktop
apps to use the camera; listing an input does not establish permission to read it.

The Windows-only `pygrabber` and `comtypes` dependencies read DirectShow's actual
video-device names and `DevicePath` identities without opening capture. A named
**LVNext CPD Camera** can then be attempted separately while the existing RGB
preview remains open. CPD is not created if Windows does not enumerate it, and a
restricted Hello entry can still fail its frame attempt. No RGB/IR role is inferred
from an index or a requested image size. The inventory does not enumerate Windows
formats; each requested mode is checked against frames and driver settings.

After upgrading an existing kit, rerun the dependency-install command before
restarting its bridge. Missing adapters return `windows_inventory_missing`; a
driver/COM enumeration failure returns `windows_inventory_failed`, with no
substituted device names. Manual numeric probes remain available. The optional
local web app needs `scripts/vendor-mediapipe.py --fetch` to restore any omitted
model asset; the hosted app already has its assets and does not require that step.

## Connect the LogiInsight AI data

RGB and infrared video use ordinary USB camera interfaces. The on-device face
box and mesh use a separate USB network connection and SFTP.

1. Plug the kit camera into a USB 3 port with a USB 3 cable.
2. In macOS Network settings, find the new USB/LVNext network adapter and set its
   IPv4 address to `192.168.1.20`, subnet mask `255.255.255.0`. Leave router and DNS
   empty. The camera's documented address is `192.168.1.10`.
3. Set `LOGIWEBCAM_USER` and `LOGIWEBCAM_PASSWORD` in the terminal running the
   bridge, using the values on the kit card. The bridge never asks the browser
   for credentials. Do not put credentials in app files or upload them.
4. Trust the physical camera's SSH host key once using
   `sftp USER_FROM_KIT_CARD@192.168.1.10`. Verify and accept the camera's key, then
   type `bye`. The bridge checks your `~/.ssh/known_hosts`; it does not silently
   accept unknown or changed keys. You can select another host-key file with
   `LOGIWEBCAM_KNOWN_HOSTS`.
5. Restart the bridge in that terminal and open the RGB camera in Aperture.
   In the landmark input, connect to `ws://127.0.0.1:9040/ws`.
6. Enable the face mesh through the AI configuration controls or the request
   below. The camera's default mesh setting is off.

To enter the kit values without placing them in shell history on macOS's default
zsh shell:

```zsh
read -r "LOGIWEBCAM_USER?Kit username: "
read -rs "LOGIWEBCAM_PASSWORD?Kit password: "
export LOGIWEBCAM_USER LOGIWEBCAM_PASSWORD
python bridge/bridge.py
```

The RGB stream must remain open for fresh AI results. The bridge emits a stale
status if the camera timestamp does not advance for two seconds. These timestamps
come from the camera's wrapping clock; they are not host UTC timestamps.

For Wi-Fi subnet collisions, local-network permission failures, old firmware, or
USB adapter setup, use Logitech's
[official quick start and connection checker](https://logitech.github.io/hackathons/logiinsight/).
An alternate kit address can be selected with `--camera-ip` or `LOGIWEBCAM_IP`.

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Local bridge version, configured capabilities, active indexes; does not contact a camera. |
| `GET /api/camera/inventory?backend=auto` | Reads named macOS AVFoundation devices and formats, or named Windows DirectShow devices and identities, without capture; Linux lists actual video nodes. Other backends return an explicit inventory-unavailable status. |
| `GET /api/devices?max_index=8` | Explicitly attempts native indexes 0 through 7 using the requested backend/settings and reports every success/failure. `start_index` selects a different starting index. No camera names or roles are guessed from indexes. |
| `GET /api/camera/status?index=0` | Reads an already-open stream's exact job identity, actual settings, frame sequence and capture age; never opens or closes a reader. |
| `GET /api/frame?index=0` | Opens that exact native camera, returns one PNG, releases the device. Negotiated settings are in `X-Camera-Settings`. |
| `GET /api/video?index=0` | Streams JPEG frames as MJPEG until the connection closes, then releases that camera. |
| `GET /api/landmarks` | Latest unmodified Logitech API v2 JSON; HTTP 202 when no JSON exists yet. |
| `WS /ws` | Automatically subscribes to on-device AI data at up to 15 polls/second; no subscribe message required. |
| `GET /api/ai/config` | Reads the four documented AI booleans. |
| `POST /api/ai/config` | Writes supplied AI booleans while preserving unspecified values. |
| `GET /api/ai/diagnostics` | Reads AI configuration, availability, timestamp, face count and snapshot write status. |
| `GET /api/ai/snapshot` | Briefly enables a paired NV12 snapshot, returns PNG + matching AI JSON, and restores the previous snapshot setting. |
| `GET /api/ai/firmware` | Attempts the official SDK's firmware reader when that optional SDK is installed. |
| `GET /api/audio/devices` | Lists native microphone indexes and supported maximum channel counts; no recording. |
| `POST /api/audio/record` | Records a short raw PCM WAV from the exact selected native microphone. |

`/api/frame` and `/api/video` also accept `width`, `height`, `fps`,
`fourcc=MJPG|YUY2|NV12`, `backend=auto|avfoundation|v4l2|dshow|msmf|any`, and
`warmup=0..30`. The probe endpoint honors the same settings. Camera indexes are integers 0–31, probe counts are 1–32, frame
dimensions are 16–4096 and requested FPS is 1–240. Native driver operations run
in separate processes so an unresponsive camera can be stopped on timeout.
The default first-frame timeout is seven seconds; use `--camera-timeout 15`
if a permission prompt takes longer, then retry the request.

### Native preview progress

Bridge 1.2.0 adds read-only progress fields to `/api/camera/status`:
`job_id`, `matches`, `match_error`, `frame_sequence`, `frame_age_ms`, and
`timeout_ms`. The existing `active` and `settings` fields remain. A new capture
has a unique `job_id`, sequence zero, and a null frame age until its first encoded
camera frame arrives. `active` alone only means a job exists; it does not prove
that a camera is delivering frames.

Check the initial status with the same `index`, `backend`, and observed
`device_uid` used in `/api/video`. Retain its `job_id` and supply that ID on later
status polls. `matches: false` means the reader ended, its job was replaced, or
the requested backend/device identity differs. Status checks leave all readers
untouched, including an unmatched replacement or the primary camera.

`frame_age_ms` measures elapsed time since the native driver's actual frame read,
including any processing/queue delay. Polling status does not refresh it.
`frame_sequence` advances for real encoded frames and may skip values because
the queue keeps only recent frames. It is not a configured or measured FPS value.
`timeout_ms` is the configured wait limit for the next native frame (7,000 ms by
default). A stopped MJPEG connection can leave its last image visible in the
browser; checking job identity and advancing frames prevents that image from
being mistaken for a continuing live preview.

On macOS an inventory row's `unique_id` can be supplied as `device_uid`. Before
opening capture, the bridge checks that this exact ID still occupies that
AVFoundation index. A hotplug-induced mismatch returns `camera_identity_changed`
and requires a fresh inventory, rather than silently opening a different camera.
Index ordering matches OpenCV 4.x: video devices followed by muxed devices. An
AVFoundation identity always selects that backend, including with `backend=any`.

On Windows the inventory preserves DirectShow's raw video-moniker order, including
entries whose metadata could not be read. A row's `unique_id` is its observed
`DevicePath`, not its friendly name. Supplying it as `device_uid` rechecks the ID
at that exact index before capture and forces `CAP_DSHOW`, including with
`backend=auto` or `backend=any`. A moved or replaced device returns
`camera_identity_changed`. The bridge rejects `backend=msmf` with a DirectShow
identity: MSMF can have a different device order. If a device lacks a readable ID,
its row remains visible with an explicit metadata error; refresh discovery before
any unverified numeric attempt after hotplug. Permission remains `unknown` until
capture is attempted, and a failed probe remains a failure.

The identity mapping follows Microsoft's
[DirectShow device enumeration](https://learn.microsoft.com/en-us/windows/win32/directshow/selecting-a-capture-device)
and OpenCV 4.x's
[`getDevice()` implementation](https://github.com/opencv/opencv/blob/4.x/modules/videoio/src/cap_dshow.cpp).
The optional adapter uses the COM interfaces in
[`pygrabber` 0.2](https://pypi.org/project/pygrabber/0.2/).

Frame settings contain `requested`, `settings_applied` (each actual `cap.set`
result), received width/height, driver-reported FPS/FourCC, and mismatch warnings.
FPS is not a measured delivery rate. AVFoundation media subtypes such as `420v`
are preserved in the inventory and are not relabelled as a verified UVC format.
Selecting an advertised fractional frame rate requests the nearest whole-number
rate; the exact advertised ranges remain visible. Presets never establish a
sensor's identity.

For infrared inspection, add `mode=raw|stretch|clahe|threshold|otsu`,
`threshold=0..255` (default 128), and `flicker=1` for a two-frame maximum filter.
The default `raw` leaves decoded footage unchanged. Other modes process a
grayscale frame; they do not change the camera's hardware output. Use `warmup=20`
to skip the infrared sensor's initial exposure ramp only when the frame rate and
configured timeout allow it. The IR presets and discovery start with `warmup=0`
so initial footage is visible. Logitech documents that CPD can slow to about
1 fps beside MJPG RGB; discarding 20 frames then cannot finish within the default
seven-second first-frame timeout. A user can still request warm-up explicitly.

Examples (with the bridge already running):

```bash
curl http://127.0.0.1:9040/health
curl http://127.0.0.1:9040/api/camera/inventory
curl 'http://127.0.0.1:9040/api/devices?max_index=4'
curl 'http://127.0.0.1:9040/api/devices?start_index=2&max_index=1&backend=avfoundation&width=512&height=640&fps=30&fourcc=MJPG'
curl 'http://127.0.0.1:9040/api/frame?index=0&width=1920&height=1080&fps=30&fourcc=NV12' -o frame.png
curl -H 'Content-Type: application/json' \
  -d '{"enable_face_detection":true,"enable_face_mesh":true}' \
  http://127.0.0.1:9040/api/ai/config
```

Open `http://127.0.0.1:9040/api/video?index=0` directly to inspect a native stream.
The app's HTTP feed input can also use this URL. Native indexes differ from
browser `deviceId` strings; enumerate them separately. A source cannot be opened
twice within the bridge; a second request returns `camera_busy`.

### Native microphone channels

The audio API can inspect raw channels that the browser may not expose. First
enumerate native microphones with `/api/audio/devices`, then POST JSON to
`/api/audio/record`:

```json
{"index": 2, "duration": 5, "channels": 2, "sample_rate": 48000}
```

Choose the actual enumerated index; `2` above is illustrative. Duration is 1–30
seconds, channels 1–8, and sample rate 16000 or 48000. The response is an
`audio/wav` download with 16-bit PCM, with no mixing, resampling or filtering.
`X-Audio-Settings` contains per-channel RMS and peak levels, zero-data flags,
and duplicate-channel information. A six-channel LogiInsight listing carries
the microphones in channels **1 and 4**, counted from one. Recording all six
preserves the raw layout. The bridge reports unsupported channel counts or
sample rates rather than silently selecting another device or format.

Allow the terminal's microphone permission on macOS. The `sounddevice` dependency
is included in requirements. Linux may additionally need `libportaudio2` from
its package manager; a missing dependency returns an actionable API error.

### Optional firmware reader

Firmware inspection uses the documented `LogiWebcamClient.get_firmware_version()`
method from Logitech's official SDK. Download and unpack that SDK from the
[official resources](https://logitech.github.io/hackathons/logiinsight/), then set
`LOGIWEBCAM_SDK_DIR` to the directory containing `logiwebcam.py` before starting
the bridge. This is optional: video, audio, AI JSON, configuration and snapshots
work through the bridge's own documented-protocol implementation. If the SDK is
absent, firmware inspection reports `sdk_missing` and keeps the other controls
available.

### WebSocket data

The camera payload is passed through, including unfamiliar fields:

```json
{
  "api_version": 2,
  "plugin_loaded": true,
  "timestamp_ms": 1812345678,
  "face_timestamp_ms": 1812345678,
  "faces": [{
    "bbox": [480, 180, 320, 400],
    "confidence": 0.97,
    "capture_timestamp_ms": 1812345678,
    "landmarks": [[600, 300, -5]]
  }]
}
```

The example contains one illustrative point; the actual mesh, when present,
contains 478. Coordinates are **absolute pixels of the negotiated RGB frame**,
with a top-left origin. They are not IR coordinates. The camera emits at most one
face, and the mesh can be empty on some results even when enabled.

Status messages are separate and should not be interpreted as landmark frames:

```json
{"type":"bridge_status","state":"stale","message":"AI timestamp has not advanced for 2 seconds. Keep RGB open; verify firmware and AI settings."}
```

States include `connecting`, `connected`, `waiting`, `stale`, and `error`. Errors
also contain a stable `code`. The bridge reconnects after an interrupted SSH
transport; it does not change missing credentials or unknown host keys for you.

`/api/ai/snapshot` returns
`{device_ai_data, image_resolution: {width,height}, image_data_url, synchronized:true}`.
It compares the 8-byte YUV header timestamp with both `timestamp_ms` and
`yuv_capture_timestamp_ms`, and rejects mismatching supplied face timestamps before
decoding the frame. A snapshot can take several seconds. Live UVC footage plus
separately polled AI JSON is not guaranteed to be synchronized; the paired
snapshot endpoint is intended for exact frame/landmark pairs.

## Try all streams, with actual results

All requested native indexes are attempted, including an index corresponding to
the `LVNext Hello Camera`, even though Logitech documents that camera apps cannot
open it. The bridge reports what the OS returns. It does not guess a hidden index,
discard an enumerated camera because of its label, or bypass an OS permission.

The documented streams are RGB (`LVNext Camera`), near-infrared
(`LVNext CPD Camera`), and the restricted Windows Hello interface. IR modes are
portrait: 256×320, 512×640, and 1024×1280. To try the Hello interface, request its
actual index at 480×480. A failed probe remains a failure, not simulated footage.

**Find native streams** first reads the actual OS inventory. It prioritizes
observed CPD and Hello identities, reports each bounded capture attempt as it
finishes, and retains failed or unreadable rows. CPD is tried at 512×640 and, if
necessary, 256×320. Discovery uses zero warm-up frames so an IR stream slowed by
the shared JPEG encoder can still prove that a frame exists; its initial exposure
may need about 20 frames to settle. Manual presets retain the optional 20-frame
warm-up. All advertised modes remain inspectable, separately from tested modes.

Discovery preserves browser readers whose observed names match a native row. If
named inventory is unavailable while browser cameras are active, anonymous
indexes remain explicitly untested; stop the preview or use the separate exact
index probe to try them. Every source can still be selected for an explicit retry.
No additional wide-angle RGB camera is invented: the documented interfaces are
RGB, CPD near-infrared, and Hello. A missing CPD listing remains “not exposed”
until the operating system or a successful native attempt provides evidence.

For simultaneous RGB + IR, open RGB first with NV12 or YUY2, then IR with MJPG.
The two streams share the JPEG encoder; using MJPG for RGB can substantially slow
IR. macOS and some Windows backends can ignore the requested FOURCC, so inspect
the negotiated settings instead of assuming the requested format was accepted.
Advertised high frame rates are hardware limits and may not be delivered by the
driver, USB connection or exposure settings.

The Logi Hands Tracker (`ws://127.0.0.1:8765`, optional frame at
`http://127.0.0.1:8765/api/frame`) and Logi Gaze Tracker
(`ws://127.0.0.1:8964`) are separate Logitech applications. Aperture can connect
directly to them; this bridge does not synthesize hand or gaze results.

The LogiInsight AI is not available on an ordinary MacBook camera. You can preview
that camera and import external landmark results. Installing this bridge does
not add an inference model to the MacBook camera.

## Using the hosted app with this bridge

The most reliable route is the local app at **http://127.0.0.1:9040**. To allow the
hosted app to request this bridge, start it with the exact origin:

```bash
python bridge/bridge.py \
  --allow-origin https://aperture-camera-lab.batikanor.chatgpt.site
```

Browser versions vary in how they permit HTTPS pages to connect to loopback
HTTP/WebSocket services. Allow a local-network prompt if shown; if the request is
blocked, open the local app. The server remains bound to `127.0.0.1`, checks the
Host and Origin headers, and has no wildcard CORS setting. Do not put this bridge
behind a public reverse proxy.

## Verification and references

The code includes no-hardware tests for origin checks, input validation, config
validation and HTTP behavior. Run them from the project directory:

```bash
python -m unittest discover -s bridge -p 'test_*.py' -v
python -m py_compile bridge/bridge.py
```

Real RGB, IR, Hello, audio and on-device inference require the user's physical
hardware and permissions and were not validated in the build environment.
Protocol and coordinate details follow Logitech's
[SDK API reference](https://logitech.github.io/hackathons/logiinsight/API) and
[quick start](https://logitech.github.io/hackathons/logiinsight/).
