import test from 'node:test';
import assert from 'node:assert/strict';
import {createGazeModelController, decodeGazeMask, validateGpuStatus} from '../dist/gaze-models.js';

const flush = async () => {for (let n = 0; n < 24; n++) await Promise.resolve();};
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const source = () => ({width: 4, height: 3, marker: 'gesture-time pixels'});
const point = () => ({x: .5, y: .5});
const status = (ids = ['sam2.1-base-plus', 'sam2.1-large', 'sam2.1-tiny']) => ({protocol: 'roofcat-gaze-v1',
  cuda: {available: true, name: 'NVIDIA GeForce RTX 4060 Laptop GPU', freeBytes: 6e9, totalBytes: 8e9},
  models: ids.map(id => ({id, name: id, revision: 'verified-revision', installed: true, available: true})), busy: false});
const response = (value, code = 200) => ({ok: code >= 200 && code < 300, status: code, headers: {get: () => null}, text: async () => JSON.stringify(value)});
const result = request => ({protocol: 'roofcat-gaze-v1', requestId: request.requestId,
  model: {id: request.model, revision: 'verified-revision'}, delegate: 'CUDA', width: request.width, height: request.height,
  mask: {width: request.width, height: request.height, encoding: 'rle-binary', startsWith: 0, counts: [2, 5, request.width * request.height - 7]},
  qualityScore: .93, latencyMs: 18, device: 'NVIDIA GeForce RTX 4060 Laptop GPU'});

function fixture(options = {}) {
  let now = 1, nextTimer = 0; const timers = new Map(), frames = [], requests = [], states = [], browserCalls = [];
  const browser = {prepare: async () => {browserCalls.push({action: 'prepare'});},
    segment: async (image, args) => {browserCalls.push({action: 'segment', width: image.width, height: image.height, marker: image.marker, point: {...args.point}});
      return {width: image.width, height: image.height, mask: {width: image.width, height: image.height, data: new Float32Array(image.width * image.height)},
        model: {id: 'magic-touch-v2-int8', name: 'MagicTouch v2'}, delegate: 'GPU', latencyMs: 12};},
    cancel: () => browserCalls.push({action: 'cancel'}), destroy: () => browserCalls.push({action: 'destroy'}),
    getState: () => ({model: {id: 'magic-touch-v2-int8', name: 'MagicTouch v2'}, delegate: 'GPU'})};
  const fetcher = async (url, options) => {
    requests.push({url, options});
    if (url.endsWith('/status')) return response(status());
    return response(result(JSON.parse(options.body)));
  };
  const controller = createGazeModelController({browserSegmenter: browser, fetcher,
    createCanvas: () => {const image = {width: 0, height: 0, getContext: () => ({drawImage: from => {image.marker = from.marker;}})}; frames.push(image); return image;},
    encodeImage: async frame => {assert.equal(frame.marker, 'gesture-time pixels'); return 'iVBORw0KGgo=';},
    clock: () => now, statusTimeoutMs: 20, requestTimeoutMs: 100,
    setTimer: (callback, delay) => {const id = ++nextTimer; timers.set(id, {callback, at: now + delay}); return id;},
    clearTimer: id => timers.delete(id), onState: state => states.push(state), ...options});
  async function advance(ms) {now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) {timers.delete(id); timer.callback();} await flush();}
  return {controller, browser, browserCalls, requests, states, frames, timers, advance};
}

test('Automatic stays browser-only until the user checks the local GPU', async () => {
  const h = fixture(); assert.equal(h.requests.length, 0);
  await h.controller.prepare();
  const output = await h.controller.segment(source(), {point: point()});
  assert.equal(output.model.id, 'magic-touch-v2-int8'); assert.equal(h.requests.length, 0);
  assert.equal(output.maskSemantics, 'foreground-probability');
  assert.deepEqual(h.browserCalls.map(call => call.action), ['prepare', 'segment']);
  assert.equal(h.controller.getState().local.checked, false); h.controller.destroy();
});

test('a successful explicit GPU check enables balanced Automatic selection without changing the preference', async () => {
  const h = fixture(); await h.controller.checkLocal();
  assert.equal(h.controller.getSelection(), 'auto'); assert.equal(h.controller.getState().model.id, 'sam2.1-base-plus');
  const output = await h.controller.segment(source(), {point: point()});
  assert.equal(output.model.id, 'sam2.1-base-plus'); assert.equal(output.delegate, 'CUDA'); assert.equal(output.qualityScore, .93);
  assert.equal(output.maskSemantics, 'binary');
  assert.equal(output.qualityScoreKind, 'predicted-mask-iou'); assert.deepEqual([...output.mask.data], [0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  assert.equal(h.browserCalls.length, 0); assert.equal(h.requests.length, 2); h.controller.destroy();
});

test('explicit Large preserves the selected model and sends only the gesture-time pixels to loopback', async () => {
  const gate = deferred(), h = fixture({initialSelection: 'sam2.1-large', encodeImage: () => gate.promise});
  const image = source(), seed = point(), job = h.controller.segment(image, {point: seed});
  image.marker = 'new video frame'; image.width = 8; seed.x = .8;
  await flush(); assert.equal(h.frames[0].marker, 'gesture-time pixels'); gate.resolve('iVBORw0KGgo=');
  const output = await job, sent = h.requests.find(row => row.options.method === 'POST');
  assert.equal(sent.url, 'http://127.0.0.1:9041/api/segmentation/segment');
  assert.equal(sent.options.targetAddressSpace, 'loopback');
  assert.equal(sent.options.credentials, 'omit'); assert.equal(sent.options.redirect, 'error'); assert.equal(sent.options.referrerPolicy, 'no-referrer');
  const payload = JSON.parse(sent.options.body);
  assert.deepEqual(payload.point, {x: .5, y: .5});
  assert.equal(payload.width, 4); assert.equal(payload.height, 3); assert.equal(payload.model, 'sam2.1-large');
  assert.equal(output.model.id, 'sam2.1-large'); assert.equal(h.frames[0].width, 1); h.controller.destroy();
});

test('browsers with an older address-space enum still attempt the fixed loopback service', async context => {
  context.mock.method(globalThis, 'Request', function () {throw new TypeError('Unsupported targetAddressSpace');});
  const h = fixture(); await h.controller.checkLocal();
  assert.equal(h.requests[0].url, 'http://127.0.0.1:9041/api/segmentation/status');
  assert.equal('targetAddressSpace' in h.requests[0].options, false);
  assert.equal(h.controller.getState().local.status, 'ready'); h.controller.destroy();
});

test('Automatic falls back visibly to the actual browser model after a GPU error', async () => {
  const h = fixture({fetcher: async url => url.endsWith('/status') ? response(status()) : response({error: 'cuda_out_of_memory', message: 'CUDA memory is full.'}, 503)});
  await h.controller.checkLocal(); const output = await h.controller.segment(source(), {point: point()});
  assert.equal(output.model.id, 'magic-touch-v2-int8'); assert.match(h.controller.getState().fallbackReason, /CUDA memory/);
  assert.equal(h.controller.getState().model.id, 'magic-touch-v2-int8'); assert.equal(h.controller.getState().delegate, 'GPU'); h.controller.destroy();
});

test('explicit GPU errors never silently substitute a browser model or permit detector fallback', async () => {
  const h = fixture({initialSelection: 'sam2.1-large', fetcher: async url => url.endsWith('/status') ? response(status()) : response({error: 'cuda_out_of_memory', message: 'Choose a smaller model.'}, 503)});
  await assert.rejects(h.controller.segment(source(), {point: point()}), error => error.code === 'cuda_out_of_memory' && error.allowDetectorFallback === false);
  assert.equal(h.browserCalls.length, 0); assert.equal(h.controller.getState().status, 'error'); h.controller.destroy();
});

test('missing GPU or weights are reported before any frame is sent', async () => {
  const requests = [], h = fixture({initialSelection: 'sam2.1-large', fetcher: async (url, options) => {requests.push({url, options}); return response(status(['sam2.1-base-plus']));}});
  await assert.rejects(h.controller.segment(source(), {point: point()}), error => error.code === 'GPU_MODEL_UNAVAILABLE' && error.allowDetectorFallback === false);
  assert.equal(requests.length, 1); assert.equal(requests[0].options.method, 'GET'); assert.equal(h.browserCalls.length, 0);
  assert.equal(h.controller.getOptions().find(choice => choice.value === 'sam2.1-large').available, false); h.controller.destroy();
});

test('failed status checks leave Automatic usable in the browser without probing again', async () => {
  let calls = 0; const h = fixture({fetcher: async () => {calls++; throw new TypeError('Network permission denied');}});
  await assert.rejects(h.controller.checkLocal(), {code: 'GPU_SERVICE_UNAVAILABLE'});
  await h.controller.segment(source(), {point: point()}); assert.equal(calls, 1);
  assert.equal(h.controller.getState().local.status, 'unavailable'); h.controller.destroy();
});

test('invalid service identities cannot enable local inference', () => {
  for (const value of [null, {}, {...status(), protocol: 'other'}, {...status(), cuda: {available: 'true'}}, {...status(), models: null}])
    assert.throws(() => validateGpuStatus(value), {code: 'GPU_SERVICE_PROTOCOL'});
  const value = validateGpuStatus({...status(), models: [{id: 'remote-command', installed: true, available: true}, ...status().models]});
  assert.equal(value.models.length, 3);
});

test('mask decoding validates all geometry and runs before trusting a result', () => {
  const valid = {width: 4, height: 3, encoding: 'rle-binary', startsWith: 0, counts: [0, 12]};
  assert.ok([...decodeGazeMask(valid, 4, 3).data].every(value => value === 1));
  for (const mask of [null, {...valid, width: 5}, {...valid, startsWith: 1}, {...valid, counts: [13]}, {...valid, counts: [0, 11]},
    {...valid, counts: [1, 0, 11]}, {...valid, counts: [-1, 13]}, {...valid, counts: [.5, 11.5]}, {...valid, counts: Array(14).fill(1)}])
    assert.throws(() => decodeGazeMask(mask, 4, 3), {code: 'GPU_MASK_INVALID'});
  assert.throws(() => decodeGazeMask(valid, 3000, 3000), {code: 'GAZE_MODEL_IMAGE_INVALID'});
});

test('foreign request, model, revision, dimensions and delegate cannot return plausible crops', async () => {
  for (const override of [{requestId: 'old'}, {model: {id: 'sam2.1-tiny', revision: 'verified-revision'}},
    {model: {id: 'sam2.1-large', revision: 'another-revision'}}, {width: 5}, {delegate: 'CPU'}]) {
    const h = fixture({initialSelection: 'sam2.1-large', fetcher: async (url, options) => url.endsWith('/status') ? response(status()) : response({...result(JSON.parse(options.body)), ...override})});
    await assert.rejects(h.controller.segment(source(), {point: point()}), {code: 'GPU_RESULT_MISMATCH'}); h.controller.destroy();
  }
});

test('mask-quality scores retain their real meaning and are not clamped into confidence', async () => {
  const h = fixture({initialSelection: 'sam2.1-large', fetcher: async (url, options) => url.endsWith('/status') ? response(status()) : response({...result(JSON.parse(options.body)), qualityScore: 1.01})});
  const output = await h.controller.segment(source(), {point: point()}); assert.equal(output.qualityScore, 1.01);
  assert.equal(output.qualityScoreKind, 'predicted-mask-iou'); assert.equal('confidence' in output, false); h.controller.destroy();
});

test('a second image is rejected while encoding, without replacing the pending frame', async () => {
  const gate = deferred(), h = fixture({initialSelection: 'sam2.1-large', encodeImage: () => gate.promise});
  const job = h.controller.segment(source(), {point: point()}); await flush();
  await assert.rejects(h.controller.segment(source(), {point: point()}), {name: 'BusyError'});
  gate.resolve('iVBORw0KGgo='); await job; assert.equal(h.frames.length, 1); h.controller.destroy();
});

test('cancellation during encoding releases pixels and a late encoder cannot upload them', async () => {
  const gate = deferred(), h = fixture({initialSelection: 'sam2.1-large', encodeImage: () => gate.promise});
  const job = h.controller.segment(source(), {point: point()}), rejected = assert.rejects(job, {name: 'AbortError'});
  await flush(); h.controller.cancel(); await rejected; gate.resolve('iVBORw0KGgo='); await flush();
  assert.equal(h.requests.filter(row => row.options.method === 'POST').length, 0); assert.equal(h.frames[0].width, 1);
  assert.equal(h.controller.getState().busy, false); assert.equal(h.timers.size, 0); h.controller.destroy();
});

test('changing model while a response is delayed rejects the old result and preserves the new choice', async () => {
  const late = deferred(); let payload;
  const h = fixture({initialSelection: 'sam2.1-large', fetcher: async (url, options) => {if (url.endsWith('/status')) return response(status()); payload = JSON.parse(options.body); return late.promise;}});
  const job = h.controller.segment(source(), {point: point()}), rejected = assert.rejects(job, {name: 'AbortError'});
  await flush(); h.controller.setSelection('browser'); await rejected; late.resolve(response(result(payload))); await flush();
  assert.equal(h.controller.getSelection(), 'browser'); assert.equal(h.controller.getState().model.id, 'magic-touch-v2-int8');
  assert.equal(h.controller.getState().completed, 0); h.controller.destroy();
});

test('pre-aborted or invalid frames allocate no pixels and perform no network requests', async () => {
  const h = fixture(), signal = new AbortController(); signal.abort();
  await assert.rejects(h.controller.segment(source(), {point: point(), signal: signal.signal}), {name: 'AbortError'});
  await assert.rejects(h.controller.checkLocal({signal: signal.signal}), {name: 'AbortError'});
  await assert.rejects(h.controller.segment(source(), {point: {x: -1, y: 0}}));
  await assert.rejects(h.controller.segment({width: 2000, height: 1}, {point: point()}), {code: 'GAZE_MODEL_IMAGE_INVALID'});
  assert.equal(h.frames.length, 0); assert.equal(h.requests.length, 0); h.controller.destroy();
});

test('timeouts settle status and inference even when a transport ignores cancellation', async () => {
  const hanging = deferred(), h = fixture({fetcher: () => hanging.promise});
  const statusJob = h.controller.checkLocal(), statusFailure = assert.rejects(statusJob, {code: 'GPU_SERVICE_TIMEOUT'});
  await h.advance(21); await statusFailure; assert.equal(h.controller.getState().local.status, 'unavailable'); assert.equal(h.timers.size, 0); h.controller.destroy();
  const pending = deferred(), active = fixture({initialSelection: 'sam2.1-large', fetcher: async url => url.endsWith('/status') ? response(status()) : pending.promise});
  const job = active.controller.segment(source(), {point: point()}), rejected = assert.rejects(job, error => error.code === 'GPU_SERVICE_TIMEOUT' && error.allowDetectorFallback === false);
  await flush(); await active.advance(101); await rejected; assert.equal(active.frames[0].width, 1); assert.equal(active.timers.size, 0); active.controller.destroy();
});

test('cancelled status checks cannot replace a newer GPU response or leave Checking stuck', async () => {
  const old = deferred(); let count = 0;
  const h = fixture({fetcher: () => ++count === 1 ? old.promise : Promise.resolve(response(status(['sam2.1-tiny'])))});
  const first = h.controller.checkLocal(), rejected = assert.rejects(first, {name: 'AbortError'});
  await h.controller.checkLocal(); await rejected; old.resolve(response(status())); await flush();
  assert.deepEqual(h.controller.getState().local.models.map(model => model.id), ['sam2.1-tiny']);
  assert.equal(h.controller.getState().local.status, 'ready'); h.controller.destroy();
});

test('abort during an explicit preparation never switches the saved model or leaves checking active', async () => {
  const h = fixture({initialSelection: 'sam2.1-large', fetcher: () => deferred().promise}), abort = new AbortController();
  const job = h.controller.prepare({signal: abort.signal}), rejected = assert.rejects(job, {name: 'AbortError'}); abort.abort(); await rejected;
  assert.equal(h.controller.getSelection(), 'sam2.1-large'); assert.equal(h.controller.getState().local.status, 'unchecked'); h.controller.destroy();
});

test('aborting a replacement GPU check restores the last settled status', async () => {
  const h = fixture({fetcher: () => deferred().promise}), abort = new AbortController();
  const first = h.controller.checkLocal(), oldRejected = assert.rejects(first, {name: 'AbortError'});
  const second = h.controller.checkLocal({signal: abort.signal}), newRejected = assert.rejects(second, {name: 'AbortError'});
  abort.abort(); await Promise.all([oldRejected, newRejected]);
  assert.equal(h.controller.getState().local.status, 'unchecked'); assert.equal(h.timers.size, 0); h.controller.destroy();
});

test('status callback cancellation prevents any frame from reaching an inference engine', async () => {
  let controller; const h = fixture({onState: state => {if (state.status === 'segmenting') controller.cancel();}}); controller = h.controller;
  await assert.rejects(controller.segment(source(), {point: point()}), {name: 'AbortError'});
  assert.equal(h.browserCalls.filter(call => call.action === 'segment').length, 0); assert.equal(h.requests.length, 0);
  assert.equal(h.frames[0].width, 1); controller.destroy();
});

test('destroy is final and model preferences accept only the fixed choices', async () => {
  const h = fixture(); assert.throws(() => h.controller.setSelection('https://remote.test/model'), RangeError);
  h.controller.destroy(); await assert.rejects(h.controller.segment(source(), {point: point()}), {code: 'GAZE_MODELS_DESTROYED'});
  assert.throws(() => h.controller.setSelection('browser'), {code: 'GAZE_MODELS_DESTROYED'});
});
