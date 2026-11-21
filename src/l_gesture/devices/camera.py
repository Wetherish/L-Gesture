"""Camera discovery by name and lifecycle-managed RGB capture."""

from dataclasses import dataclass
import sys

import cv2
from cv2_enumerate_cameras import enumerate_cameras

from l_gesture.vendor.logiinsight.camera_utils import open_camera


@dataclass(frozen=True)
class CameraDevice:
    index: int
    name: str
    backend: int


def preferred_backend():
    if sys.platform == "win32":
        return cv2.CAP_DSHOW
    if sys.platform == "darwin":
        return cv2.CAP_AVFOUNDATION
    return cv2.CAP_V4L2


def list_cameras():
    return [CameraDevice(item.index, item.name, item.backend)
            for item in enumerate_cameras(preferred_backend())]


def select_camera(name="LVNext Camera", device=None):
    if device is not None:
        return CameraDevice(device, f"Explicit device {device}", preferred_backend())
    cameras = list_cameras()
    exact = [camera for camera in cameras if camera.name.casefold() == name.casefold()]
    matches = exact or [camera for camera in cameras if name.casefold() in camera.name.casefold()]
    if len(matches) != 1:
        available = ", ".join(f"{camera.index}: {camera.name}" for camera in cameras) or "none"
        raise RuntimeError(f"Expected one camera matching {name!r}, found {len(matches)}. "
                           f"Available: {available}. Use --camera-name or --device.")
    return matches[0]


class CameraStream:
    def __init__(self, name="LVNext Camera", device=None, width=1280, height=720,
                 fps=30, pixel_format="NV12"):
        self.name, self.device = name, device
        self.width, self.height = width, height
        self.fps, self.pixel_format = fps, pixel_format
        self.capture = None
        self.info = None

    def __enter__(self):
        selected = select_camera(self.name, self.device)
        self.capture, self.info = open_camera(selected.index, selected.backend,
                                             self.width, self.height, self.pixel_format, self.fps)
        self.info["name"] = selected.name
        return self

    def read(self):
        if self.capture is None:
            raise RuntimeError("Open CameraStream with a with-block before reading")
        ok, frame = self.capture.read()
        return frame if ok else None

    def close(self):
        if self.capture is not None:
            self.capture.release()
            self.capture = None

    def __exit__(self, *_):
        self.close()
