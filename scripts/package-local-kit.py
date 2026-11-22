#!/usr/bin/env python3
"""Rebuild the optional native kit from this exact working tree, without secrets."""
from pathlib import Path
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'dist' / 'downloads' / 'aperture-local.zip'
SKIP = {'.git', '.venv', '.venv-gpu', '__pycache__', 'node_modules', 'tmp', 'downloads', '__scene_qa', '__gaze_qa', '__gpu_qa', '__capture_qa', '__object_qa'}
# Static hosting limits each downloadable file to 25 MiB. The optional object and segmentation
# models are restored by the launcher from its pinned, hash-verified manifest URL.
# They remain normal same-origin assets in the live app and full Git checkout.
FETCH_ON_SETUP = {
    'dist/vendor/mediapipe/models/efficientdet_lite2_float16.tflite',
    'dist/vendor/mediapipe/models/magic_touch_v2.part1.bin',
    'dist/vendor/mediapipe/models/magic_touch_v2.part2.bin',
}
MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024


def main():
    version = json.loads((ROOT / 'package.json').read_text())['version']
    paths = [ROOT / 'README.md', ROOT / 'package.json', ROOT / 'LICENSE']
    for directory in ('dist', 'bridge', 'tests', 'scripts'):
        for path in (ROOT / directory).rglob('*'):
            relative = path.relative_to(ROOT)
            if not path.is_file() or path.is_symlink() or any(part in SKIP for part in relative.parts):
                continue
            if relative.as_posix() in FETCH_ON_SETUP:
                continue
            if path.name.startswith('.env') or path.name == '.DS_Store' or path.suffix in ('.pyc', '.pyo'):
                continue
            paths.append(path)
    DEST.parent.mkdir(parents=True, exist_ok=True)
    staged = DEST.with_suffix('.zip.tmp')
    with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(set(paths)):
            if not path.is_file():
                continue
            name = 'aperture-camera-lab/' + path.relative_to(ROOT).as_posix()
            entry = zipfile.ZipInfo.from_file(path, name)
            entry.compress_type = zipfile.ZIP_DEFLATED
            # Preserve executable macOS launcher mode in the ZIP metadata.
            archive.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        archive.writestr('aperture-camera-lab/KIT-VERSION.txt', version + '\n')
        archive.writestr('aperture-camera-lab/MODEL-SETUP.txt',
            'The live Roofcat app already serves its object and gaze segmentation models.\n'
            'For the optional local copy, start-macos.command restores the models automatically.\n'
            'Manual setup: python3 scripts/vendor-mediapipe.py --fetch\n'
            'The download is checked against the bundled SHA-256 manifest before use.\n'
            'Optional NVIDIA GPU models: run bridge/start-gpu-windows.cmd on Windows.\n'
            'This installs a separate CUDA environment and all three pinned SAM 2.1 models.\n'
            'The public weights stay in your user cache; inference stays on this laptop.\n')
    with zipfile.ZipFile(staged) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError('Corrupt kit member: ' + bad)
        launcher = archive.getinfo('aperture-camera-lab/bridge/start-macos.command')
        if not (launcher.external_attr >> 16) & 0o111:
            raise RuntimeError('The macOS launcher lost its executable mode.')
        count = len(archive.namelist())
    if staged.stat().st_size > MAX_DOWNLOAD_BYTES:
        staged.unlink()
        raise RuntimeError('Local kit exceeds the static host\'s 25 MiB download limit.')
    staged.replace(DEST)
    print(f'Roofcat {version} kit: {count} files, {DEST.stat().st_size:,} bytes.')


if __name__ == '__main__':
    main()
