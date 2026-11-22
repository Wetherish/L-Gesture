import test from 'node:test';
import assert from 'node:assert/strict';
import {extractSceneGaze, fitSceneCalibration, mapSceneGaze, isSceneGazeSignal} from '../dist/scene-gaze.js';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const scene = {sourceId: 'scene-camera', generation: 4, width: 1280, height: 720};
const targets = [{x: .15, y: .15}, {x: .85, y: .15}, {x: .85, y: .85}, {x: .15, y: .85}, {x: .5, y: .5}];
function signal(x, y, timestampMs = 1000, extra = {}) {
  return {type: 'scene-gaze-feature', live: true, synthetic: false, replay: false,
    feature: {x, y}, sourceId: 'gaze-source', generation: 2, method: 'logitech-screen-geometric',
    inputSignature: 'screen:1920x1080:camera:1280x720', timestampMs, observedAtMs: timestampMs, ...extra};
}
const samples = (extra = {}) => targets.map((target, index) => ({target: {...target}, signal: signal(target.x, target.y, 1000 + index * 100, extra)}));
function faceEntry({width = 1000, height = 800, irisX = 0, irisY = 0, irisXOther = irisX, roll = 0, shiftX = 0, shiftY = 0} = {}) {
  const scale = Math.min(width, height) / 800;
  const points = Array.from({length: 478}, (_, index) => ({index, x: .5, y: .5, z: 0, visibility: 0}));
  const set = (index, x, y) => {
    const dx = (x - 500) * scale, dy = (y - 300) * scale;
    points[index] = {index, x: (width / 2 + dx * Math.cos(roll) - dy * Math.sin(roll) + shiftX) / width,
      y: (height * .375 + dx * Math.sin(roll) + dy * Math.cos(roll) + shiftY) / height, z: 0, visibility: 0};
  };
  set(1, 500, 400);
  for (const [ids, cx, ix] of [[[33, 133, 159, 145, 468, 469, 470, 471, 472], 350, irisX],
    [[362, 263, 386, 374, 473, 474, 475, 476, 477], 650, irisXOther]]) {
    set(ids[0], cx - 50, 300);set(ids[1], cx + 50, 300);set(ids[2], cx, 280);set(ids[3], cx, 320);
    set(ids[4], cx + ix * 100, 300 + irisY * 100);
    [[10, 0], [0, -10], [-10, 0], [0, 10]].forEach(([x, y], offset) => set(ids[5 + offset], cx + ix * 100 + x, 300 + irisY * 100 + y));
  }
  const inference = {engine: 'MediaPipe', location: 'browser', sourceId: 'rgb-camera', generation: 3,
    taskSamples: {face: {timestampMs: 980, ageMs: 0, stale: false}}};
  const frame = {source: 'Browser inference', timestampMs: 980, width, height, coordinateSpace: 'normalized-top-left',
    faces: [{points, confidence: .95, topology: 'mediapipe'}], inference,
    raw: {inference, frame_timestamp_ms: 980}};
  return {frame, live: true, changedAt: 995, receivedAt: 995};
}
function gazeEntry(source = 'geometric') {
  return {live: true, changedAt: 995, receivedAt: 998, frame: {source: 'Logitech Gaze Tracker', timestampMs: 12, width: 1280, height: 720,
    gaze: {space: 'screen', xPx: 960, yPx: 540, screenWidth: 1920, screenHeight: 1080, source},
    trackerState: {tracking_enabled: true, geometric_calibrated: true, model_calibrated: true}, raw: {}}};
}
const sdkOptions = {nowMs: 1000, sourceId: 'gaze-socket', generation: 'socket-1'};

test('real iris features are uncalibrated observations with exact source/timing provenance', () => {
  const entry = faceEntry({irisX: .1, irisY: -.05}), original = structuredClone(entry);
  const result = extractSceneGaze(entry, {nowMs: 1000});
  assert.equal(result.status, 'ready');assert.ok(isSceneGazeSignal(result.signal));
  near(result.signal.feature.x, .1);near(result.signal.feature.y, -.05 + .2 / 3);
  assert.equal(result.signal.method, 'browser-iris-head-v1');
  assert.equal(result.signal.quality.kind, 'uncalibrated-eye-feature');assert.equal(result.signal.quality.confidence, null);
  assert.equal(result.signal.sourceId, 'rgb-camera');assert.equal(result.signal.generation, 3);
  assert.equal(result.signal.observedAtMs, 980);assert.deepEqual(entry, original);
});

test('eye geometry is aspect-correct and resistant to small image translation, scale and roll', () => {
  const first = extractSceneGaze(faceEntry({irisX: -.1, irisY: .04}), {nowMs: 1000}).signal;
  for (const options of [{width: 1920, height: 1080}, {width: 800, height: 1200}, {shiftX: 30, shiftY: 25}, {roll: .25}]) {
    const result = extractSceneGaze(faceEntry({...options, irisX: -.1, irisY: .04}), {nowMs: 1000});
    assert.equal(result.status, 'ready');near(result.signal.feature.x, first.feature.x);near(result.signal.feature.y, first.feature.y);
  }
});

test('missing, closed, disagreeing or low-confidence eyes do not become a gaze estimate', () => {
  const missing = faceEntry();missing.frame.faces[0].points.pop();
  assert.equal(extractSceneGaze(missing, {nowMs: 1000}).status, 'iris-missing');
  const closed = faceEntry();closed.frame.faces[0].blendshapes = {categories: [{categoryName: 'eyeBlinkLeft', score: .9}]};
  assert.equal(extractSceneGaze(closed, {nowMs: 1000}).status, 'eyes-closed');
  const shut = faceEntry();shut.frame.faces[0].points[159].y = shut.frame.faces[0].points[145].y;
  assert.equal(extractSceneGaze(shut, {nowMs: 1000}).status, 'iris-uncertain');
  assert.equal(extractSceneGaze(faceEntry({irisX: .3, irisXOther: -.3}), {nowMs: 1000}).status, 'eyes-disagree');
  const uncertain = faceEntry();uncertain.frame.faces[0].confidence = .3;
  assert.equal(extractSceneGaze(uncertain, {nowMs: 1000}).status, 'face-uncertain');
  const ambiguous = faceEntry();ambiguous.frame.faces.push(ambiguous.frame.faces[0]);
  assert.equal(extractSceneGaze(ambiguous, {nowMs: 1000}).status, 'face-ambiguous');
});

test('imported, replayed, synthetic and wrong-source input cannot qualify', () => {
  for (const change of [entry => entry.live = false, entry => entry.replay = true,
    entry => entry.frame.synthetic = true, entry => entry.frame.raw.replay = true]) {
    const entry = faceEntry();change(entry);assert.equal(extractSceneGaze(entry, {nowMs: 1000}).status, 'not-live');
  }
  assert.equal(extractSceneGaze(faceEntry(), {nowMs: 1000, sourceId: 'another-camera'}).status, 'source-mismatch');
  assert.equal(extractSceneGaze(faceEntry(), {nowMs: 1000, inferenceGeneration: 4}).status, 'source-mismatch');
  const mirrored = faceEntry();mirrored.frame.coordinateSpace = 'normalized-mirrored-top-left';
  assert.equal(extractSceneGaze(mirrored, {nowMs: 1000}).status, 'coordinate-mismatch');
});

test('camera-session identity survives a checked worker restart without accepting late-worker frames', () => {
  const first = faceEntry(), second = faceEntry();
  second.frame.inference.generation = 8;
  const options = {nowMs: 1000, sourceId: 'rgb-camera', generation: 'camera-session-1'};
  const a = extractSceneGaze(first, {...options, inferenceGeneration: 3});
  const b = extractSceneGaze(second, {...options, inferenceGeneration: 8});
  assert.equal(a.status, 'ready');assert.equal(b.status, 'ready');
  assert.equal(a.signal.generation, b.signal.generation);assert.equal(b.signal.workerGeneration, 8);
  assert.equal(a.signal.inputSignature, b.signal.inputSignature);
  assert.equal(extractSceneGaze(first, {...options, inferenceGeneration: 8}).status, 'source-mismatch');
  const rows = samples({method: a.signal.method, inputSignature: a.signal.inputSignature,
    sourceId: a.signal.sourceId, generation: a.signal.generation, geometry: a.signal.geometry});
  const fit = fitSceneCalibration(rows, {scene});assert.equal(fit.status, 'ready');
  const current = {...b.signal, timestampMs: 1500, observedAtMs: 1500, feature: {x: .5, y: .5}};
  assert.equal(mapSceneGaze(current, fit.calibration, {scene, nowMs: 1500}).status, 'ready');
  assert.equal(mapSceneGaze({...current, generation: 'camera-session-2'}, fit.calibration, {scene, nowMs: 1500}).status, 'source-mismatch');
});

test('freshness follows changed source frames and actual face capture, not other tasks or receipt resends', () => {
  const stale = gazeEntry();stale.changedAt = 400;stale.receivedAt = 999;
  assert.equal(extractSceneGaze(stale, sdkOptions).status, 'gaze-stale');
  const future = faceEntry();future.changedAt = 1001;
  assert.equal(extractSceneGaze(future, {nowMs: 1000}).status, 'gaze-stale');
  const cached = faceEntry();cached.frame.timestampMs = 999;cached.frame.inference.taskSamples.face = {timestampMs: 100, ageMs: 899, stale: false};
  assert.equal(extractSceneGaze(cached, {nowMs: 1000}).status, 'gaze-stale');
  const delayed = faceEntry();delayed.frame.inference.taskSamples.face = {timestampMs: 100, ageMs: 0, stale: false};
  assert.equal(extractSceneGaze(delayed, {nowMs: 1000}).status, 'gaze-stale');
  const unknownClock = gazeEntry();unknownClock.frame.timestampMs = null;
  assert.equal(extractSceneGaze(unknownClock, sdkOptions).status, 'timestamp-missing');
});

test('SDK calibrated screen gaze is only a feature; remote clock and off-display values are preserved', () => {
  const entry = gazeEntry();entry.frame.gaze.xPx = 2304;entry.frame.gaze.yPx = -216;
  const result = extractSceneGaze(entry, sdkOptions);
  assert.equal(result.status, 'ready');near(result.signal.feature.x, 1.2);near(result.signal.feature.y, -.2);
  assert.equal(result.signal.timestampMs, 12);assert.equal(result.signal.observedAtMs, 995);
  assert.equal(result.signal.quality.confidence, null);assert.equal(result.point, undefined);
  assert.equal(extractSceneGaze(entry, {nowMs: 1000}).status, 'source-missing');
});

test('SDK baseline, disabled tracking and missing calibration flags are rejected; calibrated fallback stays distinct', () => {
  assert.equal(extractSceneGaze(gazeEntry('baseline'), sdkOptions).status, 'gaze-uncalibrated');
  const noCalibration = gazeEntry();noCalibration.frame.trackerState.geometric_calibrated = false;
  assert.equal(extractSceneGaze(noCalibration, sdkOptions).status, 'gaze-uncalibrated');
  const paused = gazeEntry();paused.frame.trackerState.tracking_enabled = false;
  assert.equal(extractSceneGaze(paused, sdkOptions).status, 'tracking-paused');
  const legacy = extractSceneGaze(gazeEntry('calibrated_legacy_fallback'), sdkOptions);
  assert.equal(legacy.status, 'ready');assert.equal(legacy.signal.quality.legacyFallback, true);
  assert.notEqual(legacy.signal.method, extractSceneGaze(gazeEntry(), sdkOptions).signal.method);
});

test('five well-spread distinct targets recover an affine scene map without mutating inputs', () => {
  const rows = samples(), original = structuredClone(rows);
  const fit = fitSceneCalibration(rows, {scene});assert.equal(fit.status, 'ready');
  assert.deepEqual(fit.calibration.gazeSource, {sourceId: 'gaze-source', generation: 2, method: 'logitech-screen-geometric', inputSignature: 'screen:1920x1080:camera:1280x720'});
  const mapped = mapSceneGaze(signal(.35, .6, 1500), fit.calibration, {scene, nowMs: 1550});
  assert.equal(mapped.status, 'ready');near(mapped.point.x, .35);near(mapped.point.y, .6);
  assert.equal(mapped.point.estimate, true);near(fit.calibration.rmsError, 0);assert.deepEqual(rows, original);
});

test('a real nonidentity affine transform is fitted instead of assuming screen equals scene', () => {
  const rows = samples().map(row => ({...row, signal: {...row.signal, feature: {x: (row.target.x - .1) / .7, y: (row.target.y - .05) / .8}}}));
  const fit = fitSceneCalibration(rows, {scene});assert.equal(fit.status, 'ready');
  const mapped = mapSceneGaze(signal(.5, .5, 1500), fit.calibration, {scene, nowMs: 1500});
  assert.equal(mapped.status, 'ready');near(mapped.point.x, .45);near(mapped.point.y, .45);
});

test('too few, repeated, source-mixed, collinear and narrowly spread calibration samples are rejected', () => {
  assert.equal(fitSceneCalibration(samples().slice(0, 4), {scene}).status, 'not-enough-samples');
  const repeated = samples();repeated[4].signal.timestampMs = repeated[3].signal.timestampMs;
  assert.equal(fitSceneCalibration(repeated, {scene}).status, 'duplicate-sample');
  const mixed = samples();mixed[2].signal.generation++;
  assert.equal(fitSceneCalibration(mixed, {scene}).status, 'source-mismatch');
  const collinear = samples();collinear.forEach((row, i) => row.signal.feature = {x: i / 5, y: i / 5});
  assert.equal(fitSceneCalibration(collinear, {scene}).status, 'degenerate-calibration');
  const narrow = samples();narrow.forEach(row => {row.signal.feature.x *= .001;row.signal.feature.y *= .001;});
  assert.equal(fitSceneCalibration(narrow, {scene}).status, 'features-too-close');
  const clustered = samples();clustered.forEach(row => {row.target.x *= .1;row.target.y *= .1;});
  assert.equal(fitSceneCalibration(clustered, {scene}).status, 'targets-too-close');
});

test('misrecorded targets and unstable fits cannot silently produce a calibration', () => {
  const rows = samples();rows[4].target = {x: .9, y: .1};
  assert.equal(fitSceneCalibration(rows, {scene}).status, 'poor-fit');
  const swapped = samples();[swapped[1].target, swapped[2].target] = [swapped[2].target, swapped[1].target];
  assert.notEqual(fitSceneCalibration(swapped, {scene}).status, 'ready');
});

test('mapping rejects changed source/session/dimensions/orientation and requires recent live data', () => {
  const calibration = fitSceneCalibration(samples(), {scene}).calibration, current = signal(.5, .5, 1500);
  for (const change of [{sourceId: 'other'}, {generation: 5}, {width: 1920}, {mirrored: true}, {revision: 'moved'}])
    assert.equal(mapSceneGaze(current, calibration, {scene: {...scene, ...change}, nowMs: 1500}).status, 'scene-mismatch');
  for (const change of [{sourceId: 'other'}, {generation: 3}, {method: 'logitech-screen-calibrated_legacy_fallback'}, {inputSignature: 'screen:changed'}])
    assert.equal(mapSceneGaze({...current, ...change}, calibration, {scene, nowMs: 1500}).status, 'source-mismatch');
  assert.equal(mapSceneGaze(current, calibration, {scene, nowMs: 2001}).status, 'gaze-stale');
  assert.equal(mapSceneGaze(current, calibration, {scene, nowMs: 1499}).status, 'gaze-stale');
  assert.equal(mapSceneGaze(signal(.5, .5, 1200, {observedAtMs: 1500}), calibration, {scene, nowMs: 1500}).status, 'gaze-stale');
  assert.equal(mapSceneGaze({...current, replay: true}, calibration, {scene, nowMs: 1500}).status, 'gaze-missing');
});

test('no extrapolation or screen-edge clamping occurs outside the calibrated feature hull', () => {
  const calibration = fitSceneCalibration(samples(), {scene}).calibration;
  for (const point of [[.1, .5], [.9, .9], [1.2, -.1]])
    assert.equal(mapSceneGaze(signal(...point, 1500), calibration, {scene, nowMs: 1500}).status, 'outside-calibration');
  assert.equal(mapSceneGaze(signal(.15, .15, 1500), calibration, {scene, nowMs: 1500}).status, 'ready');
});

test('browser calibration rejects significant head repositioning despite unchanged feature coordinates', () => {
  const geometry = {centerX: .5, centerY: .4, eyeSpan: .3, roll: 0};
  const extra = {method: 'browser-iris-head-v1', inputSignature: 'face:1280x720:unmirrored', geometry};
  const fit = fitSceneCalibration(samples(extra), {scene});assert.equal(fit.status, 'ready');
  for (const change of [{centerX: .7}, {centerY: .6}, {eyeSpan: .5}, {roll: .5}]) {
    const current = signal(.5, .5, 1500, {...extra, geometry: {...geometry, ...change}});
    assert.equal(mapSceneGaze(current, fit.calibration, {scene, nowMs: 1500}).status, 'pose-outside-calibration');
  }
  assert.equal(mapSceneGaze(signal(.5, .5, 1500, extra), fit.calibration, {scene, nowMs: 1500}).status, 'ready');
});
