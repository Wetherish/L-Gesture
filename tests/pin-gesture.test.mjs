import test from 'node:test';
import assert from 'node:assert/strict';
import {createPinHoldDetector, DEFAULT_PIN_HOLD_MS} from '../dist/pin-gesture.js';
import {normalizeFrame} from '../dist/landmarks.js';

function frame(timestamp, {pose = true, labels = ['Right'], width = 1000, height = 1000,
  confidence = .96, sourceId = 'camera-a', generation = 1, handId, scale = 1, offset = 0,
  mirrored = false, placeholder = false, native = false, changePoints, rawExtra = {}} = {}) {
  const unit = Math.min(width, height) * .17 * scale;
  const geometry = [[0, 1], [-.35, .7], [-.6, .45], [-.8, .25], [-.75, .05],
    [-.35, .1], [-.38, -.45], [-.4, -.9], [-.4, -1.2],
    [0, 0], [0, -.6], [0, -1.1], [0, -1.4],
    [.25, .1], [.3, -.2], [.3, .1], [.28, .35],
    [.5, .2], [.55, -.1], [.5, .25], [.45, .4]];
  if (!pose) {geometry[8] = [-.35, .3];geometry[12] = [0, .3];}
  changePoints?.(geometry);
  const hands = labels.map(handedness => ({handedness, confidence,
    ...(handId === undefined ? {} : {trackingId: handId}),
    landmarks: geometry.map(([x, y]) => ({x: mirrored ? 1 - (.5 + offset + x * unit / width) : .5 + offset + x * unit / width,
      y: .5 + y * unit / height, z: 0, ...(placeholder ? {visibility: 0} : {})}))}));
  const landmarks = hands.map(hand => hand.landmarks);
  const handedness = hands.map(hand => [{categoryName: hand.handedness, score: confidence}]);
  const raw = {type: 'browser_inference', coordinate_space: 'normalized', timestamp_ms: timestamp,
    image_resolution: {width, height}, inference: {engine: 'MediaPipe', location: native ? 'native' : 'browser', sourceId, generation},
    hands, handLandmarks: landmarks, handedness, rawResults: {hands: {landmarks, handedness}}, ...rawExtra};
  const result = normalizeFrame(raw);
  if (mirrored) result.hands.forEach(hand => hand.mirrored = true);
  return result;
}

function harness(options = {}) {
  const events = [], detector = createPinHoldDetector({...options, onTrigger: event => events.push(event)});
  let now = -100, timestamp = -100, lastFrame;
  const fresh = (params = {}, context = {}, delta = 100, sourceDelta = delta) => {
    now += delta;timestamp += sourceDelta;lastFrame = frame(timestamp, params);
    return detector.update(lastFrame, {now, sourceId: params.sourceId ?? 'camera-a', ...context});
  };
  const hold = (count = 16, params = {}, context = {}) => {
    let result;for (let i = 0; i < count; i++) result = fresh(params, context);return result;
  };
  const repeat = (delta = 16, context = {}) => {now += delta;return detector.update(lastFrame, {now, sourceId: 'camera-a', ...context});};
  const missing = (delta = 100, context = {}) => {now += delta;timestamp += delta;return detector.update(null, {now, sourceId: 'camera-a', ...context});};
  return {detector, events, fresh, hold, repeat, missing, getNow: () => now, getFrame: () => lastFrame};
}

test('default hold cannot fire at 1499 ms and fires exactly once on the fresh 1500 ms observation', () => {
  assert.equal(DEFAULT_PIN_HOLD_MS, 1500);
  const h = harness();
  const start = h.fresh();assert.equal(start.kind, 'pin');assert.equal(start.phase, 'holding');
  assert.equal(start.progress, 0);assert.equal(start.remainingMs, 1500);
  h.hold(7);const middle = h.fresh({}, {}, 50);
  assert.equal(middle.heldMs, 750);assert.equal(middle.progress, .5);assert.equal(middle.triggered, false);
  h.hold(7);assert.equal(h.events.length, 0);
  const before = h.fresh({}, {}, 49);
  assert.equal(before.heldMs, 1499);assert.equal(before.remainingMs, 1);assert.equal(before.triggered, false);
  assert.equal(before.progress, 1499 / 1500);assert.equal(h.events.length, 0);
  const done = h.fresh({}, {}, 1);assert.equal(done.triggered, true);assert.equal(done.phase, 'latched');
  assert.equal(done.progress, 1);assert.equal(done.heldMs, 1500);assert.equal(done.holding, true);
  assert.equal(h.events.length, 1);assert.deepEqual(h.events[0], done);
  assert.equal(h.detector.getState().triggered, false);
  assert.equal(h.hold(60).triggered, false);assert.equal(h.events.length, 1);
  assert.equal(h.fresh({pose: false}).phase, 'waiting');
  assert.equal(h.hold().triggered, true);assert.equal(h.events.length, 2);
});

test('an explicitly configured longer hold still waits for its requested duration', () => {
  const h = harness({holdMs: 3000});h.fresh();
  const defaultBoundary = h.hold(15);
  assert.equal(defaultBoundary.heldMs, 1500);assert.equal(defaultBoundary.remainingMs, 1500);
  assert.equal(defaultBoundary.triggered, false);assert.equal(h.events.length, 0);
  h.hold(14);assert.equal(h.events.length, 0);
  assert.equal(h.fresh().triggered, true);assert.equal(h.events.length, 1);
});

test('duplicate RAF updates cannot advance the hold or keep a frozen observation alive', () => {
  const h = harness();h.fresh();
  for (let index = 0; index < 10; index++) assert.equal(h.repeat().progress, 0);
  const clone = structuredClone(h.getFrame());
  assert.equal(h.detector.update(clone, {now: 200, sourceId: 'camera-a'}).progress, 0);
  const expired = h.detector.update(clone, {now: 400, sourceId: 'camera-a'});
  assert.equal(expired.holding, false);assert.equal(expired.progress, 0);assert.equal(h.events.length, 0);
});

test('only advancing hands samples count when other tasks or wrapper timestamps update', () => {
  const h = harness();h.fresh();
  for (let time = 100; time <= 3500; time += 100) {
    const input = frame(time);
    input.inference.taskSamples = {hands: {timestampMs: 0, ageMs: time, stale: false}};
    const result = h.detector.update(input, {now: time, sourceId: 'camera-a'});
    assert.equal(result.triggered, false);assert.equal(result.progress, 0);
  }
  assert.equal(h.events.length, 0);
});

test('source and host clocks must each reach 1.5 seconds, including the 1499 ms boundary and different native origins', () => {
  const h = harness();
  for (let i = 0; i < 31; i++) h.fresh({native: true}, {}, 100, 25);
  assert.equal(h.events.length, 0);assert.equal(h.detector.getState().heldMs, 750);
  for (const slowerClock of ['source', 'host']) {
    const detector = createPinHoldDetector();
    for (let time = 0; time <= 1400; time += 100)
      assert.equal(detector.update(frame(1_000_000 + time, {native: true}), {now: 5000 + time, sourceId: 'camera-a'}).triggered, false);
    const sourceElapsed = slowerClock === 'source' ? 1499 : 1500;
    const hostElapsed = slowerClock === 'host' ? 1499 : 1500;
    const before = detector.update(frame(1_000_000 + sourceElapsed, {native: true}), {now: 5000 + hostElapsed, sourceId: 'camera-a'});
    assert.equal(before.heldMs, 1499);assert.equal(before.remainingMs, 1);assert.equal(before.triggered, false);
    const done = detector.update(frame(1_000_001 + sourceElapsed, {native: true}), {now: 5001 + hostElapsed, sourceId: 'camera-a'});
    assert.equal(done.heldMs, 1500);assert.equal(done.triggered, true);
  }
  const fastSource = harness();
  for (let i = 0; i < 31; i++) fastSource.fresh({native: true}, {}, 25, 100);
  assert.equal(fastSource.events.length, 0);assert.equal(fastSource.detector.getState().heldMs, 750);
});

test('tracking gaps, loss, invalid frames and partial poses restart the full hold', () => {
  for (const interrupt of [h => h.fresh({}, {}, 300), h => h.missing(),
    h => h.fresh({pose: false}), h => h.fresh({confidence: .3}),
    h => h.fresh({labels: []}), h => h.fresh({rawExtra: {synthetic: true}})]) {
    const h = harness();h.hold(15);interrupt(h);
    assert.equal(h.detector.getState().progress, 0);assert.equal(h.events.length, 0);
    // A fresh valid frame after a long gap starts at zero immediately; invalid
    // observations need the next frame to start. Both require a new 1.5-second hold.
    h.hold(h.detector.getState().holding ? 14 : 15);
    assert.equal(h.detector.getState().heldMs, 1400);assert.equal(h.events.length, 0);
    assert.equal(h.fresh().triggered, true);assert.equal(h.events.length, 1);
  }
});

test('a trigger remains latched through busy/inactive, loss and reset until an observed valid release', () => {
  const h = harness();h.hold();assert.equal(h.events.length, 1);
  h.hold(40, {}, {active: false});h.missing();h.detector.reset('operation-busy');
  h.hold(40);assert.equal(h.events.length, 1);assert.equal(h.detector.getState().phase, 'latched');
  h.fresh({pose: false}, {active: false});
  assert.equal(h.detector.getState().phase, 'inactive');
  h.hold(40, {}, {active: false});assert.equal(h.events.length, 1);
  h.hold();assert.equal(h.events.length, 2);
});

test('unique classified Right hand is required; mirror and Left/Right array order do not swap anatomy', () => {
  for (const params of [{labels: ['Left']}, {labels: ['Unknown']}, {labels: ['Right', 'Right']}, {labels: []}]) {
    const h = harness();h.hold(40, params);assert.equal(h.events.length, 0);
  }
  const h = harness();let result;
  for (let i = 0; i < 16; i++) result = h.fresh({mirrored: true, labels: i % 2 ? ['Left', 'Right'] : ['Right', 'Left']});
  assert.equal(result.triggered, true);assert.equal(h.events.length, 1);
});

test('aspect ratio and hand size do not change the 1.5-second pose condition', () => {
  for (const params of [{width: 1920, height: 1080, scale: .6}, {width: 720, height: 1280}, {width: 640, height: 480, scale: 1.2}]) {
    const h = harness();assert.equal(h.hold(16, params).triggered, true);
  }
});

test('both index and middle must be above every other tip and extended from their knuckles', () => {
  const invalid = [
    points => points[8] = [-.35, .2],
    points => points[12] = [0, .3],
    points => points[16] = [.3, -1.3],
    points => points[4] = [-.7, -1.2],
    points => points[20] = [.5, -1.4],
    points => {points[6] = [-.8, -.7];points[7] = [.4, -.3];},
  ];
  for (const changePoints of invalid) {
    const h = harness();h.hold(40, {changePoints});assert.equal(h.events.length, 0);
    assert.equal(h.detector.getState().phase, 'waiting');
  }
});

test('source/session/geometry changes and explicit or abrupt hand replacements cannot share a hold', () => {
  for (const params of [{sourceId: 'camera-b'}, {generation: 2}, {width: 1200}, {handId: 'b'}, {offset: .25}, {scale: .4}]) {
    const h = harness();h.hold(15, {handId: params.handId ? 'a' : undefined});
    assert.equal(h.fresh(params).progress, 0);
    h.hold(h.detector.getState().holding ? 14 : 15, params);
    assert.equal(h.detector.getState().heldMs, 1400);assert.equal(h.events.length, 0);
    assert.equal(h.fresh(params).triggered, true);assert.equal(h.events.length, 1);
  }
  const h = harness();h.hold(15);
  const result = h.fresh({sourceId: 'camera-b'}, {sourceId: 'camera-a'});
  assert.equal(result.reason, 'source-mismatch');assert.equal(result.progress, 0);
});

test('reported confidence and complete unique full-hand points are required', () => {
  const h = harness();h.hold(40, {confidence: .5});assert.equal(h.events.length, 0);
  const unscored = frame(0);delete unscored.raw.hands[0].confidence;delete unscored.raw.handedness[0][0].score;
  assert.equal(createPinHoldDetector().update(unscored, {now: 0, sourceId: 'camera-a'}).reason, 'confidence-unavailable');
  for (const change of [input => input.hands[0].points.pop(),
    input => input.hands[0].points[5].index = 4,
    input => input.hands[0].points[6].x = -1,
    input => input.hands[0].points[11].presence = .1]) {
    const input = frame(0);change(input);
    const result = createPinHoldDetector().update(input, {now: 0, sourceId: 'camera-a'});
    assert.equal(result.holding, false);assert.equal(result.progress, 0);
  }
  const placeholders = harness();assert.equal(placeholders.hold(16, {placeholder: true}).triggered, true);
});

test('replay/synthetic/stale markings and clock reversals reset progress without a trigger', () => {
  for (const rawExtra of [{synthetic: true}, {replay: true}, {stale: true}]) {
    const h = harness();h.hold(15);h.fresh({rawExtra});assert.equal(h.detector.getState().progress, 0);
  }
  const h = harness();h.hold(15, {native: true});
  const backwards = h.detector.update(frame(1000, {native: true}), {now: 2000, sourceId: 'camera-a'});
  assert.equal(backwards.reason, 'timestamp-reset');assert.equal(backwards.holding, false);assert.equal(backwards.progress, 0);
  const clock = h.detector.update(frame(900), {now: 900, sourceId: 'camera-a'});
  assert.equal(clock.reason, 'clock-reset');assert.equal(h.events.length, 0);
  const replay = frame(0);replay.timelineMs = 0;
  assert.equal(createPinHoldDetector().update(replay, {now: 0, sourceId: 'camera-a'}).reason, 'replay');
});

test('input frames are immutable and options reject unsafe thresholds', () => {
  const input = frame(0), original = structuredClone(input);
  createPinHoldDetector().update(input, {now: 0, sourceId: 'camera-a'});assert.deepEqual(input, original);
  for (const options of [{holdMs: 0}, {holdMs: 100, maxGapMs: 250}, {maxGapMs: 0},
    {confidenceThreshold: 0}, {confidenceThreshold: 2}, {maxScaleJump: 1}])
    assert.throws(() => createPinHoldDetector(options), RangeError);
  assert.throws(() => createPinHoldDetector().update(input, {now: NaN}), TypeError);
});
