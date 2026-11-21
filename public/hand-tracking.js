const sdk = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const model = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

function localHand(landmarks, video, layer) {
  const [wrist, , , , thumb, , , , index, middle] = landmarks;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const distance = (a, b) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const palm = distance(wrist, middle);
  if (!palm) return undefined;

  const preview = video.getBoundingClientRect();
  const bounds = layer.getBoundingClientRect();
  const scale = Math.max(preview.width / width, preview.height / height);
  const offsetX = preview.left - bounds.left + (preview.width - width * scale) / 2;
  const offsetY = preview.top - bounds.top + (preview.height - height * scale) / 2;
  const clamp = value => Math.max(0, Math.min(1, value));
  return {
    label: 'camera',
    x: clamp((offsetX + (thumb.x + index.x) / 2 * width * scale) / bounds.width),
    y: clamp((offsetY + (thumb.y + index.y) / 2 * height * scale) / bounds.height),
    distance: distance(thumb, index) / palm,
  };
}

export async function trackCamera({ video, layer, signal, onHands, onMetrics, onError }) {
  if (!video.requestVideoFrameCallback) throw new Error('Camera tracking is unavailable in this browser.');
  const { FilesetResolver, HandLandmarker } = await import(sdk + '/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(sdk + '/wasm');
  signal.throwIfAborted();
  const options = { baseOptions: { modelAssetPath: model }, runningMode: 'VIDEO', numHands: 1 };
  let delegate = 'GPU';
  let tracker;
  try {
    tracker = await HandLandmarker.createFromOptions(files, {
      ...options, baseOptions: { ...options.baseOptions, delegate },
    });
  } catch {
    signal.throwIfAborted();
    delegate = 'CPU';
    tracker = await HandLandmarker.createFromOptions(files, options);
  }
  if (signal.aborted) {
    tracker.close();
    return;
  }

  let callback;
  let firstTime;
  let firstFrame;
  let durations = [];
  let detected = 0;
  const stop = () => {
    signal.removeEventListener('abort', stop);
    video.cancelVideoFrameCallback(callback);
    tracker.close();
  };
  signal.addEventListener('abort', stop, { once: true });

  function processFrame(now, metadata) {
    try {
      const start = performance.now();
      const result = tracker.detectForVideo(video, now);
      const duration = performance.now() - start;
      const hand = result.landmarks[0] && localHand(result.landmarks[0], video, layer);
      onHands(hand ? [hand] : []);
      if (firstTime === undefined) {
        firstTime = now;
        firstFrame = metadata.presentedFrames;
      } else {
        durations.push(duration);
        detected += Number(Boolean(hand));
        const elapsed = (now - firstTime) / 1000;
        if (elapsed >= 2) {
          const sorted = durations.sort((a, b) => a - b);
          onMetrics({
            delegate,
            cameraFps: Math.round((metadata.presentedFrames - firstFrame) / elapsed),
            trackingFps: Math.round(sorted.length / elapsed),
            detectionP95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
            trackedFrames: detected,
          });
          firstTime = now;
          firstFrame = metadata.presentedFrames;
          durations = [];
          detected = 0;
        }
      }
      callback = video.requestVideoFrameCallback(processFrame);
    } catch (error) {
      stop();
      onError(error);
    }
  }
  callback = video.requestVideoFrameCallback(processFrame);
}
