import test from 'node:test';
import assert from 'node:assert/strict';
import {borrowCameraSource} from '../dist/borrowed-camera-source.js';

function mockGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {configurable: true, value});
  t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
}

function harness(overrides = {}, {onDraw, onRead, contextMissing = false} = {}) {
  const operations = [], canvases = [];
  let stopped = 0;
  const track = {readyState: 'live', stop() {stopped++;}};
  const stream = {getTracks: () => [track], getVideoTracks: () => [track]};
  const element = {videoWidth: 1920, videoHeight: 1080, readyState: 2, ended: false, srcObject: stream,
    style: Object.freeze({transform: 'scaleX(-1)'}),
    play() {operations.push(['play']);}, pause() {operations.push(['pause']);},
    applyConstraints() {operations.push(['constraints']);}, remove() {operations.push(['remove']);}};
  const descriptor = {kind: 'main', type: 'camera', live: true, sourceId: '7:camera-a', generation: 7,
    element, width: 1920, height: 1080, sourceName: 'Primary RGB camera', role: 'rgb', mirror: true, ...overrides};
  let current = descriptor;
  const makeCanvas = () => {
    const canvas = {width: 0, height: 0, draws: [], reads: [], getContext(kind, options) {
      assert.equal(kind, '2d'); assert.deepEqual(options, {alpha: false});
      return contextMissing ? null : {
        drawImage(...args) {canvas.draws.push(args); onDraw?.();},
        getImageData(...args) {canvas.reads.push(args); onRead?.(); return {data: new Uint8ClampedArray(4)};},
        translate() {operations.push(['translate']);}, scale() {operations.push(['scale']);},
      };
    }};
    canvases.push(canvas); return canvas;
  };
  return {element, stream, descriptor, operations, canvases, makeCanvas,
    borrow: () => borrowCameraSource(descriptor, {getCurrent: () => current, makeCanvas}),
    setCurrent(value) {current = value;}, stopped: () => stopped,
  };
}

test('borrowing and retaining reuse the decoded main feed without acquiring media or changing camera mode', async t => {
  let acquisitions = 0;
  mockGlobal(t, 'navigator', {mediaDevices: {getUserMedia() {acquisitions++; throw new Error('Unexpected camera request');}}});
  const h = harness(), source = h.borrow();
  assert.ok(source); assert.equal(source.kind, 'main'); assert.equal(source.label, 'Primary RGB camera');
  assert.equal(source.mirrored, false); assert.equal(source.isActive(), true);
  const lease = await source.retain(); lease.capture(); lease.stop();
  assert.equal(acquisitions, 0); assert.equal(h.stopped(), 0); assert.deepEqual(h.operations, []);
  assert.equal(h.element.srcObject, h.stream); assert.equal(h.element.style.transform, 'scaleX(-1)');
  assert.equal(h.descriptor.mirror, true); assert.equal(h.descriptor.role, 'rgb');
  assert.equal(source.isActive(), true);
});

test('two retained camera leases release independently and never stop the main feed', async () => {
  const h = harness(), source = h.borrow();
  const [first, second] = await Promise.all([source.retain(), source.retain()]);
  assert.notStrictEqual(first, second);
  for (const lease of [first, second]) {
    assert.equal(lease.kind, 'camera'); assert.equal(lease.stream, null); assert.equal(typeof lease.id, 'string');
    for (const property of ['sourceHint', 'resumeHint', 'deviceId', 'nativeDevice', 'video']) assert.equal(property in lease, false);
  }
  first.stop(); first.stop();
  assert.equal(first.isActive(), false); assert.throws(() => first.capture(), {name: 'InvalidStateError'});
  assert.equal(second.isActive(), true); assert.equal(source.isActive(), true);
  assert.equal(second.capture().draws[0][0], h.element); assert.equal(source.capture().draws[0][0], h.element);
  const third = await source.retain();
  second.stop(); assert.equal(third.isActive(), true); third.stop();
  assert.equal(h.stopped(), 0); assert.deepEqual(h.operations, []); assert.equal(source.isActive(), true);
});

test('normalized crops use original unmirrored pixels and preserve aspect without upscaling', () => {
  const h = harness(), source = h.borrow();
  const frame = source.capture({x: .25, y: .2, width: .5, height: .4}, {maxWidth: 400, maxHeight: 400});
  assert.equal(frame.width, 400); assert.equal(frame.height, 180);
  assert.deepEqual(frame.draws, [[h.element, 480, 216, 960, 432, 0, 0, 400, 180]]);
  assert.deepEqual(frame.reads, [[0, 0, 1, 1]]); assert.deepEqual(h.operations, []);
  const small = source.capture({x: 0, y: 0, width: .1, height: .1});
  assert.equal(small.width, 192); assert.equal(small.height, 108);
  const full = source.capture(); assert.equal(full.width, 1600); assert.equal(full.height, 900);
  assert.notStrictEqual(full, frame);
});

test('decoded native images and live video URLs can be borrowed in their current camera mode', async () => {
  const image = {naturalWidth: 1280, naturalHeight: 720, complete: false};
  for (const overrides of [
    {type: 'image', element: image, width: 1280, height: 720, role: 'ir'},
    {type: 'url', role: 'hello'},
  ]) {
    const h = harness(overrides), source = h.borrow(); assert.ok(source);
    const lease = await source.retain(), frame = lease.capture();
    assert.strictEqual(frame.draws[0][0], h.descriptor.element); assert.equal(lease.kind, 'camera');
    assert.equal(h.descriptor.role, overrides.role); assert.equal(h.descriptor.type, overrides.type);
    lease.stop(); assert.equal(source.isActive(), true); assert.equal(h.stopped(), 0);
  }
});

test('samples, synthetic or non-live media and undecoded or malformed sources are rejected', () => {
  assert.equal(borrowCameraSource(null), null);
  for (const overrides of [
    {kind: 'scene'}, {type: 'sample'}, {type: 'file'}, {type: 'landmarks'},
    {synthetic: true}, {sample: true}, {coordinatePreview: true}, {live: false}, {live: undefined},
    {sourceId: ''}, {generation: undefined}, {element: null},
    {width: 0}, {height: -1}, {width: Infinity}, {height: NaN}, {width: 1920.5},
    {element: {videoWidth: 0, videoHeight: 0, readyState: 0}},
    {element: {videoWidth: 1920, videoHeight: 1080, readyState: 1}},
    {element: {videoWidth: 1920, videoHeight: 1080, readyState: 2, ended: true}},
    {element: {width: 1920, height: 1080, readyState: 2}},
    {type: 'image', element: {naturalWidth: 0, naturalHeight: 0, complete: true}},
    {width: 1280},
  ]) assert.equal(harness(overrides).borrow(), null, JSON.stringify(overrides));
});

test('source, session, element and format changes invalidate the parent and all leases', async () => {
  const changes = [
    h => h.setCurrent({...h.descriptor, sourceId: '8:camera-b'}),
    h => h.setCurrent({...h.descriptor, generation: 8}),
    h => h.setCurrent({...h.descriptor, element: {...h.element}}),
    h => h.setCurrent({...h.descriptor, width: 1280}),
    h => h.setCurrent({...h.descriptor, height: 720}),
    h => {h.element.videoWidth = 1280;},
    h => {h.element.videoHeight = 720;},
    h => h.setCurrent({...h.descriptor, live: false}),
    h => h.setCurrent({...h.descriptor, synthetic: true}),
    h => h.setCurrent({...h.descriptor, type: 'file'}),
    h => h.setCurrent(null),
    h => {h.descriptor.sourceId = 'same-object-new-source';},
  ];
  for (const change of changes) {
    const h = harness(), source = h.borrow(), lease = await source.retain(); change(h);
    assert.equal(source.isActive(), false); assert.equal(lease.isActive(), false);
    assert.throws(() => source.capture(), error => error.name === 'AbortError' && /changed/.test(error.message));
    assert.throws(() => lease.capture(), {name: 'AbortError'});
    await assert.rejects(source.retain(), {name: 'AbortError'});
    lease.stop(); assert.equal(h.stopped(), 0);
  }
});

test('a live source losing decoded video pixels reports an actionable read error', () => {
  const h = harness(), source = h.borrow(); h.element.readyState = 1;
  assert.equal(source.isActive(), false);
  assert.throws(() => source.capture(), error => error.name === 'NotReadableError' && /decoded live frame/.test(error.message));
  assert.equal(h.canvases.length, 0); assert.equal(h.stopped(), 0);
});

test('retaining rejects an already aborted or same-turn aborted acquisition', async () => {
  const h = harness(), source = h.borrow(), before = new AbortController(), during = new AbortController();
  before.abort(); await assert.rejects(source.retain({signal: before.signal}), {name: 'AbortError'});
  const pending = source.retain({signal: during.signal}); during.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && /cancelled/.test(error.message));
  assert.equal(h.canvases.length, 0); assert.equal(h.stopped(), 0); assert.equal(source.isActive(), true);
});

test('retaining revalidates identity and intrinsic dimensions at asynchronous resolution', async () => {
  for (const change of [
    h => h.setCurrent({...h.descriptor, sourceId: 'other'}),
    h => h.setCurrent({...h.descriptor, generation: 8}),
    h => h.setCurrent({...h.descriptor, element: {...h.element}}),
    h => h.setCurrent({...h.descriptor, width: 1280}),
    h => {h.element.videoHeight = 720;},
  ]) {
    const h = harness(), source = h.borrow(), pending = source.retain(); change(h);
    await assert.rejects(pending, {name: 'AbortError'}); assert.equal(h.stopped(), 0);
  }
});

test('an acquisition signal does not take ownership of a transferred lease', async () => {
  const h = harness(), source = h.borrow(), controller = new AbortController();
  const lease = await source.retain({signal: controller.signal}); controller.abort();
  assert.equal(lease.isActive(), true); assert.equal(lease.capture().draws[0][0], h.element);
  lease.stop(); assert.equal(h.stopped(), 0);
});

test('tainted image readback fails before a frame can reach a pin and releases the temporary canvas', () => {
  const h = harness({}, {onRead() {throw new DOMException('Canvas is tainted', 'SecurityError');}}), source = h.borrow();
  assert.throws(() => source.capture(), error => error.name === 'SecurityError' && /cannot be read/.test(error.message));
  assert.equal(h.canvases[0].width, 1); assert.equal(h.canvases[0].height, 1);
  assert.equal(h.element.videoWidth, 1920); assert.equal(h.element.videoHeight, 1080); assert.equal(h.stopped(), 0);
});

test('a missing canvas context fails helpfully without changing the live camera', () => {
  const h = harness({}, {contextMissing: true}), source = h.borrow();
  assert.throws(() => source.capture(), {name: 'NotSupportedError'});
  assert.equal(h.canvases[0].width, 1); assert.equal(h.canvases[0].height, 1); assert.equal(source.isActive(), true);
});

test('a source change during drawing discards the capture rather than returning mismatched pixels', () => {
  const h = harness({}, {onDraw() {h.setCurrent({...h.descriptor, generation: 8});}}), source = h.borrow();
  assert.throws(() => source.capture(), {name: 'AbortError'});
  assert.equal(h.canvases[0].width, 1); assert.equal(h.canvases[0].height, 1); assert.equal(h.stopped(), 0);
});

test('the default current descriptor still protects against later mutation and dimension changes', () => {
  const h = harness(), source = borrowCameraSource(h.descriptor, {makeCanvas: h.makeCanvas});
  assert.ok(source); h.element.videoWidth = 1280;
  assert.equal(source.isActive(), false); assert.throws(() => source.capture(), {name: 'AbortError'});
});
