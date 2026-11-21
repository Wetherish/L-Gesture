# Third-party notices

## Logitech LogiInsight SDK 1.5.2

`src/l_gesture/vendor/logiinsight/` preserves upstream helpers. Adapted examples are in
`examples/logiinsight/`. The face drawing code in `src/l_gesture/ui/face.py` is adapted
from the SDK. Copyright (c) 2026 Logitech Europe S.A., MIT License; the full license is
retained at `src/l_gesture/vendor/logiinsight/LICENSE`.

Upstream: https://logitech.github.io/hackathons/logiinsight/

`docs/LOGIINSIGHT_API.md` and `docs/LOGIINSIGHT_SDK.md` preserve upstream references to
the original SDK layout. Use this repository's README for current commands.

## Official Hands Tracker sample and app

`src/l_gesture/vendor/hand_tracker_client.py` is the unchanged official Python sample:
https://logitech.github.io/hackathons/logi-hands-tracker/

The installer downloads the official 1.0.0 app from:
https://github.com/Logitech/hackathons/releases/tag/hands-tracker

App binaries are excluded from Git. Their bundled Electron, Chromium, MediaPipe and
other dependency notices remain with the installed app.
