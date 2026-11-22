import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTrackingSource, selectCaptureSource, cameraRoleSelectionKey, cameraRoleContextKey, cameraGazeContextKey, landmarkFrameMatchesSource} from '../dist/tracking-source.js';

const main = {kind:'main', sourceId:'5:rgb', generation:5, width:1280, height:720, role:'rgb', mirror:true};
const scene = {kind:'scene', sourceId:'scene:3:browser:cpd', generation:3, width:512, height:640, role:'ir', mirror:false};
const browserFrame = (source, extra = {}) => ({source:'Browser inference', width:source.width, height:source.height,
  raw:{inference:{sourceId:source.sourceId, generation:19}}, ...extra});

test('main owns tracking by default even with a scene; explicit scene keeps its own mirror and dimensions', () => {
  assert.strictEqual(selectTrackingSource({main, scene}), main);
  assert.strictEqual(selectTrackingSource({main, scene, trackingRole:'scene'}), scene);
  assert.equal(selectTrackingSource({main, scene, trackingRole:'scene'}).mirror, false);
  assert.equal(landmarkFrameMatchesSource(browserFrame(scene, {faces:[], hands:[], poses:[]}), scene), true);
  assert.equal(landmarkFrameMatchesSource(browserFrame(main), scene), false);
  assert.equal(landmarkFrameMatchesSource(browserFrame(scene), main), false);
});

test('an explicitly selected missing camera never silently borrows the other camera', () => {
  for (const sceneState of [{connecting:true}, {connected:true}, {connected:true, streaming:true}]) {
    assert.equal(selectTrackingSource({main, sceneState, trackingRole:'scene'}), null);
    assert.strictEqual(selectTrackingSource({main, sceneState}), main);
  }
  assert.strictEqual(selectTrackingSource({main, sceneState:{connected:false, connecting:false}}), main);
  assert.strictEqual(selectTrackingSource({main, sceneState:{connected:true, streaming:false}}), main);
  assert.equal(selectTrackingSource(), null);
  assert.equal(selectTrackingSource({scene}), null, 'default main remains unavailable when main is off');
  assert.strictEqual(selectTrackingSource({scene, trackingRole:'scene'}), scene, 'explicit scene works while main is off');
  assert.equal(selectTrackingSource({main, scene, trackingRole:'invalid'}), null);
});

test('capture defaults to scene then main independently of the tracking role', () => {
  assert.strictEqual(selectCaptureSource({main, scene}), scene);
  assert.strictEqual(selectCaptureSource({main}), main);
  assert.strictEqual(selectCaptureSource({main, scene, captureRole:'main'}), main);
  assert.strictEqual(selectCaptureSource({main, scene, captureRole:'scene'}), scene);
  assert.equal(selectCaptureSource({main, captureRole:'scene'}), null);
  assert.equal(selectCaptureSource({scene, captureRole:'main'}), null);
  assert.equal(selectCaptureSource({main, scene, captureRole:'invalid'}), null);
});

test('automatic capture waits for an opening scene rather than silently photographing main', () => {
  for (const sceneState of [{connecting:true}, {connected:true}, {connected:true, streaming:true}]) {
    assert.equal(selectCaptureSource({main, sceneState}), null);
    assert.strictEqual(selectCaptureSource({main, sceneState, captureRole:'main'}), main);
  }
  assert.strictEqual(selectCaptureSource({main, sceneState:{connected:true, streaming:false}}), main);
  assert.strictEqual(selectCaptureSource({main, sceneState:{connected:false}}), main);
});

test('context keys invalidate either camera session, dimensions, coordinate orientation or role, while display mirror and model restarts are independent', () => {
  const options={tracking:main,object:main,capture:scene};
  const original=cameraRoleContextKey(options);
  for (const changed of [
    {...options,trackingRole:'scene'}, {...options,objectRole:'scene'}, {...options,captureRole:'scene'},
    {...options,tracking:{...main,generation:6}}, {...options,capture:{...scene,generation:4}},
    {...options,tracking:{...main,sourceId:'6:rgb'}}, {...options,capture:{...scene,width:1024,height:1280}},
    {...options,tracking:{...main,mirrored:true}}, {...options,object:{...main,generation:6}}, {...options,capture:{...scene,revision:2}}, {...options,capture:null},
  ]) assert.notEqual(cameraRoleContextKey(changed),original);
  assert.equal(cameraRoleContextKey({...options,tracking:{...main,workerGeneration:99}}),original);
  assert.equal(cameraRoleContextKey({...options,tracking:{...main,mirror:false}}),original);
  assert.notEqual(cameraRoleSelectionKey(),cameraRoleSelectionKey({captureRole:'main'}), 'policy matters even when auto also selects main');
  assert.notEqual(cameraRoleSelectionKey(),cameraRoleSelectionKey({objectRole:'scene'}));
  assert.equal(cameraGazeContextKey({...options,objectRole:'scene',object:scene}),cameraGazeContextKey(options), 'object role changes cancel actions without discarding a valid gaze mapping');
});

test('a scene reconnect and a crop/aspect change invalidate previous frames; scaling and model restarts retain identity', () => {
  const frame = browserFrame(scene);
  assert.equal(landmarkFrameMatchesSource(frame, {...scene, sourceId:'scene:4:browser:cpd', generation:4}), false);
  assert.equal(landmarkFrameMatchesSource(frame, {...scene, width:1024, height:1280}), true);
  assert.equal(landmarkFrameMatchesSource(frame, {...scene, width:640, height:480}), false);
  frame.raw.inference.generation++;
  assert.equal(landmarkFrameMatchesSource(frame, scene), true, 'worker generation is checked separately at ingestion');
});

test('unbound or contradictory telemetry cannot overlay footage, even with matching name and dimensions', () => {
  const frame = {source:'Custom landmarks', width:main.width, height:main.height, raw:{camera_name:'LVNext Camera'}};
  assert.equal(landmarkFrameMatchesSource(frame, main), false);
  frame.raw.sourceId = main.sourceId;
  assert.equal(landmarkFrameMatchesSource(frame, main), true);
  frame.inference = {sourceId:scene.sourceId};
  assert.equal(landmarkFrameMatchesSource(frame, main), false);
});

test('RGB SDK and tracker coordinate systems cannot become IR overlays through an ID alone', () => {
  for (const source of ['Logitech LogiInsight', 'Logitech Hands Tracker', 'Logitech Gaze Tracker']) {
    assert.equal(landmarkFrameMatchesSource({...browserFrame(scene), source}, scene), false);
  }
  assert.equal(landmarkFrameMatchesSource({...browserFrame(main), source:'Logitech LogiInsight'}, main), true);
});

test('paired native snapshots and independent coordinate previews retain their explicit image plane', () => {
  const native = {source:'Logitech LogiInsight', raw:{synchronized:true}, width:1024, height:768};
  assert.equal(landmarkFrameMatchesSource(native, main), false);
  assert.equal(landmarkFrameMatchesSource(native, main, {paired:true}), true);
  const imported = {source:'Custom landmarks', synthetic:true, raw:{}, width:800, height:600};
  assert.equal(landmarkFrameMatchesSource(imported, main), false);
  assert.equal(landmarkFrameMatchesSource(imported, {type:'landmarks'}, {coordinatePreview:true}), true);
});
