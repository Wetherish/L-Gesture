#!/usr/bin/env python3
"""Optional SAM 2.1 service: frozen pixels in, one mask out, localhost only."""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
import contextlib
import io
import json
import math
import warnings
from typing import Any

from aiohttp import web
from PIL import Image

from bridge import BridgeError, check_request_origin, validate_origin
from gpu_models import CUDARuntime, GPUError, MAX_HEIGHT, MAX_PIXELS, MAX_WIDTH, MODELS, PROTOCOL, cuda_probe, get_model, installed_model

VERSION = "1.0.0"
MAX_BODY = 8 * 1024 * 1024
MAX_PNG_BYTES = 6 * 1024 * 1024
SERVICE_KEY = web.AppKey("gpu_service", object)
CONFIG_KEY = web.AppKey("gpu_config", object)
DEFAULT_ORIGIN = "https://aperture-camera-lab.batikanor.chatgpt.site"


def decode_request(value: Any) -> tuple[dict[str, Any], Image.Image]:
    if not isinstance(value, dict) or set(value) != {"requestId", "model", "point", "width", "height", "image"}:
        raise GPUError("request_invalid", "The segmentation request has invalid fields.", 400)
    request_id = value["requestId"]
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100 or any(ord(char) < 32 for char in request_id):
        raise GPUError("request_invalid", "A valid request identifier is required.", 400)
    get_model(value["model"])
    width, height = value["width"], value["height"]
    if type(width) is not int or type(height) is not int or not 1 <= width <= MAX_WIDTH or not 1 <= height <= MAX_HEIGHT or width * height > MAX_PIXELS:
        raise GPUError("image_too_large", "The frozen image must fit within 1600 pixels per side and two megapixels.", 400)
    point = value["point"]
    if not isinstance(point, dict) or set(point) != {"x", "y"} or any(type(point[k]) not in (int, float) or not math.isfinite(point[k]) or not 0 <= point[k] <= 1 for k in ("x", "y")):
        raise GPUError("point_invalid", "The gaze point must be inside the frozen image.", 400)
    encoded = value["image"]
    if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_PNG_BYTES * 4 // 3 + 4:
        raise GPUError("image_invalid", "The frozen PNG is missing or too large.", 400)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise GPUError("image_invalid", "The frozen PNG encoding is invalid.", 400) from None
    if len(raw) > MAX_PNG_BYTES or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise GPUError("image_invalid", "Only a bounded PNG image is accepted.", 400)
    original = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            original = Image.open(io.BytesIO(raw))
            if original.format != "PNG" or original.size != (width, height) or getattr(original, "n_frames", 1) != 1:
                raise GPUError("image_dimensions", "The frozen PNG dimensions do not match the request.", 400)
            original.load()
            image = original.convert("RGB")
    except GPUError:
        raise
    except Exception:
        raise GPUError("image_invalid", "The frozen PNG could not be decoded.", 400) from None
    finally:
        if original is not None:
            original.close()
    # Never keep another copy of the user's base64 pixels in the queued job.
    clean = {key: value[key] for key in ("requestId", "model", "width", "height")}
    clean["point"] = {"x": float(point["x"]), "y": float(point["y"])}
    return clean, image


class SegmentationService:
    """No queue: a timeout never makes a still-running CUDA thread available."""
    def __init__(self, runtime: Any = None, *, timeout: float = 120, probe: Any = cuda_probe, installed: Any = installed_model):
        self.runtime = runtime or CUDARuntime()
        self.timeout, self.probe, self.installed = timeout, probe, installed
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="roofcat-gpu")
        self.active: asyncio.Future | None = None
        self.closed = False
        self.last_error: dict[str, str] | None = None
        self._probe_task: asyncio.Task | None = None
        self._probe_value: dict[str, Any] | None = None

    @property
    def busy(self) -> bool:
        return self.active is not None and not self.active.done()

    async def status(self) -> dict[str, Any]:
        # A single shared probe prevents a burst of polling from spawning imports.
        if self._probe_task is None or self._probe_task.done():
            self._probe_task = asyncio.create_task(asyncio.to_thread(self.probe))
        cuda = await asyncio.shield(self._probe_task)
        self._probe_value = cuda
        models = []
        for spec in MODELS.values():
            installed = self.installed(spec)
            models.append({**spec.public(), "installed": installed, "available": bool(cuda.get("available") and installed)})
        return {"protocol": PROTOCOL, "version": VERSION, "cuda": cuda, "models": models,
                "busy": self.busy, "loadedModel": self.runtime.loaded_model, "lastError": self.last_error}

    async def segment(self, request: dict[str, Any], image: Image.Image) -> dict[str, Any]:
        if self.closed:
            image.close()
            raise GPUError("service_closed", "The GPU service is closing. Restart its launcher.")
        if self.busy:
            image.close()
            raise GPUError("busy", "The GPU is finishing another capture. Try again shortly.", 409)
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self.executor, self.runtime.segment, request, image)
        self.active = future

        def finished(done: asyncio.Future) -> None:
            # Consume late exceptions even when the request timed out/disconnected.
            with contextlib.suppress(asyncio.CancelledError):
                error = done.exception()
                if isinstance(error, GPUError):
                    self.last_error = {"code": error.code, "message": error.message}
            if self.active is done:
                self.active = None

        future.add_done_callback(finished)
        try:
            result = await asyncio.wait_for(asyncio.shield(future), timeout=self.timeout)
            self.last_error = None
            return result
        except asyncio.TimeoutError:
            self.last_error = {"code": "timeout", "message": "The GPU capture took too long. It is still finishing; restart the service if it remains busy."}
            raise GPUError("timeout", self.last_error["message"], 504) from None
        except asyncio.CancelledError:
            # Shield keeps ownership until CUDA actually returns. A second browser
            # request must never start over this in-flight model/image state.
            raise
        except GPUError:
            raise
        except Exception:
            raise GPUError("inference_failed", "The local GPU capture failed. Restart the GPU service.") from None

    async def close(self) -> None:
        self.closed = True
        if self.active is not None:
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(self.active), timeout=2)
        # Do not unload an active model from another thread. Process exit releases
        # it; a completed worker can safely be unloaded on its owning executor.
        if not self.busy:
            await asyncio.get_running_loop().run_in_executor(self.executor, self.runtime.unload)
        self.executor.shutdown(wait=False, cancel_futures=True)


@web.middleware
async def security(request: web.Request, handler: Any) -> web.StreamResponse:
    config = request.app[CONFIG_KEY]
    origin = request.headers.get("Origin")
    request_allowed = False
    try:
        check_request_origin(request.host, origin, request.headers.get("Sec-Fetch-Site"), config["origins"], config["port"])
        request_allowed = True
        if request.method == "OPTIONS":
            response = web.Response(status=204)
        else:
            response = await handler(request)
    except (GPUError, BridgeError) as error:
        response = web.json_response({"protocol": PROTOCOL, "error": error.code, "message": error.message}, status=error.status)
    except web.HTTPRequestEntityTooLarge:
        response = web.json_response({"protocol": PROTOCOL, "error": "request_too_large", "message": "The frozen image request exceeds 8 MiB."}, status=413)
    except web.HTTPException as error:
        response = error
    except (ConnectionResetError, asyncio.CancelledError):
        raise
    except Exception:
        response = web.json_response({"protocol": PROTOCOL, "error": "request_failed", "message": "The local GPU request failed."}, status=500)
    if not response.prepared:
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"})
        if request_allowed and origin in config["origins"]:
            response.headers.update({"Access-Control-Allow-Origin": origin, "Vary": "Origin",
                                     "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
                                     "Access-Control-Allow-Private-Network": "true"})
    return response


async def status_handler(request: web.Request) -> web.Response:
    return web.json_response(await request.app[SERVICE_KEY].status())


async def segment_handler(request: web.Request) -> web.Response:
    service = request.app[SERVICE_KEY]
    if service.busy:
        raise GPUError("busy", "The GPU is finishing another capture. Try again shortly.", 409)
    if request.content_type != "application/json":
        raise GPUError("request_invalid", "Send a JSON segmentation request.", 415)
    try:
        body = await request.json(loads=json.loads)
    except web.HTTPRequestEntityTooLarge:
        raise
    except (ValueError, UnicodeDecodeError):
        raise GPUError("request_invalid", "The segmentation JSON is invalid.", 400) from None
    clean, image = decode_request(body)
    body.clear()
    return web.json_response(await service.segment(clean, image))


async def cleanup(app: web.Application) -> None:
    await app[SERVICE_KEY].close()


def create_app(*, port: int = 9041, allowed_origins: tuple[str, ...] = (), service: SegmentationService | None = None) -> web.Application:
    app = web.Application(middlewares=[security], client_max_size=MAX_BODY)
    app[CONFIG_KEY] = {"port": port, "origins": {DEFAULT_ORIGIN, f"http://127.0.0.1:{port}", f"http://localhost:{port}",
                                                 "http://127.0.0.1:9040", "http://localhost:9040", *allowed_origins}}
    app[SERVICE_KEY] = service or SegmentationService()
    app.add_routes([web.get("/api/segmentation/status", status_handler), web.post("/api/segmentation/segment", segment_handler),
                    web.options("/api/segmentation/{path:.*}", status_handler)])
    app.on_cleanup.append(cleanup)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9041)
    parser.add_argument("--allow-origin", action="append", default=[], type=validate_origin)
    arguments = parser.parse_args()
    if not 1024 <= arguments.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    print(f"Roofcat GPU service: http://127.0.0.1:{arguments.port}")
    print("Keep this window open. In Roofcat, open the eye settings, press Check GPU, and choose a SAM 2.1 model.")
    print("Only frozen images from allowed local app origins are processed. Nothing opens a camera or uploads footage.")
    web.run_app(create_app(port=arguments.port, allowed_origins=tuple(arguments.allow_origin)), host="127.0.0.1", port=arguments.port,
                access_log=None, handler_cancellation=True)


if __name__ == "__main__":
    main()
