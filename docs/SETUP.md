# Windows and macOS setup

Requirements: Git, Python 3.10-3.13 (3.11 recommended), internet and a USB 3 data cable.
The official installer supports Windows x64 and macOS Apple Silicon/Intel. Use a plain
venv or uv rather than Conda for the Logitech SDK. Run commands from the repository root.

`scripts/setup.py` creates `.venv` and installs an editable package, so source changes
apply immediately. `--with-tracker` downloads and verifies the official app into the
ignored `tools/` directory without launching the camera.

## macOS

```sh
python3 scripts/setup.py --with-tracker
.venv/bin/python -m l_gesture tracker start
.venv/bin/python -m l_gesture hands
```

The installer chooses Apple Silicon/Intel and mounts the DMG read-only. If macOS blocks
the unsigned app, use System Settings > Privacy & Security > Open Anyway, then retry.
Allow Hand Tracker camera access. Allow the terminal/Python app separately for OpenCV.
Its menu bar icon has a Quit action; closing its window alone keeps the app running.

At each start, the launcher copies `config/hand_tracker.json` into
`.hands-tracker-data/config.json` and passes that project-local user-data directory.

## Windows PowerShell

```powershell
py -3.11 scripts/setup.py --with-tracker
.\.venv\Scripts\python.exe -m l_gesture tracker start
.\.venv\Scripts\python.exe -m l_gesture hands
```

The NSIS installer is invoked for a local silent install into `tools\Hand Tracker`.
If Windows blocks it, run the official installer manually and choose that directory.
Allow desktop camera apps under Settings > Privacy & security > Camera.
Quit the app from its tray icon. The launcher copies config beside `Hand Tracker.exe`,
as required by the official Windows build. It uses no macOS-specific paths.

## Manual installation

Use the [official release](https://github.com/Logitech/hackathons/releases/tag/hands-tracker).
macOS: copy `Hand Tracker.app` into `tools/`. Windows: install so the executable is
`tools\Hand Tracker\Hand Tracker.exe`. Then run `l-gesture tracker start`.

## Cameras and port

`config/hand_tracker.json` selects `LVNext Camera` by name with full-frame 1280x720
and port 9000. The RGB fallback still needs live detection verification. For the intended
IR sensor, choose `LVNext CPD Camera` and remove `camera_resolution` to restore its crop.
Quit/restart Hand Tracker after edits; our launcher reapplies the source config.

Use `l-gesture cameras` to enumerate the backend actually used by the preview. Names
are preferred; `--device` overrides them explicitly. NV12 is requested by default for
RGB so IR can run alongside it. macOS may negotiate a different format.

## Face AI networking

Configure only the webcam USB adapter: IP `192.168.1.20`, mask `255.255.255.0`, gateway
and DNS empty. The camera listens at `192.168.1.10:22`.

- macOS: System Settings > Network > webcam adapter > Details > TCP/IP > Manually.
- Windows: Network Connections > webcam adapter > Properties > IPv4 > manual address.

If Wi-Fi uses the same subnet, routing may conflict. macOS may also need Local Network
permission for the terminal. `check`, `face` and `combined` read `LOGIWEBCAM_USER` and
`LOGIWEBCAM_PASSWORD`, or prompt in the local interactive terminal. No credential files
are created; the password is hidden. Do not commit or share kit credentials.

## Troubleshooting

- **Offline / wrong service:** start the official app. An HTTP file server is not a
  WebSocket feed. The launcher detects occupied ports; change config and pass the matching
  `--port` to previews if another service owns it.
- **Connected but no hands:** check the app's camera image, full hand visibility and light.
- **Camera busy / no frames:** close other camera apps. For simultaneous use, choose CPD
  for hands if available; otherwise test face and hands separately if RGB cannot be shared.
- **Frozen AI timestamp:** confirm the actual LogiInsight RGB feed is read. SSH and video
  are independent, so successful SSH does not prove the correct video camera was opened.
- **Hot camera freezes after prolonged AI use:** stop, unplug and let it cool before retrying,
  as described in the upstream SDK.
- **App asset errors:** the official renderer loads MediaPipe JS/WASM from jsDelivr and
  needs internet on first use.
- **Import errors:** rerun setup and use the project venv interpreter.

## Validation status

Local tests cover protocol I/O with a mock WebSocket server, gesture rules, package imports,
camera-name selection and platform-specific installer/launcher command construction.
CI runs the same hardware-free checks on Windows/macOS. It cannot grant OS privacy
permissions, configure USB networking or verify a physical camera. Windows live inference
and simultaneous camera sharing still require a real Windows machine and camera.
