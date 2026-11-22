import test from 'node:test';
import assert from 'node:assert/strict';
import {createCameraFeedPool, classifyCameraDevice} from '../dist/camera-feed-pool.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}

class Track extends EventTarget {
  constructor(deviceId, {label = 'LVNext CPD Camera', width = 512, height = 640, capabilities = {width: {min: 512, max: 512}, height: {min: 640, max: 640}}} = {}) {
    super(); this.readyState = 'live'; this.label = label; this.stops = 0; this.listeners = new Set();
    this.settings = {deviceId, width, height, frameRate: 30}; this.capabilities = capabilities;
  }
  addEventListener(type, listener, options) {if (type === 'ended') this.listeners.add(listener); super.addEventListener(type, listener, options);}
  removeEventListener(type, listener, options) {if (type === 'ended') this.listeners.delete(listener); super.removeEventListener(type, listener, options);}
  getSettings() {return this.settings;}
  getCapabilities() {return this.capabilities;}
  stop() {this.stops++; this.readyState = 'ended';}
  end() {this.readyState = 'ended'; this.dispatchEvent(new Event('ended'));}
}

function stream(deviceId, options) {
  const track = new Track(deviceId, options);
  return {track, getTracks: () => [track], getVideoTracks: () => [track]};
}

class Video extends EventTarget {
  constructor() {super(); this.srcObject = null; this.videoWidth = 512; this.videoHeight = 640; this.readyState = 2; this.style = {}; this.pauses = 0; this.removes = 0; this.attributes = {};}
  play() {return Promise.resolve();}
  pause() {this.pauses++;}
  remove() {this.removes++;}
  setAttribute(name, value) {this.attributes[name] = value;}
  removeAttribute(name) {delete this.attributes[name];}
}

function harness(options = {}) {
  const mediaCalls = [], videos = [], canvases = [], events = [], streams = [];
  let primaryId = 'rgb';
  const pool = createCameraFeedPool({
    getPrimaryDeviceId: () => primaryId,
    onState: event => events.push(event),
    getMedia: async constraints => {mediaCalls.push(constraints); const opened = stream(constraints.video.deviceId.exact); streams.push(opened); return opened;},
    makeVideo: () => {const video = new Video(); videos.push(video); return video;},
    attachVideo() {}, waitFrame: async () => {},
    makeCanvas: () => {
      const calls = [], canvas = {width: 0, height: 0, calls, getContext: () => ({drawImage: (...args) => calls.push(args)})};
      canvases.push(canvas); return canvas;
    },
    ...options,
  });
  return {pool, mediaCalls, videos, canvases, streams, events, setPrimary: value => {primaryId = value;}};
}

test('concurrent consumers share one exact native camera, one video and one generation', async () => {
  const grant = deferred(), calls = [];
  const primary = stream('rgb');
  const h = harness({getMedia: constraints => {calls.push(constraints); return grant.promise;}});
  const a = h.pool.acquire('cpd'), b = h.pool.acquire('cpd');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {video: {deviceId: {exact: 'cpd'}}, audio: false});
  assert.deepEqual(h.pool.getState().feeds.map(({pending, leases}) => ({pending, leases})), [{pending: 2, leases: 0}]);
  const opened = stream('cpd'); grant.resolve(opened);
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one.kind, 'aux-camera'); assert.notEqual(one, two);
  assert.equal(one.id, two.id); assert.equal(one.stream, two.stream); assert.equal(one.video, two.video);
  assert.equal(h.videos.length, 1); assert.equal(h.pool.getState().feeds[0].leases, 2);
  one.release(); one.stop();
  assert.equal(opened.track.stops, 0); assert.equal(two.isActive(), true);
  assert.equal(one.stream, null); assert.equal(one.video, null);
  assert.throws(() => one.capture(), {name: 'InvalidStateError'});
  two.stop(); two.stop();
  assert.equal(opened.track.stops, 1); assert.equal(primary.track.stops, 0);
  assert.equal(h.videos[0].removes, 1); assert.equal(h.videos[0].srcObject, null);
  assert.equal(opened.track.listeners.size, 0); assert.deepEqual(h.pool.getState().feeds, []);
});

test('the same labels and group IDs do not combine different video endpoints', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.pool.acquire('cpd', {label: 'Camera'}), h.pool.acquire('wide', {label: 'Camera'})]);
  assert.equal(h.mediaCalls.length, 2); assert.equal(h.videos.length, 2); assert.notEqual(a.id, b.id);
  a.release(); assert.equal(b.isActive(), true);
  h.pool.destroy(); assert.equal(h.streams[1].track.stops, 1);
});

test('capture consumers choose independent regions and limits without changing the shared stream', async () => {
  const h = harness(); const [a, b] = await Promise.all([h.pool.acquire('cpd'), h.pool.acquire('cpd')]);
  const first = a.capture({x: .25, y: .25, width: .5, height: .5}, {maxWidth: 128, maxHeight: 128});
  const second = b.capture();
  assert.deepEqual([first.width, first.height], [102, 128]);
  assert.deepEqual(first.calls[0].slice(1), [128, 160, 256, 320, 0, 0, 102, 128]);
  assert.deepEqual([second.width, second.height], [512, 640]);
  assert.equal(first.calls[0][0], a.video); assert.notEqual(first, second);
  // A faster consumer never starts another track, timer or shared canvas.
  const third = b.capture({x: 1, y: 1, width: -.5, height: -.5});
  assert.deepEqual(third.calls[0].slice(1, 5), [256, 320, 256, 320]);
  assert.equal(h.mediaCalls.length, 1); assert.equal(h.canvases.length, 3);
  assert.throws(() => a.capture({x: 2, y: 2, width: 1, height: 1}), {name: 'RangeError'});
  assert.throws(() => a.capture(undefined, {maxWidth: Infinity}), {name: 'RangeError'});
  h.pool.destroy();
});

test('decoded dimensions and metadata come from the actual frame and are independent snapshots', async () => {
  const h = harness(); const lease = await h.pool.acquire('cpd', {label: 'Requested label'});
  const result = lease.getMetadata();
  assert.equal(result.label, 'LVNext CPD Camera'); assert.equal(result.width, 512); assert.equal(result.height, 640);
  assert.equal(result.settings.deviceId, 'cpd'); assert.equal(result.identity.role, 'video');
  assert.equal(result.identity.suggestedRole, 'cpd'); assert.equal(result.identity.confirmed, false);
  result.capabilities.width.max = 9000; result.settings.width = 9000;
  assert.equal(lease.getMetadata().capabilities.width.max, 512); assert.equal(lease.getMetadata().settings.width, 512);
  h.videos[0].videoWidth = 1024; h.videos[0].videoHeight = 1280;
  assert.equal(lease.capture().width, 960); assert.equal(lease.getMetadata().height, 1280);
  lease.release(); assert.equal(lease.getMetadata().height, 1280);
});

test('aborting one pending lease does not cancel another consumer or restart the camera', async () => {
  const grant = deferred(), aborted = new AbortController(); let requests = 0;
  const h = harness({getMedia: () => {requests++; return grant.promise;}});
  const first = h.pool.acquire('cpd', {signal: aborted.signal}), second = h.pool.acquire('cpd');
  const rejected = assert.rejects(first, {name: 'AbortError'}); aborted.abort(); await rejected;
  assert.equal(h.pool.getState().feeds[0].pending, 1);
  const opened = stream('cpd'); grant.resolve(opened); const lease = await second;
  assert.equal(requests, 1); assert.equal(opened.track.stops, 0); assert.equal(lease.isActive(), true);
  h.pool.destroy();
});

test('the last pending cancellation closes a late grant without creating a video', async () => {
  const grant = deferred(), controller = new AbortController();
  const h = harness({getMedia: () => grant.promise});
  const pending = h.pool.acquire('cpd', {signal: controller.signal});
  const rejected = assert.rejects(pending, {name: 'AbortError'}); controller.abort(); await rejected;
  assert.deepEqual(h.pool.getState().feeds, []);
  const opened = stream('cpd'); grant.resolve(opened); await flush();
  assert.equal(opened.track.stops, 1); assert.equal(h.videos.length, 0);
});

test('abort after a resolved acquisition does not kill a pin handed to the board', async () => {
  const controller = new AbortController(), h = harness();
  const lease = await h.pool.acquire('cpd', {signal: controller.signal});
  controller.abort();
  assert.equal(lease.isActive(), true); assert.equal(h.streams[0].track.stops, 0);
  lease.release(); assert.equal(h.streams[0].track.stops, 1);
});

test('cancellation during frame readiness releases stream and element despite a stalled decoder', async () => {
  const frames = deferred(), controller = new AbortController(), h = harness({waitFrame: () => frames.promise});
  const pending = h.pool.acquire('cpd', {signal: controller.signal});
  await flush(); assert.equal(h.videos.length, 1);
  const rejected = assert.rejects(pending, {name: 'AbortError'}); controller.abort(); await rejected;
  assert.equal(h.streams[0].track.stops, 1); assert.equal(h.videos[0].removes, 1);
  frames.resolve(); await flush(); assert.deepEqual(h.pool.getState().feeds, []);
});

test('permission timeout settles every waiter and closes an eventual grant', async () => {
  const grant = deferred(), h = harness({getMedia: () => grant.promise, requestTimeoutMs: 15});
  const a = h.pool.acquire('cpd'), b = h.pool.acquire('cpd');
  await Promise.all([assert.rejects(a, {name: 'TimeoutError'}), assert.rejects(b, {name: 'TimeoutError'})]);
  assert.deepEqual(h.pool.getState().feeds, []);
  const opened = stream('cpd'); grant.resolve(opened); await flush(); assert.equal(opened.track.stops, 1);
});

test('frame startup is bounded even when video.play never settles', async () => {
  const video = new Video(); video.play = () => new Promise(() => {});
  const h = harness({makeVideo: () => video, frameTimeoutMs: 15});
  await assert.rejects(h.pool.acquire('cpd'), {name: 'TimeoutError'});
  assert.equal(h.streams[0].track.stops, 1); assert.equal(video.removes, 1); assert.equal(video.srcObject, null);
  assert.deepEqual(h.pool.getState().feeds, []);
});

test('track ended invalidates all leases once, retains metadata, and permits a new generation', async () => {
  const notices = [], h = harness();
  const [a, b] = await Promise.all([
    h.pool.acquire('cpd', {onEnded: (error, data) => notices.push([error.name, data.generation])}),
    h.pool.acquire('cpd', {onEnded: (error, data) => notices.push([error.name, data.generation])}),
  ]);
  const firstId = a.id, firstGeneration = a.getMetadata().generation;
  h.streams[0].track.end();
  assert.equal(a.isActive(), false); assert.equal(b.isActive(), false); assert.equal(notices.length, 2);
  assert.equal(a.getMetadata().width, 512); assert.deepEqual(h.pool.getState().feeds, []);
  h.streams[0].track.end(); a.stop(); b.stop(); assert.equal(notices.length, 2);
  const next = await h.pool.acquire('cpd');
  assert.notEqual(next.id, firstId); assert.ok(next.getMetadata().generation > firstGeneration);
  assert.equal(h.mediaCalls.length, 2); h.pool.destroy();
});

test('unplug during startup rejects all acquisitions and cleans the readiness wait', async () => {
  const frames = deferred(), h = harness({waitFrame: () => frames.promise});
  const a = h.pool.acquire('cpd'), b = h.pool.acquire('cpd');
  const rejected = Promise.all([assert.rejects(a, {name: 'NotReadableError'}), assert.rejects(b, {name: 'NotReadableError'})]);
  await flush(); h.streams[0].track.end(); await rejected;
  assert.equal(h.videos[0].srcObject, null); assert.equal(h.streams[0].track.listeners.size, 0);
  frames.reject(new Error('Late decoder failure')); await flush(); assert.deepEqual(h.pool.getState().feeds, []);
});

test('a track stopped without an ended event cannot yield a stale capture', async () => {
  const h = harness(); const lease = await h.pool.acquire('cpd');
  h.streams[0].track.stop();
  assert.equal(lease.isActive(), false); assert.deepEqual(h.pool.getState().feeds, []);
  assert.throws(() => lease.capture(), {name: 'InvalidStateError'});
});

test('an initially selected primary is never requested by the auxiliary pool', async () => {
  const h = harness();
  assert.equal(h.pool.canAcquire('rgb'), false); assert.equal(h.pool.canAcquire('cpd'), true);
  await assert.rejects(h.pool.acquire('rgb'), error => error.code === 'APERTURE_PRIMARY_CAMERA_IN_USE');
  assert.equal(h.mediaCalls.length, 0); assert.deepEqual(h.pool.getState().feeds, []);
});

test('primary change during the permission wait discards only the pool-owned grant', async () => {
  const grant = deferred(), h = harness({getMedia: () => grant.promise}), primary = stream('cpd');
  const pending = h.pool.acquire('cpd'); h.setPrimary('cpd');
  const opened = stream('cpd'); grant.resolve(opened);
  await assert.rejects(pending, error => error.code === 'APERTURE_PRIMARY_CAMERA_IN_USE');
  assert.equal(opened.track.stops, 1); assert.equal(primary.track.stops, 0); assert.equal(h.videos.length, 0);
});

test('primary change while decoding cannot resolve an auxiliary lease', async () => {
  const frames = deferred(), h = harness({waitFrame: () => frames.promise});
  const pending = h.pool.acquire('cpd'); await flush(); h.setPrimary('cpd'); frames.resolve();
  await assert.rejects(pending, error => error.code === 'APERTURE_PRIMARY_CAMERA_IN_USE');
  assert.equal(h.streams[0].track.stops, 1); assert.equal(h.videos[0].srcObject, null);
});

test('active captures recheck primary ownership and stop only their auxiliary tracks', async () => {
  const h = harness(), primary = stream('cpd');
  const lease = await h.pool.acquire('cpd'); h.setPrimary('cpd');
  assert.throws(() => lease.capture(), error => error.code === 'APERTURE_PRIMARY_CAMERA_IN_USE');
  assert.equal(primary.track.stops, 0); assert.equal(h.streams[0].track.stops, 1); assert.deepEqual(h.pool.getState().feeds, []);
});

test('the browser cannot silently substitute a different device', async () => {
  const wrong = stream('rgb'), h = harness({getMedia: async () => wrong});
  await assert.rejects(h.pool.acquire('cpd'), error => error.code === 'APERTURE_CAMERA_DEVICE_MISMATCH');
  assert.equal(wrong.track.stops, 1); assert.equal(h.videos.length, 0); assert.deepEqual(h.pool.getState().feeds, []);
});

test('permission failure is shared, removed, and retryable without stale promises', async () => {
  const grant = deferred(); let attempts = 0;
  const h = harness({getMedia: () => ++attempts === 1 ? grant.promise : Promise.resolve(stream('cpd'))});
  const a = h.pool.acquire('cpd'), b = h.pool.acquire('cpd');
  const rejected = Promise.all([assert.rejects(a, {name: 'NotAllowedError'}), assert.rejects(b, {name: 'NotAllowedError'})]);
  grant.reject(new DOMException('Denied', 'NotAllowedError')); await rejected;
  assert.deepEqual(h.pool.getState().feeds, []);
  const lease = await h.pool.acquire('cpd'); assert.equal(attempts, 2); assert.equal(lease.isActive(), true); lease.release();
});

test('destroy releases active and pending inputs; a late grant cannot leak or resurrect the pool', async () => {
  const grant = deferred(), h = harness({getMedia: constraints => constraints.video.deviceId.exact === 'pending' ? grant.promise : Promise.resolve(stream('cpd'))});
  const active = await h.pool.acquire('cpd'), activeTrack = active.stream.getVideoTracks()[0];
  const pending = h.pool.acquire('pending'); const rejected = assert.rejects(pending, {name: 'AbortError'});
  h.pool.destroy(); h.pool.destroy(); await rejected;
  assert.equal(activeTrack.stops, 1); assert.equal(active.isActive(), false); assert.equal(h.pool.canAcquire('cpd'), false);
  const late = stream('pending'); grant.resolve(late); await flush(); assert.equal(late.track.stops, 1);
  await assert.rejects(h.pool.acquire('cpd'), {name: 'InvalidStateError'});
  assert.deepEqual(h.pool.getState(), {destroyed: true, feeds: []});
});

test('an old cancelled grant cannot delete or stop a replacement generation', async () => {
  const old = deferred(), controller = new AbortController(); let calls = 0;
  const h = harness({getMedia: () => ++calls === 1 ? old.promise : Promise.resolve(stream('cpd'))});
  const first = h.pool.acquire('cpd', {signal: controller.signal});
  const rejected = assert.rejects(first, {name: 'AbortError'}); controller.abort(); await rejected;
  const current = await h.pool.acquire('cpd'); const obsolete = stream('cpd'); old.resolve(obsolete); await flush();
  assert.equal(obsolete.track.stops, 1); assert.equal(current.isActive(), true); assert.equal(h.pool.getState().feeds.length, 1);
  current.release();
});

test('unready dimensions, playback errors and element-creation failures release the granted camera', async t => {
  const cases = [
    ['zero dimensions', {makeVideo: () => Object.assign(new Video(), {videoWidth: 0})}, 'NotReadableError'],
    ['playback rejection', {makeVideo: () => Object.assign(new Video(), {play: () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'))})}, 'NotAllowedError'],
    ['creation failure', {makeVideo: () => {throw new Error('DOM unavailable');}}, 'Error'],
    ['synchronous readiness failure', {waitFrame: () => {throw new Error('Decoder unavailable');}}, 'Error'],
  ];
  for (const [name, options, errorName] of cases) await t.test(name, async () => {
    const h = harness(options); await assert.rejects(h.pool.acquire('cpd'), {name: errorName});
    assert.equal(h.streams[0].track.stops, 1); assert.deepEqual(h.pool.getState().feeds, []);
  });
});

test('one throwing or rejecting observer cannot strand other consumers', async () => {
  const h = harness({onState: async () => {throw new Error('Diagnostic observer');}}); let notified = 0;
  const [a, b] = await Promise.all([
    h.pool.acquire('cpd', {onEnded: async () => {throw new Error('Consumer observer');}}),
    h.pool.acquire('cpd', {onEnded: () => {notified++;}}),
  ]);
  a.stream.getVideoTracks()[0].end(); await flush();
  assert.equal(notified, 1); assert.equal(a.isActive(), false); assert.equal(b.isActive(), false);
});

test('invalid IDs and already-cancelled requests never open a default device', async () => {
  const h = harness();
  for (const id of ['', ' ', 'default', 'communications', null, 4]) {
    assert.equal(h.pool.canAcquire(id), false); await assert.rejects(h.pool.acquire(id), {name: 'TypeError'});
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.pool.acquire('cpd', {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(h.mediaCalls.length, 0);
});

test('role labels suggest CPD, wide and IR without asserting confirmed sensor identity', () => {
  for (const [label, suggested] of [['LVNext CPD Camera', 'cpd'], ['USB Wide-angle', 'wide'], ['Infrared camera', 'ir'], ['Near IR', 'ir'], ['LVNext Camera', 'rgb'], ['Hello Camera', 'hello'], ['FaceTime HD Camera', 'video'], ['', 'video']]) {
    const identity = classifyCameraDevice({deviceId: label || 'opaque', label});
    assert.equal(identity.suggestedRole, suggested); assert.equal(identity.role, 'video'); assert.equal(identity.confirmed, false);
  }
  const byName = classifyCameraDevice({label: 'IR'}, {confirmation: {role: 'ir', source: 'label', detail: 'IR in name'}});
  assert.equal(byName.confirmed, false);
  const confirmed = classifyCameraDevice({deviceId: 'cpd', label: 'Camera'}, {confirmation: {role: 'ir', source: 'sdk', detail: 'Observed SDK sensor metadata'}});
  assert.equal(confirmed.role, 'ir'); assert.equal(confirmed.confirmed, true); assert.equal(confirmed.suggestedRole, 'video');
});
