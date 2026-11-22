import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeypadController, buildKeyImagePackets, parseKeypadInput, parseKeypadImageAck, jpegDimensions,
  KEYPAD_LAYOUT, KEYPAD_VENDOR_ID, KEYPAD_PRODUCT_ID, MAX_IMAGE_BYTES, MAX_ENCODED_IMAGE_BYTES, DISPLAY_WIDTH, DISPLAY_HEIGHT
} from '../dist/keypad-hid.js';

// JPEG-shaped transport fixture: tests validate byte transport, not image decoding.
function jpeg(length = 128, marker = 42, width = 118, height = 118) {
  const bytes = new Uint8Array(length).fill(marker);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
  bytes.set([0xff, 0xd9], length - 2);
  return bytes;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Events {
  listeners = new Map();
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  fire(type, event) { for (const callback of this.listeners.get(type) || []) callback(event); }
}
class Device extends Events {
  vendorId = KEYPAD_VENDOR_ID;
  productId = KEYPAD_PRODUCT_ID;
  productName = 'MX Creative Keypad';
  collections = [{ outputReports: [{ reportId: 0x14 }], inputReports: [{ reportId: 0x13 }] }];
  opened = false;
  opens = 0;
  closes = 0;
  reports = [];
  send = null;
  autoAck = true;
  async open() { this.opens++; this.opened = true; }
  async close() { this.closes++; this.opened = false; }
  async sendReport(reportId, data) {
    this.reports.push({ reportId, data: new Uint8Array(data).slice() });
    if (this.send) await this.send(reportId, data);
    if (reportId === 0x14 && (data[3] & 0x40) && this.autoAck) this.ack(data[3] & ~0x20);
  }
  ack(part, statusHi = 0, statusLo = 1, {prefix = [0xff, 2, 0x2b], reportId = 0x13} = {}) {
    this.fire('inputreport', {reportId, data: new DataView(Uint8Array.from([...prefix, part, statusHi, statusLo]).buffer)});
  }
  keys(values) { this.fire('inputreport', { reportId: 0x13, data: new DataView(Uint8Array.from([0xff, 2, 0, 0, 0, ...values, 0]).buffer) }); }
}
class Hid extends Events {
  constructor(devices = []) { super(); this.devices = devices; this.requests = []; this.scans = 0; }
  async getDevices() { this.scans++; return this.devices; }
  requestDevice(options) { this.requests.push(options); return Promise.resolve(this.devices); }
}
function fakeCanvas() {
  const canvas = { width: 118, height: 118, marker: 0, draws: [] };
  const context = { fillRect() { canvas.marker = 0; }, drawImage(source, ...coordinates) { canvas.marker = source.marker; canvas.draws.push({ marker: source.marker, coordinates }); } };
  canvas.getContext = () => context;
  return canvas;
}
const fakeEncoder = async captured => ({ imageFormat: 0, imageData: captured.bytes || jpeg(128, captured.canvas.marker, captured.width, captured.height) });
function boardCanvases(marker = 10) {
  return Array.from({length: 9}, (_, index) => Object.assign(fakeCanvas(), {marker: marker + index}));
}
async function connected(t, options = {}) {
  const device = new Device();
  const hid = new Hid([device]);
  let now = 0;
  const controller = createKeypadController({ hid, secureContext: true, clock: () => now, delay: async milliseconds => {now += milliseconds;}, ...options });
  t.after(() => controller.destroy());
  await controller.detect();
  return { device, hid, controller };
}
function locationOf(report) {
  const view = new DataView(report.data.buffer, report.data.byteOffset, report.data.byteLength);
  return { x: view.getUint16(8), y: view.getUint16(10), w: view.getUint16(12), h: view.getUint16(14) };
}

test('key locations match the physical LCD offsets and gaps', () => {
  assert.deepEqual(KEYPAD_LAYOUT[0], { x: 23, y: 6, w: 118, h: 118 });
  assert.deepEqual(KEYPAD_LAYOUT[4], { x: 181, y: 164, w: 118, h: 118 });
  assert.deepEqual(KEYPAD_LAYOUT[8], { x: 339, y: 322, w: 118, h: 118 });
  assert.throws(() => buildKeyImagePackets(9, jpeg()), /0 to 8/);
});

test('a single image report uses the upstream first/last header and big-endian fields', () => {
  const source = jpeg();
  const [packet] = buildKeyImagePackets(4, source);
  assert.equal(packet.length, 4095);
  assert.deepEqual([...packet.subarray(0, 9)], [0x14, 0xff, 0x02, 0x2b, 0xe1, 1, 0, 1, 0]);
  const view = new DataView(packet.buffer);
  assert.equal(view.getUint16(9), 181);
  assert.equal(view.getUint16(11), 164);
  assert.equal(view.getUint16(13), 118);
  assert.equal(view.getUint16(15), 118);
  assert.equal(view.getUint16(18), source.length);
  assert.deepEqual(packet.subarray(20, 20 + source.length), source);
  assert.equal(packet[20 + source.length], 0);
});

test('chunk boundaries preserve all bytes without inserting report IDs into payloads', () => {
  const bytes = Uint8Array.from({ length: 10000 }, (_, index) => index % 251);
  const packets = buildKeyImagePackets(0, bytes);
  assert.equal(packets.length, 3);
  assert.deepEqual(packets.map(packet => packet[4]), [0xa1, 0x22, 0x63]);
  const reconstructed = new Uint8Array(10000);
  reconstructed.set(packets[0].subarray(20), 0);
  reconstructed.set(packets[1].subarray(5), 4075);
  reconstructed.set(packets[2].subarray(5, 5 + 1835), 8165);
  assert.deepEqual(reconstructed, bytes);
  assert.equal(buildKeyImagePackets(0, bytes.subarray(0, 4075)).length, 1);
  assert.equal(buildKeyImagePackets(0, bytes.subarray(0, 4076)).length, 2);
});

test('24-bit length and sequence wrap are encoded, with no fabricated checksum', () => {
  const packets = buildKeyImagePackets(8, new Uint8Array(70000), { deferDisplayUpdate: true });
  assert.equal(packets[0][6], 1);
  assert.deepEqual([...packets[0].subarray(17, 20)], [1, 0x11, 0x70]);
  assert.equal(packets[15][4], 0x20);
  assert.equal(packets[16][4], 0x21);
  assert.equal(packets.at(-1)[4], 0x62);
  assert.throws(() => buildKeyImagePackets(0, new Uint8Array(MAX_IMAGE_BYTES + 1)), /payload length/);
});

test('input decoding honors DataView offsets and distinguishes release from unrelated messages', () => {
  const bytes = Uint8Array.from([99, 99, 0xff, 2, 0, 0, 0, 1, 9, 9, 0xa1, 0, 88]);
  assert.deepEqual(parseKeypadInput(0x13, new DataView(bytes.buffer, 2, 10)), [0, 8]);
  assert.deepEqual(parseKeypadInput(0x13, new DataView(Uint8Array.from([255, 2, 0, 0, 0, 0]).buffer)), []);
  assert.equal(parseKeypadInput(0x11, new DataView(bytes.buffer)), null);
  assert.equal(parseKeypadInput(0x13, new DataView(new Uint8Array(3).buffer)), null);
  assert.equal(parseKeypadInput(0x13, new DataView(new Uint8Array(10).buffer)), null);
});

test('JPEG dimensions and invalid payloads are checked before writes', async t => {
  assert.deepEqual(jpegDimensions(jpeg()), { width: 118, height: 118 });
  assert.throws(() => jpegDimensions(new Uint8Array(20)), /not a JPEG/);
  assert.throws(() => jpegDimensions(jpeg().subarray(0, 7)), /Truncated/);
  const { controller, device } = await connected(t);
  await assert.rejects(controller.setKeyImage(0, jpeg(128, 1, 100, 118)), /118/);
  await assert.rejects(controller.setKeyImage(-1, jpeg()), /0 to 8/);
  assert.equal(device.reports.length, 0);
});

test('detect reconnects only an authorized exact keypad display interface', async t => {
  const unrelated = new Device(); unrelated.productId = 0xbc00;
  const device = new Device();
  device.collections = [{ children: [{ outputReports: [{ reportId: 0x14 }] }] }];
  const hid = new Hid([unrelated, device]);
  const controller = createKeypadController({ hid, secureContext: true });
  t.after(() => controller.destroy());
  assert.equal(device.opens, 0);
  const state = await controller.detect();
  assert.equal(state.connected, true);
  assert.equal(state.authorizedCount, 1);
  assert.equal(device.opens, 1);
  assert.equal(unrelated.opens, 0);
  assert.equal(hid.requests.length, 0);
  assert.equal(device.reports.length, 0);
});

test('connect invokes the exact device picker synchronously before any await', async t => {
  const hid = new Hid([new Device()]);
  const controller = createKeypadController({ hid, secureContext: true });
  t.after(() => controller.destroy());
  const pending = controller.connect();
  assert.deepEqual(hid.requests, [{ filters: [{ vendorId: 0x046d, productId: 0xc354 }] }]);
  assert.equal(hid.scans, 0);
  assert.equal((await pending).connected, true);
});

test('unpaired and unsupported states do not imply physical device absence or success', async () => {
  const controller = createKeypadController({ hid: new Hid(), secureContext: true });
  assert.equal((await controller.detect()).status, 'unpaired');
  assert.equal(controller.getState().connected, false);
  assert.match(controller.getState().message, /authorized/);
  await assert.rejects(controller.setKeyImage(0, jpeg()), /Connect/);
  await controller.destroy();
  const insecure = createKeypadController({ hid: new Hid(), secureContext: false });
  await assert.rejects(insecure.connect(), /HTTPS/);
  const absent = createKeypadController({ hid: null, secureContext: true });
  await assert.rejects(absent.detect(), /Chrome/);
  await insecure.destroy(); await absent.destroy();
});

test('known page policy denial blocks detection, picker and reconnect without touching HID', async t => {
  const device = new Device(), hid = new Hid([device]), states = [];
  const controller = createKeypadController({hid, secureContext: true, policyAllowed: false, embedded: true, onStatus: state => states.push(state)});
  t.after(() => controller.destroy());
  const initial = controller.getState();
  assert.equal(initial.supported, true, 'API presence is distinct from permission to use it');
  assert.equal(initial.available, false);
  assert.equal(initial.policyAllowed, false);
  assert.equal(initial.embedded, true);
  assert.equal(initial.status, 'policy-blocked');
  assert.match(initial.message, /own desktop Chrome or Edge tab/);
  await assert.rejects(controller.detect(), /Permissions Policy/);
  await assert.rejects(controller.connect(), /Permissions Policy/);
  hid.fire('connect', {device});
  await Promise.resolve();
  assert.equal(hid.scans, 0);
  assert.equal(hid.requests.length, 0);
  assert.equal(device.opens, 0);
  assert.equal(states.length, 1, 'Blocked retries do not emit repeated status updates');
  await controller.disconnect();
  assert.equal(controller.getState().status, 'policy-blocked');
  assert.equal(controller.getState().connected, false);
});

test('policy denial remains distinct when the browser hides its HID API', async t => {
  const controller = createKeypadController({hid: null, secureContext: true, policyAllowed: false, embedded: false});
  t.after(() => controller.destroy());
  assert.equal(controller.getState().supported, false);
  assert.equal(controller.getState().status, 'policy-blocked');
  assert.match(controller.getState().message, /localhost app/);
  assert.doesNotMatch(controller.getState().message, /own.*tab/);
  await assert.rejects(controller.connect(), /Permissions Policy/);
});

test('insecure and unsupported browsers give different capability reasons before any HID call', async t => {
  const hid = new Hid([new Device()]);
  const insecure = createKeypadController({hid, secureContext: false, policyAllowed: null});
  const unsupported = createKeypadController({hid: null, secureContext: true, policyAllowed: null});
  t.after(() => Promise.all([insecure.destroy(), unsupported.destroy()]));
  assert.equal(insecure.getState().status, 'insecure');
  assert.equal(insecure.getState().available, false);
  await assert.rejects(insecure.detect(), /HTTPS or localhost/);
  assert.equal(unsupported.getState().status, 'unsupported');
  assert.equal(unsupported.getState().available, false);
  await assert.rejects(unsupported.connect(), /desktop Chrome or Edge/);
  assert.equal(hid.scans, 0);
  assert.equal(hid.requests.length, 0);
});

test('unknown policy allows a real detection attempt, then latches actual getDevices SecurityError', async t => {
  const device = new Device(), hid = new Hid([device]), states = [];
  hid.getDevices = async () => {hid.scans++; throw new DOMException('Access is denied.', 'SecurityError');};
  const controller = createKeypadController({hid, secureContext: true, policyAllowed: null, embedded: true, onStatus: state => states.push(state)});
  t.after(() => controller.destroy());
  assert.equal(controller.getState().available, true);
  await assert.rejects(controller.detect(), /browser blocked WebHID/);
  const state = controller.getState();
  assert.equal(state.status, 'policy-blocked');
  assert.equal(state.policyAllowed, null, 'Do not manufacture an introspection result');
  assert.equal(state.available, false);
  assert.equal(state.connected, false);
  assert.equal(state.authorizedCount, 0);
  await assert.rejects(controller.detect(), /browser blocked WebHID/);
  await assert.rejects(controller.connect(), /browser blocked WebHID/);
  hid.fire('connect', {device});
  await Promise.resolve();
  assert.equal(hid.scans, 1);
  assert.equal(hid.requests.length, 0);
  assert.equal(device.opens, 0);
  assert.equal(states.filter(item => item.status === 'policy-blocked').length, 1);
});

test('actual chooser policy rejection overrides optimistic introspection and never opens a device', async t => {
  for (const synchronous of [true, false]) {
    const device = new Device(), hid = new Hid([device]);
    hid.requestDevice = options => {
      hid.requests.push(options);
      const error = new DOMException('Access to the feature "hid" is disallowed by permissions policy.', 'SecurityError');
      if (synchronous) throw error;
      return Promise.reject(error);
    };
    const controller = createKeypadController({hid, secureContext: true, policyAllowed: true});
    t.after(() => controller.destroy());
    const connecting = controller.connect();
    assert.equal(hid.requests.length, 1, 'The picker is still invoked directly in the click');
    await assert.rejects(connecting, /Permissions Policy/);
    assert.equal(controller.getState().status, 'policy-blocked');
    assert.equal(controller.getState().available, false);
    assert.equal(controller.getState().connected, false);
    await assert.rejects(controller.connect(), /Permissions Policy/);
    assert.equal(hid.requests.length, 1);
    assert.equal(device.opens, 0);
  }
});

test('a raw chooser SecurityError has a blocked-page fallback when policy introspection is unavailable', async t => {
  const hid = new Hid();
  hid.requestDevice = options => {hid.requests.push(options); return Promise.reject(new DOMException('Access is denied.', 'SecurityError'));};
  const controller = createKeypadController({hid, secureContext: true, policyAllowed: null});
  t.after(() => controller.destroy());
  await assert.rejects(controller.connect(), /browser blocked WebHID/);
  assert.equal(controller.getState().status, 'policy-blocked');
  assert.equal(controller.getState().available, false);
  await assert.rejects(controller.connect(), /browser blocked WebHID/);
  assert.equal(hid.requests.length, 1);
});

test('missing user activation stays retryable instead of being mislabeled as page policy', async t => {
  for (const synchronous of [true, false]) {
    const device = new Device(), hid = new Hid([device]);
    hid.requestDevice = options => {
      hid.requests.push(options);
      if (hid.requests.length > 1) return Promise.resolve([device]);
      const error = new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
      if (synchronous) throw error;
      return Promise.reject(error);
    };
    const controller = createKeypadController({hid, secureContext: true, policyAllowed: null});
    t.after(() => controller.destroy());
    await assert.rejects(controller.connect(), /Click Connect keypad directly/);
    assert.equal(controller.getState().status, 'error');
    assert.equal(controller.getState().available, true);
    assert.equal((await controller.connect()).connected, true);
    assert.equal(hid.requests.length, 2);
    assert.equal(device.opens, 1);
  }
});

test('picker cancellation and permission refusal never become policy denial or device detection', async t => {
  const hid = new Hid();
  const controller = createKeypadController({hid, secureContext: true, policyAllowed: null});
  t.after(() => controller.destroy());
  const cancelled = await controller.connect();
  assert.equal(cancelled.status, 'unpaired');
  assert.equal(cancelled.available, true);
  assert.equal(cancelled.connected, false);
  hid.requestDevice = () => Promise.reject(new DOMException('The user declined access.', 'NotAllowedError'));
  await assert.rejects(controller.connect(), /user declined/);
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().available, true);
  assert.equal(controller.getState().connected, false);
});

test('a cancelled detection cannot apply a late policy failure to the current controller state', async t => {
  const hid = new Hid(), pending = deferred();
  hid.getDevices = () => {hid.scans++; return pending.promise;};
  const controller = createKeypadController({hid, secureContext: true, policyAllowed: null});
  t.after(() => controller.destroy());
  const detecting = controller.detect();
  const rejected = assert.rejects(detecting, /Access is denied/);
  await controller.disconnect();
  pending.reject(new DOMException('Access is denied.', 'SecurityError'));
  await rejected;
  assert.equal(controller.getState().status, 'disconnected');
  assert.equal(controller.getState().available, true);
  assert.equal(controller.getState().connected, false);
});

test('button callbacks fire only on actual pressed/released transitions', async t => {
  const events = [];
  const { controller, device } = await connected(t, { onKey: event => events.push(event) });
  device.keys([1, 5]); device.keys([1, 5]); device.keys([5]); device.keys([]);
  assert.deepEqual(events.map(({ index, pressed }) => ({ index, pressed })), [
    { index: 0, pressed: true }, { index: 4, pressed: true }, { index: 0, pressed: false }, { index: 4, pressed: false }
  ]);
  await controller.disconnect();
  device.keys([9]);
  assert.equal(events.length, 4);
});

test('controller sends full upstream chunks sequentially and reports final image acceptance', async t => {
  const { controller, device } = await connected(t);
  const result = await controller.setKeyImage(8, jpeg(9000));
  assert.equal(result.status, 'sent');
  assert.equal(result.displayAcknowledged, true);
  assert.equal(result.deviceAccepted, true);
  assert.equal(result.displayReadback, false);
  assert.equal(device.reports.length, 3);
  assert.ok(device.reports.every(report => report.reportId === 0x14 && report.data.length === 4094));
  assert.deepEqual(locationOf(device.reports[0]), KEYPAD_LAYOUT[8]);
  assert.deepEqual(device.reports.map(report => report.data[3]), [0xa1, 0x22, 0x63]);
  assert.equal(controller.getState().sentImages, 1);
});

test('latest pending image wins while the queue remains fair across hot keys', async t => {
  const { controller, device } = await connected(t);
  const entered = deferred(), release = deferred();
  device.send = async () => { if (device.reports.length === 1) { entered.resolve(); await release.promise; } };
  const first = controller.setKeyImage(0, jpeg(128, 10));
  await entered.promise;
  const oldOne = controller.setKeyImage(1, jpeg(128, 11));
  const two = controller.setKeyImage(2, jpeg(128, 12));
  const newOne = controller.setKeyImage(1, jpeg(128, 13));
  const newZero = controller.setKeyImage(0, jpeg(128, 14));
  assert.deepEqual(controller.getState().pendingKeys, [1, 2, 0]);
  assert.equal((await oldOne).status, 'superseded');
  release.resolve();
  assert.ok((await Promise.all([first, two, newOne, newZero])).every(result => result.status === 'sent'));
  assert.deepEqual(device.reports.map(report => locationOf(report).x), [23, 181, 339, 23]);
  assert.deepEqual(device.reports.map(report => report.data[34]), [10, 13, 12, 14]);
});

test('superseded encoding is dropped before sending any packet', async t => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const { controller, device } = await connected(t, { encode: async captured => {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    return { imageFormat: 0, imageData: captured.bytes };
  } });
  const old = controller.setKeyImage(0, jpeg(128, 40));
  await entered.promise;
  const latest = controller.setKeyImage(0, jpeg(128, 41));
  release.resolve();
  assert.equal((await old).status, 'superseded');
  assert.equal((await latest).status, 'sent');
  assert.equal(device.reports.length, 1);
  assert.equal(device.reports[0].data[34], 41);
});

test('a queued canvas is captured immediately so later drawing cannot change its image', async t => {
  const entered = deferred(), release = deferred();
  const { controller, device } = await connected(t, {
    canvasFactory: fakeCanvas,
    encode: async captured => { entered.resolve(); await release.promise; return fakeEncoder(captured); }
  });
  const source = fakeCanvas();
  source.marker = 72;
  const sending = controller.setKeyImage(0, source);
  await entered.promise;
  source.marker = 99;
  release.resolve();
  assert.equal((await sending).status, 'sent');
  assert.equal(device.reports[0].data[34], 72);
});

test('clear waits behind an in-flight frame and replaces stale queued footage', async t => {
  const { controller, device } = await connected(t, { canvasFactory: fakeCanvas, encode: fakeEncoder });
  const entered = deferred(), release = deferred();
  device.send = async () => { if (device.reports.length === 1) { entered.resolve(); await release.promise; } };
  const first = controller.setKeyImage(0, jpeg(128, 60));
  await entered.promise;
  const stale = controller.setKeyImage(1, jpeg(128, 61));
  const clearOne = controller.clearKey(1);
  const clearZero = controller.clearKey(0);
  assert.equal((await stale).status, 'superseded');
  release.resolve();
  await Promise.all([first, clearOne, clearZero]);
  assert.deepEqual(device.reports.map(report => report.data[34]), [60, 0, 0]);
  assert.deepEqual(controller.getState().pendingKeys, []);
});

test('clearAll sends one neutral full-board image and retains nine result entries', async t => {
  const { controller, device } = await connected(t, { canvasFactory: fakeCanvas, encode: fakeEncoder });
  const results = await controller.clearAll();
  assert.equal(results.length, 9);
  assert.ok(results.every(result => result.status === 'sent'));
  assert.deepEqual(device.reports.map(locationOf), [{x: 0, y: 0, w: DISPLAY_WIDTH, h: DISPLAY_HEIGHT}]);
  assert.ok(device.reports.every(report => report.data[34] === 0));
});

test('shared rate limiter allows at most ten image starts per second', async t => {
  let now = 0;
  const waits = [];
  const { controller } = await connected(t, { clock: () => now, delay: async milliseconds => { waits.push(milliseconds); now += milliseconds; } });
  await Promise.all([0, 1, 2, 3].map(index => controller.setKeyImage(index, jpeg())));
  assert.deepEqual(waits, [100, 100, 100]);
  assert.equal(controller.getState().maxUpdatesPerSecond, 10);
});

test('setKeyImages snapshots nine physical tile positions and sends one full-display JPEG command', async t => {
  const entered = deferred(), release = deferred();
  let snapshot;
  const payload = jpeg(9000, 77, DISPLAY_WIDTH, DISPLAY_HEIGHT);
  let now = 10;
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, clock: () => now,
    encode: async captured => {snapshot = captured; entered.resolve(); await release.promise; return {imageFormat: 0, imageData: payload};}});
  device.send = async () => {now += 5;};
  const sources = boardCanvases(30);
  const sending = controller.setKeyImages(sources);
  sources.forEach(source => {source.marker = 99;});
  await entered.promise;
  assert.equal(controller.getState().uploadingBoard, true);
  assert.equal(controller.getState().uploadingKey, null);
  assert.equal(snapshot.canvas.width, 457);
  assert.equal(snapshot.canvas.height, 440);
  assert.deepEqual(snapshot.canvas.draws, KEYPAD_LAYOUT.map(({x, y, w, h}, index) => ({marker: 30 + index, coordinates: [x, y, w, h]})));
  release.resolve();
  const result = await sending;
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.indices, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.displayAcknowledged, true);
  assert.equal(result.deviceAccepted, true);
  assert.equal(result.bytes, 9000);
  assert.equal(result.durationMs, 15);
  assert.equal(device.reports.length, 3);
  assert(device.reports.every(report => report.reportId === 0x14));
  assert.deepEqual(device.reports.map(report => report.data[3]), [0xa1, 0x22, 0x63]);
  assert.deepEqual(locationOf(device.reports[0]), {x: 0, y: 0, w: 457, h: 440});
  assert.deepEqual([...device.reports[0].data.subarray(4, 8)], [1, 0, 1, 0], 'One image descriptor, immediate full-image display update');
  const reconstructed = new Uint8Array(9000);
  reconstructed.set(device.reports[0].data.subarray(19), 0);
  reconstructed.set(device.reports[1].data.subarray(4), 4075);
  reconstructed.set(device.reports[2].data.subarray(4, 4 + 835), 8165);
  assert.deepEqual(reconstructed, payload);
  assert.equal(controller.getState().sentImages, 1);
  assert.equal(controller.getState().lastSendBytes, 9000);
  assert.equal(controller.getState().lastSendDurationMs, 15);
  assert.equal(controller.getState().uploadingBoard, false);
});

test('two full boards consume two paced frame starts instead of eighteen key starts', async t => {
  let now = 0;
  const waits = [];
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: fakeEncoder,
    clock: () => now, delay: async milliseconds => {waits.push(milliseconds); now += milliseconds;}});
  await controller.setKeyImages(boardCanvases());
  await controller.setKeyImages(boardCanvases(20));
  assert.deepEqual(waits, [150]);
  assert.equal(device.reports.length, 2);
  assert.equal(controller.getState().sentImages, 2);
});

test('a full-board generation supersedes old key work while newer live tiles queue behind it', async t => {
  const entered = deferred(), release = deferred();
  let first = true;
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: async captured => {
    if (first) {first = false; entered.resolve(); await release.promise;}
    return fakeEncoder(captured);
  }});
  const oldEncoding = controller.setKeyImage(0, jpeg(128, 10));
  await entered.promise;
  const oldQueued = controller.setKeyImage(1, jpeg(128, 11));
  const oldBoard = controller.setKeyImages(boardCanvases(20));
  const latestBoard = controller.setKeyImages(boardCanvases(40));
  const liveTile = controller.setKeyImage(0, jpeg(128, 80));
  assert.equal(controller.getState().pendingBoard, true);
  assert.equal((await oldQueued).status, 'superseded');
  assert.equal((await oldBoard).status, 'superseded');
  assert.equal((await deadline(oldEncoding, 'Superseded key encoding did not cancel')).status, 'superseded');
  assert.equal((await deadline(latestBoard, 'New live tiles starved the board')).status, 'sent');
  assert.equal((await liveTile).status, 'sent');
  assert.deepEqual(device.reports.map(locationOf), [{x: 0, y: 0, w: 457, h: 440}, KEYPAD_LAYOUT[0]]);
  assert.deepEqual(device.reports.map(report => report.data[34]), [48, 80]);
  release.resolve();
  await Promise.resolve();
  assert.equal(device.reports.length, 2, 'Late obsolete encoding cannot write after the new mode');
});

test('a newer full board cancels older board encoding without waiting for its encoder', async t => {
  const entered = deferred(), release = deferred();
  let first = true;
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: async captured => {
    if (first) {first = false; entered.resolve(); await release.promise;}
    return fakeEncoder(captured);
  }});
  const oldBoard = controller.setKeyImages(boardCanvases(10));
  await entered.promise;
  const newBoard = controller.setKeyImages(boardCanvases(50));
  assert.equal((await deadline(oldBoard, 'Old board encoding did not cancel')).status, 'superseded');
  assert.equal((await deadline(newBoard, 'New board was held by stale encoding')).status, 'sent');
  assert.equal(device.reports.length, 1);
  assert.equal(device.reports[0].data[34], 58);
  release.resolve();
});

test('a board queued during throttle waiting takes priority over stale tiles and precedes newer live tiles', async t => {
  let now = 0, firstWait = true;
  const waits = [], entered = deferred(), release = deferred();
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: fakeEncoder,
    clock: () => now, delay: async milliseconds => {
      waits.push(milliseconds);
      if (firstWait) {firstWait = false; entered.resolve(); await release.promise;}
      now += milliseconds;
    }});
  await controller.setKeyImage(0, jpeg(128, 10));
  const stale = controller.setKeyImage(1, jpeg(128, 20));
  await entered.promise;
  const board = controller.setKeyImages(boardCanvases(30));
  const live = controller.setKeyImage(8, jpeg(128, 80));
  assert.equal((await stale).status, 'superseded');
  assert.equal(controller.getState().pendingBoard, true);
  release.resolve();
  assert.equal((await board).status, 'sent');
  assert.equal((await live).status, 'sent');
  assert.deepEqual(device.reports.map(locationOf), [KEYPAD_LAYOUT[0], {x: 0, y: 0, w: 457, h: 440}, KEYPAD_LAYOUT[8]]);
  assert.deepEqual(device.reports.map(report => report.data[34]), [10, 38, 80]);
  assert.deepEqual(waits, [100, 50, 100]);
});

test('an in-flight tile completes before the board and later live tile, with no VLP interleaving', async t => {
  const entered = deferred(), release = deferred();
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: async captured => ({imageFormat: 0,
    imageData: captured.bytes || jpeg(9000, captured.canvas.marker, captured.width, captured.height)})});
  device.send = async () => {if (device.reports.length === 1) {entered.resolve(); await release.promise;}};
  const first = controller.setKeyImage(1, jpeg(9000, 10));
  await entered.promise;
  const board = controller.setKeyImages(boardCanvases(30));
  const latest = controller.setKeyImage(8, jpeg(9000, 70));
  release.resolve();
  const results = await Promise.all([first, board, latest]);
  assert(results.every(result => result.status === 'sent'));
  assert.equal(device.reports.length, 9);
  assert.deepEqual(device.reports.map(report => report.data[3]), [0xa1, 0x22, 0x63, 0xa1, 0x22, 0x63, 0xa1, 0x22, 0x63]);
  assert.deepEqual([0, 3, 6].map(index => locationOf(device.reports[index])), [KEYPAD_LAYOUT[1], {x: 0, y: 0, w: 457, h: 440}, KEYPAD_LAYOUT[8]]);
});

test('a live tile enqueued by the board status callback cannot start a second packet stream', async t => {
  const entered = deferred(), release = deferred();
  let activeController, live, queued = false;
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas,
    onStatus: state => {
      if (state.uploadingBoard && !queued) {
        queued = true;
        live = activeController.setKeyImage(8, jpeg(9000, 80));
      }
    },
    encode: async captured => ({imageFormat: 0, imageData: captured.bytes || jpeg(9000, 40, captured.width, captured.height)})});
  activeController = controller;
  device.send = async () => {if (device.reports.length === 1) {entered.resolve(); await release.promise;}};
  const board = controller.setKeyImages(boardCanvases());
  await entered.promise;
  release.resolve();
  const results = await Promise.all([board, live]);
  assert(results.every(result => result.status === 'sent'));
  assert.deepEqual(device.reports.map(report => report.data[3]), [0xa1, 0x22, 0x63, 0xa1, 0x22, 0x63]);
  assert.deepEqual([0, 3].map(index => locationOf(device.reports[index])), [{x: 0, y: 0, w: 457, h: 440}, KEYPAD_LAYOUT[8]]);
});

test('batch input and JPEG dimensions are validated before any hardware write', async t => {
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas,
    encode: async () => ({imageFormat: 0, imageData: jpeg(128, 1, 118, 118)})});
  await assert.rejects(controller.setKeyImages(boardCanvases().slice(0, 8)), /exactly nine/);
  const invalid = boardCanvases(); invalid[4] = jpeg();
  await assert.rejects(controller.setKeyImages(invalid), /canvas/);
  await assert.rejects(controller.setKeyImages(boardCanvases()), /457 × 440/);
  assert.equal(device.reports.length, 0);
  assert.equal(controller.getState().connected, true);
  assert.equal(controller.getState().sentImages, 0);
});

test('full-board JPEG encoding never falls back to an oversized RGB payload', async t => {
  let encodes = 0, pixelReads = 0;
  const canvasFactory = () => {
    const canvas = fakeCanvas();
    canvas.convertToBlob = async () => {encodes++; return new Blob([new Uint8Array(10)], {type: 'image/png'});};
    canvas.getContext().getImageData = () => {pixelReads++; throw new Error('Oversized RGB read must not happen');};
    return canvas;
  };
  const {controller, device} = await connected(t, {canvasFactory});
  await assert.rejects(controller.setKeyImages(boardCanvases()), /JPEG within the 61335-byte/);
  assert.equal(encodes, 8);
  assert.equal(pixelReads, 0);
  assert.equal(device.reports.length, 0);
  assert.equal(controller.getState().connected, true);
});

test('disconnect cancels board encoding and pending live tiles without waiting for encoding', async t => {
  const entered = deferred(), release = deferred();
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: async captured => {
    entered.resolve(); await release.promise; return fakeEncoder(captured);
  }});
  const board = controller.setKeyImages(boardCanvases());
  await entered.promise;
  const live = controller.setKeyImage(1, jpeg());
  const settled = Promise.allSettled([board, live]);
  await controller.disconnect();
  const results = await deadline(settled, 'Disconnect left a board promise pending');
  assert(results.every(result => result.status === 'rejected'));
  assert.equal(device.reports.length, 0);
  release.resolve();
  await Promise.resolve();
  assert.equal(device.reports.length, 0);
});

test('unplug during a full-board image rejects pending boards and stops continuation packets', async t => {
  const entered = deferred(), release = deferred();
  const {controller, device, hid} = await connected(t, {canvasFactory: fakeCanvas,
    encode: async captured => ({imageFormat: 0, imageData: jpeg(9000, captured.canvas?.marker || 10, captured.width, captured.height)})});
  device.send = async () => {entered.resolve(); await release.promise;};
  const board = controller.setKeyImages(boardCanvases());
  await entered.promise;
  const pending = controller.setKeyImages(boardCanvases(50));
  const results = Promise.allSettled([board, pending]);
  hid.fire('disconnect', {device});
  release.resolve();
  assert((await results).every(result => result.status === 'rejected'));
  assert.equal(device.reports.length, 1);
  assert.equal(controller.getState().sentImages, 0);
  assert.equal(controller.getState().pendingBoard, false);
});

test('a timed-out board upload rejects all queued work without claiming a completed frame', async t => {
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: fakeEncoder, reportTimeoutMs: 20});
  device.send = () => new Promise(() => {});
  const board = controller.setKeyImages(boardCanvases());
  const tile = controller.setKeyImage(0, jpeg());
  const results = await Promise.allSettled([board, tile]);
  assert(results.every(result => result.status === 'rejected'));
  assert.equal(controller.getState().connected, false);
  assert.equal(controller.getState().sentImages, 0);
  assert.equal(controller.getState().lastSendBytes, null);
  assert.equal(controller.getState().lastSentAt, null);
});

test('write failure rejects every queued job and never records a successful image', async t => {
  const { controller, device } = await connected(t);
  device.send = async () => { throw new Error('USB transfer refused'); };
  const results = await Promise.allSettled([controller.setKeyImage(0, jpeg()), controller.setKeyImage(1, jpeg())]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(controller.getState().connected, false);
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().sentImages, 0);
  assert.equal(controller.getState().lastSentAt, null);
  assert.match(controller.getState().error, /USB transfer refused/);
});

test('an unresponsive sendReport times out and closes the connection', async t => {
  const { controller, device } = await connected(t, { reportTimeoutMs: 20 });
  device.send = () => new Promise(() => {});
  await assert.rejects(controller.setKeyImage(0, jpeg()), /timed out/);
  assert.equal(controller.getState().connected, false);
  assert.equal(controller.getState().sentImages, 0);
});

test('unplugging cancels pending images and prevents continuation packets', async t => {
  const { controller, device, hid } = await connected(t);
  const entered = deferred(), release = deferred();
  device.send = async () => { entered.resolve(); await release.promise; };
  const inFlight = controller.setKeyImage(0, jpeg(9000));
  const queued = controller.setKeyImage(1, jpeg());
  const done = Promise.allSettled([inFlight, queued]);
  await entered.promise;
  hid.fire('disconnect', { device });
  release.resolve();
  const outcomes = await done;
  assert.ok(outcomes.every(result => result.status === 'rejected'));
  assert.equal(device.reports.length, 1);
  assert.equal(controller.getState().connected, false);
});

test('a late device open is closed after the user cancels the connection', async () => {
  const device = new Device(), entered = deferred(), release = deferred();
  device.open = async () => { entered.resolve(); await release.promise; device.opened = true; };
  const controller = createKeypadController({ hid: new Hid([device]), secureContext: true });
  const detecting = controller.detect();
  const rejected = assert.rejects(detecting, /cancelled/);
  await entered.promise;
  await controller.disconnect();
  release.resolve();
  await rejected;
  assert.equal(device.opened, false);
  assert.equal(controller.getState().connected, false);
  assert.ok(device.closes > 0);
  await controller.destroy();
});

// Optional HID++ 0x1B04 support. This mock speaks the actual 19-byte 0x11
// request/reply envelope, independently from the contextual-display reports.
const optionalControls = () => [
  {id: 1, task: 0x1001, reporting: 0x10, remap: 0x0123, reporting2: 0x04},
  {id: 5, task: 0x1005, reporting: 0x01, remap: 0x0042, reporting2: 0x08},
  {id: 9, task: 0x1009, reporting: 0x00, remap: 0x0067, reporting2: 0x03},
  {id: 0x01a1, task: 0x2001, reporting: 0x10, remap: 0x01a1, reporting2: 0x00},
  {id: 0x01a2, task: 0x2002, reporting: 0x01, remap: 0x0042, reporting2: 0x08},
  {id: 0x0053, task: 0x2053, reporting: 0x00, remap: 0x0056, reporting2: 0x04}
];
class FeatureDevice extends Device {
  collections = [{outputReports: [{reportId: 0x14}, {reportId: 0x11}], inputReports: [{reportId: 0x13}, {reportId: 0x11}]}];
  constructor({featureIndex = 7, silentDiscovery = false, dropFirstSetFor = null, controls = optionalControls(), brightness = 70, minBrightness = 0, maxBrightness = 100, brightnessFeatureIndex = 8} = {}) {
    super();
    this.featureIndex = featureIndex;
    this.silentDiscovery = silentDiscovery;
    this.dropFirstSetFor = dropFirstSetFor;
    this.droppedFirstSet = false;
    this.brightness = brightness;
    this.minBrightness = minBrightness;
    this.maxBrightness = maxBrightness;
    this.brightnessFeatureIndex = brightnessFeatureIndex;
    this.brightnessWrites = [];
    this.controls = controls.map(control => ({...control}));
    this.initialControls = this.controls.map(control => ({...control}));
    this.commands = [];
    this.writes = [];
    this.trace = [];
    this.send = async (reportId, payload) => {
      if (reportId !== 0x11) return;
      const bytes = new Uint8Array(payload);
      assert.equal(bytes.length, 19);
      assert.equal(bytes[0], 0xff);
      const feature = bytes[1], fn = bytes[2] >> 4, softwareId = bytes[2] & 15;
      assert.notEqual(softwareId, 0, 'Requests need a nonzero software ID so replies are not button events');
      const parameters = [...bytes.subarray(3)];
      this.commands.push({feature, fn, softwareId, parameters});
      let response;
      if (feature === 0 && fn === 0) {
        if (parameters[0] === 0x80 && parameters[1] === 0x40) response = [this.brightnessFeatureIndex, 0, 0];
        else {
          assert.deepEqual(parameters.slice(0, 3), [0x1b, 0x04, 0]);
          if (this.silentDiscovery) return;
          response = [this.featureIndex, 0, 0];
        }
      } else if (feature === this.brightnessFeatureIndex && fn === 0) {
        response = [this.maxBrightness >> 8, this.maxBrightness & 255, 101, 0x10, this.minBrightness >> 8, this.minBrightness & 255, 0];
      } else if (feature === this.brightnessFeatureIndex && fn === 1) {
        response = [this.brightness >> 8, this.brightness & 255];
      } else if (feature === this.brightnessFeatureIndex && fn === 2) {
        this.brightness = (parameters[0] << 8) | parameters[1];
        this.brightnessWrites.push(this.brightness);
        response = [];
      } else if (feature === this.featureIndex && fn === 0) {
        response = [this.controls.length];
      } else if (feature === this.featureIndex && fn === 1) {
        const control = this.controls[parameters[0]];
        assert(control, 'Control discovery uses an advertised control index');
        response = [control.id >> 8, control.id & 255, control.task >> 8, control.task & 255,
          0x20, parameters[0], 0, 0, 0];
      } else if (feature === this.featureIndex && fn === 2) {
        const id = (parameters[0] << 8) | parameters[1];
        const control = this.controls.find(item => item.id === id);
        assert(control);
        response = [id >> 8, id & 255, control.reporting, control.remap >> 8, control.remap & 255, control.reporting2];
      } else if (feature === this.featureIndex && fn === 3) {
        const id = (parameters[0] << 8) | parameters[1];
        const control = this.controls.find(item => item.id === id);
        assert(control);
        const written = parameters.slice(0, 6);
        this.writes.push(written);
        this.trace.push({type: 'set', id, reporting: written[2]});
        control.reporting = written[2];
        control.remap = (written[3] << 8) | written[4];
        control.reporting2 = written[5];
        // Simulate a write that reached the device but whose reply was lost.
        if (id === this.dropFirstSetFor && !this.droppedFirstSet) {this.droppedFirstSet = true; return;}
        response = written;
      } else {
        throw new Error(`Unexpected optional feature request: ${feature}/${fn}`);
      }
      const reply = new Uint8Array(19);
      reply.set([0xff, feature, bytes[2]]);
      reply.set(response, 3);
      queueMicrotask(() => this.fire('inputreport', {reportId: 0x11, data: new DataView(reply.buffer)}));
    };
  }
  async close() {this.trace.push({type: 'close'}); return super.close();}
  diverted(ids, {feature = this.featureIndex, fn = 0, softwareId = 0} = {}) {
    const bytes = new Uint8Array(19);
    bytes.set([0xff, feature, (fn << 4) | softwareId]);
    ids.slice(0, 4).forEach((id, index) => {bytes[3 + index * 2] = id >> 8; bytes[4 + index * 2] = id & 255;});
    this.fire('inputreport', {reportId: 0x11, data: new DataView(bytes.buffer)});
  }
}
function deadline(promise, message, timeout = 1200) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(message)), timeout);})]).finally(() => clearTimeout(timer));
}
async function featureConnected(t, deviceOptions = {}, controllerOptions = {}) {
  const device = new FeatureDevice(deviceOptions), hid = new Hid([device]);
  const ready = deferred(), states = [], events = [], navigation = [];
  let now = 0;
  const controller = createKeypadController({hid, secureContext: true, clock: () => now, delay: async milliseconds => {now += milliseconds;},
    inputTimeoutMs: 20, inputSetupTimeoutMs: 450, inputRestoreTimeoutMs: 250,
    onKey: event => events.push(event), onNavigation: event => navigation.push(event), ...controllerOptions,
    onStatus: state => {states.push(state); if (['ready', 'raw-only'].includes(state.inputStatus)) ready.resolve(state); controllerOptions.onStatus?.(state);}});
  t.after(() => controller.destroy());
  await controller.detect();
  return {controller, device, hid, states, events, navigation, inputReady: () => deadline(ready.promise, 'Optional button setup did not settle')};
}
const controlParams = (control, flags) => [control.id >> 8, control.id & 255, flags, control.remap >> 8, control.remap & 255, control.reporting2];
const supportedControls = controls => controls.filter(control => control.id <= 9 || [0x01a1, 0x01a2].includes(control.id));

test('optional 1B04 configures only LCD and paging controls while preserving remap/reporting2', async t => {
  const {device, controller, inputReady} = await featureConnected(t);
  const state = await inputReady();
  assert.equal(state.inputStatus, 'ready');
  assert.equal(controller.getState().connected, true);
  const supported = supportedControls(device.initialControls);
  assert.deepEqual(device.writes, supported.map(control => controlParams(control, control.reporting | 0x03)));
  const queried = device.commands.filter(command => command.feature === 7 && command.fn === 2).map(command => (command.parameters[0] << 8) | command.parameters[1]);
  assert.deepEqual(queried, [1, 5, 9, 0x01a1, 0x01a2]);
  assert(!device.writes.some(parameters => ((parameters[0] << 8) | parameters[1]) === 0x0053));
});

test('navigation-only firmware enables paging callbacks and retains independent raw LCD input', async t => {
  const controls = optionalControls().filter(control => [0x01a1, 0x01a2].includes(control.id));
  const logs = [];
  const {device, controller, events, navigation, inputReady} = await featureConnected(t, {controls}, {log: (message, detail) => logs.push({message, detail})});
  const state = await inputReady();
  assert.equal(state.connected, true);
  assert.equal(state.inputStatus, 'ready');
  assert.equal(state.inputError, null);
  assert.deepEqual(device.writes, controls.map(control => controlParams(control, control.reporting | 0x03)));
  const diagnostic = logs.find(entry => entry.message === 'MX Keypad button input enabled');
  assert(diagnostic);
  assert.equal(diagnostic.detail.advertisedControlCount, 2);
  assert.deepEqual(diagnostic.detail.advertisedControlIds, ['0x01a1', '0x01a2']);
  assert.deepEqual(diagnostic.detail.navigation, ['previous', 'next']);
  device.diverted([0x01a1, 0x01a2]);
  assert.deepEqual(events, []);
  assert.deepEqual(navigation, [{direction: 'previous', pressed: true}, {direction: 'next', pressed: true}]);
  assert.deepEqual(controller.getState().activeNavigation, ['previous', 'next']);
  device.keys([1]); device.keys([]);
  assert.deepEqual(events.map(({index, pressed}) => ({index, pressed})), [{index: 0, pressed: true}, {index: 0, pressed: false}]);
  assert.equal(navigation.length, 2, 'Raw LCD reports do not release held paging controls');
  assert.equal((await controller.setKeyImage(0, jpeg())).status, 'sent');
  const writes = device.writes.length;
  await controller.disconnect();
  assert.deepEqual(device.writes.slice(writes), controls.map(control => controlParams(control, control.reporting | 0x02)));
  assert.deepEqual(navigation.slice(2), [{direction: 'previous', pressed: false}, {direction: 'next', pressed: false}]);
  assert.deepEqual(controller.getState().activeNavigation, []);
  assert.equal(device.trace.at(-1).type, 'close');
  device.diverted([0x01a1]);
  assert.equal(navigation.length, 4, 'Closed sessions cannot emit further navigation');
});

test('unrecognized optional controls preserve the normal LCD fallback without arbitrary mapping', async t => {
  const controls = optionalControls().filter(control => control.id === 0x0053);
  const {device, controller, events, navigation, inputReady} = await featureConnected(t, {controls});
  const state = await inputReady();
  assert.equal(state.inputStatus, 'raw-only');
  assert.equal(state.inputError, null);
  assert.deepEqual(device.writes, []);
  assert.deepEqual(device.controls, controls);
  device.diverted([0x0053, 0x01a1, 0x01a2]);
  assert.deepEqual(navigation, []);
  device.keys([1]); device.keys([]);
  assert.deepEqual(events.map(({index, pressed}) => ({index, pressed})), [{index: 0, pressed: true}, {index: 0, pressed: false}]);
  assert.equal((await controller.setKeyImage(0, jpeg())).status, 'sent');
});

test('paging edges are deduplicated independently from LCD presses and unrelated reports', async t => {
  const {device, controller, events, navigation, inputReady} = await featureConnected(t);
  await inputReady();
  device.diverted([0x01a1, 1]);
  device.diverted([0x01a1, 0x01a1, 1]);
  device.diverted([0x01a1, 0x01a2, 1]);
  device.diverted([0x01a2, 1]);
  device.diverted([], {feature: 6});
  device.diverted([], {fn: 1});
  device.diverted([], {softwareId: 3});
  assert.deepEqual(controller.getState().activeNavigation, ['next']);
  device.keys([0xa1, 0xa2]);
  assert.deepEqual(controller.getState().activeNavigation, ['next'], 'Truncated raw bytes are not treated as 16-bit paging CIDs');
  device.diverted([1]);
  device.diverted([1]);
  assert.deepEqual(navigation, [
    {direction: 'previous', pressed: true}, {direction: 'next', pressed: true},
    {direction: 'previous', pressed: false}, {direction: 'next', pressed: false}
  ]);
  assert.deepEqual(events.map(({index, pressed}) => ({index, pressed})), [{index: 0, pressed: true}]);
  device.diverted([]);
  assert.deepEqual(events.at(-1), {index: 0, pressed: false, activeIndices: []});
});

test('raw and diverted button reports are unioned without duplicate presses or early releases', async t => {
  const {device, events, inputReady} = await featureConnected(t);
  await inputReady();
  device.keys([1]);
  device.diverted([1]);
  device.keys([]); // The diverted source still holds key 1.
  device.diverted([1, 9]);
  device.diverted([9]);
  device.keys([9]);
  device.diverted([]); // The raw source still holds key 9.
  device.keys([]);
  assert.deepEqual(events.map(({index, pressed}) => ({index, pressed})), [
    {index: 0, pressed: true}, {index: 8, pressed: true},
    {index: 0, pressed: false}, {index: 8, pressed: false}
  ]);
});

test('unrelated optional replies are ignored and navigation controls never become LCD key presses', async t => {
  const {device, events, inputReady} = await featureConnected(t);
  await inputReady();
  device.diverted([1], {feature: 6});
  device.diverted([1], {fn: 1});
  device.diverted([1], {softwareId: 3});
  assert.deepEqual(events, []);
  device.diverted([0x01a1, 5, 0x01a2, 9]);
  assert.deepEqual(events.map(({index, pressed}) => ({index, pressed})), [{index: 4, pressed: true}, {index: 8, pressed: true}]);
  device.diverted([], {softwareId: 3});
  assert.equal(events.length, 2, 'A feature reply must not release held keys');
  device.diverted([]);
  assert.deepEqual(events.slice(2).map(({index, pressed}) => ({index, pressed})), [{index: 4, pressed: false}, {index: 8, pressed: false}]);
});

test('disconnect restores prior temporary reporting, remap and reporting2 before closing HID', async t => {
  const {device, controller, inputReady} = await featureConnected(t);
  await inputReady();
  const before = device.writes.length;
  await controller.disconnect();
  const configured = supportedControls(device.initialControls);
  const restored = device.writes.slice(before).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(restored, configured.map(control => controlParams(control, control.reporting | 0x02)));
  assert.equal(device.trace.at(-1).type, 'close');
  assert.equal(controller.getState().connected, false);
});

test('destroy restores optional settings once and remains idempotent', async t => {
  const {device, controller, inputReady} = await featureConnected(t);
  await inputReady();
  const before = device.writes.length;
  await controller.destroy();
  const configured = supportedControls(device.initialControls);
  assert.deepEqual(device.writes.slice(before).sort((a, b) => a[1] - b[1]), configured.map(control => controlParams(control, control.reporting | 0x02)));
  const writes = device.writes.length;
  await controller.destroy();
  assert.equal(device.writes.length, writes);
});

test('missing 1B04 falls back to raw input while contextual-display writes still work', async t => {
  const {device, controller, events, inputReady} = await featureConnected(t, {featureIndex: 0});
  assert.equal((await inputReady()).inputStatus, 'raw-only');
  assert.equal(device.writes.length, 0);
  device.keys([1]); device.keys([]);
  assert.deepEqual(events.map(({index, pressed}) => ({index, pressed})), [{index: 0, pressed: true}, {index: 0, pressed: false}]);
  assert.equal((await controller.setKeyImage(0, jpeg())).status, 'sent');
  assert.equal(device.reports.filter(report => report.reportId === 0x14).length, 1);
  assert.equal(controller.getState().connected, true);
});

test('optional feature timeout cannot block image writes or disconnect the display', async t => {
  const {device, controller, inputReady} = await featureConnected(t, {silentDiscovery: true});
  assert.equal((await controller.setKeyImage(8, jpeg())).status, 'sent');
  const state = await inputReady();
  assert.equal(state.inputStatus, 'raw-only');
  assert.equal(typeof state.inputError, 'string');
  assert(state.inputError.length > 0);
  assert.equal(controller.getState().connected, true);
  assert.equal((await controller.setKeyImage(0, jpeg())).status, 'sent');
  assert.equal(device.reports.filter(report => report.reportId === 0x14).length, 2);
});

test('a lost configuration reply restores every touched control and retains raw/display fallback', async t => {
  const {device, controller, inputReady} = await featureConnected(t, {dropFirstSetFor: 5});
  assert.equal((await inputReady()).inputStatus, 'raw-only');
  const original = device.initialControls.filter(control => [1, 5].includes(control.id));
  for (const control of original) {
    const last = device.writes.filter(parameters => ((parameters[0] << 8) | parameters[1]) === control.id).at(-1);
    assert.deepEqual(last, controlParams(control, control.reporting | 0x02));
  }
  assert(!device.writes.some(parameters => parameters[0] === 0 && parameters[1] === 9), 'Setup stops after its failed LCD control');
  assert.equal(controller.getState().connected, true);
  assert.equal((await controller.setKeyImage(1, jpeg())).status, 'sent');
});

test('failed paging setup restores both attempted navigation controls and leaves raw LCD input active', async t => {
  const controls = optionalControls().filter(control => [0x01a1, 0x01a2].includes(control.id));
  const {device, controller, events, navigation, inputReady} = await featureConnected(t, {controls, dropFirstSetFor: 0x01a2});
  const state = await inputReady();
  assert.equal(state.inputStatus, 'raw-only');
  assert.match(state.inputError, /timed out/);
  for (const control of controls) {
    const writes = device.writes.filter(parameters => ((parameters[0] << 8) | parameters[1]) === control.id);
    assert.deepEqual(writes, [controlParams(control, control.reporting | 0x03), controlParams(control, control.reporting | 0x02)]);
  }
  device.diverted([0x01a1, 0x01a2]);
  assert.deepEqual(navigation, [], 'Rolled-back optional navigation must not dispatch actions');
  device.keys([9]); device.keys([]);
  assert.deepEqual(events.map(({index, pressed}) => ({index, pressed})), [{index: 8, pressed: true}, {index: 8, pressed: false}]);
  assert.equal((await controller.setKeyImage(8, jpeg())).status, 'sent');
});

test('reconnect waits for paging restoration and close while the picker still opens synchronously', async t => {
  const controls = optionalControls().filter(control => [0x01a1, 0x01a2].includes(control.id));
  const {device, controller, hid, inputReady} = await featureConnected(t, {controls});
  await inputReady();
  const entered = deferred(), release = deferred();
  const originalSend = device.send;
  let paused = false;
  device.send = async (reportId, payload) => {
    const bytes = new Uint8Array(payload);
    if (!paused && reportId === 0x11 && (bytes[2] >> 4) === 3 && bytes[3] === 1 && bytes[4] === 0xa1 && bytes[5] === (controls[0].reporting | 0x02)) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return originalSend(reportId, payload);
  };
  const disconnecting = controller.disconnect();
  await deadline(entered.promise, 'Disconnect did not start restoring paging controls');
  const reconnecting = controller.connect();
  assert.equal(hid.requests.length, 1, 'User activation reaches the picker before restoration finishes');
  await Promise.resolve();
  assert.equal(device.opens, 1, 'The previous handle cannot be reopened while restoration is pending');
  release.resolve();
  await disconnecting;
  assert.equal((await reconnecting).connected, true);
  assert.equal(device.closes, 1);
  assert.equal(device.opens, 2);
  assert.equal(device.opened, true, 'The old teardown cannot close the new session');
});

// These tests acknowledge actual image packets. A resolved USB send alone is
// deliberately insufficient to pass transport or stress checks.
test('image ACK decoding honors offsets and requires the exact device/channel/function envelope', () => {
  const bytes = Uint8Array.from([99, 0xff, 2, 0x2b, 0xc1, 0, 1, 99]);
  assert.deepEqual(parseKeypadImageAck(0x13, new DataView(bytes.buffer, 1, 6)), {part: 0xc1, statusHi: 0, statusLo: 1});
  assert.equal(parseKeypadImageAck(0x11, new DataView(bytes.buffer, 1, 6)), null);
  assert.equal(parseKeypadImageAck(0x13, new DataView(bytes.buffer, 1, 5)), null);
  for (const prefix of [[0, 2, 0x2b], [255, 3, 0x2b], [255, 2, 0x20], [255, 2, 0]]) {
    assert.equal(parseKeypadImageAck(0x13, new DataView(Uint8Array.from([...prefix, 0xc1, 0, 1]).buffer)), null);
  }
});

test('multi-packet firmware can reply only at image completion; exact final ACK gates the next image', async t => {
  const entered = [deferred(), deferred(), deferred(), deferred()];
  const events = [];
  const {device, controller} = await connected(t, {onKey: event => events.push(event)});
  device.autoAck = false;
  device.send = async () => entered[device.reports.length - 1].resolve();
  device.keys([1]);
  const image = controller.setKeyImage(4, jpeg(9000));
  const next = controller.setKeyImage(5, jpeg());
  await entered[2].promise;
  assert.equal(device.reports.length, 3, 'Every fragment is written without requiring intermediate ACKs');
  device.ack(0x81); // An intermediate reply is not image acceptance.
  device.ack(0x43 | 0x20); // Data-marker bit is not accepted in an ACK.
  device.ack(0x43, 0, 1, {prefix: [255, 2, 0x20]});
  device.ack(0x43, 0, 1, {reportId: 0x11});
  await new Promise(setImmediate);
  assert.equal(device.reports.length, 3, 'A queued image waits for final acceptance');
  assert.equal(events.length, 1, 'Image responses cannot synthesize a key release');
  assert.equal(controller.getState().acceptedFrames, 0);
  device.ack(0x43, 0, 1);
  const result = await image;
  assert.equal(result.deviceAccepted, true);
  assert.equal(result.packetCount, 3);
  assert.equal(result.displayReadback, false);
  assert.equal(controller.getState().acceptedFrames, 1);
  assert.equal(controller.getState().lastAck.part, 0x43);
  await entered[3].promise;
  device.ack(0x43, 0, 1); // A previous image's differently sized ACK is unrelated.
  await new Promise(setImmediate);
  assert.equal(controller.getState().acceptedFrames, 1);
  device.ack(0xc1, 0, 1);
  assert.equal((await next).deviceAccepted, true);
  assert.equal(controller.getState().acceptedFrames, 2);
});

test('an ACK arriving before the USB promise cannot claim success or hide a failed USB write', async t => {
  const entered = deferred(), release = deferred();
  const {controller, device} = await connected(t);
  device.autoAck = false;
  device.send = async (_id, data) => {device.ack(data[3] & ~0x20); entered.resolve(); await release.promise;};
  const image = controller.setKeyImage(0, jpeg());
  const failed = assert.rejects(image, /USB rejected after early ACK/);
  await entered.promise;
  await new Promise(setImmediate);
  assert.equal(device.reports.length, 1);
  assert.equal(controller.getState().acceptedFrames, 0);
  release.reject(new Error('USB rejected after early ACK'));
  await failed;
  assert.equal(controller.getState().connected, false);
  assert.equal(controller.getState().acceptedFrames, 0);
});

test('missing ACK closes the transport and rejects pending work; late replies cannot revive it', async t => {
  const {controller, device} = await connected(t, {imageAckTimeoutMs: 20});
  device.autoAck = false;
  const results = await Promise.allSettled([controller.setKeyImage(0, jpeg(9000)), controller.setKeyImage(1, jpeg())]);
  assert(results.every(result => result.status === 'rejected'));
  assert.match(results[0].reason.message, /did not acknowledge/);
  assert.equal(device.reports.length, 3);
  assert.equal(controller.getState().acceptedFrames, 0);
  assert.equal(controller.getState().connected, false);
  device.ack(0x81);
  device.ack(0xc1);
  await new Promise(setImmediate);
  assert.equal(controller.getState().acceptedFrames, 0);
  device.autoAck = true;
  await controller.detect();
  const result = await controller.setKeyImage(2, jpeg());
  assert.equal(result.deviceAccepted, true);
  assert.equal(controller.getState().acceptedFrames, 1);
  assert.equal(device.opens, 2);
});

test('a matching image refusal stops the queue without treating USB completion as display acceptance', async t => {
  const {controller, device} = await connected(t);
  device.autoAck = false;
  device.send = async (_id, data) => device.ack(data[3] & ~0x20, 0xf8, 0x02);
  const results = await Promise.allSettled([controller.setKeyImage(0, jpeg()), controller.setKeyImage(1, jpeg())]);
  assert(results.every(result => result.status === 'rejected'));
  assert.equal(device.reports.length, 1);
  assert.equal(controller.getState().lastAck.accepted, false);
  assert.equal(controller.getState().lastAck.statusHi, 0xf8);
  assert.equal(controller.getState().lastError.code, 'KEYPAD_IMAGE_REFUSED');
  assert.equal(controller.getState().acceptedFrames, 0);
});

test('busy retries use the newest board, wait for quiet time, and keep later live tiles', async t => {
  let now = 0;
  const waits = [], entered = deferred(), release = deferred();
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: fakeEncoder,
    clock: () => now, delay: async ms => {waits.push(ms); entered.resolve(); await release.promise; now += ms;}});
  device.autoAck = false;
  device.send = async (_id, data) => device.ack(data[3] & ~0x20, device.reports.length === 1 ? 0xfb : 0, 1);
  const old = controller.setKeyImages(boardCanvases(10));
  await entered.promise;
  const latest = controller.setKeyImages(boardCanvases(100));
  const live = controller.setKeyImage(3, jpeg(128, 200));
  release.resolve();
  const results = await Promise.all([old, latest, live]);
  assert.equal(results[0].status, 'superseded');
  assert(results.slice(1).every(result => result.deviceAccepted));
  assert.equal(device.reports.length, 3);
  assert.deepEqual(device.reports.map(report => report.data[19 + 20]), [18, 108, 200]);
  assert.deepEqual(waits, [150, 100]);
  assert.equal(controller.getState().busyRetries, 1);
  assert.equal(controller.getState().acceptedFrames, 2);
});

test('replacing busy generations cannot reset the bounded retry budget', async t => {
  let active, now = 0;
  const jobs = [];
  const {controller, device} = await connected(t, {canvasFactory: fakeCanvas, encode: fakeEncoder,
    clock: () => now, delay: async ms => {now += ms; jobs.push(active.setKeyImages(boardCanvases(20 + jobs.length)));}});
  active = controller;
  device.autoAck = false;
  device.send = async (_id, data) => device.ack(data[3] & ~0x20, 0xfb, 0);
  jobs.push(controller.setKeyImages(boardCanvases()));
  const settled = [];
  // Register each rejection as soon as jobs are appended during the queue's waits.
  const oldPush = jobs.push.bind(jobs);
  jobs.push = (...items) => {for (const item of items) settled.push(item.then(value => ({value}), reason => ({reason}))); return oldPush(...items);};
  settled.push(jobs[0].then(value => ({value}), reason => ({reason})));
  await deadline(new Promise(resolve => {
    const check = () => {if (!controller.getState().connected) resolve(); else setImmediate(check);}; check();
  }), 'Busy retry did not terminate');
  const outcomes = await Promise.all(settled);
  assert.equal(device.reports.length, 3, 'Three refused attempts terminate even when new images keep arriving');
  assert.equal(controller.getState().busyRetries, 2);
  assert.equal(controller.getState().acceptedFrames, 0);
  assert.equal(controller.getState().lastError.code, 'KEYPAD_BUSY_LIMIT');
  assert(outcomes.some(outcome => outcome.reason));
  assert(outcomes.every(outcome => outcome.reason || outcome.value.status === 'superseded'));
});

test('pacing reserves 100ms after a long accepted transfer instead of counting that transfer as quiet time', async t => {
  let now = 0;
  const starts = [], waits = [];
  const {controller, device} = await connected(t, {clock: () => now, delay: async ms => {waits.push(ms); now += ms;}});
  device.send = async () => {starts.push(now); now += 230;};
  await controller.setKeyImage(0, jpeg());
  await controller.setKeyImage(1, jpeg());
  assert.deepEqual(starts, [0, 330]);
  assert.deepEqual(waits, [100]);
  assert.equal(controller.getState().lastSendDurationMs, 230);
});

test('actual encodings stay within 15 packets while the generic upstream builder stays unchanged', async t => {
  assert.equal(MAX_ENCODED_IMAGE_BYTES, 61335);
  const {controller, device} = await connected(t);
  await assert.rejects(controller.setKeyImage(0, jpeg(MAX_ENCODED_IMAGE_BYTES + 1)), /15-packet/);
  assert.equal(device.reports.length, 0);
  const result = await controller.setKeyImage(0, jpeg(MAX_ENCODED_IMAGE_BYTES));
  assert.equal(result.packetCount, 15);
  assert.equal(device.reports.at(-1).data[3], 0x6f);
  assert.equal(buildKeyImagePackets(0, new Uint8Array(70000)).length, 18);
});

test('full-board canvas encoding reduces JPEG quality to the conservative payload cap', async t => {
  const qualities = [];
  const canvasFactory = () => {
    const canvas = fakeCanvas();
    canvas.convertToBlob = async ({quality}) => {qualities.push(quality); return new Blob([jpeg(quality > 0.75 ? 65000 : 55000, 22, canvas.width, canvas.height)], {type: 'image/jpeg'});};
    return canvas;
  };
  const {controller, device} = await connected(t, {canvasFactory});
  const result = await controller.setKeyImages(boardCanvases());
  assert.deepEqual(qualities, [0.95, 0.85, 0.75]);
  assert.equal(result.bytes, 55000);
  assert.equal(result.deviceAccepted, true);
  assert.equal(device.reports.length, 14);
});

test('standard HID++ errors match the original feature/function/software, not unrelated notifications', async t => {
  const device = new FeatureDevice(), hid = new Hid([device]);
  const baseSend = device.send;
  let injected = false;
  device.send = async (reportId, payload) => {
    if (reportId === 0x11 && payload[1] === 7 && (payload[2] >> 4) === 2 && !injected) {
      injected = true;
      const emitError = (feature, fnSoftware, code) => {
        const reply = new Uint8Array(19); reply.set([255, 255, feature, fnSoftware, code]);
        device.fire('inputreport', {reportId: 0x11, data: new DataView(reply.buffer)});
      };
      emitError(6, payload[2], 3);
      emitError(7, payload[2] ^ 1, 4);
      emitError(7, payload[2], 8);
      return;
    }
    return baseSend(reportId, payload);
  };
  const ready = deferred();
  const controller = createKeypadController({hid, secureContext: true, inputTimeoutMs: 500,
    onStatus: state => {if (state.inputStatus === 'raw-only') ready.resolve(state);}});
  t.after(() => controller.destroy());
  await controller.detect();
  const state = await deadline(ready.promise, 'Correlated HID++ error was ignored', 300);
  assert.match(state.inputError, /error 0x08/);
  assert.doesNotMatch(state.inputError, /0x03|0x04|timed out/);
  assert.equal(device.writes.length, 0, 'The refused GetReporting prevents unsupported mutations');
  assert.equal((await controller.setKeyImage(0, jpeg())).deviceAccepted, true);
});

test('brightness diagnostics discover 8040 and read its actual range without changing brightness', async t => {
  const {controller, device, inputReady} = await featureConnected(t, {minBrightness: 4, maxBrightness: 200, brightness: 86});
  await inputReady();
  const result = await controller.checkDisplay();
  assert.deepEqual(result.brightness, {current: 86, min: 4, max: 200, steps: 101, capabilities: 0x10});
  assert.equal(result.displayReadback, false);
  assert.equal(result.acceptedFrames, 0);
  assert.deepEqual(device.brightnessWrites, []);
  assert(device.commands.some(command => command.feature === 0 && command.parameters[0] === 0x80 && command.parameters[1] === 0x40));
  assert.deepEqual(controller.getState().displayDiagnostic.brightness, result.brightness);
  const refreshed = await controller.recoverDisplay({brightness: 100});
  assert.equal(refreshed.brightnessChanged, false);
  assert.equal(refreshed.brightness.current, 86);
  assert.deepEqual(device.brightnessWrites, [], 'Nonzero brightness is preserved even when a recovery level was supplied');
});

test('zero brightness recovery requires a known or explicit positive in-range level and verifies readback', async t => {
  const {controller, device, inputReady} = await featureConnected(t, {brightness: 0});
  await inputReady();
  await assert.rejects(controller.recoverDisplay(), /explicit nonzero brightness/);
  for (const brightness of [0, -1, 101, 3.5, '50', NaN]) await assert.rejects(controller.recoverDisplay({brightness}), /nonzero brightness/);
  assert.deepEqual(device.brightnessWrites, []);
  assert.equal(controller.getState().connected, true);
  const restored = await controller.recoverDisplay({brightness: 37});
  assert.equal(restored.brightnessChanged, true);
  assert.equal(restored.brightness.current, 37);
  assert.deepEqual(device.brightnessWrites, [37]);
  device.brightness = 0;
  await controller.disconnect();
  const reconnected = await controller.recoverDisplay();
  assert.equal(reconnected.reconnected, true);
  assert.equal(reconnected.brightness.current, 37);
  assert.deepEqual(device.brightnessWrites, [37, 37], 'An observed positive level survives reconnect without guessing a new setting');
  assert.equal(device.reports.filter(report => report.reportId === 0x14).length, 0, 'Recovery never clears or substitutes display images');
});

test('brightness recovery refuses to claim restoration when the device readback differs', async t => {
  const {controller, device, inputReady} = await featureConnected(t, {brightness: 0});
  await inputReady();
  const baseSend = device.send;
  device.send = async (reportId, payload) => {
    await baseSend(reportId, payload);
    if (reportId === 0x11 && payload[1] === 8 && payload[2] >> 4 === 2) device.brightness = 0;
  };
  await assert.rejects(controller.recoverDisplay({brightness: 50}), /not confirmed/);
  assert.equal(controller.getState().displayDiagnostic.brightness.current, 0);
  assert.equal(controller.getState().connected, true);
});

test('optional brightness unavailability does not close an otherwise healthy image connection', async t => {
  const {controller, device, inputReady} = await featureConnected(t, {brightnessFeatureIndex: 0});
  await inputReady();
  await assert.rejects(controller.checkDisplay(), /8040.*not found/);
  assert.equal(controller.getState().connected, true);
  assert.equal((await controller.setKeyImage(0, jpeg())).deviceAccepted, true);
  assert.deepEqual(device.brightnessWrites, []);
});

test('brightness commands cannot interleave a multi-packet image transaction', async t => {
  const {controller, device, inputReady} = await featureConnected(t);
  await inputReady();
  const baseSend = device.send, entered = deferred(), release = deferred();
  let first = true;
  device.send = async (reportId, payload) => {
    if (reportId === 0x14 && first) {first = false; entered.resolve(); await release.promise;}
    return baseSend(reportId, payload);
  };
  const before = device.reports.length;
  const image = controller.setKeyImage(0, jpeg(9000));
  await entered.promise;
  const checking = controller.checkDisplay();
  await new Promise(setImmediate);
  assert.deepEqual(device.reports.slice(before).map(report => report.reportId), [0x14]);
  release.resolve();
  const [result, diagnostic] = await Promise.all([image, checking]);
  assert.equal(result.deviceAccepted, true);
  assert.equal(diagnostic.brightness.current, 70);
  assert.deepEqual(device.reports.slice(before).map(report => report.reportId), [0x14, 0x14, 0x14, 0x11, 0x11, 0x11]);
});

test('1200 mixed board, tile and held-button events stay bounded, serialized and finish on the newest valid frame', async t => {
  const entered = deferred(), release = deferred(), jobs = [], nav = [], keys = [];
  let active, reentered = false, maxPending = 0, maxConcurrent = 0, concurrent = 0;
  const add = promise => jobs.push(promise.then(value => ({value}), reason => ({reason})));
  const {controller, device, inputReady} = await featureConnected(t, {}, {
    canvasFactory: fakeCanvas,
    encode: async captured => ({imageFormat: 0, imageData: captured.bytes || jpeg(9000, captured.canvas.marker, captured.width, captured.height)}),
    onNavigation: event => {nav.push(event); if (event.pressed) add(active.setKeyImages(boardCanvases((nav.length % 100) + 10)));},
    onKey: event => {keys.push(event); if (event.pressed) add(active.setKeyImage(event.index, jpeg(9000, (keys.length % 100) + 10)));},
    onStatus: state => {
      maxPending = Math.max(maxPending, state.pendingKeys.length + (state.pendingBoard ? 1 : 0));
      if (active && state.uploadingBoard && !reentered) {reentered = true; add(active.setKeyImage(7, jpeg(9000, 77)));}
    }
  });
  active = controller;
  await inputReady();
  const baseSend = device.send;
  let first = true;
  device.send = async (reportId, payload) => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    try {
      if (reportId === 0x14 && first) {first = false; entered.resolve(); await release.promise;}
      await baseSend(reportId, payload);
    } finally {concurrent--;}
  };
  add(controller.setKeyImages(boardCanvases(10)));
  await entered.promise;
  for (let index = 0; index < 1200; index++) {
    if (index % 3 === 0) {
      const id = index % 2 ? 0x01a1 : 0x01a2;
      device.diverted([id]); device.diverted([id]); device.diverted([]);
    } else if (index % 3 === 1) {
      device.keys([index % 9 + 1]); device.keys([index % 9 + 1]); device.keys([]);
    } else add(controller.setKeyImages(boardCanvases((index % 100) + 20)));
  }
  add(controller.setKeyImages(boardCanvases(150)));
  add(controller.setKeyImage(8, jpeg(9000, 230)));
  release.resolve();
  const results = await deadline(Promise.all(jobs), 'Burst left unresolved image work', 2000);
  assert(results.every(result => result.value && ['sent', 'superseded'].includes(result.value.status)));
  assert.equal(nav.filter(event => event.pressed).length, 400);
  assert.equal(keys.filter(event => event.pressed).length, 400);
  assert(maxPending <= 10);
  assert.equal(maxConcurrent, 1, 'Control/image writes are never concurrent');
  const images = device.reports.filter(report => report.reportId === 0x14);
  assert.equal(images.length, 9, 'An in-flight board, newest board, and newest live tile are the only actual uploads');
  assert.deepEqual(images.map(report => report.data[3]), [0xa1, 0x22, 0x63, 0xa1, 0x22, 0x63, 0xa1, 0x22, 0x63]);
  assert.deepEqual([0, 3, 6].map(index => images[index].data[19 + 20]), [18, 158, 230]);
  assert.deepEqual([0, 3, 6].map(index => locationOf(images[index])), [{x: 0, y: 0, w: 457, h: 440}, {x: 0, y: 0, w: 457, h: 440}, KEYPAD_LAYOUT[8]]);
  assert.equal(controller.getState().acceptedFrames, 3);
  assert.equal(controller.getState().pendingKeys.length, 0);
  assert.equal(controller.getState().pendingBoard, false);
  assert.equal(controller.getState().lastError, null);
});

test('USB disconnect records the actual lifecycle event and pending work without inventing a display failure cause', async t => {
  const logs = [];
  const {controller, device, hid} = await connected(t, {log: (message, detail) => logs.push({message, detail})});
  hid.fire('disconnect', {device});
  const entry = logs.find(item => item.message === 'MX Keypad USB disconnected');
  assert(entry);
  assert.equal(entry.detail.acceptedFrames, 0);
  assert.equal(entry.detail.deviceName, 'MX Creative Keypad');
  assert.equal(controller.getState().status, 'disconnected');
});

test('disconnect cancels an image ACK wait and restores paging without leaving image promises pending', async t => {
  const {controller, device, inputReady} = await featureConnected(t);
  await inputReady();
  const entered = deferred(), baseSend = device.send;
  device.autoAck = false;
  device.send = async (reportId, payload) => {if (reportId === 0x14 && (payload[3] & 0x40)) entered.resolve(); return baseSend(reportId, payload);};
  const first = controller.setKeyImage(0, jpeg(9000));
  const pending = controller.setKeyImage(1, jpeg());
  const settled = Promise.allSettled([first, pending]);
  await entered.promise;
  await deadline(controller.disconnect(), 'Disconnect waited forever for an image ACK');
  assert((await settled).every(result => result.status === 'rejected'));
  assert.equal(controller.getState().acceptedFrames, 0);
  assert.equal(device.reports.filter(report => report.reportId === 0x14).length, 3);
  for (const control of supportedControls(device.initialControls)) {
    assert.deepEqual(device.writes.filter(params => ((params[0] << 8) | params[1]) === control.id).at(-1), controlParams(control, control.reporting | 0x02));
  }
  device.ack(0x81);
  assert.equal(controller.getState().status, 'disconnected');
});

test('disconnect during a bounded brightness query settles diagnostics before closing and reopening the handle', async t => {
  const {controller, device, inputReady} = await featureConnected(t);
  await inputReady();
  const entered = deferred(), baseSend = device.send;
  device.send = async (reportId, payload) => {
    if (reportId === 0x11 && payload[1] === 8 && payload[2] >> 4 === 0) {entered.resolve(); return;}
    return baseSend(reportId, payload);
  };
  const checking = controller.checkDisplay();
  const rejected = assert.rejects(checking, /timed out|disconnected/);
  await entered.promise;
  await deadline(controller.disconnect(), 'Brightness query blocked device teardown');
  await rejected;
  assert.equal(device.opened, false);
  assert.deepEqual(device.brightnessWrites, []);
  device.send = baseSend;
  await controller.detect();
  assert.equal((await controller.checkDisplay()).brightness.current, 70);
  assert.equal(device.opens, 2);
});

test('a premature final-part reply cannot accept a multi-packet image before its final packet starts', async t => {
  const entered = deferred(), release = deferred(), finalWritten = deferred();
  const {controller, device} = await connected(t);
  device.autoAck = false;
  device.send = async (_id, data) => {
    if (data[3] & 0x80) {entered.resolve(); await release.promise;}
    if (data[3] & 0x40) finalWritten.resolve();
  };
  const image = controller.setKeyImage(0, jpeg(9000));
  await entered.promise;
  device.ack(0x43);
  release.resolve();
  await finalWritten.promise;
  await new Promise(setImmediate);
  assert.equal(controller.getState().acceptedFrames, 0);
  device.ack(0x43);
  assert.equal((await image).deviceAccepted, true);
});

test('image response diagnostics stay bounded to eight-byte prefixes and exclude raw and diverted button reports', async t => {
  const {controller, device, inputReady} = await featureConnected(t);
  await inputReady();
  const entered = deferred(), release = deferred(), baseSend = device.send;
  device.send = async (reportId, payload) => {
    if (reportId === 0x14 && (payload[3] & 0x80)) {entered.resolve(); await release.promise;}
    return baseSend(reportId, payload);
  };
  const image = controller.setKeyImage(0, jpeg(9000));
  await entered.promise;
  for (let index = 0; index < 20; index++) {
    const bytes = new Uint8Array(24); bytes.set([255, 2, 0x10, index, 0xa0]);
    device.fire('inputreport', {reportId: 0x13, data: new DataView(bytes.buffer)});
  }
  const before = controller.getState().recentImageResponses;
  assert.equal(before.length, 8);
  assert(before.every(item => item.prefix.length === 8 && item.reportId === 0x13));
  device.keys([1]); device.keys([]);
  device.diverted([0x01a1, 0x01a2]); device.diverted([]);
  assert.deepEqual(controller.getState().recentImageResponses, before, 'Button reports are never captured in diagnostics');
  release.resolve();
  await image;
  const state = controller.getState();
  assert.equal(state.acknowledgementMode, 'final-image');
  assert.equal(state.lastAckExpectation.part, 0x43);
  assert.equal(state.lastAckExpectation.writtenPackets, 3);
  assert.equal(state.lastAckExpectation.finalPacketStarted, true);
  assert.equal(state.recentImageResponses.length, 8);
  assert.deepEqual(state.recentImageResponses.at(-1).prefix, [255, 2, 0x2b, 0x43, 0, 1]);
});

test('actual Mac seven-packet fixture accepts C1–C6 0000 fragment replies followed by C7 0001', async t => {
  const {controller, device} = await connected(t);
  device.autoAck = false;
  device.send = async (_id, data) => {
    const sequence = data[3] & 15;
    const reply = new Uint8Array(31);
    reply.set([255, 2, 0x2b, 0xc0 | sequence, 0, data[3] & 0x40 ? 1 : 0]);
    device.fire('inputreport', {reportId: 0x13, data: new DataView(reply.buffer)});
  };
  const result = await controller.setKeyImage(0, jpeg(28000));
  assert.equal(result.packetCount, 7);
  assert.equal(result.deviceAccepted, true);
  const state = controller.getState();
  assert.equal(state.acceptedFrames, 1);
  assert.equal(state.lastAck.part, 0xc7);
  assert.equal(state.lastAck.statusLo, 1);
  assert.deepEqual(state.lastAckExpectation.acceptedParts, [0x47, 0xc7]);
  assert.deepEqual(state.recentImageResponses.map(reply => reply.prefix.slice(3, 6)), [
    [0xc1, 0, 0], [0xc2, 0, 0], [0xc3, 0, 0], [0xc4, 0, 0], [0xc5, 0, 0], [0xc6, 0, 0], [0xc7, 0, 1]
  ]);
});

test('final-sequence 0000 and wrong-sequence 0001 do not mask the later completed-image reply', async t => {
  const written = deferred();
  const {controller, device} = await connected(t);
  device.autoAck = false;
  device.send = async (_id, data) => {
    device.ack(0xc0 | (data[3] & 15), 0, 0);
    if (data[3] & 0x40) written.resolve();
  };
  const image = controller.setKeyImage(0, jpeg(28000));
  await written.promise;
  device.ack(0xc6, 0, 1);
  device.ack(0xe7, 0, 1);
  await new Promise(setImmediate);
  assert.equal(controller.getState().acceptedFrames, 0);
  assert.equal(controller.getState().lastAck, null);
  device.ack(0xc7, 0, 1);
  assert.equal((await image).deviceAccepted, true);
});

test('a final 0000 fragment reply alone times out without claiming image acceptance', async t => {
  const {controller, device} = await connected(t, {imageAckTimeoutMs: 20});
  device.autoAck = false;
  device.send = async (_id, data) => device.ack(0xc0 | (data[3] & 15), 0, 0);
  await assert.rejects(controller.setKeyImage(0, jpeg(28000)), /status 0001/);
  assert.equal(device.reports.length, 7);
  assert.equal(controller.getState().acceptedFrames, 0);
  assert.equal(controller.getState().lastAck, null);
  assert.equal(controller.getState().connected, false);
  assert.equal(controller.getState().recentImageResponses.at(-1).prefix[3], 0xc7);
});
