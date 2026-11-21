# Gesture performance handoff

## Current implementation

The camera studio defaults to **Studio camera gestures**. It runs MediaPipe Hand Landmarker on one hand using the existing preview stream. The browser tries the GPU delegate and falls back to CPU if GPU initialization fails. The MediaPipe runtime and model download on first use, and inference runs locally. The gesture-source menu also supports the external Logitech Hand Tracker over its local WebSocket.

Pinch detection in studio mode measures thumb-to-index distance relative to palm length. Separate grab and release thresholds prevent flickering. A brief tracking interruption preserves the grab for up to 500 ms. The studio saves a photo's position on release.

## Measurements

These were short samples on the development Mac with the Logitech LVNext camera. Frame rates vary with workload, hand visibility, and browser scheduling. Detection timings measure the model call, and delivery timings start after the external tracker has produced telemetry.

| Setup | Observed result |
| --- | --- |
| Logitech studio preview, 720p | About 29 presented camera frames per second in a standalone preview measurement |
| External tracker, Logitech preview active | 14.9–17.3 tracking updates per second across separate samples |
| External tracker, FaceTime HD preview active | 16.7 tracking updates per second |
| External tracker, studio preview off | 24.3 tracking updates per second |
| Studio GPU tracker, external tracker stopped, hand in view | 27–30 tracking updates per second with 29–30 camera frames per second and 24–29 ms p95 detection time |

The preview comparison measured tracking cadence without a hand detected. The studio GPU samples included a detected hand, and a live pinch grab and release were observed. These runs were not a controlled end-to-end comparison of physical drag latency.

Local WebSocket delivery took 1–4 ms in the external-tracker runs. Turning off the studio preview improved external tracking throughput more than moving the preview to FaceTime HD. The results suggest that the second video stream and its processing contribute to the slowdown. The external app's camera, frame scheduling, and inference times were not individually measured. Reducing its camera resolution to 640×360 did not improve cadence in the short trial, so 720p was restored.

## Reproduce and continue

1. Run `npm start` with Node.js 22 or newer and open the studio at `http://localhost:3000/`. Choose the Logitech camera if available.
2. Quit the external tracker for the single-stream test. Select **Studio camera gestures**, enable gestures, and pinch and drag a pinned photo.
3. Read the rolling two-second sample in the browser console with `JSON.parse(document.querySelector('#gesture-status').dataset.metrics)`. It reports the delegate, camera presentation rate, tracking rate, p95 detection time, and number of frames with a detected hand.
4. To compare the external path, start Logitech Hand Tracker on port 9000, switch the gesture source, and sample `hand_telemetry` timestamps with the same camera setup and hand motion.

The next useful check is a longer repeatable drag benchmark with a hand in view in both modes. Measure missed grabs, tracking dropouts, and release latency as well as throughput. The CPU fallback and performance on other machines still need a live test. If the GPU path causes UI stalls, measure time spent on the page's main thread before moving inference into a worker.
