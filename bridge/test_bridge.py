"""Tests deliberately use no camera, SSH credentials, or networked kit."""
import asyncio
import json
import queue
import threading
import types
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import bridge


class ValidationTests(unittest.TestCase):
    def test_snapshot_rejects_old_yuv_paired_with_new_ai(self):
        # The YUV header and YUV metadata agree, but the face result is newer.
        data = {"timestamp_ms": 102, "yuv_capture_timestamp_ms": 101,
                "face_timestamp_ms": 102, "faces": [{"capture_timestamp_ms": 102}]}
        self.assertFalse(bridge.snapshot_timestamps_match(data, 101))
        data["timestamp_ms"] = data["face_timestamp_ms"] = 101
        self.assertFalse(bridge.snapshot_timestamps_match(data, 101))  # Face still differs.
        data["faces"][0]["capture_timestamp_ms"] = 101
        self.assertTrue(bridge.snapshot_timestamps_match(data, 101))
        self.assertFalse(bridge.snapshot_timestamps_match(data, 100))  # Header differs.

    def test_snapshot_requires_primary_timestamps_and_uses_camera_clock(self):
        self.assertFalse(bridge.snapshot_timestamps_match({"yuv_capture_timestamp_ms": 7}, 7))
        self.assertFalse(bridge.snapshot_timestamps_match({"timestamp_ms": 7}, 7))
        self.assertTrue(bridge.snapshot_timestamps_match({"timestamp_ms": 0, "yuv_capture_timestamp_ms": 0, "faces": []}, 0))
        self.assertFalse(bridge.snapshot_timestamps_match({"timestamp_ms": True, "yuv_capture_timestamp_ms": 1}, 1))

    def test_exact_camera_id_and_bounds(self):
        request = bridge.CameraRequest.from_query({"index": "3", "width": "480", "height": "480", "fps": "30"})
        self.assertEqual(request.index, 3)
        self.assertEqual(request.width, 480)
        for value in ["-1", "32", "1.5", "abc", "1;ls", True]:
            with self.subTest(value=value), self.assertRaises(bridge.BridgeError):
                bridge.CameraRequest.from_query({"index": value})

    def test_native_format_is_explicit(self):
        self.assertEqual(bridge.CameraRequest.from_query({"fourcc": "nv12"}).fourcc, "NV12")
        with self.assertRaises(bridge.BridgeError):
            bridge.CameraRequest.from_query({"fourcc": "H264"})

    def test_only_exact_origins_and_loopback_host(self):
        allowed = {"http://127.0.0.1:9040", "https://app.example"}
        bridge.check_request_origin("127.0.0.1:9040", "https://app.example", "cross-site", allowed, 9040)
        bridge.check_request_origin("localhost:9040", None, None, allowed, 9040)
        for host, origin, fetch_site in [
            ("attacker.example:9040", None, None),
            ("127.0.0.1:9040", "https://app.example.attacker.test", "cross-site"),
            ("127.0.0.1:9040", "null", None),
            ("127.0.0.1:9040", None, "cross-site"),
            ("127.0.0.1:80", None, None),
        ]:
            with self.subTest(host=host, origin=origin), self.assertRaises(bridge.BridgeError):
                bridge.check_request_origin(host, origin, fetch_site, allowed, 9040)

    def test_config_turning_detection_off_also_turns_mesh_off(self):
        connection = bridge.LogiConnection("192.168.1.10", 1)
        written = []

        class File:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def write(self, value): written.append(value)
            def flush(self): pass

        connection._read = lambda path, limit: b"[logiwebcam_ai]\nenable_face_detection=1\nenable_face_mesh=1\nenable_yuv_snapshot=1\n"
        connection.sftp = types.SimpleNamespace(open=lambda *args: File())
        values = connection.set_configuration({"enable_face_detection": False})
        self.assertFalse(values["enable_face_mesh"])
        self.assertTrue(values["enable_yuv_snapshot"])
        self.assertIn("enable_face_mesh = 0", written[0])

    def test_camera_config_order_and_release(self):
        events = []

        class Capture:
            def __init__(self, index, backend): events.append(("open", index, backend))
            def isOpened(self): return True
            def set(self, prop, value): events.append(("set", prop, value))
            def get(self, prop): return 0
            def getBackendName(self): return "FAKE"
            def read(self): return True, types.SimpleNamespace(shape=(480, 640, 3))
            def release(self): events.append(("release",))

        fake = types.SimpleNamespace(CAP_AVFOUNDATION=1, CAP_V4L2=2, CAP_DSHOW=3, CAP_MSMF=4, CAP_ANY=5,
            CAP_PROP_FRAME_WIDTH=10, CAP_PROP_FRAME_HEIGHT=11, CAP_PROP_FPS=12, CAP_PROP_FOURCC=13,
            IMWRITE_JPEG_QUALITY=14, VideoCapture=Capture, VideoWriter_fourcc=lambda *args: 123,
            imencode=lambda *args: (True, types.SimpleNamespace(tobytes=lambda: b"PNG")))
        out = queue.Queue()
        spec = bridge.CameraRequest(index=4, width=640, height=480, fps=30, fourcc="MJPG")
        with patch.dict("sys.modules", {"cv2": fake}):
            bridge.camera_worker(bridge.asdict(spec), out, threading.Event(), False)
        self.assertEqual(events[0][1], 4)
        self.assertEqual([event[1] for event in events if event[0] == "set"], [10, 11, 12, 13])
        self.assertEqual(events[-1], ("release",))
        result = out.get()
        self.assertEqual(result["data"], b"PNG")
        self.assertEqual(result["frame_sequence"], 1)
        self.assertLessEqual(result["captured_at_monotonic"], bridge.time.monotonic())


class InventoryTests(unittest.TestCase):
    def avf(self, devices, muxed=()):
        return types.SimpleNamespace(AVMediaTypeVideo="video", AVMediaTypeMuxed="muxed",
            AVCaptureDevice=types.SimpleNamespace(
                devicesWithMediaType_=lambda media: devices if media == "video" else muxed,
                authorizationStatusForMediaType_=lambda media: 0))

    def device(self, name, uid, formats=()):
        return types.SimpleNamespace(localizedName=lambda: name, uniqueID=lambda: uid, modelID=lambda: "model",
            formats=lambda: formats, isConnected=lambda: True, isSuspended=lambda: False, isInUseByAnotherApplication=lambda: False)

    def test_mac_inventory_preserves_opencv_order_names_subtypes_and_fractional_rates_without_capture(self):
        mode = types.SimpleNamespace(formatDescription=lambda: (512, 640, 0x34323076),
            videoSupportedFrameRateRanges=lambda: [types.SimpleNamespace(minFrameRate=lambda: 29.97, maxFrameRate=lambda: 59.94)])
        devices = [self.device("Built-in camera", "rgb-id"), self.device("LVNext CPD Camera", "ir-id", [mode])]
        muxed = [self.device("LVNext Hello Camera", "hello-id")]
        avf = self.avf(devices, muxed)
        cm = types.SimpleNamespace(CMVideoFormatDescriptionGetDimensions=lambda desc: types.SimpleNamespace(width=desc[0], height=desc[1]),
            CMFormatDescriptionGetMediaSubType=lambda desc: desc[2])
        with patch.dict("sys.modules", {"AVFoundation": avf, "CoreMedia": cm}), patch.object(bridge.platform, "system", return_value="Darwin"):
            result = bridge.native_inventory()
        self.assertEqual([row["unique_id"] for row in result["devices"]], ["rgb-id", "ir-id", "hello-id"])
        self.assertEqual([row["index"] for row in result["devices"]], [0, 1, 2])
        self.assertEqual(result["permission"], "not_determined")
        self.assertFalse(result["capture_tested"])
        self.assertTrue(all(row["status"] == "enumerated" for row in result["devices"]))
        actual = result["devices"][1]["formats"][0]
        self.assertEqual(actual["media_subtype"], "420v", "An OS media subtype is not relabelled as a requested UVC FOURCC")
        self.assertEqual(actual["frame_rate_ranges"], [{"min": 29.97, "max": 59.94}])
        json.dumps(result, allow_nan=False)

    def test_mac_inventory_keeps_a_discovered_device_when_format_read_fails(self):
        device = self.device("LVNext CPD Camera", "ir-id")
        device.formats = lambda: (_ for _ in ()).throw(RuntimeError("driver metadata unavailable"))
        with patch.dict("sys.modules", {"AVFoundation": self.avf([device]), "CoreMedia": types.SimpleNamespace()}), patch.object(bridge.platform, "system", return_value="Darwin"):
            result = bridge.native_inventory()
        self.assertEqual(result["devices"][0]["name"], "LVNext CPD Camera")
        self.assertEqual(result["devices"][0]["status"], "inventory_error")
        self.assertFalse(result["devices"][0]["capture_tested"])

    def test_missing_optional_mac_inventory_is_explicit_without_fabricated_devices(self):
        with patch.dict("sys.modules", {"AVFoundation": None}), patch.object(bridge.platform, "system", return_value="Darwin"):
            result = bridge.native_inventory()
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error"], "mac_inventory_missing")
        self.assertEqual(result["devices"], [])

    def cv(self, events, backend_name="AVFOUNDATION"):
        class Capture:
            def __init__(self, index, backend): events.append(("open", index, backend))
            def isOpened(self): return True
            def set(self, prop, value): events.append(("set", prop, value)); return False
            def get(self, prop): return float("nan")
            def getBackendName(self): return backend_name
            def read(self): events.append(("read",)); return True, types.SimpleNamespace(shape=(480, 640, 3))
            def release(self): events.append(("release",))
        return types.SimpleNamespace(CAP_AVFOUNDATION=1, CAP_V4L2=2, CAP_DSHOW=3, CAP_MSMF=4, CAP_ANY=5,
            CAP_PROP_FRAME_WIDTH=10, CAP_PROP_FRAME_HEIGHT=11, CAP_PROP_FPS=12, CAP_PROP_FOURCC=13,
            IMWRITE_JPEG_QUALITY=14, VideoCapture=Capture, VideoWriter_fourcc=lambda *args: 123,
            imencode=lambda *args: (True, types.SimpleNamespace(tobytes=lambda: b"PNG")))

    def test_stale_unique_id_rejects_before_opening_a_different_camera(self):
        events, out = [], queue.Queue()
        spec = bridge.CameraRequest(index=0, backend="avfoundation", device_uid="old-id")
        with patch.dict("sys.modules", {"AVFoundation": self.avf([self.device("Different camera", "new-id")]), "cv2": self.cv(events)}), patch.object(bridge.platform, "system", return_value="Darwin"):
            bridge.camera_worker(bridge.asdict(spec), out, threading.Event(), False)
        self.assertEqual(out.get()["error"], "camera_identity_changed")
        self.assertEqual(events, [])

    def test_uid_verified_any_request_uses_avfoundation_and_exposes_actual_negotiation_failures(self):
        events, out = [], queue.Queue()
        spec = bridge.CameraRequest(index=0, backend="any", device_uid="rgb-id", width=1920, height=1080, fps=30, fourcc="NV12")
        with patch.dict("sys.modules", {"AVFoundation": self.avf([self.device("LVNext Camera", "rgb-id")]), "cv2": self.cv(events)}), patch.object(bridge.platform, "system", return_value="Darwin"):
            bridge.camera_worker(bridge.asdict(spec), out, threading.Event(), False)
        self.assertEqual(events[0], ("open", 0, 1), "A verified AVFoundation identity cannot be opened via another CAP_ANY backend")
        result = out.get()
        info = result["info"]
        self.assertEqual(info["name"], "LVNext Camera")
        self.assertEqual((info["width"], info["height"]), (640, 480))
        self.assertEqual(info["requested"]["width"], 1920)
        self.assertFalse(info["settings_applied"]["fourcc"])
        self.assertEqual(info["fourcc"], "unknown")
        self.assertIsNone(info["fps"])
        self.assertTrue(info["received_frame"])
        self.assertTrue(any("Requested width 1920; received 640" in warning for warning in info["warnings"]))
        json.dumps(info, allow_nan=False)

    def dshow(self, entries, events, empty_category=False):
        """Mock only property enumeration, with no capture/filter API to call."""
        property_interface = types.SimpleNamespace(_iid_="property-bag")
        device_interface = object()

        class Moniker:
            def __init__(self, properties): self.properties = properties
            def BindToStorage(self, left, context, iid):
                events.append(("metadata", iid))
                if isinstance(self.properties, Exception): raise self.properties
                return self
            def QueryInterface(self, interface):
                assert interface is property_interface
                return self
            def Read(self, name, pErrorLog):
                value = self.properties[name]
                if isinstance(value, Exception): raise value
                return value

        class Enumerator:
            def __init__(self): self.iterator = iter(entries)
            def Next(self, count):
                assert count == 1
                try: return Moniker(next(self.iterator)), 1
                except StopIteration: return None, 0

        class Owner:
            def CreateClassEnumerator(self, category, dwFlags):
                events.append(("enumerate", category, dwFlags))
                return None if empty_category else Enumerator()

        def create(clsid, interface):
            self.assertIs(interface, device_interface)
            events.append(("system-enumerator", clsid))
            return Owner()

        return {"comtypes": types.SimpleNamespace(GUID=lambda value: value,
                    CoInitialize=lambda: events.append(("init",)),
                    CoUninitialize=lambda: events.append(("uninit",)),
                    client=types.SimpleNamespace(CreateObject=create)),
                "comtypes.persist": types.SimpleNamespace(IPropertyBag=property_interface),
                "pygrabber": types.SimpleNamespace(),
                "pygrabber.dshow_core": types.SimpleNamespace(ICreateDevEnum=device_interface),
                "pygrabber.dshow_ids": types.SimpleNamespace(
                    DeviceCategories=types.SimpleNamespace(VideoInputDevice="video-category"),
                    clsids=types.SimpleNamespace(CLSID_SystemDeviceEnum="system-enumerator"))}

    def test_windows_inventory_preserves_raw_order_and_failed_metadata_without_capture(self):
        events = []
        entries = [{"FriendlyName": "Same model", "DevicePath": "path-one"},
                   RuntimeError("metadata not available"),
                   {"FriendlyName": "Same model", "DevicePath": "path-two"},
                   {"FriendlyName": "LVNext CPD Camera", "DevicePath": "cpd-path"},
                   {"FriendlyName": "Virtual camera", "DevicePath": KeyError("missing")},
                   {"FriendlyName": "LVNext Hello Camera", "DevicePath": "hello-path"}]
        with patch.dict("sys.modules", self.dshow(entries, events)), patch.object(bridge.platform, "system", return_value="Windows"):
            result = bridge.native_inventory()
        self.assertEqual(result["backend"], "dshow")
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["permission"], "unknown")
        self.assertFalse(result["capture_tested"])
        rows = result["devices"]
        self.assertEqual([row["index"] for row in rows], list(range(6)))
        self.assertEqual(rows[1]["status"], "inventory_error")
        self.assertNotIn("name", rows[1])
        self.assertEqual(rows[2]["unique_id"], "path-two", "A metadata failure must not shift later capture indexes")
        self.assertEqual(rows[3]["name"], "LVNext CPD Camera")
        self.assertEqual(rows[4]["name"], "Virtual camera")
        self.assertNotIn("unique_id", rows[4], "A missing DevicePath is not replaced by an invented identity")
        self.assertEqual(rows[5]["name"], "LVNext Hello Camera", "Restricted devices remain listed; availability is untested")
        self.assertTrue(all(not row["capture_tested"] and row["formats"] == [] for row in rows))
        self.assertTrue(result["warnings"])
        self.assertEqual(events[0], ("init",))
        self.assertEqual(events[-1], ("uninit",))
        json.dumps(result, allow_nan=False)

    def test_windows_empty_inventory_is_not_fabricated_and_missing_adapter_is_explicit(self):
        events = []
        with patch.dict("sys.modules", self.dshow([], events, empty_category=True)), patch.object(bridge.platform, "system", return_value="Windows"):
            result = bridge.native_inventory("any")
        self.assertEqual(result["devices"], [])
        self.assertEqual(result["backend"], "dshow")
        self.assertEqual(result["status"], "available")
        self.assertEqual(events[-1], ("uninit",))
        with patch.dict("sys.modules", {"comtypes": None}), patch.object(bridge.platform, "system", return_value="Windows"):
            result = bridge.native_inventory()
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error"], "windows_inventory_missing")
        self.assertEqual(result["devices"], [])

    def test_windows_msmf_cannot_borrow_directshow_names_or_identifiers(self):
        events, out = [], queue.Queue()
        with patch.object(bridge, "directshow_devices", side_effect=AssertionError("Wrong enumeration backend")), patch.object(bridge.platform, "system", return_value="Windows"), patch.dict("sys.modules", {"cv2": self.cv(events, "MSMF")}):
            result = bridge.native_inventory("msmf")
            bridge.camera_worker(bridge.asdict(bridge.CameraRequest(index=1, backend="msmf", device_uid="cpd-path")), out, threading.Event(), False)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["devices"], [])
        self.assertEqual(out.get()["error"], "identity_backend_mismatch")
        self.assertEqual(events, [])

    def test_windows_failed_enumeration_releases_com_and_never_claims_an_empty_success(self):
        events = []
        modules = self.dshow([], events)
        def fail(*args, **kwargs): raise RuntimeError("driver initialization failed")
        modules["comtypes"].client.CreateObject = fail
        with patch.dict("sys.modules", modules), patch.object(bridge.platform, "system", return_value="Windows"):
            result = bridge.native_inventory()
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error"], "windows_inventory_failed")
        self.assertEqual(result["devices"], [])
        self.assertEqual(events, [("init",), ("uninit",)])

    def test_windows_hotplug_identity_mismatch_rejects_before_open(self):
        events, out = [], queue.Queue()
        entries = [{"FriendlyName": "LVNext Camera", "DevicePath": "rgb-path"}]
        with patch.dict("sys.modules", {**self.dshow(entries, events), "cv2": self.cv(events, "DSHOW")}), patch.object(bridge.platform, "system", return_value="Windows"):
            bridge.camera_worker(bridge.asdict(bridge.CameraRequest(index=0, backend="dshow", device_uid="cpd-path")), out, threading.Event(), False)
        self.assertEqual(out.get()["error"], "camera_identity_changed")
        self.assertFalse(any(event[0] == "open" for event in events))

    def test_windows_verified_identity_forces_directshow_and_returns_real_negotiation(self):
        entries = [{"FriendlyName": "LVNext CPD Camera", "DevicePath": "cpd-path"}]
        for backend in ["auto", "any", "dshow"]:
            with self.subTest(backend=backend):
                events, out = [], queue.Queue()
                with patch.dict("sys.modules", {**self.dshow(entries, events), "cv2": self.cv(events, "DSHOW")}), patch.object(bridge.platform, "system", return_value="Windows"):
                    spec = bridge.CameraRequest(index=0, backend=backend, device_uid="cpd-path", width=512, height=640, fps=30, fourcc="MJPG")
                    bridge.camera_worker(bridge.asdict(spec), out, threading.Event(), False)
                self.assertIn(("open", 0, 3), events, "Identity-verified capture must select CAP_DSHOW explicitly")
                info = out.get()["info"]
                self.assertEqual(info["name"], "LVNext CPD Camera")
                self.assertTrue(info["identity_verified_before_open"])
                self.assertEqual((info["width"], info["height"]), (640, 480))
                self.assertEqual(info["requested"]["width"], 512)
                self.assertEqual(info["fourcc"], "unknown")
                self.assertTrue(info["received_frame"])
                self.assertEqual(events[-1], ("release",))

    def test_verified_directshow_identity_rejects_an_unexpected_capture_backend(self):
        events, out = [], queue.Queue()
        entries = [{"FriendlyName": "LVNext CPD Camera", "DevicePath": "cpd-path"}]
        with patch.dict("sys.modules", {**self.dshow(entries, events), "cv2": self.cv(events, "MSMF")}), patch.object(bridge.platform, "system", return_value="Windows"):
            bridge.camera_worker(bridge.asdict(bridge.CameraRequest(index=0, backend="any", device_uid="cpd-path")), out, threading.Event(), False)
        self.assertEqual(out.get()["error"], "identity_backend_mismatch")
        self.assertIn(("open", 0, 3), events)
        self.assertNotIn(("read",), events)
        self.assertEqual(events[-1], ("release",))


class HTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.args = bridge.parse_args([])
        self.app = bridge.create_app(self.args)
        self.server = TestServer(self.app)
        self.client = TestClient(self.server)
        await self.client.start_server()
        self.args.port = self.server.port
        self.state = self.app[bridge.APP_KEY]
        self.state.allowed_origins.add(f"http://127.0.0.1:{self.server.port}")

    async def asyncTearDown(self):
        await self.client.close()

    async def test_health_does_not_open_hardware(self):
        with patch.object(self.state.logi, "latest", side_effect=AssertionError("No AI request expected")):
            response = await self.client.get("/health")
            data = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(data["active_camera_indices"], [])
        self.assertNotIn("password", json.dumps(data).lower())

    async def test_rejected_origin_cannot_read_ai(self):
        with patch.object(self.state.logi, "latest", side_effect=AssertionError("Origin should reject first")):
            response = await self.client.get("/api/landmarks", headers={"Origin": "https://untrusted.example"})
        self.assertEqual(response.status, 403)
        self.assertEqual((await response.json())["error"], "origin_rejected")

    async def test_pending_data_and_passthrough(self):
        with patch.object(self.state.logi, "latest", return_value=None):
            response = await self.client.get("/api/landmarks")
            self.assertEqual(response.status, 202)
            self.assertEqual((await response.json())["type"], "bridge_status")
        data = {"api_version": 2, "timestamp_ms": 1, "faces": [], "future_key": "preserved"}
        with patch.object(self.state.logi, "latest", return_value=data):
            response = await self.client.get("/api/landmarks")
            self.assertEqual(await response.json(), data)

    async def test_config_requires_documented_booleans(self):
        for value in [{"enable_face_mesh": "true"}, {"path": "/etc/passwd"}, {}, [], {"enable_face_mesh": 1}]:
            response = await self.client.post("/api/ai/config", json=value)
            self.assertEqual(response.status, 400, value)
        with patch.object(self.state.logi, "set_configuration", return_value={"enable_face_mesh": True}) as writer:
            response = await self.client.post("/api/ai/config", json={"enable_face_mesh": True})
            self.assertEqual(response.status, 200)
            writer.assert_called_once_with({"enable_face_mesh": True})

    async def test_explicit_cors_only(self):
        self.state.allowed_origins.add("https://app.example")
        response = await self.client.options("/api/ai/config", headers={"Origin": "https://app.example"})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://app.example")
        response = await self.client.options("/api/ai/config", headers={"Origin": "https://other.example"})
        self.assertEqual(response.status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    async def test_websocket_announces_status_and_preserves_frames(self):
        with patch.object(self.state.logi, "latest", return_value={"api_version": 2, "timestamp_ms": 101, "faces": []}):
            ws = await self.client.ws_connect("/ws")
            status = await ws.receive_json(timeout=1)
            self.assertEqual(status["type"], "bridge_status")
            frame = await ws.receive_json(timeout=1)
            self.assertEqual(frame["api_version"], 2)
            self.assertEqual(frame["timestamp_ms"], 101)
            await ws.close()

    async def test_probe_attempts_each_exact_index_and_keeps_failures(self):
        opened, closed = [], []

        class FakeJob:
            def __init__(self, spec, streaming=False): self.spec = spec
            def start(self): opened.append(self.spec.index)
            async def next_frame(self, timeout, request=None):
                if self.spec.index == 1:
                    raise bridge.BridgeError("camera_unavailable", "Rejected by the OS")
                return {"info": {"index": self.spec.index, "width": 640, "height": 480}, "data": b"png"}
            async def close(self): closed.append(self.spec.index)

        with patch.object(bridge, "CameraJob", FakeJob):
            response = await self.client.get("/api/devices?max_index=3")
            data = await response.json()
        self.assertEqual(opened, [0, 1, 2])
        self.assertEqual(closed, [0, 1, 2])
        self.assertEqual([value["status"] for value in data["devices"]], ["available", "unavailable", "available"])
        self.assertEqual(self.state.active_cameras, {})

    async def test_exact_native_probe_honors_selected_backend_profile_and_nonzero_start(self):
        specs, released = [], []
        class FakeJob:
            def __init__(self, spec, streaming=False): self.spec = spec; specs.append(spec)
            def start(self): pass
            async def next_frame(self, timeout, request=None):
                if self.spec.index == 5: raise bridge.BridgeError("camera_unavailable", "Actual OS rejection")
                return {"info": {"index": self.spec.index, "width": 256, "height": 320, "received_frame": True}, "data": b"png"}
            async def close(self): released.append(self.spec.index)
        with patch.object(bridge, "CameraJob", FakeJob):
            response = await self.client.get("/api/devices?max_index=2&start_index=4&backend=avfoundation&width=512&height=640&fps=30&fourcc=MJPG&warmup=20")
            data = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual([spec.index for spec in specs], [4, 5])
        self.assertEqual([spec.backend for spec in specs], ["avfoundation", "avfoundation"])
        self.assertTrue(all(spec.width == 512 and spec.height == 640 and spec.fourcc == "MJPG" and spec.warmup == 20 for spec in specs))
        self.assertEqual([row["status"] for row in data["devices"]], ["available", "unavailable"])
        self.assertEqual(data["devices"][1]["requested"]["width"], 512)
        self.assertEqual(released, [4, 5])

    async def test_inventory_and_active_status_are_read_only(self):
        events = []
        expected = {"backend": "avfoundation", "permission": "denied", "capture_tested": False, "devices": [{"index": 2, "name": "LVNext CPD Camera", "status": "enumerated"}]}
        class FakeInventory:
            def __init__(self, backend): events.append(backend)
            def start(self): events.append("start")
            async def next_frame(self, timeout, request=None): return {"info": expected}
            async def close(self): events.append("close")
        with patch.object(bridge, "InventoryJob", FakeInventory), patch.object(bridge, "CameraJob", side_effect=AssertionError("Inventory must never open capture")):
            response = await self.client.get("/api/camera/inventory?backend=avfoundation")
            self.assertEqual(await response.json(), expected)
            status = await self.client.get("/api/camera/status?index=2")
            self.assertEqual(await status.json(), {"index": 2, "active": False, "settings": None,
                "job_id": None, "matches": False, "match_error": "camera_inactive", "frame_sequence": 0,
                "frame_age_ms": None, "timeout_ms": self.args.camera_timeout * 1000})
        self.assertEqual(events, ["avfoundation", "start", "close"])

    async def test_status_preserves_capture_age_of_a_queued_frame_and_only_actual_frames_advance_it(self):
        # Use the actual queue-consumption method without starting a process or
        # opening hardware. The driver-read time is deliberately older than the
        # time this frame reaches the server/browser.
        job = object.__new__(bridge.CameraJob)
        job.output = queue.Queue()
        job.process = types.SimpleNamespace(exitcode=None)
        job.last_info, job.frame_sequence, job.frame_captured_at = None, 0, None
        job.job_id = "a" * 32
        job.request = bridge.CameraRequest(index=2, backend="dshow", device_uid="cpd")
        settings = {"index": 2, "backend": "DSHOW", "unique_id": "cpd", "width": 512, "height": 640}
        captured_at = bridge.time.monotonic() - 10
        job.output.put({"info": settings, "data": b"frame", "frame_sequence": 7, "captured_at_monotonic": captured_at})
        await job.next_frame(1)
        self.state.active_cameras[2] = job
        try:
            url = "/api/camera/status?index=2&backend=dshow&device_uid=cpd&job_id=" + job.job_id
            first = await (await self.client.get(url)).json()
            second = await (await self.client.get(url)).json()
            self.assertTrue(first["matches"])
            self.assertEqual(first["frame_sequence"], 7)
            self.assertGreaterEqual(first["frame_age_ms"], 10000)
            self.assertGreaterEqual(second["frame_age_ms"], first["frame_age_ms"])
            self.assertEqual(second["frame_sequence"], 7, "HTTP polls must not manufacture frame progress")
            job.output.put({"info": settings, "data": b"new-frame", "frame_sequence": 9,
                "captured_at_monotonic": bridge.time.monotonic()})
            await job.next_frame(1)
            latest = await (await self.client.get(url)).json()
            self.assertEqual(latest["frame_sequence"], 9, "A bounded queue may skip intermediate camera frames")
            self.assertLess(latest["frame_age_ms"], second["frame_age_ms"])
        finally:
            self.state.active_cameras.clear()

    async def test_status_matches_the_reader_backend_and_identity_without_changing_ownership(self):
        job = types.SimpleNamespace(job_id="a" * 32, request=bridge.CameraRequest(index=2, backend="dshow", device_uid="cpd"),
            last_info={"index": 2, "backend": "DSHOW", "unique_id": "cpd"}, frame_sequence=3,
            frame_captured_at=bridge.time.monotonic())
        self.state.active_cameras[2] = job
        try:
            with patch.object(self.state, "camera", side_effect=AssertionError("Status must never open hardware")), patch.object(self.state, "release", side_effect=AssertionError("Status must never close a reader")):
                for parameters, error in [
                    ("backend=dshow&device_uid=cpd&job_id=" + "a" * 32, None),
                    ("backend=msmf&device_uid=cpd", "backend_mismatch"),
                    ("backend=dshow&device_uid=other", "identity_mismatch"),
                    ("backend=dshow&device_uid=cpd&job_id=" + "b" * 32, "job_replaced")
                ]:
                    result = await (await self.client.get("/api/camera/status?index=2&" + parameters)).json()
                    self.assertTrue(result["active"], "An unmatched active reader remains open")
                    self.assertEqual(result["matches"], error is None)
                    self.assertEqual(result["match_error"], error)
                    self.assertIs(self.state.active_cameras[2], job)
                response = await self.client.get("/api/camera/status?index=2&job_id=untrusted-value")
                self.assertEqual(response.status, 400)
        finally:
            self.state.active_cameras.clear()

    async def test_releasing_secondary_keeps_primary_progress_and_replacement_cannot_match_old_job(self):
        closed = []
        class Job:
            def __init__(self, index, letter):
                self.job_id = letter * 32
                self.request = bridge.CameraRequest(index=index, backend="dshow")
                self.last_info = {"index": index, "backend": "DSHOW"}
                self.frame_sequence = 12
                self.frame_captured_at = bridge.time.monotonic()
            async def close(self): closed.append(self.job_id)
        main, secondary, replacement = Job(0, "a"), Job(2, "b"), Job(2, "c")
        self.state.active_cameras.update({0: main, 2: secondary})
        try:
            await self.state.release(2, secondary)
            stopped = await (await self.client.get("/api/camera/status?index=2&job_id=" + secondary.job_id)).json()
            primary = await (await self.client.get("/api/camera/status?index=0&job_id=" + main.job_id)).json()
            self.assertFalse(stopped["active"])
            self.assertIsNone(stopped["frame_age_ms"])
            self.assertTrue(primary["active"] and primary["matches"])
            self.assertEqual(primary["frame_sequence"], 12)
            self.assertEqual(closed, [secondary.job_id])
            self.state.active_cameras[2] = replacement
            stale = await (await self.client.get("/api/camera/status?index=2&job_id=" + secondary.job_id)).json()
            self.assertFalse(stale["matches"])
            self.assertEqual(stale["match_error"], "job_replaced")
            self.assertEqual(stale["job_id"], replacement.job_id)
            self.assertEqual(closed, [secondary.job_id], "A stale status query must not release a replacement reader")
        finally:
            self.state.active_cameras.clear()

    async def test_opening_job_has_unique_identity_and_no_fabricated_frame(self):
        first = bridge.CameraJob(bridge.CameraRequest(index=2, backend="dshow"))
        second = bridge.CameraJob(bridge.CameraRequest(index=2, backend="dshow"))
        self.state.active_cameras[2] = first
        try:
            result = await (await self.client.get("/api/camera/status?index=2&backend=dshow")).json()
            self.assertTrue(result["active"] and result["matches"])
            self.assertEqual(result["frame_sequence"], 0)
            self.assertIsNone(result["frame_age_ms"])
            self.assertIsNone(result["settings"])
            self.assertEqual(result["job_id"], first.job_id)
            self.assertNotEqual(first.job_id, second.job_id)
            self.assertRegex(first.job_id, r"^[0-9a-f]{32}$")
        finally:
            self.state.active_cameras.clear()
            await first.close()
            await second.close()

    async def test_probe_keeps_an_active_reader_without_reopening_it(self):
        self.state.active_cameras[0] = object()
        try:
            with patch.object(bridge, "CameraJob", side_effect=AssertionError("Existing reader must remain open")):
                response = await self.client.get("/api/devices?max_index=1&width=512&height=640")
                result = await response.json()
            row = result["devices"][0]
            self.assertEqual(row["status"], "in_use")
            self.assertFalse(row["received_frame"])
            self.assertEqual(row["requested"]["width"], 512)
        finally:
            self.state.active_cameras.clear()

    async def test_audio_requires_exact_index_and_valid_format(self):
        for value in [{}, {"index": -1}, {"index": 0, "sample_rate": 44100}, {"index": 0, "channels": 9}, {"index": 0, "duration": 31}]:
            response = await self.client.post("/api/audio/record", json=value)
            self.assertEqual(response.status, 400, value)

    async def test_audio_wav_and_settings_are_returned_and_released(self):
        events = []

        class FakeJob:
            def __init__(self, options, record): self.options = options
            def start(self): events.append("start")
            async def next_frame(self, timeout, request=None):
                return {"info": self.options, "data": b"RIFF-TEST"}
            async def close(self): events.append("close")

        with patch.object(bridge, "AudioJob", FakeJob):
            response = await self.client.post("/api/audio/record", json={"index": 5, "duration": 1, "channels": 6, "sample_rate": 48000})
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), b"RIFF-TEST")
            self.assertEqual(json.loads(response.headers["X-Audio-Settings"])["index"], 5)
            self.assertEqual(response.content_type, "audio/wav")
        self.assertEqual(events, ["start", "close"])
        self.assertIsNone(self.state.active_audio)


if __name__ == "__main__":
    unittest.main()
