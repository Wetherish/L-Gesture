#!/usr/bin/env python3
"""Aperture local camera / LogiInsight bridge. Python 3.10+.

Nothing opens a camera or contacts the kit until an API or WebSocket is used.
Only the four documented AI flags and fixed SDK file paths are accessible.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import configparser
import contextlib
import io
import importlib.util
import json
import math
import multiprocessing as mp
import os
import platform
import queue
import struct
import sys
import threading
import time
import uuid
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web


VERSION = "1.2.0"
API_DOCS = "https://logitech.github.io/hackathons/logiinsight/API"
AI_PATH = "/files/logi_conf/logiwebcam_ai_output.json"
CONFIG_PATH = "/files/logi_conf/logiwebcam_ai.ini"
YUV_PATH = "/files/logi_conf/logiwebcam_frame.yuv"
YUV_STATUS_PATH = "/files/logi_conf/logiwebcam_frame.status"
AI_FLAGS = {
    "enable_face_detection": True,
    "enable_face_mesh": False,
    "enable_debug_timestamp": False,
    "enable_yuv_snapshot": False,
}
APP_KEY = web.AppKey("bridge", object)


class BridgeError(Exception):
    def __init__(self, code: str, message: str, status: int = 503):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def snapshot_timestamps_match(data: dict[str, Any], header_timestamp: int) -> bool:
    """Every supplied AI timestamp must identify the same NV12 camera frame.

    Logitech timestamps wrap and are not host UTC. Compare camera values directly;
    matching only the YUV metadata to the YUV header can pair an older saved frame
    with newer face inference in the latest JSON.
    """
    timestamps = [header_timestamp, data.get("timestamp_ms"), data.get("yuv_capture_timestamp_ms")]
    if "face_timestamp_ms" in data:
        timestamps.append(data["face_timestamp_ms"])
    faces = data.get("faces", [])
    if not isinstance(faces, list):
        return False
    for face in faces:
        if not isinstance(face, dict):
            return False
        if "capture_timestamp_ms" in face:
            timestamps.append(face["capture_timestamp_ms"])
    return all(type(timestamp) is int and timestamp == header_timestamp for timestamp in timestamps)


def bounded_int(value: Any, name: str, low: int, high: int, default: int | None = None) -> int:
    if value is None and default is not None:
        return default
    try:
        if isinstance(value, bool) or str(value).strip() != str(int(value)):
            raise ValueError
        number = int(value)
    except (ValueError, TypeError, OverflowError):
        raise BridgeError("invalid_parameter", f"{name} must be an integer from {low} to {high}.", 400)
    if not low <= number <= high:
        raise BridgeError("invalid_parameter", f"{name} must be from {low} to {high}.", 400)
    return number


def validate_origin(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise ValueError("Origin must be an http(s) origin with no credentials.")
    if parts.path not in {"", "/"} or parts.query or parts.fragment:
        raise ValueError("Origin must have no path, query, or fragment.")
    return f"{parts.scheme}://{parts.netloc}".rstrip("/")


def check_request_origin(host: str, origin: str | None, fetch_site: str | None, allowed: set[str], port: int) -> None:
    try:
        parsed = urlsplit("//" + host)
        valid_host = parsed.hostname in {"localhost", "127.0.0.1", "::1"} and parsed.port in {None, port}
    except ValueError:
        valid_host = False
    if not valid_host:
        raise BridgeError("host_rejected", "The bridge only accepts a localhost Host header.", 403)
    if origin is not None and origin not in allowed:
        raise BridgeError("origin_rejected", "This origin is not allowed. Open the local app or add its exact origin with --allow-origin.", 403)
    if not origin and fetch_site == "cross-site":
        raise BridgeError("origin_rejected", "Cross-site requests need an explicitly allowed Origin.", 403)


@dataclass(frozen=True)
class CameraRequest:
    index: int
    width: int | None = None
    height: int | None = None
    fps: int | None = None
    fourcc: str | None = None
    backend: str = "auto"
    warmup: int = 0
    mode: str = "raw"
    threshold: int = 128
    flicker: bool = False
    device_uid: str | None = None

    @classmethod
    def from_query(cls, query: Any) -> "CameraRequest":
        index = bounded_int(query.get("index"), "index", 0, 31, 0)
        options: dict[str, Any] = {"index": index}
        for key, low, high in [("width", 16, 4096), ("height", 16, 4096), ("fps", 1, 240), ("warmup", 0, 30)]:
            if key in query:
                options[key] = bounded_int(query[key], key, low, high)
        fourcc = query.get("fourcc", "").upper()
        if fourcc:
            if fourcc not in {"MJPG", "NV12", "YUY2"}:
                raise BridgeError("invalid_parameter", "fourcc must be MJPG, NV12 or YUY2.", 400)
            options["fourcc"] = fourcc
        backend = query.get("backend", "auto").lower()
        if backend not in {"auto", "avfoundation", "v4l2", "dshow", "msmf", "any"}:
            raise BridgeError("invalid_parameter", "Unsupported OpenCV backend.", 400)
        options["backend"] = backend
        mode = query.get("mode", "raw").lower()
        if mode not in {"raw", "stretch", "clahe", "threshold", "otsu"}:
            raise BridgeError("invalid_parameter", "mode must be raw, stretch, clahe, threshold or otsu.", 400)
        options["mode"] = mode
        if "threshold" in query:
            options["threshold"] = bounded_int(query["threshold"], "threshold", 0, 255)
        if "flicker" in query:
            options["flicker"] = bool(bounded_int(query["flicker"], "flicker", 0, 1))
        if "device_uid" in query:
            uid = query["device_uid"]
            if not isinstance(uid, str) or not 1 <= len(uid) <= 512 or any(ord(char) < 32 for char in uid):
                raise BridgeError("invalid_parameter", "device_uid must be an observed camera identifier.", 400)
            options["device_uid"] = uid
        return cls(**options)


def default_camera_backend() -> str:
    return {"Darwin": "avfoundation", "Windows": "dshow", "Linux": "v4l2"}.get(platform.system(), "any")


def avfoundation_devices(avf: Any) -> list[Any]:
    """Match OpenCV 4.x's exact Video-then-Muxed ordering; never sort by name."""
    return list(avf.AVCaptureDevice.devicesWithMediaType_(avf.AVMediaTypeVideo) or []) + list(
        avf.AVCaptureDevice.devicesWithMediaType_(avf.AVMediaTypeMuxed) or [])


def directshow_devices() -> list[dict[str, Any]]:
    """Read DirectShow monikers in OpenCV 4.x getDevice() index order.

    Binding a moniker's property bag does not create its capture filter. Do not
    use FilterGraph, sort names, or drop a failed property bag: getDevice() counts
    every moniker, including one whose metadata could not be read.
    """
    try:
        import comtypes
        from comtypes import client, GUID
        from comtypes.persist import IPropertyBag
        from pygrabber.dshow_core import ICreateDevEnum
        from pygrabber.dshow_ids import DeviceCategories, clsids
    except ImportError:
        raise BridgeError("windows_inventory_missing", "Named Windows inventory needs the optional pygrabber/comtypes dependencies. Reinstall bridge/requirements.txt in the bridge environment. Explicit numeric capture attempts remain available.")
    except Exception as exc:
        raise BridgeError("windows_inventory_failed", f"The DirectShow inventory adapter could not load ({type(exc).__name__}). Reinstall bridge/requirements.txt; no camera identities were inferred.")
    owner = enumerator = moniker = storage = properties = None
    initialized = False
    try:
        comtypes.CoInitialize()
        initialized = True
        owner = client.CreateObject(clsids.CLSID_SystemDeviceEnum, interface=ICreateDevEnum)
        enumerator = owner.CreateClassEnumerator(GUID(DeviceCategories.VideoInputDevice), dwFlags=0)
        rows: list[dict[str, Any]] = []
        if not enumerator:  # The category is empty; no invented camera indexes.
            return rows
        while True:
            moniker, count = enumerator.Next(1)
            if not count:
                break
            row: dict[str, Any] = {"index": len(rows), "backend": "dshow", "status": "enumerated",
                "capture_tested": False, "formats": [], "identity_source": "DirectShow video-device moniker"}
            failures = []
            try:
                storage = moniker.BindToStorage(0, 0, IPropertyBag._iid_)
                properties = storage.QueryInterface(IPropertyBag)
                for property_name, key in [("FriendlyName", "name"), ("DevicePath", "unique_id")]:
                    try:
                        value = properties.Read(property_name, pErrorLog=None)
                        if not isinstance(value, str) or not value or any(ord(char) < 32 for char in value):
                            raise ValueError("Missing or invalid property")
                        if key == "unique_id" and len(value) > 512:
                            raise ValueError("Identifier exceeds the supported length")
                        row[key] = value
                    except Exception as exc:
                        failures.append(f"{property_name} ({type(exc).__name__})")
            except Exception as exc:
                failures.append(f"property bag ({type(exc).__name__})")
            finally:
                # Release COM references on this thread before uninitializing it.
                properties = storage = moniker = None
            if failures:
                row.update(status="inventory_error", error="device_metadata_failed",
                    message="Could not read " + ", ".join(failures) + ". The original DirectShow index is retained.")
            rows.append(row)
        return rows
    except BridgeError:
        raise
    except Exception as exc:
        raise BridgeError("windows_inventory_failed", f"DirectShow device enumeration failed ({type(exc).__name__}). No camera identities were inferred. Reinstall bridge/requirements.txt or retry an explicit numeric capture.")
    finally:
        properties = storage = moniker = enumerator = owner = None
        if initialized:
            with contextlib.suppress(Exception):
                comtypes.CoUninitialize()


def native_inventory(backend: str = "auto") -> dict[str, Any]:
    """Read identities/formats without a capture session or permission request."""
    system = platform.system()
    backend = default_camera_backend() if backend == "auto" else backend
    result: dict[str, Any] = {"platform": system, "backend": backend, "devices": [],
        "capture_tested": False, "permission": "unknown", "status": "available", "warnings": []}
    if system == "Darwin" and backend in {"avfoundation", "any"}:
        try:
            import AVFoundation as avf
            import CoreMedia as cm
        except ImportError:
            return {**result, "status": "unavailable", "error": "mac_inventory_missing",
                "message": "Named macOS inventory needs the optional pyobjc-framework-AVFoundation dependency. Run the updated Mac launcher or reinstall bridge/requirements.txt. Numeric capture attempts remain available."}
        result["backend"] = "avfoundation"
        result["source"] = "AVFoundation device and format inventory"
        authorization = int(avf.AVCaptureDevice.authorizationStatusForMediaType_(avf.AVMediaTypeVideo))
        result["permission"] = {0: "not_determined", 1: "restricted", 2: "denied", 3: "authorized"}.get(authorization, "unknown")
        for index, device in enumerate(avfoundation_devices(avf)):
            row: dict[str, Any] = {"index": index, "backend": "avfoundation", "status": "enumerated", "capture_tested": False, "formats": []}
            try:
                row.update(name=str(device.localizedName()), unique_id=str(device.uniqueID()), model_id=str(device.modelID()))
                for key, getter in [("connected", "isConnected"), ("suspended", "isSuspended"), ("in_use", "isInUseByAnotherApplication")]:
                    if hasattr(device, getter):
                        row[key] = bool(getattr(device, getter)())
                for mode_index, mode in enumerate(device.formats() or []):
                    description = mode.formatDescription()
                    dimensions = cm.CMVideoFormatDescriptionGetDimensions(description)
                    subtype = int(cm.CMFormatDescriptionGetMediaSubType(description))
                    subtype_bytes = subtype.to_bytes(4, "big", signed=False)
                    ranges = [{"min": float(rate.minFrameRate()), "max": float(rate.maxFrameRate())}
                              for rate in mode.videoSupportedFrameRateRanges() or []]
                    row["formats"].append({"format_index": mode_index, "width": int(dimensions.width), "height": int(dimensions.height),
                        "media_subtype": subtype_bytes.decode("ascii", errors="replace"), "media_subtype_code": subtype,
                        "frame_rate_ranges": ranges, "evidence": "OS-advertised; capture not tested"})
            except Exception as exc:
                # Keep a discovered device even if one of its properties fails.
                row.update(status="inventory_error", error="device_metadata_failed", message=f"Could not read all metadata ({type(exc).__name__}).")
            result["devices"].append(row)
        result["message"] = "AVFoundation identities and formats were read without opening capture. Indexes can change after hotplug; observed unique IDs are checked before capture. Media subtypes are OS descriptions, not guarantees that OpenCV accepts a requested FOURCC."
        return result
    if system == "Windows" and backend in {"dshow", "any"}:
        result["backend"] = "dshow"
        result["source"] = "DirectShow video-device moniker inventory"
        try:
            result["devices"] = directshow_devices()
        except BridgeError as exc:
            return {**result, "status": "unavailable", "error": exc.code, "message": exc.message}
        result["message"] = "DirectShow names and DevicePath identities were read without opening capture. Indexes match OpenCV's DirectShow backend only; they cannot be used to name MSMF devices. Observed IDs are checked again before capture. Formats and Windows camera permission are not established by this inventory; a frame attempt is required."
        if any(not row.get("unique_id") for row in result["devices"]):
            result["warnings"].append("Some device identities could not be read. Those indexes are retained, but their identity cannot be checked after hotplug; refresh discovery before trying them.")
        return result
    if system == "Linux" and backend in {"v4l2", "any"}:
        result["backend"] = "v4l2"
        result["source"] = "Linux video4linux inventory"
        for path in sorted(Path("/sys/class/video4linux").glob("video*"), key=lambda item: int(item.name[5:]) if item.name[5:].isdigit() else 9999):
            if not path.name[5:].isdigit():
                continue
            index = int(path.name[5:])
            try:
                name = (path / "name").read_text().strip()
            except OSError:
                name = path.name
            result["devices"].append({"index": index, "backend": "v4l2", "name": name, "device_path": f"/dev/video{index}",
                "status": "enumerated", "capture_tested": False, "formats": []})
        result["message"] = "Every video node is listed, including possible metadata-only nodes. A frame attempt is needed to establish capture. Format enumeration is unavailable on this bridge backend."
        return result
    return {**result, "status": "unavailable", "error": "inventory_unavailable",
        "message": "Named inventory is unavailable for this platform/backend. Explicit numeric index and mode attempts remain available; their identities are not inferred."}


def inventory_worker(backend: str, out: Any, stopped: Any) -> None:
    try:
        out.put({"info": native_inventory(backend)})
    except Exception as exc:
        out.put({"error": "inventory_failed", "message": f"The OS camera inventory could not be read ({type(exc).__name__}). Numeric capture attempts remain available."})


def negotiation_warnings(requested: dict[str, Any], observed: dict[str, Any], applied: dict[str, bool]) -> list[str]:
    warnings = []
    for key, accepted in applied.items():
        if not accepted:
            warnings.append(f"The driver did not confirm setting {key} to {requested[key]}.")
    for key in ["width", "height"]:
        if requested.get(key) is not None and observed.get(key) != requested[key]:
            warnings.append(f"Requested {key} {requested[key]}; received {observed.get(key)}.")
    if requested.get("fps") is not None:
        fps = observed.get("fps")
        if not fps:
            warnings.append("The driver did not report a negotiated frame rate; requested FPS is unverified.")
        elif abs(fps - requested["fps"]) > max(1, requested["fps"] * 0.05):
            warnings.append(f"Requested {requested['fps']} fps; driver reports {fps:g} fps. This is not a measured delivery rate.")
    if requested.get("fourcc"):
        actual = observed.get("fourcc", "unknown")
        if actual == "unknown" or actual.upper() != requested["fourcc"]:
            warnings.append(f"Requested FOURCC {requested['fourcc']}; driver reports {actual}. The requested pixel format is not confirmed.")
    return warnings


def _put_latest(out: Any, value: dict[str, Any]) -> None:
    """Keep a slow browser from accumulating video frames in memory."""
    try:
        out.put_nowait(value)
    except queue.Full:
        with contextlib.suppress(queue.Empty):
            out.get_nowait()
        with contextlib.suppress(queue.Full):
            out.put_nowait(value)


def camera_worker(params: dict[str, Any], out: Any, stopped: Any, streaming: bool) -> None:
    """Isolate blocking native camera drivers so a timeout can release the process."""
    cap = None
    try:
        try:
            import cv2
        except ImportError:
            out.put({"error": "opencv_missing", "message": "Install bridge/requirements.txt to use native video."})
            return
        backend_names = {
            "avfoundation": cv2.CAP_AVFOUNDATION,
            "v4l2": cv2.CAP_V4L2,
            "dshow": cv2.CAP_DSHOW,
            "msmf": cv2.CAP_MSMF,
            "any": cv2.CAP_ANY,
        }
        requested_backend = params["backend"]
        if requested_backend == "auto":
            requested_backend = default_camera_backend()
        identity: dict[str, Any] = {}
        if params.get("device_uid"):
            index = params["index"]
            if platform.system() == "Darwin" and requested_backend in {"avfoundation", "any"}:
                try:
                    import AVFoundation as avf
                except ImportError:
                    raise BridgeError("mac_inventory_missing", "The camera identity cannot be verified without the optional macOS inventory dependency.")
                devices = avfoundation_devices(avf)
                observed = {"name": str(devices[index].localizedName()), "unique_id": str(devices[index].uniqueID())} if index < len(devices) else {}
                requested_backend = "avfoundation"
            elif platform.system() == "Windows" and requested_backend in {"dshow", "any"}:
                devices = directshow_devices()
                observed = devices[index] if index < len(devices) else {}
                requested_backend = "dshow"
            else:
                raise BridgeError("identity_backend_mismatch", "This camera identity cannot be verified with the selected backend. Use AVFoundation identities on macOS or DirectShow identities on Windows; refresh inventory after changing backends.", 409)
            if observed.get("unique_id") != params["device_uid"]:
                raise BridgeError("camera_identity_changed", "Camera indexes changed since discovery. Refresh the native inventory before opening this source.", 409)
            identity = {key: observed[key] for key in ["name", "unique_id"] if key in observed}
            identity["identity_verified_before_open"] = True
        cap = cv2.VideoCapture(params["index"], backend_names[requested_backend])
        if not cap.isOpened():
            out.put({"error": "camera_unavailable", "message": f"Native camera index {params['index']} could not be opened. It may be absent, busy, unsupported or denied by the OS."})
            return
        actual_backend = requested_backend
        with contextlib.suppress(Exception):
            actual_backend = str(cap.getBackendName())
        if identity and actual_backend.lower() != requested_backend:
            raise BridgeError("identity_backend_mismatch", "The capture driver differs from the backend that supplied this camera identity. No frames were read; refresh inventory using the matching backend.", 409)
        # Logitech: size, then FPS, then FOURCC. DirectShow is sensitive to order.
        applied: dict[str, bool] = {}
        setting_errors: dict[str, str] = {}
        def set_property(key: str, prop: int, value: Any) -> None:
            try:
                applied[key] = bool(cap.set(prop, value))
            except Exception as exc:
                applied[key] = False
                setting_errors[key] = f"{type(exc).__name__}: {str(exc)[:240]}"
        def get_property(prop: int) -> float:
            try:
                return float(cap.get(prop))
            except Exception:
                return float("nan")
        for key, prop in [("width", cv2.CAP_PROP_FRAME_WIDTH), ("height", cv2.CAP_PROP_FRAME_HEIGHT), ("fps", cv2.CAP_PROP_FPS)]:
            if params[key] is not None:
                set_property(key, prop, params[key])
        if params["fourcc"]:
            set_property("fourcc", cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*params["fourcc"]))
        fourcc_value = get_property(cv2.CAP_PROP_FOURCC)
        fourcc_int = int(fourcc_value) if math.isfinite(fourcc_value) and 0 <= fourcc_value <= 0xffffffff else 0
        negotiated_fourcc = "".join(chr((fourcc_int >> (8 * i)) & 255) for i in range(4)).strip("\x00")
        fps = get_property(cv2.CAP_PROP_FPS)
        info = {
            "index": params["index"], "backend": actual_backend,
            "fps": fps if math.isfinite(fps) and fps > 0 else None, "fourcc": negotiated_fourcc or "unknown",
            "requested": params, "settings_applied": applied, "setting_errors": setting_errors, "fps_evidence": "driver-reported, not measured", **identity,
        }
        failures = 0
        skipped = 0
        frame_sequence = 0
        previous_gray = None
        while not stopped.is_set():
            ok, frame = cap.read()
            if not ok or frame is None:
                failures += 1
                if failures >= 5:
                    _put_latest(out, {"error": "no_frames", "message": "The camera opened but did not deliver frames."})
                    return
                time.sleep(0.05)
                continue
            captured_at_monotonic = time.monotonic()
            failures = 0
            if skipped < params["warmup"]:
                skipped += 1
                continue
            info["height"], info["width"] = frame.shape[:2]
            info["warnings"] = negotiation_warnings(params, info, applied)
            info["received_frame"] = True
            if params["mode"] != "raw" or params["flicker"]:
                import numpy as np
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
                unfiltered = gray
                if params["flicker"] and previous_gray is None:
                    previous_gray = unfiltered
                    continue  # A still capture also needs two real frames for this filter.
                if params["flicker"] and previous_gray is not None and previous_gray.shape == gray.shape:
                    gray = np.maximum(gray, previous_gray)
                previous_gray = unfiltered
                if params["mode"] == "stretch":
                    low, high = np.percentile(gray, (1, 99))
                    if high > low:
                        gray = np.clip((gray.astype(np.float32) - low) * 255 / (high - low), 0, 255).astype(np.uint8)
                elif params["mode"] == "clahe":
                    gray = cv2.createCLAHE(clipLimit=2, tileGridSize=(8, 8)).apply(gray)
                elif params["mode"] == "threshold":
                    _, gray = cv2.threshold(gray, params["threshold"], 255, cv2.THRESH_BINARY)
                elif params["mode"] == "otsu":
                    _, gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                frame = gray
            extension = ".jpg" if streaming else ".png"
            ok, encoded = cv2.imencode(extension, frame, [cv2.IMWRITE_JPEG_QUALITY, 85] if streaming else [])
            if not ok:
                _put_latest(out, {"error": "encode_failed", "message": "The camera frame could not be encoded."})
                return
            frame_sequence += 1
            _put_latest(out, {"info": dict(info), "data": encoded.tobytes(),
                "frame_sequence": frame_sequence, "captured_at_monotonic": captured_at_monotonic})
            if not streaming:
                return
    except BridgeError as exc:
        _put_latest(out, {"error": exc.code, "message": exc.message})
    except Exception:
        _put_latest(out, {"error": "camera_error", "message": "The native camera driver failed. Check camera permissions and close other camera apps."})
    finally:
        if cap is not None:
            cap.release()


def audio_worker(options: dict[str, Any], out: Any, stopped: Any, record: bool) -> None:
    """Raw native PCM, with no resampling, mixing or noise processing."""
    try:
        try:
            import sounddevice as sd
            import numpy as np
        except (ImportError, OSError):
            out.put({"error": "audio_dependency_missing", "message": "Install sounddevice from bridge/requirements.txt. Linux also needs the PortAudio system library."})
            return
        if not record:
            devices = [dict(value, index=index) for index, value in enumerate(sd.query_devices()) if value["max_input_channels"] > 0]
            out.put({"info": {"devices": devices, "note": "These are native audio indexes, separate from browser deviceIds. In a 6-channel LogiInsight entry, microphones are channels 1 and 4."}})
            return
        samples = sd.rec(options["duration"] * options["sample_rate"], samplerate=options["sample_rate"],
                         channels=options["channels"], device=options["index"], dtype="int16", blocking=True)
        normalized = samples.astype(np.float64) / 32768
        levels = []
        for index in range(options["channels"]):
            values = normalized[:, index]
            duplicate = next((other + 1 for other in range(index) if np.array_equal(samples[:, index], samples[:, other])), None)
            levels.append({"channel": index + 1, "rms": round(float(np.sqrt(np.mean(values * values))), 6),
                           "peak": round(float(np.max(np.abs(values))), 6), "silent": bool(np.all(samples[:, index] == 0)),
                           "duplicate_of": duplicate})
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as output:
            output.setnchannels(options["channels"])
            output.setsampwidth(2)
            output.setframerate(options["sample_rate"])
            output.writeframes(samples.astype("<i2", copy=False).tobytes())
        out.put({"info": {**options, "channel_levels": levels}, "data": buffer.getvalue()})
    except Exception:
        _put_latest(out, {"error": "audio_unavailable", "message": "The microphone could not deliver the requested raw PCM format. Check its exact native index, supported channel count, sample rate and OS permission."})


class CameraJob:
    def __init__(self, request: CameraRequest, streaming: bool = False):
        ctx = mp.get_context("spawn")
        self.output = ctx.Queue(maxsize=2)
        self.stop_event = ctx.Event()
        self.label = "camera"
        self.job_id = uuid.uuid4().hex
        self.request = request
        self.last_info: dict[str, Any] | None = None
        self.frame_sequence = 0
        self.frame_captured_at: float | None = None
        self.process = ctx.Process(target=camera_worker, args=(asdict(request), self.output, self.stop_event, streaming), daemon=True)

    def start(self) -> None:
        self.process.start()

    def accept_result(self, result: dict[str, Any]) -> dict[str, Any]:
        self.last_info = result.get("info")
        sequence, captured_at = result.get("frame_sequence"), result.get("captured_at_monotonic")
        if type(sequence) is int and sequence > 0 and type(captured_at) in {int, float} and math.isfinite(captured_at):
            # Python 3.10+ monotonic clocks use the same reference across these
            # local worker processes. A queued frame must retain its capture
            # age; pulling it or polling HTTP status never makes it fresh again.
            self.frame_sequence = sequence
            self.frame_captured_at = captured_at
        return result

    async def next_frame(self, timeout: float, request: web.Request | None = None) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if request is not None and (request.transport is None or request.transport.is_closing()):
                raise ConnectionResetError
            try:
                result = await asyncio.to_thread(self.output.get, True, 0.2)
                if "error" in result:
                    raise BridgeError(result["error"], result["message"])
                return self.accept_result(result)
            except queue.Empty:
                if self.process.exitcode is not None:
                    # A child's queue feeder may finish just after its process.
                    try:
                        result = self.output.get(timeout=0.1)
                    except queue.Empty:
                        raise BridgeError("capture_stopped", f"The native {self.label} process stopped without a result.")
                    if "error" in result:
                        raise BridgeError(result["error"], result["message"])
                    return self.accept_result(result)
        raise BridgeError("capture_timeout", f"The native {self.label} did not deliver a result within {timeout:g} seconds.", 504)

    async def close(self) -> None:
        self.stop_event.set()
        if self.process.pid is None:
            self.output.close()
            self.output.cancel_join_thread()
            return
        await asyncio.to_thread(self.process.join, 0.5)
        if self.process.is_alive():
            self.process.terminate()
            await asyncio.to_thread(self.process.join, 1)
        if self.process.is_alive():
            self.process.kill()
            await asyncio.to_thread(self.process.join, 1)
        self.output.close()
        self.output.cancel_join_thread()


class AudioJob(CameraJob):
    def __init__(self, options: dict[str, Any], record: bool):
        ctx = mp.get_context("spawn")
        self.output = ctx.Queue(maxsize=1)
        self.stop_event = ctx.Event()
        self.label = "audio"
        self.process = ctx.Process(target=audio_worker, args=(options, self.output, self.stop_event, record), daemon=True)


class InventoryJob(CameraJob):
    def __init__(self, backend: str):
        ctx = mp.get_context("spawn")
        self.output = ctx.Queue(maxsize=1)
        self.stop_event = ctx.Event()
        self.label = "camera inventory"
        self.process = ctx.Process(target=inventory_worker, args=(backend, self.output, self.stop_event), daemon=True)


class LogiConnection:
    """A single serialized SFTP session; credentials never pass through HTTP."""
    def __init__(self, ip: str, timeout: float):
        self.ip = ip
        self.timeout = timeout
        self.client = None
        self.sftp = None
        self.lock = threading.RLock()

    def disconnect(self) -> None:
        with self.lock:
            for obj in (self.sftp, self.client):
                if obj:
                    with contextlib.suppress(Exception):
                        obj.close()
            self.sftp = self.client = None

    def _connect(self) -> None:
        if self.client and self.client.get_transport() and self.client.get_transport().is_active():
            return
        self.disconnect()
        try:
            import paramiko
        except ImportError:
            raise BridgeError("paramiko_missing", "Install bridge/requirements.txt to read on-device AI data.")
        username = os.environ.get("LOGIWEBCAM_USER")
        password = os.environ.get("LOGIWEBCAM_PASSWORD")
        if not username or not password:
            raise BridgeError("credentials_missing", "Set LOGIWEBCAM_USER and LOGIWEBCAM_PASSWORD from the kit card in the terminal that starts the bridge.")
        client = paramiko.SSHClient()
        client.load_system_host_keys()
        known_hosts = os.environ.get("LOGIWEBCAM_KNOWN_HOSTS")
        if known_hosts:
            try:
                client.load_host_keys(known_hosts)
            except OSError:
                raise BridgeError("known_hosts_unreadable", "The LOGIWEBCAM_KNOWN_HOSTS file could not be read.")
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        try:
            client.connect(self.ip, port=22, username=username, password=password,
                           timeout=self.timeout, auth_timeout=self.timeout, banner_timeout=self.timeout,
                           look_for_keys=False, allow_agent=False)
            sftp = client.open_sftp()
            sftp.get_channel().settimeout(self.timeout)
        except paramiko.AuthenticationException:
            client.close()
            raise BridgeError("authentication_failed", "Camera authentication failed. Check the kit-card credentials in the bridge terminal.")
        except paramiko.BadHostKeyException:
            client.close()
            raise BridgeError("host_key_changed", "The camera SSH host key changed. Verify the connected camera and update its known_hosts entry before reconnecting.")
        except paramiko.SSHException as exc:
            client.close()
            if "not found in known_hosts" in str(exc):
                raise BridgeError("host_key_unknown", "Trust this camera once with sftp USER@192.168.1.10 in your terminal, verify its key, then reconnect here.")
            raise BridgeError("ssh_failed", "The camera SSH session failed. Check the USB network adapter and camera connection.")
        except (OSError, EOFError):
            client.close()
            raise BridgeError("connection_failed", "Cannot connect to the camera. Check its USB network adapter (host 192.168.1.20/24), local-network permission and port 22.")
        self.client, self.sftp = client, sftp

    def _read(self, path: str, limit: int) -> bytes | None:
        self._connect()
        try:
            with self.sftp.open(path, "rb") as file:
                result = file.read(limit + 1)
            if len(result) > limit:
                raise BridgeError("data_too_large", "The camera file exceeds this bridge's size limit.")
            return result
        except FileNotFoundError:
            return None
        except (OSError, EOFError):
            self.disconnect()
            raise BridgeError("read_failed", "The camera file could not be read. Reconnect the camera and retry.")

    def latest(self) -> dict[str, Any] | None:
        with self.lock:
            raw = self._read(AI_PATH, 2 * 1024 * 1024)
            if not raw or not raw.strip():
                return None
            try:
                data = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                return None  # The device may be replacing the file.
            if not isinstance(data, dict):
                raise BridgeError("invalid_ai_json", "The camera's AI file is not a JSON object.")
            return data

    def configuration(self) -> dict[str, bool]:
        with self.lock:
            raw = self._read(CONFIG_PATH, 65536)
            parser = configparser.ConfigParser()
            if raw:
                try:
                    parser.read_string(raw.decode("utf-8"))
                except (configparser.Error, UnicodeDecodeError):
                    raise BridgeError("invalid_ai_config", "The camera AI configuration could not be parsed.")
            result = dict(AI_FLAGS)
            if parser.has_section("logiwebcam_ai"):
                for key in result:
                    try:
                        result[key] = parser.getboolean("logiwebcam_ai", key, fallback=result[key])
                    except ValueError:
                        raise BridgeError("invalid_ai_config", "The camera AI configuration contains a non-boolean flag.")
            return result

    def set_configuration(self, changes: dict[str, bool]) -> dict[str, bool]:
        with self.lock:
            values = self.configuration()
            values.update(changes)
            if not values["enable_face_detection"]:
                values["enable_face_mesh"] = False
            parser = configparser.ConfigParser()
            parser["logiwebcam_ai"] = {k: "1" if v else "0" for k, v in values.items()}
            stream = io.StringIO()
            parser.write(stream)
            try:
                with self.sftp.open(CONFIG_PATH, "w") as file:
                    file.write(stream.getvalue())
                    file.flush()
            except (OSError, EOFError):
                self.disconnect()
                raise BridgeError("config_write_failed", "The camera rejected the AI configuration write.")
            return values

    def diagnostics(self) -> dict[str, Any]:
        with self.lock:
            configuration = self.configuration()
            data = self.latest()
            status = self._read(YUV_STATUS_PATH, 16384)
            return {"configuration": configuration, "ai_available": data is not None,
                    "api_version": data.get("api_version") if data else None,
                    "plugin_loaded": data.get("plugin_loaded") if data else None,
                    "timestamp_ms": data.get("timestamp_ms") if data else None,
                    "faces": len(data.get("faces", [])) if data else 0,
                    "yuv_status": status.decode("utf-8", "replace").strip() if status else None,
                    "note": "AI timestamps are the camera's wrapping clock, not the host's wall clock."}

    def firmware(self) -> dict[str, Any]:
        """Use the documented SDK call; do not guess unlisted firmware paths."""
        with self.lock:
            self._connect()  # Verify our normal credentials and known-host policy first.
            try:
                sdk_directory = os.environ.get("LOGIWEBCAM_SDK_DIR")
                if sdk_directory:
                    path = Path(sdk_directory).expanduser() / "logiwebcam.py"
                    spec = importlib.util.spec_from_file_location("aperture_logiwebcam_sdk", path)
                    if not spec or not spec.loader:
                        raise ImportError
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[spec.name] = module
                    spec.loader.exec_module(module)
                    client_type = module.LogiWebcamClient
                else:
                    from logiwebcam import LogiWebcamClient
                    client_type = LogiWebcamClient
            except (ImportError, OSError, AttributeError):
                raise BridgeError("sdk_missing", "Firmware inspection needs the official Logitech SDK. Set LOGIWEBCAM_SDK_DIR to the folder containing logiwebcam.py, then restart the bridge.", 501)
            client = None
            try:
                client = client_type(ip=self.ip, timeout=self.timeout)
                client.connect()
                version = client.get_firmware_version()
                return {"firmware": version, "source": "LogiWebcamClient.get_firmware_version", "available": version is not None}
            except Exception:
                raise BridgeError("firmware_unavailable", "The official SDK could not read the firmware version. Check the SDK version and camera connection.")
            finally:
                if client:
                    with contextlib.suppress(Exception):
                        client.disconnect()

    def snapshot(self) -> dict[str, Any]:
        """Enable paired NV12 briefly; restore the prior flag even after a failure."""
        try:
            import cv2
            import numpy as np
        except ImportError:
            raise BridgeError("opencv_missing", "Install bridge/requirements.txt to decode a paired camera snapshot.")
        with self.lock:
            previous = self.configuration()
            initial = self.latest()
            initial_timestamp = initial.get("yuv_capture_timestamp_ms") if initial else None
            self.set_configuration({"enable_yuv_snapshot": True})
            result = None
            error = None
            try:
                # The INI is re-read around twice per second. Do not pair an old
                # snapshot left on disk with an unrelated new AI frame.
                for _ in range(6):
                    time.sleep(0.5)
                    data = self.latest()
                    if not data or data.get("yuv_capture_timestamp_ms") in {None, initial_timestamp}:
                        continue
                    raw = self._read(YUV_PATH, 40 * 1024 * 1024)
                    if not raw or len(raw) < 8:
                        continue
                    if not snapshot_timestamps_match(data, struct.unpack("<Q", raw[:8])[0]):
                        continue
                    width = bounded_int(data.get("yuv_width"), "yuv_width", 16, 4096)
                    height = bounded_int(data.get("yuv_height"), "yuv_height", 16, 4096)
                    if width % 2 or height % 2 or data.get("yuv_pixel_format", "NV12") != "NV12":
                        raise BridgeError("invalid_snapshot", "The camera did not supply an even-sized NV12 frame.")
                    stride_y = bounded_int(data.get("yuv_stride_y", width), "yuv_stride_y", width, 8192)
                    stride_uv = bounded_int(data.get("yuv_stride_uv", width), "yuv_stride_uv", width, 8192)
                    header_size = bounded_int(data.get("yuv_header_size", 8), "yuv_header_size", 8, 8)
                    needed = stride_y * height + stride_uv * (height // 2)
                    if len(raw) < header_size + needed:
                        continue
                    payload = np.frombuffer(raw, dtype=np.uint8, offset=header_size, count=needed)
                    y = payload[:stride_y * height].reshape(height, stride_y)[:, :width]
                    uv = payload[stride_y * height:].reshape(height // 2, stride_uv)[:, :width]
                    image = cv2.cvtColor(np.vstack((y, uv)), cv2.COLOR_YUV2BGR_NV12)
                    ok, png = cv2.imencode(".png", image)
                    if not ok:
                        raise BridgeError("encode_failed", "The paired camera frame could not be encoded.")
                    result = {"device_ai_data": data, "image_resolution": {"width": width, "height": height},
                              "image_data_url": "data:image/png;base64," + base64.b64encode(png.tobytes()).decode("ascii"),
                              "synchronized": True}
                    break
                if result is None:
                    raise BridgeError("snapshot_unavailable", "No matching RGB snapshot arrived. Keep an RGB reader open and check the device snapshot status.")
            except Exception as exc:
                error = exc
            finally:
                try:
                    self.set_configuration({"enable_yuv_snapshot": previous["enable_yuv_snapshot"]})
                except BridgeError:
                    raise BridgeError("snapshot_restore_failed", "The camera disconnected before the snapshot flag could be restored. Reconnect and turn enable_yuv_snapshot off in AI settings.")
            if error:
                raise error
            return result


class Bridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.allowed_origins = {f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}", f"http://[::1]:{args.port}"}
        self.allowed_origins.update(args.allow_origin)
        self.logi = LogiConnection(args.camera_ip, args.ssh_timeout)
        self.active_cameras: dict[int, CameraJob] = {}
        self.active_audio: AudioJob | None = None
        self.sockets: set[web.WebSocketResponse] = set()
        self.poll_task: asyncio.Task | None = None
        self.last_timestamp = None
        self.last_change = time.monotonic()

    async def camera(self, spec: CameraRequest, streaming: bool = False) -> CameraJob:
        if spec.index in self.active_cameras:
            raise BridgeError("camera_busy", f"Native camera index {spec.index} is already in use by this bridge.", 409)
        job = CameraJob(spec, streaming)
        self.active_cameras[spec.index] = job
        try:
            job.start()
        except Exception:
            self.active_cameras.pop(spec.index, None)
            raise BridgeError("camera_start_failed", "The native camera process could not start.")
        return job

    async def release(self, index: int, job: CameraJob) -> None:
        try:
            await job.close()
        finally:
            if self.active_cameras.get(index) is job:
                self.active_cameras.pop(index, None)

    async def broadcast(self, value: dict[str, Any]) -> None:
        async def send(socket: web.WebSocketResponse) -> None:
            try:
                await asyncio.wait_for(socket.send_json(value), timeout=2)
            except (ConnectionError, asyncio.TimeoutError, RuntimeError):
                self.sockets.discard(socket)
                await socket.close()
        await asyncio.gather(*(send(socket) for socket in tuple(self.sockets)), return_exceptions=True)

    async def poll(self) -> None:
        error_code = None
        stale_sent = False
        try:
            while self.sockets:
                begin = time.monotonic()
                try:
                    data = await asyncio.to_thread(self.logi.latest)
                    if data is None:
                        if error_code != "no_data":
                            await self.broadcast({"type": "bridge_status", "state": "waiting", "code": "no_data", "message": "Connected, waiting for AI JSON. Keep the RGB camera open."})
                        error_code = "no_data"
                    else:
                        if error_code:
                            await self.broadcast({"type": "bridge_status", "state": "connected", "message": "Receiving on-device AI JSON."})
                        error_code = None
                        stamp = data.get("timestamp_ms")
                        if stamp != self.last_timestamp or stamp is None:
                            self.last_timestamp, self.last_change = stamp, time.monotonic()
                            stale_sent = False
                            await self.broadcast(data)
                        elif time.monotonic() - self.last_change > 2 and not stale_sent:
                            stale_sent = True
                            await self.broadcast({"type": "bridge_status", "state": "stale", "message": "AI timestamp has not advanced for 2 seconds. Keep RGB open; verify firmware and AI settings."})
                except BridgeError as exc:
                    if error_code != exc.code:
                        await self.broadcast({"type": "bridge_status", "state": "error", "code": exc.code, "message": exc.message})
                    error_code = exc.code
                except Exception:
                    if error_code != "bridge_error":
                        await self.broadcast({"type": "bridge_status", "state": "error", "code": "bridge_error", "message": "The AI connection failed. Check the bridge terminal and camera connection."})
                    error_code = "bridge_error"
                interval = 1.0 if error_code else 1 / self.args.poll_hz
                await asyncio.sleep(max(0, interval - (time.monotonic() - begin)))
        finally:
            self.poll_task = None


@web.middleware
async def security(request: web.Request, handler: Any) -> web.StreamResponse:
    bridge: Bridge = request.app[APP_KEY]
    origin = request.headers.get("Origin")
    try:
        check_request_origin(request.host, origin, request.headers.get("Sec-Fetch-Site"), bridge.allowed_origins, bridge.args.port)
        if request.method == "OPTIONS":
            response = web.Response(status=204)
        else:
            response = await handler(request)
    except BridgeError as exc:
        response = web.json_response({"error": exc.code, "message": exc.message}, status=exc.status)
    except web.HTTPException as exc:
        response = exc
    except (ConnectionResetError, asyncio.CancelledError):
        raise
    except Exception:
        response = web.json_response({"error": "bridge_error", "message": "The bridge request failed. Check local dependencies and camera permissions."}, status=500)
    if not response.prepared:
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if origin in bridge.allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


async def health(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    return web.json_response({"name": "Aperture local bridge", "version": VERSION, "status": "ready", "docs": API_DOCS,
        "platform": platform.system(), "default_camera_backend": default_camera_backend(), "camera_timeout_seconds": bridge.args.camera_timeout,
        "credentials_configured": bool(os.environ.get("LOGIWEBCAM_USER") and os.environ.get("LOGIWEBCAM_PASSWORD")),
        "active_camera_indices": list(bridge.active_cameras), "ai_subscribers": len(bridge.sockets),
        "capabilities": ["native-camera-inventory", "native-camera-probe", "native-camera-progress", "png-frame", "mjpeg-video", "ir-processing", "native-audio", "logiinsight-ai-json", "ai-configuration", "paired-nv12-snapshot", "firmware-sdk-attempt"],
        "endpoints": {"inventory": "/api/camera/inventory", "camera_status": "/api/camera/status", "devices": "/api/devices", "frame": "/api/frame", "video": "/api/video", "landmarks": "/api/landmarks",
                      "websocket": "/ws", "ai_config": "/api/ai/config", "diagnostics": "/api/ai/diagnostics", "snapshot": "/api/ai/snapshot",
                      "audio_devices": "/api/audio/devices", "audio_record": "/api/audio/record", "firmware": "/api/ai/firmware"}})


async def camera_inventory(request: web.Request) -> web.Response:
    backend = CameraRequest.from_query(request.query).backend
    job = InventoryJob(backend)
    try:
        job.start()
        result = await job.next_frame(10, request)
        return web.json_response(result["info"])
    finally:
        await job.close()


async def camera_status(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    expected = CameraRequest.from_query(request.query)
    index = expected.index
    expected_job_id = request.query.get("job_id")
    if expected_job_id is not None and (len(expected_job_id) != 32 or any(char not in "0123456789abcdef" for char in expected_job_id)):
        raise BridgeError("invalid_parameter", "job_id must be the exact identifier returned by camera status.", 400)
    job = bridge.active_cameras.get(index)
    settings = getattr(job, "last_info", None)
    job_id = getattr(job, "job_id", None)
    job_request = getattr(job, "request", None)
    actual_backend = str((settings or {}).get("backend") or getattr(job_request, "backend", "")).lower()
    if actual_backend == "auto":
        actual_backend = default_camera_backend()
    actual_uid = (settings or {}).get("unique_id") or getattr(job_request, "device_uid", None)
    expected_backend = default_camera_backend() if expected.backend == "auto" else expected.backend
    match_error = None
    if job is None:
        match_error = "camera_inactive"
    elif expected_job_id is not None and job_id != expected_job_id:
        match_error = "job_replaced"
    elif "backend" in request.query and expected_backend != "any" and actual_backend != expected_backend:
        match_error = "backend_mismatch"
    elif expected.device_uid is not None and actual_uid != expected.device_uid:
        match_error = "identity_mismatch"
    captured_at = getattr(job, "frame_captured_at", None)
    frame_age_ms = None
    if type(captured_at) in {int, float} and math.isfinite(captured_at):
        elapsed = time.monotonic() - captured_at
        if elapsed >= 0:
            frame_age_ms = round(elapsed * 1000, 1)
    return web.json_response({"index": index, "active": job is not None, "settings": settings,
        "job_id": job_id, "matches": match_error is None, "match_error": match_error,
        "frame_sequence": getattr(job, "frame_sequence", 0), "frame_age_ms": frame_age_ms,
        "timeout_ms": bridge.args.camera_timeout * 1000})


async def devices(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    count = bounded_int(request.query.get("max_index"), "max_index", 1, 32, 8)
    start = bounded_int(request.query.get("start_index"), "start_index", 0, 31, 0)
    if start + count > 32:
        raise BridgeError("invalid_parameter", "The requested index range must stay within 0–31.", 400)
    template = CameraRequest.from_query(request.query)
    if template.device_uid and count != 1:
        raise BridgeError("invalid_parameter", "An observed device_uid must be tested as one exact index.", 400)
    rows = []
    for index in range(start, start + count):
        if request.transport is None or request.transport.is_closing():
            raise ConnectionResetError
        row: dict[str, Any] = {"index": index, "name": f"Native camera {index}"}
        sys_name = Path(f"/sys/class/video4linux/video{index}/name")
        if platform.system() == "Linux" and sys_name.is_file():
            with contextlib.suppress(OSError):
                row["name"] = sys_name.read_text().strip()
        if index in bridge.active_cameras:
            rows.append({**row, "status": "in_use", "message": "Already open in this bridge; its reader was preserved.",
                "backend": template.backend, "requested": {**asdict(template), "index": index}, "received_frame": False})
            continue
        job = None
        try:
            spec = CameraRequest(**{**asdict(template), "index": index})
            job = await bridge.camera(spec)
            result = await job.next_frame(bridge.args.camera_timeout, request)
            rows.append({**row, **result["info"], "status": "available"})
        except BridgeError as exc:
            rows.append({**row, "status": "unavailable", "error": exc.code, "message": exc.message,
                "backend": template.backend, "requested": {**asdict(template), "index": index}, "received_frame": False})
        finally:
            if job is not None:
                await bridge.release(index, job)
    return web.json_response({"devices": rows, "probed": count, "start_index": start,
        "note": "Every requested free index was tried with the supplied settings. In-use indexes are retained without disturbing their reader. Names and sensor roles are never inferred from an index or requested mode."})


async def camera_frame(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    spec = CameraRequest.from_query(request.query)
    job = await bridge.camera(spec)
    try:
        frame = await job.next_frame(bridge.args.camera_timeout, request)
        return web.Response(body=frame["data"], content_type="image/png", headers={"X-Camera-Settings": json.dumps(frame["info"], separators=(",", ":")), "Access-Control-Expose-Headers": "X-Camera-Settings"})
    finally:
        await bridge.release(spec.index, job)


async def camera_video(request: web.Request) -> web.StreamResponse:
    bridge: Bridge = request.app[APP_KEY]
    spec = CameraRequest.from_query(request.query)
    job = await bridge.camera(spec, streaming=True)
    response = None
    try:
        # Fail with JSON before the multipart HTTP response if the device rejects us.
        frame = await job.next_frame(bridge.args.camera_timeout, request)
        headers = {"Content-Type": "multipart/x-mixed-replace; boundary=aperture-frame", "Cache-Control": "no-store",
                   "X-Content-Type-Options": "nosniff", "X-Camera-Settings": json.dumps(frame["info"], separators=(",", ":"))}
        origin = request.headers.get("Origin")
        if origin in bridge.allowed_origins:
            headers["Access-Control-Allow-Origin"] = origin
            headers["Vary"] = "Origin"
            headers["Access-Control-Expose-Headers"] = "X-Camera-Settings"
        response = web.StreamResponse(headers=headers)
        await response.prepare(request)
        while request.transport and not request.transport.is_closing():
            data = frame["data"]
            prefix = b"--aperture-frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(data)).encode() + b"\r\n\r\n"
            await asyncio.wait_for(response.write(prefix + data + b"\r\n"), timeout=5)
            frame = await job.next_frame(bridge.args.camera_timeout, request)
        return response
    except (ConnectionResetError, asyncio.TimeoutError):
        return response if response is not None else web.Response(status=499)
    except BridgeError:
        if response is None or not response.prepared:
            raise
        # Once multipart headers were sent, close that stream instead of trying
        # to send an incompatible JSON response over the existing connection.
        with contextlib.suppress(ConnectionResetError):
            await response.write_eof()
        return response
    finally:
        await bridge.release(spec.index, job)


async def landmarks(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    data = await asyncio.to_thread(bridge.logi.latest)
    if data is None:
        return web.json_response({"type": "bridge_status", "state": "waiting", "message": "No AI JSON yet. Keep the RGB camera open."}, status=202)
    return web.json_response(data)


async def ai_config(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    if request.method == "GET":
        return web.json_response(await asyncio.to_thread(bridge.logi.configuration))
    if request.content_type != "application/json":
        raise BridgeError("invalid_content_type", "Send application/json with documented boolean AI flags.", 415)
    try:
        changes = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise BridgeError("invalid_json", "Configuration must be valid JSON.", 400)
    if not isinstance(changes, dict) or not changes or set(changes) - set(AI_FLAGS) or any(type(value) is not bool for value in changes.values()):
        raise BridgeError("invalid_configuration", "Use only documented AI flags with true or false values.", 400)
    values = await asyncio.to_thread(bridge.logi.set_configuration, changes)
    return web.json_response({"configuration": values, "write_issued": True, "message": "Configuration written. The camera applies it while RGB is streaming, usually within one second; inspect the AI output to verify."})


async def diagnostics(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    return web.json_response(await asyncio.to_thread(bridge.logi.diagnostics))


async def snapshot(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    return web.json_response(await asyncio.to_thread(bridge.logi.snapshot))


async def firmware(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    return web.json_response(await asyncio.to_thread(bridge.logi.firmware))


async def native_audio(request: web.Request) -> web.Response:
    bridge: Bridge = request.app[APP_KEY]
    record = request.method == "POST"
    options = {}
    if record:
        if request.content_type != "application/json":
            raise BridgeError("invalid_content_type", "Send application/json with the native microphone index and recording settings.", 415)
        try:
            value = await request.json()
        except (ValueError, UnicodeDecodeError):
            raise BridgeError("invalid_json", "Recording settings must be valid JSON.", 400)
        if not isinstance(value, dict):
            raise BridgeError("invalid_parameter", "Recording settings must be a JSON object.", 400)
        options["index"] = bounded_int(value.get("index"), "index", 0, 1024)
        options["duration"] = bounded_int(value.get("duration"), "duration", 1, 30, 5)
        options["channels"] = bounded_int(value.get("channels"), "channels", 1, 8, 2)
        options["sample_rate"] = bounded_int(value.get("sample_rate"), "sample_rate", 16000, 48000, 48000)
        if options["sample_rate"] not in {16000, 48000}:
            raise BridgeError("invalid_parameter", "sample_rate must be 16000 or 48000.", 400)
    if bridge.active_audio is not None:
        raise BridgeError("audio_busy", "An audio request is already active. Wait for it to finish.", 409)
    job = AudioJob(options, record)
    bridge.active_audio = job
    try:
        job.start()
        result = await job.next_frame(options.get("duration", 0) + 12, request)
        if not record:
            return web.json_response(result["info"])
        return web.Response(body=result["data"], content_type="audio/wav", headers={
            "Content-Disposition": 'attachment; filename="aperture-audio.wav"',
            "X-Audio-Settings": json.dumps(result["info"], separators=(",", ":")),
            "Access-Control-Expose-Headers": "X-Audio-Settings, Content-Disposition"})
    finally:
        await job.close()
        if bridge.active_audio is job:
            bridge.active_audio = None


async def websocket(request: web.Request) -> web.WebSocketResponse:
    bridge: Bridge = request.app[APP_KEY]
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4096)
    await ws.prepare(request)
    bridge.sockets.add(ws)
    await ws.send_json({"type": "bridge_status", "state": "connecting", "message": "Bridge connected. Connecting to the camera AI endpoint…"})
    if bridge.poll_task is None:
        bridge.last_timestamp = None
        bridge.last_change = time.monotonic()
        bridge.poll_task = asyncio.create_task(bridge.poll())
    try:
        async for message in ws:
            if message.type == WSMsgType.TEXT:
                try:
                    value = json.loads(message.data)
                except ValueError:
                    await ws.send_json({"type": "bridge_status", "state": "error", "message": "Expected a JSON message."})
                    continue
                if isinstance(value, dict) and value.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
                # This connection is publish-only; AI writes go through POST /api/ai/config.
            elif message.type == WSMsgType.ERROR:
                break
    finally:
        bridge.sockets.discard(ws)
    return ws


async def index(request: web.Request) -> web.FileResponse:
    bridge: Bridge = request.app[APP_KEY]
    file = Path(bridge.args.web_root).resolve() / "index.html"
    if not file.is_file():
        raise BridgeError("app_missing", "App files were not found. Keep the bridge beside the dist folder or use --web-root.", 404)
    return web.FileResponse(file)


async def cleanup(app: web.Application) -> None:
    bridge: Bridge = app[APP_KEY]
    for ws in tuple(bridge.sockets):
        await ws.close(code=1001, message=b"Bridge stopping")
    if bridge.poll_task:
        bridge.poll_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await bridge.poll_task
    for index, job in tuple(bridge.active_cameras.items()):
        await bridge.release(index, job)
    if bridge.active_audio:
        await bridge.active_audio.close()
        bridge.active_audio = None
    await asyncio.to_thread(bridge.logi.disconnect)


def create_app(args: argparse.Namespace) -> web.Application:
    app = web.Application(middlewares=[security], client_max_size=16384)
    app[APP_KEY] = Bridge(args)
    app.add_routes([
        web.get("/health", health), web.get("/api/devices", devices), web.get("/api/camera/inventory", camera_inventory), web.get("/api/camera/status", camera_status),
        web.get("/api/frame", camera_frame), web.get("/api/video", camera_video),
        web.get("/api/landmarks", landmarks), web.get("/api/ai/config", ai_config),
        web.post("/api/ai/config", ai_config), web.get("/api/ai/diagnostics", diagnostics),
        web.get("/api/ai/snapshot", snapshot), web.get("/api/ai/firmware", firmware),
        web.get("/api/audio/devices", native_audio), web.post("/api/audio/record", native_audio),
        web.get("/ws", websocket), web.get("/", index),
        web.options("/{path:.*}", health),
    ])
    root = Path(args.web_root).resolve()
    if root.is_dir():
        app.router.add_static("/", root, show_index=False, follow_symlinks=False)
    app.on_cleanup.append(cleanup)
    return app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9040)
    parser.add_argument("--web-root", default=str(Path(__file__).resolve().parents[1] / "dist"))
    parser.add_argument("--allow-origin", action="append", default=[], type=validate_origin, help="Exact optional hosted app origin; repeat for more than one.")
    parser.add_argument("--camera-ip", default=os.environ.get("LOGIWEBCAM_IP", "192.168.1.10"))
    parser.add_argument("--ssh-timeout", type=float, default=5)
    parser.add_argument("--camera-timeout", type=float, default=7)
    parser.add_argument("--poll-hz", type=float, default=15)
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error("--port must be from 1024 to 65535")
    if not 1 <= args.poll_hz <= 30:
        parser.error("--poll-hz must be from 1 to 30")
    if not 1 <= args.ssh_timeout <= 20 or not 2 <= args.camera_timeout <= 30:
        parser.error("Timeouts must be 1–20 seconds (SSH) and 2–30 seconds (camera)")
    return args


if __name__ == "__main__":
    mp.freeze_support()
    arguments = parse_args()
    print(f"Aperture bridge: http://127.0.0.1:{arguments.port}")
    print("No camera is opened until requested. Press Ctrl+C to release devices and stop.")
    web.run_app(create_app(arguments), host="127.0.0.1", port=arguments.port, access_log=None)
