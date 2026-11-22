#!/usr/bin/env python3
"""Install the optional CUDA service in a separate environment and start it."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import urllib.request
import venv

from gpu_models import DEFAULT_MODELS, MODELS, model_cache_root, model_directory, model_files, sha256_file, verify_model

ROOT = Path(__file__).resolve().parent.parent
ENVIRONMENT = ROOT / ".venv-gpu"
SUPPORTED_PYTHONS = {(3, 11), (3, 12), (3, 13)}
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu128"


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def installed_versions_match(python: Path) -> bool:
    check = "import torch,torchvision,transformers; assert torch.__version__.split('+')[0]=='2.9.1'; assert torch.version.cuda=='12.8'; assert torchvision.__version__.split('+')[0]=='0.24.1'; assert transformers.__version__=='4.57.3'; import aiohttp,PIL,numpy"
    return subprocess.run([str(python), "-c", check], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def environment_python() -> Path:
    return ENVIRONMENT / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ensure_environment() -> Path:
    python = environment_python()
    if not python.is_file():
        print("Creating the separate .venv-gpu environment…", flush=True)
        venv.EnvBuilder(with_pip=True).create(ENVIRONMENT)
    if not installed_versions_match(python):
        print("Installing the pinned GPU runtime. The first setup downloads several GB; no administrator access is needed.", flush=True)
        run([str(python), "-m", "pip", "install", "--upgrade", "pip"])
        run([str(python), "-m", "pip", "install", "torch==2.9.1", "torchvision==0.24.1", "--index-url", PYTORCH_INDEX])
        run([str(python), "-m", "pip", "install", "-r", str(ROOT / "bridge" / "requirements-gpu.txt")])
    return python


def download_models(model_ids: tuple[str, ...]) -> None:
    cache = model_cache_root()
    print(f"Model files: {cache}", flush=True)
    for model_id in model_ids:
        spec = MODELS[model_id]
        directory = model_directory(spec, cache)
        directory.mkdir(parents=True, exist_ok=True)
        for name, (expected_bytes, digest) in model_files(spec).items():
            target = directory / name
            if target.is_file() and (expected_bytes is None or target.stat().st_size == expected_bytes) and sha256_file(target) == digest:
                continue
            url = f"https://huggingface.co/{spec.repository}/resolve/{spec.revision}/{name}"
            temporary = target.with_suffix(target.suffix + ".roofcat-part")
            print(f"Downloading {spec.name}: {name}" + (f" ({expected_bytes / 1_000_000:.1f} MB)" if expected_bytes else ""), flush=True)
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "Roofcat-model-setup/1.0"})
                with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
                    total = 0
                    for chunk in iter(lambda: response.read(1024 * 1024), b""):
                        total += len(chunk)
                        # Bound every immutable download before trusting it.
                        if total > (expected_bytes if expected_bytes is not None else 1024 * 1024):
                            raise RuntimeError(f"Unexpected file size for {spec.name} {name}.")
                        output.write(chunk)
                if (expected_bytes is not None and total != expected_bytes) or sha256_file(temporary) != digest:
                    raise RuntimeError(f"SHA-256 verification failed for {spec.name} {name}.")
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        receipt = {"model": spec.id, "repository": spec.repository, "revision": spec.revision, "sha256": spec.weight_sha256}
        (directory / "roofcat-verified.json").write_text(json.dumps(receipt, indent=2) + "\n")
        verify_model(spec, cache)
        print(f"Ready: {spec.name}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["all", "tiny", "base-plus", "large"], default="all", help="The launcher installs every model by default; use this for a smaller targeted download.")
    parser.add_argument("--setup-only", action="store_true", help="Install and verify without starting the service.")
    parser.add_argument("--models-only", action="store_true", help="Download model files only, without installing Python packages or starting the service.")
    args = parser.parse_args()
    if sys.version_info[:2] not in SUPPORTED_PYTHONS:
        parser.error("Use Python 3.11, 3.12 or 3.13 (64-bit).")
    if platform.system() == "Darwin" and not args.models_only:
        print("This service uses NVIDIA CUDA. On this MacBook choose Browser in Roofcat; run start-gpu-windows.cmd on the RTX laptop.")
        return
    if sys.maxsize <= 2**32:
        parser.error("A 64-bit Python installation is required.")
    selected = DEFAULT_MODELS if args.model == "all" else ("sam2.1-" + args.model,)
    if args.models_only:
        download_models(selected)
        return
    python = ensure_environment()
    probe = subprocess.run([str(python), "-c", "import torch; print('CUDA:',torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'Install/update the NVIDIA driver, then rerun this launcher.'); raise SystemExit(0 if torch.cuda.is_available() else 1)"])
    if probe.returncode:
        raise RuntimeError("No usable NVIDIA CUDA device was detected. The browser model remains available in Roofcat.")
    download_models(selected)
    if not args.setup_only:
        run([str(python), str(ROOT / "bridge" / "gpu_server.py")])


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"GPU setup could not finish: {error}", file=sys.stderr)
        raise SystemExit(1)
