"""Roofcat's optional, offline SAM 2.1 CUDA runtime.

Only setup_gpu.py downloads files. The HTTP process loads verified local model
files, owns no cameras, and never stores input images or mask outputs.
"""
from __future__ import annotations

import gc
import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_WIDTH = 1600
MAX_HEIGHT = 1600
MAX_PIXELS = 2_000_000
PROTOCOL = "roofcat-gaze-v1"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    repository: str
    revision: str
    parameters_m: float
    weight_bytes: int = 0
    weight_sha256: str = ""
    config_sha256: str = ""

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "revision": self.revision,
                "parametersM": self.parameters_m, "bytes": self.weight_bytes,
                "license": "Apache-2.0"}


MODELS = {
    item.id: item for item in [
        ModelSpec("sam2.1-tiny", "SAM 2.1 Tiny", "facebook/sam2.1-hiera-tiny", "de431c4043854a71d8101e17995dfe596bf101a5", 38.9, 155908064, "48c14467e5cf9e51870511feb72c89688e82dd74523142c0538b663e193ac2a7", "860aff9751b139d83a4ad7df1e5535416fded533e0ead02625edbefcb9953cce"),
        ModelSpec("sam2.1-base-plus", "SAM 2.1 Base+", "facebook/sam2.1-hiera-base-plus", "b7320756a13354e7530a63935656d35b2f91a290", 80.8, 323476296, "2012733a0de5d03efd1bba550a2847c4551be9ef2e0d497c83074df66189f780", "8e24a93b6a40d4dad86eaec383ce7b4044f37ec6360136460f5ff2ce55f87390"),
        ModelSpec("sam2.1-large", "SAM 2.1 Large", "facebook/sam2.1-hiera-large", "665f8e2ad61cf5f53d65644ff27c8ee525124610", 224.4, 897897416, "dc407dce21301fd94abb395c5099b4f2c455fdc8a8f261ac3d0ea6d4cd197230", "00446988cf4d617118d2d347eabe2c46aebed744628facdd540508be30b69ec3"),
    ]
}
DEFAULT_MODELS = tuple(MODELS)
PREPROCESSOR_SHA256 = "6ebf229ee259368ce4a8d4f2fe893a72b053023710853e257253939e601f583d"
PROCESSOR_SHA256 = "f8a68e865cfad115c1c2763f3d93eca7b1c622da06da2a9273eb437fb2389b6d"


def model_files(spec: ModelSpec) -> dict[str, tuple[int | None, str]]:
    return {"model.safetensors": (spec.weight_bytes, spec.weight_sha256),
            "config.json": (None, spec.config_sha256),
            "preprocessor_config.json": (683, PREPROCESSOR_SHA256),
            "processor_config.json": (95, PROCESSOR_SHA256)}


class GPUError(Exception):
    def __init__(self, code: str, message: str, status: int = 503):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def model_cache_root() -> Path:
    override = os.environ.get("ROOFCAT_MODEL_CACHE")
    if override:
        return Path(override).expanduser().resolve()
    local = os.environ.get("LOCALAPPDATA")
    return (Path(local) / "Roofcat" / "models") if local else Path.home() / ".cache" / "roofcat" / "models"


def model_directory(spec: ModelSpec, cache_root: Path | None = None) -> Path:
    return (cache_root or model_cache_root()) / spec.id / spec.revision


def get_model(model_id: str) -> ModelSpec:
    if not isinstance(model_id, str) or model_id not in MODELS:
        raise GPUError("model_invalid", "Choose a supported SAM 2.1 model.", 400)
    return MODELS[model_id]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def installed_model(spec: ModelSpec, cache_root: Path | None = None) -> bool:
    """Cheap status check; full SHA verification is repeated before model load."""
    directory = model_directory(spec, cache_root)
    try:
        receipt = json.loads((directory / "roofcat-verified.json").read_text())
        if not isinstance(receipt, dict):
            return False
        weight = directory / "model.safetensors"
        return (receipt.get("revision") == spec.revision and receipt.get("sha256") == spec.weight_sha256
                and spec.weight_bytes > 0 and weight.stat().st_size == spec.weight_bytes
                and all((directory / name).is_file() for name in model_files(spec)))
    except (OSError, ValueError, TypeError):
        return False


def verify_model(spec: ModelSpec, cache_root: Path | None = None) -> Path:
    directory = model_directory(spec, cache_root)
    if not installed_model(spec, cache_root):
        raise GPUError("model_not_installed", f"{spec.name} is not installed. Run the GPU setup launcher on this laptop.", 409)
    for name, (expected_bytes, digest) in model_files(spec).items():
        path = directory / name
        if (expected_bytes is not None and path.stat().st_size != expected_bytes) or sha256_file(path) != digest:
            raise GPUError("model_integrity", f"{spec.name} failed its file check. Run GPU setup again.", 409)
    return directory


def cuda_probe(torch_module: Any = None) -> dict[str, Any]:
    try:
        if torch_module is None:
            import torch as torch_module
        if not torch_module.cuda.is_available():
            return {"available": False, "name": None, "freeBytes": None, "totalBytes": None,
                    "reason": "CUDA is unavailable. Use the browser model, or install the NVIDIA driver and GPU setup on the RTX laptop."}
        free, total = torch_module.cuda.mem_get_info(0)
        return {"available": True, "name": torch_module.cuda.get_device_name(0),
                "freeBytes": int(free), "totalBytes": int(total), "torchVersion": str(torch_module.__version__),
                "cudaVersion": str(torch_module.version.cuda)}
    except ImportError:
        return {"available": False, "name": None, "freeBytes": None, "totalBytes": None,
                "reason": "GPU dependencies are missing. Run start-gpu-windows.cmd on the RTX laptop."}
    except Exception:
        return {"available": False, "name": None, "freeBytes": None, "totalBytes": None,
                "reason": "The NVIDIA runtime could not be initialized. Check the driver, then restart the GPU service."}


def binary_rle(mask: Any) -> list[int]:
    """Row-major binary run lengths, always beginning with a background run."""
    import numpy as np
    array = np.asarray(mask, dtype=np.bool_)
    if array.ndim != 2 or not 0 < array.size <= MAX_PIXELS:
        raise GPUError("mask_invalid", "The model returned an invalid mask.")
    flat = array.reshape(-1)
    edges = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    boundaries = np.concatenate(([0], edges, [flat.size]))
    counts = np.diff(boundaries).astype(np.int64).tolist()
    if flat[0]:
        counts.insert(0, 0)
    return counts


def choose_point_mask(masks: Any, scores: Any, point: dict[str, float], width: int, height: int) -> tuple[Any, float | None]:
    """Use actual point-containing masks; predicted IoU only ranks their quality."""
    import numpy as np
    values = np.asarray(masks)
    quality = np.asarray(scores).reshape(-1)
    if values.ndim != 3 or values.shape[1:] != (height, width) or values.shape[0] != quality.size or not 1 <= quality.size <= 8:
        raise GPUError("mask_invalid", "The model mask dimensions do not match the frozen image.")
    if not np.isfinite(values).all() or not np.isfinite(quality).all():
        raise GPUError("mask_invalid", "The model returned non-finite mask values.")
    x = min(width - 1, int(point["x"] * width))
    y = min(height - 1, int(point["y"] * height))
    binary = values > 0  # SAM's returned masks are foreground logits.
    candidates = [index for index in range(quality.size) if binary[index, y, x]]
    if not candidates:
        return np.zeros((height, width), dtype=np.bool_), None
    selected = max(candidates, key=lambda index: float(quality[index]))
    # SAM's predicted-IoU head is an estimate, not an object-confidence score.
    return binary[selected].copy(), float(quality[selected])


class CUDARuntime:
    """Called from one dedicated executor thread; one model remains resident."""
    def __init__(self, cache_root: Path | None = None):
        self.cache_root = cache_root
        self.loaded_model: str | None = None
        self.model = self.processor = self.torch = None

    def unload(self) -> None:
        self.model = self.processor = None
        self.loaded_model = None
        gc.collect()
        if self.torch is not None:
            with __import__("contextlib").suppress(Exception):
                self.torch.cuda.empty_cache()

    def _load(self, spec: ModelSpec) -> None:
        if self.loaded_model == spec.id:
            return
        self.unload()  # Never keep two model weights resident during a switch.
        directory = verify_model(spec, self.cache_root)
        try:
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["TRANSFORMERS_OFFLINE"] = "1"
            os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
            import torch
            from transformers import Sam2Model, Sam2Processor
        except ImportError:
            raise GPUError("dependencies_missing", "GPU dependencies are missing. Run the GPU setup launcher.")
        self.torch = torch
        if not cuda_probe(torch)["available"]:
            raise GPUError("cuda_unavailable", "CUDA is unavailable. Check the NVIDIA driver and use the GPU setup environment.")
        # All artifacts are already pinned and verified locally. No remote code,
        # arbitrary model repository, fallback download, or camera connection.
        self.processor = Sam2Processor.from_pretrained(str(directory), local_files_only=True, trust_remote_code=False)
        self.model = Sam2Model.from_pretrained(str(directory), local_files_only=True,
                                               trust_remote_code=False, use_safetensors=True).to("cuda").eval()
        self.loaded_model = spec.id

    def segment(self, request: dict[str, Any], image: Any) -> dict[str, Any]:
        import time
        spec = get_model(request["model"])
        started = time.perf_counter()
        try:
            self._load(spec)
            torch = self.torch
            width, height = image.size
            point = request["point"]
            point_pixels = [min(width - 1, point["x"] * width), min(height - 1, point["y"] * height)]
            inputs = self.processor(images=image, input_points=[[[point_pixels]]], input_labels=[[[1]]], return_tensors="pt").to("cuda")
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
            with torch.inference_mode(), torch.autocast("cuda", dtype=dtype):
                outputs = self.model(**inputs, multimask_output=True)
            mask_logits = self.processor.post_process_masks(outputs.pred_masks.float().cpu(), inputs["original_sizes"].cpu(), binarize=False)[0][0].numpy()
            scores = outputs.iou_scores[0, 0].float().cpu().numpy()
            selected, score = choose_point_mask(mask_logits, scores, point, width, height)
            counts = binary_rle(selected)
            return {"protocol": PROTOCOL, "requestId": request["requestId"], "model": spec.public(), "delegate": "CUDA",
                    "width": width, "height": height, "mask": {"width": width, "height": height, "encoding": "rle-binary", "counts": counts, "startsWith": 0},
                    "qualityScore": score, "qualityScoreKind": "predicted-mask-iou", "latencyMs": (time.perf_counter() - started) * 1000,
                    "device": cuda_probe(torch)}
        except GPUError:
            raise
        except Exception as exc:
            is_oom = self.torch is not None and isinstance(exc, self.torch.cuda.OutOfMemoryError)
            self.unload()
            if is_oom:
                raise GPUError("cuda_out_of_memory", f"Not enough free GPU memory for {spec.name}. Close another GPU app or choose a smaller model.") from None
            raise GPUError("inference_failed", "SAM 2.1 could not process this image. Restart the GPU service; its console contains setup instructions.") from None
        finally:
            image.close()
