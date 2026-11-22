import test from 'node:test';
import assert from 'node:assert/strict';
import {extractSceneGaze, estimateSeatedSceneGaze, resolveSceneGaze,
  fitSceneCalibration, mapSceneGaze, SEATED_GAZE_PRIOR} from '../dist/scene-gaze.js';

const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const scene = {sourceId: 'scene-camera', generation: 4, width: 1280, height: 720, live: true};
const gazeSource = {sourceId: 'rgb-camera', generation: 3, width: 1000, height: 800, live: true};
const options = {scene, gazeSource, nowMs: 1000};

// Start with observed corner, lid and iris landmarks; exercise the real public
// extractor rather than inventing ready signals or hardcoding its feature math.
function entry({width = 1000, height = 800, irisX = 0, irisY = 0, irisXOther = irisX,
  irisYOther = irisY, lidY = 0, openness = .4, noseX = 0, noseY = 1 / 3,
  roll = 0, shiftX = 0, shiftY = 0, otherEyeWidth = 1, timestampMs = 980} = {}) {
  const scale = Math.min(width, height) / 800;
  const points = Array.from({length: 478}, (_, index) => ({index, x: .5, y: .5, z: 0}));
  const set = (index, x, y) => {
    const dx = (x - 500) * scale, dy = (y - 300) * scale;
    points[index] = {index, x: (width / 2 + dx * Math.cos(roll) - dy * Math.sin(roll) + shiftX) / width,
      y: (height * .375 + dx * Math.sin(roll) + dy * Math.cos(roll) + shiftY) / height, z: 0};
  };
  set(1, 500 + noseX * 300, 300 + noseY * 300);
  for (const [ids, cx, ix, iy, eyeWidth] of [
    [[33, 133, 159, 145, 468, 469, 470, 471, 472], 350, irisX, irisY, 100],
    [[362, 263, 386, 374, 473, 474, 475, 476, 477], 650, irisXOther, irisYOther, 100 * otherEyeWidth],
  ]) {
    set(ids[0], cx - eyeWidth / 2, 300);set(ids[1], cx + eyeWidth / 2, 300);
    set(ids[2], cx, 300 + (lidY - openness / 2) * eyeWidth);
    set(ids[3], cx, 300 + (lidY + openness / 2) * eyeWidth);
    set(ids[4], cx + ix * eyeWidth, 300 + iy * eyeWidth);
    [[.1, 0], [0, -.1], [-.1, 0], [0, .1]].forEach(([x, y], offset) =>
      set(ids[5 + offset], cx + (ix + x) * eyeWidth, 300 + (iy + y) * eyeWidth));
  }
  const inference = {location: 'browser', sourceId: gazeSource.sourceId, generation: gazeSource.generation,
    taskSamples: {face: {timestampMs, ageMs: 0, stale: false}}};
  return {live: true, changedAt: timestampMs + 10, receivedAt: timestampMs + 15,
    frame: {source: 'Browser inference', timestampMs, width, height, coordinateSpace: 'normalized-top-left',
      faces: [{points, confidence: .95, topology: 'mediapipe'}], inference,
      raw: {inference, frame_timestamp_ms: timestampMs}}};
}
function observed(params = {}) {
  const result = extractSceneGaze(entry(params), {nowMs: (params.timestampMs ?? 980) + 20});
  assert.equal(result.status, 'ready');
  return result.signal;
}
const estimate = (params = {}, extra = {}) => estimateSeatedSceneGaze(observed(params), {...options, ...extra});

test('real neutral eyes produce an explicitly approximate prior without fabricating accuracy', () => {
  const signal = observed(), original = structuredClone(signal);
  const result = estimateSeatedSceneGaze(signal, options);
  assert.equal(result.status, 'ready');near(result.point.x, .5);near(result.point.y, .5);
  assert.equal(result.calibrated, false);assert.equal(result.point.calibrated, false);
  assert.equal(result.mappingMethod, 'seated-estimate-v1');
  assert.deepEqual(result.quality, {kind: 'seated-assumption', confidence: null});
  assert.equal(result.uncertainty.measured, false);assert.equal(result.uncertainty.level, 'broad');
  assert.equal(result.uncertainty.space, 'scene-normalized');
  assert.equal(result.point.cameraRelationship, 'assumed-aligned-cameras');
  assert.ok(result.assumptions.some(value => /offsets are unknown/.test(value)));
  assert.equal(result.point.rmsErrorPx, undefined);assert.equal(result.point.calibrationId, undefined);
  assert.deepEqual(signal, original);
});

test('both observed iris directions move right/down monotonically in the unmirrored scene', () => {
  const left = estimate({irisX: -.1}), center = estimate(), right = estimate({irisX: .1});
  const up = estimate({irisY: -.06}), down = estimate({irisY: .06});
  for (const result of [left, center, right, up, down]) assert.equal(result.status, 'ready');
  assert.ok(left.point.x < center.point.x && center.point.x < right.point.x);
  assert.ok(up.point.y < center.point.y && center.point.y < down.point.y);
  near(right.point.y, center.point.y);near(down.point.x, center.point.x);
  near(right.point.x - .5, .1 * SEATED_GAZE_PRIOR.irisGainX * scene.height / scene.width);
});

test('lid midpoint is neutral while the existing fitted feature retains its original nose/lid bias', () => {
  const signal = observed({irisY: .04, lidY: .04});
  near(signal.feature.y, .04 + .2 / 3);
  const result = estimateSeatedSceneGaze(signal, options);
  assert.equal(result.status, 'ready');near(result.point.y, .5);
  const head = estimate({noseX: .08, noseY: .4});
  assert.equal(head.status, 'ready');assert.ok(head.point.x > .5 && head.point.x < .53);
  assert.ok(head.point.y > .5 && head.point.y < .53);
});

test('portrait face input and translated face geometry preserve the same eye-direction prior', () => {
  const baseline = estimate({irisX: .08, irisY: .035});
  for (const params of [{width: 800, height: 1200}, {width: 1920, height: 1080}, {shiftX: 25, shiftY: 20}]) {
    const signal = observed({...params, irisX: .08, irisY: .035});
    const result = estimateSeatedSceneGaze(signal, {...options,
      gazeSource: {...gazeSource, width: params.width ?? 1000, height: params.height ?? 800}});
    assert.equal(result.status, 'ready');near(result.point.x, baseline.point.x);near(result.point.y, baseline.point.y);
  }
});

test('target aspect ratio and modest face roll preserve pixel-space displacement without mirroring', () => {
  const parameters = {irisX: .08, irisY: .04};
  const baseline = estimate(parameters);
  const portrait = {...scene, width: 720, height: 1280};
  const result = estimate(parameters, {scene: portrait});
  assert.equal(result.status, 'ready');
  near((result.point.x - .5) * portrait.width, (baseline.point.x - .5) * scene.width);
  near((result.point.y - .5) * portrait.height, (baseline.point.y - .5) * scene.height);
  const roll = .2, turned = estimate({...parameters, roll});
  assert.equal(turned.status, 'ready');
  const dx = (baseline.point.x - .5) * scene.width, dy = (baseline.point.y - .5) * scene.height;
  near((turned.point.x - .5) * scene.width, dx * Math.cos(roll) - dy * Math.sin(roll));
  near((turned.point.y - .5) * scene.height, dx * Math.sin(roll) + dy * Math.cos(roll));
});

test('same-camera fallback uses its exact session and dimensions; separate cameras remain an explicit assumption', () => {
  const same = estimate({}, {scene: gazeSource});
  assert.equal(same.status, 'ready');assert.equal(same.point.cameraRelationship, 'same-camera');
  assert.equal(estimate({}, {scene: {...gazeSource, generation: 8}}).status, 'geometry-mismatch');
  assert.equal(estimate({}, {scene: {...gazeSource, width: 1280}}).status, 'geometry-mismatch');
  assert.equal(estimate({}, {gazeSource: {...gazeSource, generation: 8}}).status, 'source-mismatch');
  assert.equal(estimate({}, {gazeSource: {...gazeSource, sourceId: 'other-camera'}}).status, 'source-mismatch');
  assert.equal(estimate({}, {gazeSource: {...gazeSource, width: 1280}}).status, 'geometry-mismatch');
  assert.equal(estimate({}, {gazeSource: {...gazeSource, workerGeneration: 8}}).status, 'source-mismatch');
  assert.equal(estimate({}, {gazeSource: undefined}).status, 'gaze-source-missing');
});

test('missing faces, closed eyes, low confidence and unobserved landmarks cannot become a center fallback', () => {
  const cases = [
    [frame => frame.faces = [], 'face-missing'],
    [frame => frame.faces[0].points.pop(), 'iris-missing'],
    [frame => frame.faces[0].confidence = .2, 'face-uncertain'],
    [frame => frame.faces[0].blendshapes = [{categoryName: 'eyeBlinkRight', score: .9}], 'eyes-closed'],
    [frame => frame.faces[0].points[468].x = -1, 'iris-uncertain'],
  ];
  for (const [change, status] of cases) {
    const input = entry();change(input.frame);
    const observation = extractSceneGaze(input, {nowMs: 1000});
    assert.equal(observation.status, status);
    const result = estimateSeatedSceneGaze(observation.signal, options);
    assert.equal(result.status, 'gaze-missing');assert.equal(result.point, null);
  }
  assert.equal(estimate({openness: .07}).status, 'iris-uncertain');
  assert.equal(estimate({irisX: .1, irisXOther: -.1}).status, 'eyes-disagree');
});

test('seated eligibility rejects turned, strongly tilted, asymmetric and off-center observations', () => {
  for (const parameters of [{noseX: .3}, {noseY: .8}, {roll: .5}, {otherEyeWidth: .55}, {shiftY: 350}]) {
    const result = estimate(parameters);
    assert.equal(result.status, 'seated-pose-unavailable', JSON.stringify(parameters));
    assert.equal(result.point, null);
  }
});

test('freshness checks use original capture plus observation clocks, never a refreshed receive time', () => {
  assert.equal(estimate({}, {nowMs: 1500}).status, 'gaze-stale');
  assert.equal(estimate({}, {maxAgeMs: 10}).status, 'gaze-stale');
  assert.equal(estimate({}, {nowMs: NaN}).status, 'gaze-stale');
  assert.equal(estimate({}, {maxAgeMs: -1}).status, 'gaze-stale');
  for (const change of [{timestampMs: 1001}, {observedAtMs: 1001}, {observedAtMs: 990}, {observedAtMs: 400}]) {
    const result = estimateSeatedSceneGaze({...observed(), ...change}, options);
    assert.equal(result.status, 'gaze-stale');assert.equal(result.point, null);
  }
});

test('synthetic, replayed, wrong-provider and mirrored inputs never qualify as observed seated eyes', () => {
  const signal = observed();
  for (const change of [{synthetic: true}, {replay: true}, {live: false}])
    assert.equal(estimateSeatedSceneGaze({...signal, ...change}, options).status, 'gaze-missing');
  for (const method of ['logitech-screen-geometric', 'unknown-iris-provider'])
    assert.equal(estimateSeatedSceneGaze({...signal, method}, options).status, 'gaze-unsupported');
  assert.equal(estimate({}, {scene: {...scene, replay: true}}).status, 'scene-missing');
  assert.equal(estimate({}, {scene: {...scene, mirrored: true}}).status, 'coordinate-mismatch');
  assert.equal(estimate({}, {gazeSource: {...gazeSource, replay: true}}).status, 'gaze-source-missing');
  assert.equal(estimate({}, {gazeSource: {...gazeSource, mirrored: true}}).status, 'coordinate-mismatch');
  assert.equal(estimateSeatedSceneGaze({...signal, geometry: {...signal.geometry, coordinateSpace: 'normalized-mirrored-top-left'}}, options).status, 'coordinate-mismatch');
});

test('out-of-frame estimates and inconsistent feature geometry fail instead of clamping to an image edge', () => {
  const out = estimate({irisY: .2});
  assert.equal(out.status, 'outside-scene');assert.equal(out.point, null);
  const signal = observed();
  assert.equal(estimateSeatedSceneGaze({...signal, feature: {x: 100, y: 100}}, options).status, 'geometry-mismatch');
  assert.equal(estimateSeatedSceneGaze({...signal, geometry: {...signal.geometry, roll: .2}}, options).status, 'geometry-mismatch');
  assert.equal(estimateSeatedSceneGaze({...signal, inputSignature: 'face:1920x1080:unmirrored'}, options).status, 'geometry-mismatch');
});

test('automatic mode needs no fit, strict mode requires one, and a supplied valid fit is always preferred', () => {
  const signal = observed();
  assert.equal(resolveSceneGaze(signal, null, options).mappingMethod, 'seated-estimate-v1');
  assert.equal(resolveSceneGaze(signal, null, {...options, mode: 'calibrated'}).status, 'calibration-required');
  assert.equal(resolveSceneGaze(signal, null, {...options, mode: 'unknown'}).status, 'mode-unsupported');
  const targets = [{x: .2, y: .2}, {x: .8, y: .2}, {x: .8, y: .8}, {x: .2, y: .8}, {x: .5, y: .5}];
  const rows = targets.map((target, index) => ({target,
    signal: observed({irisX: (target.x - .5) / 3, irisY: (target.y - .5) / 4, timestampMs: 1000 + 100 * index})}));
  const fit = fitSceneCalibration(rows, {scene});assert.equal(fit.status, 'ready');
  const current = observed({irisX: .04, irisY: .025, timestampMs: 1500});
  const fitted = mapSceneGaze(current, fit.calibration, {...options, nowMs: 1520});
  const resolved = resolveSceneGaze(current, fit.calibration, {...options, nowMs: 1520});
  assert.deepEqual(resolved, fitted);assert.equal(resolved.calibrated, true);
  assert.equal(resolved.mappingMethod, 'scene-calibration-v1');near(resolved.point.x, .62);near(resolved.point.y, .6);
  assert.equal(resolveSceneGaze(current, fit.calibration, {...options, nowMs: 1520, mode: 'calibrated'}).status, 'ready');
  assert.equal(resolveSceneGaze(current, fit.calibration, {...options, nowMs: 1520,
    gazeSource: {...gazeSource, generation: 8}}).status, 'source-mismatch');
  const changed = {...fit.calibration, scene: {...fit.calibration.scene, generation: 8}};
  assert.equal(resolveSceneGaze(current, changed, {...options, nowMs: 1520}).status, 'scene-mismatch');
  assert.equal(resolveSceneGaze(current, {type: 'invalid'}, {...options, nowMs: 1520}).status, 'calibration-required');
  const outside = observed({irisX: .12, timestampMs: 1500});
  assert.equal(estimateSeatedSceneGaze(outside, {...options, nowMs: 1520}).status, 'ready');
  assert.equal(resolveSceneGaze(outside, fit.calibration, {...options, nowMs: 1520}).status, 'outside-calibration');
});
