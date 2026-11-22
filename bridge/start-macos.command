#!/bin/bash
# Aperture local bridge. No credentials are requested or stored by this launcher.
set -euo pipefail

APERTURE_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
APERTURE_ORIGIN="${APERTURE_APP_ORIGIN:-https://aperture-camera-lab.batikanor.chatgpt.site}"
APERTURE_OPEN=0
if [[ "${1:-}" == "--open" ]]; then
  APERTURE_OPEN=1
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--open]\n' "$0"
  exit 2
fi
cd "$APERTURE_ROOT"

on_error() {
  printf '\nThe local bridge did not start. Read the error above.\n'
  printf 'The manual setup is in bridge/README.md. No camera settings or credentials were changed.\n'
  if [[ -t 0 ]]; then read -r -p 'Press Return to close this window. ' _aperture_reply; fi
}
trap on_error ERR

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'This launcher is for macOS. Follow bridge/README.md for Windows or Linux.\n'
  exit 1
fi
APERTURE_PYTHON=''
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' >/dev/null 2>&1; then
    APERTURE_PYTHON="$(command -v "$candidate")"
    break
  fi
done
if [[ -z "$APERTURE_PYTHON" ]]; then
  printf 'Python 3.10 or newer is required. Install Python from https://www.python.org/downloads/macos/, then run this launcher again.\n'
  on_error
  exit 1
fi
"$APERTURE_PYTHON" - "$APERTURE_ORIGIN" <<'PY'
import sys
from urllib.parse import urlsplit
url = urlsplit(sys.argv[1])
if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
    raise SystemExit('APERTURE_APP_ORIGIN must be one exact HTTP(S) origin, with no path, credentials, query or fragment.')
PY

if [[ ! -x .venv/bin/python ]]; then
  printf 'Creating an isolated Python environment in this downloaded folder…\n'
  "$APERTURE_PYTHON" -m venv .venv
fi
APERTURE_ENV_PYTHON="$APERTURE_ROOT/.venv/bin/python"
APERTURE_REQUIREMENTS_HASH="$("$APERTURE_ENV_PYTHON" -c 'import hashlib; print(hashlib.sha256(open("bridge/requirements.txt", "rb").read()).hexdigest())')"
APERTURE_INSTALLED_HASH=''
if [[ -f .venv/.aperture-requirements.sha256 ]]; then
  APERTURE_INSTALLED_HASH="$(cat .venv/.aperture-requirements.sha256)"
fi
if [[ "$APERTURE_REQUIREMENTS_HASH" != "$APERTURE_INSTALLED_HASH" ]] || ! "$APERTURE_ENV_PYTHON" -c 'import aiohttp, paramiko, cv2, sounddevice, AVFoundation, CoreMedia' >/dev/null 2>&1; then
  printf 'Installing the local bridge dependencies, including macOS camera inventory. The first run needs internet access…\n'
  "$APERTURE_ENV_PYTHON" -m pip install --disable-pip-version-check -r bridge/requirements.txt
  printf '%s\n' "$APERTURE_REQUIREMENTS_HASH" > .venv/.aperture-requirements.sha256
fi

printf 'Preparing the local object-capture model (verified download on first setup)…\n'
if ! "$APERTURE_ENV_PYTHON" scripts/vendor-mediapipe.py --fetch; then
  printf 'The optional local object model could not be prepared. The native bridge can still start.\n'
  printf 'Use the hosted Roofcat app, or retry: .venv/bin/python scripts/vendor-mediapipe.py --fetch\n'
fi

if "$APERTURE_ENV_PYTHON" - <<'PY'
import json
import urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:9040/health', timeout=2) as response:
        data = json.load(response)
    if data.get('name') != 'Aperture local bridge':
        raise ValueError('another service')
    print('An Aperture bridge is already running (version ' + str(data.get('version', 'unknown')) + ').')
except Exception:
    raise SystemExit(1)
PY
then
  printf 'Return to your existing Aperture tab, open Camera, and click Discover.\n'
  printf 'If that bridge is older than this kit, stop its Terminal with Control-C and run this launcher again.\n'
  printf 'App: %s\n' "$APERTURE_ORIGIN"
  if [[ "$APERTURE_OPEN" == 1 ]]; then open "$APERTURE_ORIGIN"; fi
  exit 0
fi

printf '\nStarting Aperture camera access at http://127.0.0.1:9040\n'
printf 'Keep this Terminal open. Control-C stops the bridge and releases its cameras.\n'
printf 'Return to your EXISTING Aperture tab, open Camera, and click Discover.\n'
printf 'App: %s\n' "$APERTURE_ORIGIN"
printf 'Your existing board and captures stay in that browser tab. No new tab is opened by default.\n'
printf 'Allow the browser local-network access if asked. macOS camera access belongs to the Terminal/Python process.\n'
if [[ "$APERTURE_OPEN" == 1 ]]; then
  "$APERTURE_ENV_PYTHON" - "$APERTURE_ORIGIN" <<'PY' &
import subprocess, sys, time, urllib.request
for _ in range(40):
    try:
        with urllib.request.urlopen('http://127.0.0.1:9040/health', timeout=1) as response:
            if response.status == 200:
                subprocess.run(['open', sys.argv[1]], check=False)
                break
    except Exception:
        time.sleep(0.5)
PY
fi
exec "$APERTURE_ENV_PYTHON" bridge/bridge.py --allow-origin "$APERTURE_ORIGIN"
