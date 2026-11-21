"""Create a project venv and install L-Gesture; optionally install the official app."""

import argparse
from pathlib import Path
import subprocess
import sys
import venv


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--with-tracker", action="store_true")
    args = parser.parse_args()
    if not (3, 10) <= sys.version_info[:2] < (3, 14):
        raise SystemExit("Use Python 3.10-3.13; Python 3.11 is recommended")
    root = Path(__file__).resolve().parents[1]
    environment = root / ".venv"
    if not environment.exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run([str(python), "-m", "pip", "install", "-e", str(root)], check=True)
    if args.with_tracker:
        subprocess.run([str(python), "-m", "l_gesture", "tracker", "install", "--root", str(root)], check=True)
    print("Setup complete. Run commands from the repository root.")
    print(f'"{python}" -m l_gesture cameras')
    print(f'"{python}" -m l_gesture tracker start')


if __name__ == "__main__":
    main()
