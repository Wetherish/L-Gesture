"""Protocol and lifecycle tests: no cameras, downloads, GPU or fabricated accuracy."""
import asyncio
import base64
from dataclasses import replace
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
from aiohttp.test_utils import TestClient, TestServer

import gpu_models as models
import gpu_server as server


def png_payload(width=8, height=6):
    image = Image.new("RGB", (width, height), (12, 55, 120))
    output = io.BytesIO()
    image.save(output, format="PNG")
    image.close()
    return {"requestId": "test:1", "model": "sam2.1-base-plus", "point": {"x": .5, "y": .5},
            "width": width, "height": height, "image": base64.b64encode(output.getvalue()).decode()}


class GeometryTests(unittest.TestCase):
    def test_valid_png_is_detached_from_base64_and_preserves_portrait_dimensions(self):
        raw = png_payload(30, 40)
        clean, image = server.decode_request(raw)
        self.assertNotIn("image", clean)
        self.assertEqual(image.size, (30, 40))
        self.assertEqual(image.mode, "RGB")
        image.close()

    def test_bounds_point_identifiers_and_unknown_fields_rejected(self):
        cases = [{"width": True}, {"width": 1601}, {"width": 1500, "height": 1500}, {"height": -1},
                 {"model": "../../somewhere"}, {"point": {"x": 1.01, "y": .5}}, {"point": {"x": float("nan"), "y": .5}},
                 {"point": {"x": True, "y": .5}}, {"requestId": "x\x00"}, {"unknown": 1}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(models.GPUError):
                server.decode_request({**png_payload(), **changes})

    def test_image_decoding_rejects_mismatch_corruption_non_png_and_large_payload(self):
        for changes in [{"width": 9}, {"image": "not-base64"}, {"image": base64.b64encode(b"not png").decode()},
                        {"image": "a" * (server.MAX_PNG_BYTES * 4 // 3 + 5)}]:
            with self.subTest(changes=list(changes)), self.assertRaises(models.GPUError):
                server.decode_request({**png_payload(), **changes})

    def test_rle_is_row_major_and_exact_for_empty_full_and_alternating_masks(self):
        for mask in [np.zeros((2, 3), bool), np.ones((2, 3), bool), np.array([[1, 0, 1], [0, 1, 0]], dtype=bool)]:
            counts = models.binary_rle(mask)
            decoded = np.concatenate([np.repeat(index % 2, count) for index, count in enumerate(counts)])
            np.testing.assert_array_equal(decoded, mask.reshape(-1))
            self.assertEqual(sum(counts), mask.size)
            self.assertTrue(all(count > 0 for count in counts[1:]))
        self.assertEqual(models.binary_rle(np.ones((2, 3), bool)), [0, 6])

    def test_mask_quality_only_ranks_masks_that_contain_the_supplied_point(self):
        logits = np.full((3, 6, 8), -5.)
        logits[0, 1:5, 2:6] = 2
        logits[1, 2:5, 3:7] = 3
        logits[2, 0, 0] = 5
        selected, score = models.choose_point_mask(logits, [.5, .7, .99], {"x": .5, "y": .5}, 8, 6)
        np.testing.assert_array_equal(selected, logits[1] > 0)
        self.assertEqual(score, .7)
        empty, score = models.choose_point_mask(logits, [.5, .7, .99], {"x": 1., "y": 0.}, 8, 6)
        self.assertFalse(empty.any())
        self.assertIsNone(score)

    def test_invalid_mask_dimensions_or_nonfinite_values_are_not_coerced(self):
        for masks, scores in [(np.zeros((2, 5, 8)), [.5, .6]), (np.zeros((1, 6, 8)), [float("nan")]), (np.full((1, 6, 8), float("inf")), [.5])]:
            with self.assertRaises(models.GPUError):
                models.choose_point_mask(masks, scores, {"x": .5, "y": .5}, 8, 6)

    def test_cuda_probe_reports_actual_values_and_explicit_unavailability(self):
        fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True, mem_get_info=lambda _: (123, 456), get_device_name=lambda _: "Fixture GPU"), __version__="2.9.1+cu128", version=types.SimpleNamespace(cuda="12.8"))
        self.assertEqual(models.cuda_probe(fake)["freeBytes"], 123)
        self.assertEqual(models.cuda_probe(fake)["totalBytes"], 456)
        fake.cuda.is_available = lambda: False
        self.assertFalse(models.cuda_probe(fake)["available"])

    def test_cuda_memory_failure_unloads_model_and_never_falls_back_to_cpu(self):
        import contextlib
        class OutOfMemory(Exception): pass
        class Inputs(dict):
            def to(self, device):
                self.device = device
                return self
        inputs = Inputs()
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(OutOfMemoryError=OutOfMemory,
            is_bf16_supported=lambda: True, empty_cache=lambda: None),
            bfloat16="bf16", float16="fp16", inference_mode=contextlib.nullcontext,
            autocast=lambda *args, **kwargs: contextlib.nullcontext())
        runtime = models.CUDARuntime()
        runtime.torch = torch
        runtime.loaded_model = "sam2.1-large"
        runtime._load = lambda spec: None
        runtime.processor = lambda **kwargs: inputs
        def exhausted(**kwargs): raise OutOfMemory("private runtime detail")
        runtime.model = exhausted
        image = Image.new("RGB", (8, 6))
        with self.assertRaises(models.GPUError) as error:
            runtime.segment({"requestId":"x", "model":"sam2.1-large", "point":{"x":.5,"y":.5}}, image)
        self.assertEqual(error.exception.code, "cuda_out_of_memory")
        self.assertNotIn("private runtime detail", error.exception.message)
        self.assertEqual(inputs.device, "cuda")
        self.assertIsNone(runtime.loaded_model)
        self.assertIsNone(runtime.model)

    def test_model_integrity_checks_weights_and_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            spec = replace(models.MODELS["sam2.1-tiny"], weight_bytes=4, weight_sha256=__import__('hashlib').sha256(b"test").hexdigest())
            directory = models.model_directory(spec, Path(temporary))
            directory.mkdir(parents=True)
            for name in models.model_files(spec):
                (directory / name).write_bytes(b"test")
            (directory / "roofcat-verified.json").write_text(json.dumps({"revision": spec.revision, "sha256": spec.weight_sha256}))
            self.assertTrue(models.installed_model(spec, Path(temporary)))
            with self.assertRaises(models.GPUError) as error:
                models.verify_model(spec, Path(temporary))
            self.assertEqual(error.exception.code, "model_integrity")

    def test_non_object_receipt_is_unavailable_instead_of_crashing_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            spec = models.MODELS["sam2.1-tiny"]
            directory = models.model_directory(spec, Path(temporary))
            directory.mkdir(parents=True)
            for receipt in [None, [], "incomplete", True, 12]:
                with self.subTest(receipt=receipt):
                    (directory / "roofcat-verified.json").write_text(json.dumps(receipt))
                    self.assertFalse(models.installed_model(spec, Path(temporary)))


class FakeRuntime:
    loaded_model = None
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.maximum = 0
        self.running = 0
        self.error = None
    def segment(self, request, image):
        self.calls += 1
        self.running += 1
        self.maximum = max(self.maximum, self.running)
        self.started.set()
        self.release.wait(2)
        self.running -= 1
        image.close()
        if self.error:
            raise self.error
        return {"requestId": request["requestId"], "fixture": True}
    def unload(self):
        pass


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = FakeRuntime()
        self.service = server.SegmentationService(self.runtime, timeout=.025, probe=lambda: {"available": True, "name": "Fixture GPU", "freeBytes": 123, "totalBytes": 456}, installed=lambda spec: True)
    async def asyncTearDown(self):
        self.runtime.release.set()
        if self.service.active is not None:
            await asyncio.shield(self.service.active)
        await self.service.close()
    async def until_started(self):
        await asyncio.to_thread(self.runtime.started.wait, 1)
    async def test_timeout_keeps_actual_job_busy_and_blocks_overlapping_inference(self):
        clean, image = server.decode_request(png_payload())
        task = asyncio.create_task(self.service.segment(clean, image))
        await self.until_started()
        with self.assertRaises(models.GPUError) as error:
            await task
        self.assertEqual(error.exception.code, "timeout")
        self.assertTrue(self.service.busy)
        clean2, image2 = server.decode_request(png_payload())
        with self.assertRaises(models.GPUError) as busy:
            await self.service.segment(clean2, image2)
        self.assertEqual(busy.exception.code, "busy")
        self.assertEqual(self.runtime.calls, 1)
        self.runtime.release.set()
        await asyncio.shield(self.service.active)
        await asyncio.sleep(0)
        self.assertFalse(self.service.busy)
        self.assertEqual(self.runtime.maximum, 1)
    async def test_client_cancellation_does_not_release_cuda_job_ownership(self):
        clean, image = server.decode_request(png_payload())
        task = asyncio.create_task(self.service.segment(clean, image))
        await self.until_started()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.service.busy)
        status = await self.service.status()
        self.assertTrue(status["busy"])
        self.assertTrue(status["models"][0]["available"])
    async def test_late_failure_is_consumed_and_next_job_can_run(self):
        self.runtime.error = models.GPUError("cuda_out_of_memory", "Fixture memory exhaustion")
        clean, image = server.decode_request(png_payload())
        task = asyncio.create_task(self.service.segment(clean, image))
        await self.until_started()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.runtime.release.set()
        with self.assertRaises(models.GPUError): await asyncio.shield(self.service.active)
        await asyncio.sleep(0)
        self.assertFalse(self.service.busy)
        self.assertEqual(self.service.last_error["code"], "cuda_out_of_memory")
        self.runtime.error = None
        clean, image = server.decode_request(png_payload())
        result = await self.service.segment(clean, image)
        self.assertEqual(result["requestId"], "test:1")
        self.assertEqual(self.runtime.maximum, 1)


class HTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        runtime = FakeRuntime()
        runtime.release.set()
        self.service = server.SegmentationService(runtime, probe=lambda: {"available": False, "name": None, "freeBytes": None, "totalBytes": None}, installed=lambda spec: False)
        self.client = TestClient(TestServer(server.create_app(port=9041, service=self.service)))
        await self.client.start_server()
        self.headers = {"Host": "127.0.0.1:9041", "Origin": server.DEFAULT_ORIGIN}
    async def asyncTearDown(self):
        await self.client.close()
    async def test_health_has_exact_protocol_models_and_no_camera_side_effect(self):
        response = await self.client.get('/api/segmentation/status', headers=self.headers)
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertEqual(data["protocol"], models.PROTOCOL)
        self.assertFalse(data["cuda"]["available"])
        self.assertEqual(len(data["models"]), 3)
        self.assertEqual(self.service.runtime.calls, 0)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], server.DEFAULT_ORIGIN)
    async def test_unapproved_origin_host_and_cross_site_without_origin_are_rejected(self):
        for headers in [{"Host": "evil.test:9041", "Origin": server.DEFAULT_ORIGIN},
                        {"Host": "127.0.0.1:9041", "Origin": "https://evil.test"},
                        {"Host": "127.0.0.1:9041", "Sec-Fetch-Site": "cross-site"}]:
            response = await self.client.get('/api/segmentation/status', headers=headers)
            self.assertEqual(response.status, 403)
            self.assertNotIn("Access-Control-Allow-Origin", response.headers)
    async def test_preflight_is_allowed_only_for_explicit_origin(self):
        response = await self.client.options('/api/segmentation/segment', headers=self.headers)
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers["Access-Control-Allow-Private-Network"], "true")
    async def test_strict_json_and_valid_request(self):
        response = await self.client.post('/api/segmentation/segment', data='bad', headers={**self.headers, "Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        response = await self.client.post('/api/segmentation/segment', json=png_payload(), headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["requestId"], "test:1")


if __name__ == '__main__':
    unittest.main()
