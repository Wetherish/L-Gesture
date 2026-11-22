import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeNativeDevice, boundNativeDeviceIdentity, setupNativeControls} from '../dist/native-controls.js';

test('native resume identity requires the observed ID bound to the exact capture request', () => {
  const row={index:2,backend:'dshow',unique_id:'moniker:cpd-2',name:'LVNext CPD Camera'};
  const parameters=new URLSearchParams({index:2,backend:'dshow',device_uid:row.unique_id});
  assert.deepEqual(boundNativeDeviceIdentity(row,parameters),{backend:'dshow',uniqueId:row.unique_id});
  assert.equal(boundNativeDeviceIdentity({...row,index:3},parameters),null);
  assert.equal(boundNativeDeviceIdentity({...row,unique_id:'moniker:another-camera'},parameters),null);
  assert.equal(boundNativeDeviceIdentity({...row,backend:'msmf'},parameters),null);
});

test('names, indexes and unbound native requests never create stable reconnect identity', () => {
  const row={index:0,backend:'avfoundation',name:'LVNext CPD Camera',unique_id:'camera-uid'};
  assert.equal(boundNativeDeviceIdentity(row,new URLSearchParams({index:0,backend:'avfoundation'})),null);
  assert.equal(boundNativeDeviceIdentity(row,new URLSearchParams({backend:'avfoundation',device_uid:row.unique_id})),null);
  assert.equal(boundNativeDeviceIdentity(row,new URLSearchParams({index:0,backend:'auto',device_uid:row.unique_id})),null);
  const parameters=new URLSearchParams({index:0,backend:'avfoundation',device_uid:row.unique_id});
  assert.deepEqual(boundNativeDeviceIdentity(row,parameters),{backend:'avfoundation',uniqueId:row.unique_id});
});

test('native sensor identity comes from the observed device name, never an IR-shaped request', () => {
  const anonymous = normalizeNativeDevice({index: 2, backend: 'AVFOUNDATION', status: 'available', width: 512, height: 640,
    requested: {width: 512, height: 640, fourcc: 'MJPG'}, received_frame: true});
  assert.equal(anonymous.role, 'unknown');
  assert.equal(anonymous.name, 'Native camera 2');
  assert.equal(anonymous.receivedFrame, true);
  assert.equal(anonymous.negotiated.width, 512);
  assert.equal(anonymous.id, 'native:avfoundation:2');
  const rgb = normalizeNativeDevice({...anonymous, name: 'LVNext Camera', role: 'ir'});
  assert.equal(rgb.role, 'rgb', 'An incoming or requested role cannot override the observed name');
  assert.match(rgb.roleEvidence, /Observed OS device name/);
});

test('enumerated CPD and restricted Hello identities remain visible without implying captured footage', () => {
  const formats = [{width: 256, height: 320, media_subtype: 'jpeg', frame_rate_ranges: [{min: 29.97, max: 29.97}]}];
  const ir = normalizeNativeDevice({index: 1, name: 'LVNext CPD Camera', backend: 'avfoundation', status: 'enumerated', formats});
  assert.equal(ir.role, 'ir');
  assert.equal(ir.receivedFrame, false);
  assert.equal(ir.negotiated, null);
  assert.deepEqual(ir.formats, formats);
  const hello = normalizeNativeDevice({index: 3, name: 'LVNext Hello Camera', status: 'unavailable', error: 'OS denied capture'});
  assert.equal(hello.role, 'hello');
  assert.equal(hello.receivedFrame, false);
  assert.equal(hello.status, 'unavailable');
  assert.equal(hello.error, 'OS denied capture');
});

test('requested and negotiated modes remain distinct with driver-setting failures preserved', () => {
  const row = normalizeNativeDevice({index: 0, name: 'LVNext Camera', status: 'available',
    requested: {width: 1920, height: 1080, fps: 30, fourcc: 'NV12'},
    width: 1280, height: 720, fps: 29.97, fourcc: 'unknown', settings_applied: {fourcc: false}, warnings: ['Requested FOURCC was not confirmed.']});
  assert.equal(row.requested.width, 1920);
  assert.equal(row.negotiated.width, 1280);
  assert.equal(row.negotiated.settings_applied.fourcc, false);
  assert.equal(row.negotiated.warnings.length, 1);
  assert.equal(row.role, 'rgb');
});

const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};
const json = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});

function controlsFixture(t, {inventory = [], onFetch, isCameraConnecting} = {}) {
  const elements = new Map(), calls = [], completions = [], publications = [], notices = [];
  class Element extends EventTarget {
    constructor(id = '') {super(); this.id = id; this.value = ''; this.disabled = false; this.checked = false;
      this.children = []; this.style = {}; this.attributes = {}; this.textContent = ''; this.hidden = false;}
    querySelector(selector) {return element(selector.slice(1));}
    setAttribute(key, value) {this.attributes[key] = String(value);}
    removeAttribute(key) {delete this.attributes[key];}
    append(...children) {this.children.push(...children);}
    replaceChildren(...children) {this.children = children;}
    get options() {return this.children;}
    focus() {}
    click() {if (!this.disabled) this.dispatchEvent(new Event('click'));}
  }
  const element = id => {if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id);};
  for (const [id, value] of Object.entries({nativeBackend: 'auto', nativeProbeCount: '2', nativeIndex: '0', nativeWarmup: '0', nativeThreshold: '128', nativeMode: 'raw'})) element(id).value = value;
  const replacements = {
    document: {getElementById: element, createElement: () => new Element(), body: new Element()},
    window: new EventTarget(), location: new URL('https://roofcat.example/'),
    Option: class extends Element {constructor(text, value) {super(); this.textContent = text; this.value = value;}},
    fetch: async (value, options) => {
      const url = new URL(value); calls.push({url, options});
      const custom = onFetch?.(url, options);
      if (custom !== undefined) return custom;
      if (url.pathname === '/health') return json({default_camera_backend: 'dshow'});
      if (url.pathname === '/api/camera/inventory') return json({backend: 'dshow', devices: inventory});
      if (url.pathname === '/api/devices') return json({devices: [{index: Number(url.searchParams.get('start_index')),
        status: 'available', received_frame: true, width: 512, height: 640, fps: 30, fourcc: 'MJPG'}]});
      throw new Error('Unexpected endpoint ' + url.pathname);
    }
  };
  const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  let controller;
  controller = setupNativeControls({
    isCameraConnecting, notice: (...args) => notices.push(args),
    onInventory: rows => publications.push({rows, probing: controller.isProbing()}),
    onDiscoveryComplete: result => completions.push({...result, probing: controller.isProbing()})
  });
  t.after(() => {
    controller.destroy();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return {controller, calls, completions, publications, notices, element};
}

test('named native discovery skips each unreadable row beside an active RGB camera but still attempts CPD', async t => {
  const h = controlsFixture(t, {inventory: [
    {index: 0, status: 'inventory_error', error: 'device_metadata_failed'},
    {index: 1, name: 'LVNext Camera', unique_id: 'rgb'},
    {index: 2, name: 'LVNext CPD Camera', unique_id: 'cpd'}
  ]});
  const result = await h.controller.discoverStreams({skipNames: ['LVNext Camera (046d:094f)']});
  const probes = h.calls.filter(call => call.url.pathname === '/api/devices');
  assert.deepEqual(probes.map(call => call.url.searchParams.get('start_index')), ['2']);
  assert.equal(probes[0].url.searchParams.get('device_uid'), 'cpd');
  assert.equal(result.devices.find(row => row.index === 0).status, 'not_tested');
  assert.equal(result.devices.find(row => row.index === 0).error, 'device_metadata_failed');
  assert.equal(result.devices.find(row => row.index === 0).receivedFrame, false);
  assert.equal(result.devices.find(row => row.index === 1).status, 'in_use');
  assert.equal(result.devices.find(row => row.index === 2).receivedFrame, true);
});

test('completion is emitted only after the final probe response and after isProbing becomes false', async t => {
  const requested = deferred(), response = deferred();
  const h = controlsFixture(t, {inventory: [{index: 2, name: 'LVNext CPD Camera'}],
    onFetch: url => {if (url.pathname === '/api/devices') {requested.resolve(); return response.promise;}}
  });
  const run = h.controller.discoverStreams();
  await requested.promise;
  assert.equal(h.controller.isProbing(), true);
  assert.equal(h.completions.length, 0);
  assert.ok(h.publications.every(item => item.probing));
  response.resolve(json({devices: [{index: 2, status: 'available', received_frame: true, width: 512, height: 640}]}));
  assert.equal((await run).complete, true);
  assert.equal(h.controller.isProbing(), false);
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].complete, true);
  assert.equal(h.completions[0].cancelled, false);
  assert.equal(h.completions[0].probing, false);
  assert.equal(h.completions[0].devices[0].receivedFrame, true);
});

test('cancelled discovery completion cannot be mistaken for successful camera availability', async t => {
  const requested = deferred(), response = deferred();
  const h = controlsFixture(t, {inventory: [{index: 1, name: 'LVNext CPD Camera'}],
    onFetch: url => {if (url.pathname === '/api/devices') {requested.resolve(); return response.promise;}}
  });
  const run = h.controller.discoverStreams();
  await requested.promise; h.controller.stop();
  response.resolve(json({devices: [{index: 1, status: 'available', width: 512, height: 640}]}));
  assert.equal((await run).cancelled, true);
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].complete, false);
  assert.equal(h.completions[0].cancelled, true);
  assert.equal(h.completions[0].probing, false);
  assert.equal(h.controller.getInventory()[0].receivedFrame, false, 'The late frame is ignored');
});

test('a superseded discovery cannot publish completion after newer inventory finishes', async t => {
  const started = deferred(), firstHealth = deferred(); let healthCount = 0;
  const h = controlsFixture(t, {inventory: [{index: 1, name: 'LVNext CPD Camera'}],
    onFetch: url => {if (url.pathname === '/health' && ++healthCount === 1) {started.resolve(); return firstHealth.promise;}}
  });
  const old = h.controller.discoverStreams(); await started.promise;
  const latest = await h.controller.listInventory();
  assert.equal(latest.devices[0].name, 'LVNext CPD Camera');
  assert.equal(h.completions.length, 1); assert.equal(h.completions[0].complete, true);
  firstHealth.resolve(json({default_camera_backend: 'dshow'}));
  assert.equal((await old).cancelled, true);
  assert.equal(h.completions.length, 1, 'Only the current operation may trigger automatic opening');
  assert.equal(h.controller.isProbing(), false);
});

test('named and explicit numeric probes do not compete with a camera still connecting', async t => {
  let connecting = true;
  const h = controlsFixture(t, {inventory: [{index: 1, name: 'LVNext CPD Camera'}], isCameraConnecting: () => connecting});
  await assert.rejects(h.controller.discoverStreams(), error => error.code === 'camera_connecting');
  h.element('nativeProbe').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 0, 'No native capture or inventory request starts during a pending camera connection');
  assert.equal(h.controller.isProbing(), false);
  assert.equal(h.completions.length, 0, 'A blocked action must not trigger automatic camera opening');
  assert.match(h.notices.at(-1)[0], /Wait for the camera connection/);
  connecting = false;
  assert.equal((await h.controller.discoverStreams()).complete, true);
  assert.equal(h.calls.filter(call => call.url.pathname === '/api/devices').length, 1);
});
