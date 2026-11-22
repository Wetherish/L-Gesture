import test from 'node:test';
import assert from 'node:assert/strict';
import {setupBrowserTracking} from '../dist/browser-tracking-ui.js';
import {createBrowserInference} from '../dist/browser-inference.js';

const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const source = id => ({sourceId: id, sourceName: `Camera ${id}`, element: {videoWidth: 640, videoHeight: 480, readyState: 2, currentTime: 0, paused: false}});

class Element extends EventTarget {
  constructor() {super(); this.checked = false; this.value = ''; this.textContent = ''; this.hidden = false; this.open = false;
    this.attributes = {}; this.dataset = {}; this.children = []; this.classList = {toggle() {}};}
  setAttribute(key, value) {this.attributes[key] = String(value);}
  click() {this.dispatchEvent(new Event('click'));}
}

function fixture({autoReady = true, initialSource = null, onStart, startCamera} = {}) {
  const elements = new Map(), workers = [], results = [], starts = [], timers = new Map(), frames = new Map();
  const document = {getElementById(id) {if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);}, createElement: () => new Element()};
  const $ = id => document.getElementById(id);
  $('trackFace').checked = true;
  for (const [id, value] of Object.entries({trackingFps: '15', trackingMaxFaces: '1', trackingMaxHands: '2', trackingMaxPoses: '1', trackingCompute: 'GPU'})) $(id).value = value;
  let selected = initialSource, controller, engine, callbacks, factoryCalls = 0, cameraCalls = 0, nextId = 0;
  class Worker {
    messages = []; terminated = false;
    constructor() {workers.push(this); assert.equal(workers.filter(worker => !worker.terminated).length, 1, 'only one worker may be alive');}
    postMessage(message) {this.messages.push(message); if (message.type === 'init' && autoReady) queueMicrotask(() => this.ready());}
    ready() {const init = this.messages[0]; this.onmessage?.({data: {type: 'ready', generation: init.generation, delegate: 'GPU'}});}
    terminate() {this.terminated = true;}
  }
  controller = setupBrowserTracking({document, getSource: () => selected,
    startCamera: () => {cameraCalls++; return startCamera?.();},
    onFrame: value => results.push(value), onStart: context => {starts.push(context); onStart?.(context, controller);}, onHelp: () => {},
    createInference: hooks => {
      factoryCalls++; callbacks = hooks;
      engine = createBrowserInference({...hooks, WorkerClass: Worker,
        createBitmap: async () => ({close() {}}),
        requestFrame: fn => {frames.set(++nextId, fn); return nextId;}, cancelFrame: id => frames.delete(id),
        setTimer: (fn, delay) => {timers.set(++nextId, {fn, delay}); return nextId;}, clearTimer: id => timers.delete(id)});
      return engine;
    }});
  return {controller, $, workers, results, starts, timers, frames,
    select(value) {selected = value;},
    current() {return selected;},
    options() {return workers.at(-1)?.messages[0]?.options;},
    emitResult(raw) {callbacks.onResult(raw);},
    state() {return engine.getState();},
    get factoryCalls() {return factoryCalls;}, get cameraCalls() {return cameraCalls;}};
}

test('gesture demand alone never requests camera permission or changes developer checkboxes', async () => {
  const h = fixture(); await h.controller.disable('Developer mode off');
  assert.equal(await h.controller.setGestureEnabled(true), false);
  assert.equal(h.cameraCalls, 0); assert.equal(h.workers.length, 0); assert.equal(h.factoryCalls, 1);
  const state = h.controller.getState();
  assert.equal(state.wanted, false); assert.equal(state.gestureEnabled, true); assert.equal(state.trackingPurpose, 'gesture');
  assert.equal(state.options.face, true); assert.equal(state.options.hands, false);
  assert.deepEqual([state.effectiveOptions.face, state.effectiveOptions.hands, state.effectiveOptions.pose], [false, true, false]);
  assert.equal(h.$('trackFace').checked, true); assert.equal(h.$('trackHands').checked, false);
  assert.match(h.$('browserTrackingState').textContent, /Gestures.*open a camera/);
  h.controller.destroy();
});

test('scene gaze adds face inference while Developer remains off and hands keep priority',async()=>{
  const h=fixture({initialSource:source('rgb')});await h.controller.disable();await h.controller.setGestureEnabled(true);
  await h.controller.setSceneGazeEnabled(true);
  assert.deepEqual([h.options().face,h.options().hands,h.options().pose],[true,true,false]);
  assert.equal(h.options().prioritizeHands,true);assert.equal(h.options().maxFps,60);
  assert.equal(h.controller.getState().wanted,false);assert.equal(h.controller.getState().trackingPurpose,'scene-gaze');
  assert.equal(h.$('trackPreviewButton').attributes['aria-pressed'],'false');assert.equal(h.cameraCalls,0);
  await h.controller.disable('Developer off again');assert.equal(h.controller.getState().effectiveOptions.face,true);
  await h.controller.setSceneGazeEnabled(false);
  assert.deepEqual([h.controller.getState().effectiveOptions.face,h.controller.getState().effectiveOptions.hands],[false,true]);
  h.controller.destroy();
});

test('scene gaze demand never opens a camera and is independent of gesture demand',async()=>{
  const h=fixture();await h.controller.disable();await h.controller.setSceneGazeEnabled(true);
  assert.equal(h.cameraCalls,0);assert.equal(h.workers.length,0);
  h.select(source('rgb'));await h.controller.sourceChanged();
  assert.deepEqual([h.options().face,h.options().hands,h.options().pose],[true,false,false]);
  await h.controller.setGestureEnabled(false);assert.equal(h.controller.getState().effectiveOptions.face,true);
  await h.controller.setSceneGazeEnabled(false);assert.ok(h.workers.every(worker=>worker.terminated));
  h.controller.destroy();
});

test('scene camera supplies every requested task while main can change without restarting it', async () => {
  const main=source('main:1'),scene={...source('scene:4:cpd'),kind:'scene',generation:4};
  const h=fixture({initialSource:main});await h.controller.disable();await h.controller.setGestureEnabled(true);
  h.select(scene);await h.controller.setSceneGazeEnabled(true);await h.controller.sourceChanged();
  assert.equal(h.controller.getState().sourceId,scene.sourceId);
  assert.deepEqual([h.options().face,h.options().hands,h.options().pose],[true,true,false]);
  assert.equal(h.controller.getState().wanted,false,'scene gaze does not turn on Developer');
  const sceneWorker=h.workers.at(-1),count=h.workers.length;
  await h.controller.sourceChanged(); // Main changed, but selected tracking descriptor did not.
  assert.equal(h.workers.length,count);assert.equal(sceneWorker.terminated,false);
  await h.controller.setSignals({face:true,hands:true,pose:true},{startIfPossible:false});
  assert.equal(h.controller.getState().sourceId,scene.sourceId);
  assert.deepEqual([h.options().face,h.options().hands,h.options().pose],[true,true,true]);
  assert.equal(h.options().maxFps,60);assert.equal(h.options().prioritizeHands,true);
  assert.equal(h.cameraCalls,0);h.controller.destroy();
});

test('empty scene detections remain authoritative and old main or scene-session results cannot leak through', async () => {
  const main=source('main:1'),scene=source('scene:4:cpd');
  const h=fixture({initialSource:main});await h.controller.disable();await h.controller.setGestureEnabled(true);
  h.select(scene);await h.controller.setSceneGazeEnabled(true);await h.controller.sourceChanged();
  const generation=h.state().generation;
  h.emitResult({handLandmarks:[[]],inference:{sourceId:main.sourceId,generation}});
  h.emitResult({handLandmarks:[[]],inference:{sourceId:'scene:3:cpd',generation}});
  assert.equal(h.results.filter(Boolean).length,0);
  const empty={faceLandmarks:[],handLandmarks:[],poseLandmarks:[],inference:{sourceId:scene.sourceId,generation}};
  h.emitResult(empty);assert.strictEqual(h.results.at(-1),empty);
  assert.equal(h.controller.getState().sourceId,scene.sourceId);
  h.select(main);await h.controller.setSceneGazeEnabled(false);await h.controller.sourceChanged();
  h.emitResult(empty);assert.equal(h.results.filter(Boolean).length,1);
  assert.equal(h.controller.getState().sourceId,main.sourceId);h.controller.destroy();
});

test('a scene opening without a decoded element stops the old input and never requests another camera', async () => {
  const h=fixture({initialSource:source('main:1')});await h.controller.disable();await h.controller.setGestureEnabled(true);
  h.select(null);await h.controller.setSceneGazeEnabled(false);await h.controller.sourceChanged();
  assert.equal(h.controller.getState().sourceId,null);assert.ok(h.workers.every(worker=>worker.terminated));
  assert.equal(h.results.at(-1),null);assert.equal(h.cameraCalls,0);
  h.select(source('scene:4:cpd'));await h.controller.setSceneGazeEnabled(true);await h.controller.sourceChanged();
  assert.equal(h.controller.getState().sourceId,'scene:4:cpd');assert.equal(h.cameraCalls,0);h.controller.destroy();
});

test('normal view starts hands only on an existing source and never marks the developer overlay control active', async () => {
  const h = fixture({initialSource: source('a')}); await h.controller.disable();
  assert.equal(await h.controller.setGestureEnabled(true), true);
  assert.deepEqual([h.options().face, h.options().hands, h.options().pose, h.options().numHands, h.options().maxFps], [false, true, false, 2, 60]);
  assert.equal(h.controller.getState().options.maxFps, 15, 'requested developer rate is preserved');
  assert.equal(h.options().visualMaxFps, 15); assert.equal(h.options().prioritizeHands, true);
  assert.equal(h.starts[0].purpose, 'gesture'); assert.equal(h.starts[0].developerEnabled, false);
  assert.equal(h.starts[0].sourceId, 'a'); assert.equal(h.cameraCalls, 0);
  assert.equal(h.$('trackPreviewButton').attributes['aria-pressed'], 'false');
  assert.equal(h.$('browserTrackingToggle').textContent, 'Start tracking');
  assert.equal(h.$('trackingPreviewStatus').hidden, true);
  h.controller.destroy();
});

test('developer settings survive a hands floor and disabling Developer leaves gestures running', async () => {
  const h = fixture({initialSource: source('a')}); await h.controller.disable();
  h.$('trackingMaxHands').value = '1'; h.$('trackingMaxHands').dispatchEvent(new Event('change')); await flush();
  await h.controller.setGestureEnabled(true);
  await h.controller.setSignals({face: true, hands: false, pose: true}, {startIfPossible: false});
  assert.deepEqual([h.options().face, h.options().hands, h.options().pose, h.options().numHands], [true, true, true, 2]);
  assert.equal(h.controller.getState().options.numHands, 1); assert.equal(h.$('trackHands').checked, false);
  assert.equal(h.starts.at(-1).purpose, 'developer+gesture');
  assert.equal(await h.controller.disable('Developer mode off'), true);
  assert.deepEqual([h.options().face, h.options().hands, h.options().pose], [false, true, false]);
  assert.equal(h.controller.getState().options.face, true); assert.equal(h.controller.getState().options.pose, true);
  assert.equal(h.controller.getState().status, 'running'); assert.equal(h.factoryCalls, 1);
  assert.equal(await h.controller.setGestureEnabled(false), false);
  assert.ok(h.workers.every(worker => worker.terminated));
  h.controller.destroy();
});

test('source replacement and camera stop cancel stale work but retain the future gesture preference', async () => {
  const h = fixture({autoReady: false, initialSource: source('a')}); await h.controller.disable();
  const first = h.controller.setGestureEnabled(true), old = h.workers[0], oldHandler = old.onmessage;
  h.select(source('b')); const second = h.controller.sourceChanged();
  assert.equal(old.terminated, true); assert.equal(await first, false);
  oldHandler({data: {type: 'ready', generation: old.messages[0].generation, delegate: 'GPU'}});
  assert.equal(h.controller.getState().status, 'loading');
  h.workers.at(-1).ready(); assert.equal(await second, true);
  const generation = h.state().generation;
  h.emitResult({inference: {sourceId: 'a', generation}});
  assert.equal(h.results.filter(Boolean).length, 0, 'an old source result cannot reach the gesture consumer');
  h.emitResult({inference: {sourceId: 'b', generation: generation - 1}});
  assert.equal(h.results.filter(Boolean).length, 0, 'an obsolete worker generation is rejected even for the selected source');
  h.emitResult({handLandmarks: [[]], inference: {sourceId: 'b', generation}});
  assert.equal(h.results.filter(Boolean).length, 1);
  h.controller.stopSource('Camera off'); h.select(null);
  assert.equal(h.results.at(-1), null); assert.equal(h.controller.getState().gestureEnabled, true);
  assert.ok(h.workers.every(worker => worker.terminated)); assert.equal(h.timers.size, 0); assert.equal(h.frames.size, 0);
  await h.controller.sourceChanged(); assert.equal(h.workers.length, 2);
  h.select(source('c')); const third = h.controller.sourceChanged(); h.workers.at(-1).ready();
  assert.equal(await third, true); assert.equal(h.controller.getState().sourceName, 'Camera c');
  assert.equal(h.cameraCalls, 0); h.controller.destroy();
});

test('duplicate gestures and source notifications reuse a pending configuration and one worker', async () => {
  const h = fixture({autoReady: false, initialSource: source('a')}); await h.controller.disable();
  const pending = [h.controller.setGestureEnabled(true)];
  for (let i = 0; i < 20; i++) pending.push(h.controller.setGestureEnabled(true), h.controller.sourceChanged());
  assert.equal(h.workers.length, 1); h.workers[0].ready();
  assert.ok((await Promise.all(pending)).every(Boolean)); assert.equal(h.starts.length, 1);
  h.controller.destroy();
});

test('a rapid developer enable then disable cannot restore old face or body tasks after loading', async () => {
  const h = fixture({autoReady: false, initialSource: source('a')}); await h.controller.disable();
  const gestures = h.controller.setGestureEnabled(true); h.workers[0].ready(); await gestures;
  const debug = h.controller.setSignals({face: true, hands: true, pose: true});
  const obsolete = h.workers.at(-1), obsoleteHandler = obsolete.onmessage;
  const latest = h.controller.disable('Developer mode off');
  assert.equal(obsolete.terminated, true); assert.equal(await debug, false);
  obsoleteHandler({data: {type: 'error', generation: obsolete.messages[0].generation, message: 'Obsolete model failure'}});
  h.workers.at(-1).ready(); assert.equal(await latest, true);
  assert.equal(h.controller.getState().status, 'running'); assert.equal(h.controller.getState().wanted, false);
  assert.deepEqual([h.options().face, h.options().hands, h.options().pose], [false, true, false]);
  assert.equal(h.cameraCalls, 0); h.controller.destroy();
});

test('a rate-only edit during startup waits for the same worker without reloading models', async () => {
  const h = fixture({autoReady: false, initialSource: source('a')}); await h.controller.disable();
  const first = h.controller.setGestureEnabled(true);
  h.$('trackingFps').value = '8'; h.$('trackingFps').dispatchEvent(new Event('change'));
  const latest = h.controller.sourceChanged();
  assert.equal(h.workers.length, 1); assert.equal(h.state().options.maxFps, 60); assert.equal(h.state().options.visualMaxFps, 8);
  h.workers[0].ready(); assert.equal(await first, false); assert.equal(await latest, true);
  assert.equal(h.controller.getState().effectiveOptions.maxFps, 60);
  assert.equal(h.controller.getState().options.maxFps, 8); h.controller.destroy();
});

test('a lower developer rate never lowers gesture sampling, including across Developer mode toggles', async () => {
  const h = fixture({initialSource: source('a')}); await h.controller.disable();
  h.$('trackingFps').value = '5'; h.$('trackingFps').dispatchEvent(new Event('change')); await flush();
  await h.controller.setGestureEnabled(true);
  await h.controller.setSignals({face: true, hands: true, pose: true}, {startIfPossible: false});
  assert.equal(h.state().options.maxFps, 60); assert.equal(h.state().options.visualMaxFps, 5);
  await h.controller.disable();
  assert.equal(h.state().options.maxFps, 60); assert.equal(h.state().options.face, false); assert.equal(h.state().options.pose, false);
  await h.controller.setSignals({face: true, hands: true, pose: true}, {startIfPossible: false});
  assert.equal(h.controller.getState().options.maxFps, 5); assert.equal(h.$('trackingFps').value, '5');
  assert.equal(h.state().options.maxFps, 60); assert.equal(h.state().options.visualMaxFps, 5);
  await h.controller.setGestureEnabled(false);
  assert.equal(h.state().options.maxFps, 5); assert.equal(h.state().options.prioritizeHands, false);
  assert.equal(h.cameraCalls, 0); assert.equal(h.factoryCalls, 1); h.controller.destroy();
});

test('disabling the gesture floor preserves requested developer tasks and their one-hand limit', async () => {
  const h = fixture({initialSource: source('a')});
  h.$('trackingMaxHands').value = '1';
  await h.controller.setSignals({face: false, hands: true, pose: false}, {startIfPossible: false});
  await h.controller.setGestureEnabled(true); assert.equal(h.state().options.numHands, 2);
  await h.controller.setGestureEnabled(false);
  assert.equal(h.state().options.numHands, 1); assert.equal(h.state().options.hands, true);
  assert.equal(h.controller.getState().wanted, true); assert.equal(h.controller.getState().trackingPurpose, 'developer');
  h.controller.destroy();
});

test('advanced Start and Stop control developer demand while background hands stay enabled', async () => {
  const h = fixture({initialSource: source('a')}); await h.controller.disable(); await h.controller.setGestureEnabled(true);
  h.$('browserTrackingToggle').click(); await flush();
  assert.equal(h.controller.getState().wanted, true); assert.equal(h.state().options.face, true);
  assert.equal(h.$('browserTrackingToggle').attributes['aria-pressed'], 'true');
  h.$('browserTrackingToggle').click(); await flush();
  assert.equal(h.controller.getState().wanted, false); assert.equal(h.state().options.face, false);
  assert.equal(h.state().options.hands, true); assert.equal(h.$('browserTrackingToggle').attributes['aria-pressed'], 'false');
  h.controller.destroy();
});

test('a reentrant onStart cancellation prevents the obsolete developer worker from starting', async () => {
  const h = fixture({initialSource: source('a'), onStart(context, controller) {if (context.developerEnabled) controller.disable('Cancelled during start');}});
  await h.controller.disable(); await h.controller.setGestureEnabled(true);
  const before = h.workers.length;
  assert.equal(await h.controller.setSignals({face: true, pose: true}, {startIfPossible: false}), false);
  await flush();
  assert.equal(h.workers.length, before, 'cancelling back to the already-running hands floor needs no new worker');
  assert.equal(h.controller.getState().wanted, false); assert.equal(h.state().options.face, false);
  h.controller.destroy();
});

test('a cancelled permission request cannot reopen inference or overwrite a newer healthy source', async () => {
  const permission = deferred(), h = fixture({startCamera: () => permission.promise});
  const pending = h.controller.start(); assert.equal(h.cameraCalls, 1);
  h.controller.stopSource('Camera request cancelled');
  h.select(source('new')); await h.controller.sourceChanged();
  permission.reject(new Error('Old permission request rejected'));
  assert.equal(await pending, false); assert.equal(h.controller.getState().status, 'running');
  assert.equal(h.controller.getState().sourceName, 'Camera new'); h.controller.destroy();
});

test('destroy settles pending mode changes, releases the single worker, and removes UI listeners', async () => {
  const h = fixture({autoReady: false, initialSource: source('a')}); await h.controller.disable();
  const pending = h.controller.setGestureEnabled(true); h.controller.destroy();
  assert.equal(await pending, false); assert.ok(h.workers.every(worker => worker.terminated));
  assert.equal(h.timers.size, 0); assert.equal(h.frames.size, 0);
  h.$('browserTrackingToggle').click(); h.$('trackingFps').dispatchEvent(new Event('change'));
  assert.equal(await h.controller.setGestureEnabled(true), false); assert.equal(await h.controller.start(), false);
  assert.equal(h.workers.length, 1); assert.equal(h.cameraCalls, 0);
});
