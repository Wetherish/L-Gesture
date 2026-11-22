import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraConstraints, getUserMediaBounded, waitForVideoFrame, stopTracks, describeMediaError, supportedRecordingMimeType, isSafeMediaUrl} from '../dist/media-utils.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stream = () => { const tracks = [{stopped:0,stop(){this.stopped++;}},{stopped:0,stop(){this.stopped++;}}]; return {getTracks:() => tracks, tracks}; };
function mockNavigator(t, getUserMedia) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{mediaDevices:{getUserMedia}}});
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
}
function mockGlobal(t, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {configurable:true,value});
  t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
}

class VideoMock extends EventTarget {
  readyState = 0; videoWidth = 0; videoHeight = 0; error = null; callbacks = new Map(); cancelled = [];
  listeners = new Set(); nextId = 0;
  addEventListener(name, fn, opts) {this.listeners.add(name); super.addEventListener(name, fn, opts);}
  removeEventListener(name, fn) {this.listeners.delete(name); super.removeEventListener(name, fn);}
  requestVideoFrameCallback(fn) {const id=++this.nextId;this.callbacks.set(id,fn);return id;}
  cancelVideoFrameCallback(id) {this.cancelled.push(id);this.callbacks.delete(id);}
  ready() {this.readyState=2;this.videoWidth=1280;this.videoHeight=720;this.dispatchEvent(new Event('loadeddata'));}
}

test('Camera selection stays exact while format can be ideal, exact, or native', () => {
  assert.deepEqual(cameraConstraints('infrared'), {video:{deviceId:{exact:'infrared'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:false});
  assert.deepEqual(cameraConstraints('hello', '480,480,30', true).video.width, {exact:480});
  assert.deepEqual(cameraConstraints('macbook', 'native'), {video:{deviceId:{exact:'macbook'}},audio:false});
  assert.deepEqual(cameraConstraints('', 'native'), {video:{},audio:false});
  assert.throws(() => cameraConstraints('', 'bad'), /capture profile/);
});

test('Successful permission request returns its stream without stopping it', async t => {
  const s=stream();mockNavigator(t, async () => s);
  assert.equal(await getUserMediaBounded({video:true}), s);
  assert.equal(s.tracks[0].stopped, 0);
});

test('Known camera policy denial is reported before requesting the device', async t => {
  let calls=0;mockNavigator(t,async()=>{calls++;return stream();});
  mockGlobal(t,'document',{permissionsPolicy:{features:()=>['camera','microphone'],allowsFeature:feature=>feature!=='camera'}});
  mockGlobal(t,'window',{top:{},self:{}});
  await assert.rejects(getUserMediaBounded({video:true,audio:false}),error=>error.code==='APERTURE_POLICY_BLOCKED'&&error.feature==='camera'&&/embedded preview/.test(error.message));
  assert.equal(calls,0);
});

test('Microphone requests ignore camera policy but honor microphone policy', async t => {
  let denied='camera',calls=0;const s=stream();mockNavigator(t,async()=>{calls++;return s;});
  mockGlobal(t,'document',{featurePolicy:{allowsFeature:feature=>feature!==denied}});
  assert.equal(await getUserMediaBounded({video:false,audio:true}),s);
  denied='microphone';
  await assert.rejects(getUserMediaBounded({video:true,audio:{channelCount:2}}),error=>error.code==='APERTURE_POLICY_BLOCKED'&&error.feature==='microphone'&&/Microphone/.test(error.message));
  assert.equal(calls,1);stopTracks(s);
});

test('Unknown policy support does not block the normal permission flow', async t => {
  const s=stream();let calls=0;mockNavigator(t,async()=>{calls++;return s;});
  mockGlobal(t,'document',{permissionsPolicy:{features:()=>['fullscreen'],allowsFeature:()=>false}});
  assert.equal(await getUserMediaBounded({video:true}),s);assert.equal(calls,1);stopTracks(s);
});

test('Media policy messages survive generic NotAllowedError formatting', () => {
  const message='Camera is blocked in this embedded preview. Open the full app in its own browser tab.';
  assert.equal(describeMediaError(Object.assign(new Error(message),{name:'NotAllowedError',code:'APERTURE_POLICY_BLOCKED'})),message);
});

test('Timeout rejects promptly and stops a stream granted afterwards', async t => {
  let grant;mockNavigator(t, () => new Promise(resolve => {grant=resolve;}));
  await assert.rejects(getUserMediaBounded({video:true},{timeoutMs:10}), {name:'TimeoutError'});
  const s=stream();grant(s);await delay(0);
  assert.deepEqual(s.tracks.map(track => track.stopped), [1,1]);
});

test('Supersession is detected while permission remains pending, and a late stream is stopped', async t => {
  let grant;let current=true;mockNavigator(t, () => new Promise(resolve => {grant=resolve;}));
  const request=getUserMediaBounded({video:true},{timeoutMs:1000,isCurrent:() => current});
  current=false;
  await assert.rejects(request,{name:'AbortError'});
  const s=stream();grant(s);await delay(0);
  assert.deepEqual(s.tracks.map(track => track.stopped), [1,1]);
});

test('Supersession before permission resolution is checked even before the poll fires', async t => {
  let grant;let current=true;mockNavigator(t, () => new Promise(resolve => {grant=resolve;}));
  const request=getUserMediaBounded({video:true},{isCurrent:() => current});
  current=false;const s=stream();grant(s);
  await assert.rejects(request,{name:'AbortError'});
  assert.equal(s.tracks[0].stopped,1);
});

test('AbortSignal cancels pending access and avoids opening an already-aborted request', async t => {
  let grant;let calls=0;mockNavigator(t, () => {calls++;return new Promise(resolve => {grant=resolve;});});
  const controller=new AbortController();
  const request=getUserMediaBounded({video:true},{signal:controller.signal});controller.abort();
  await assert.rejects(request,{name:'AbortError'});
  const s=stream();grant(s);await delay(0);assert.equal(s.tracks[1].stopped,1);
  await assert.rejects(getUserMediaBounded({video:true},{signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,1);
});

test('A native denial is preserved and a stale request never opens a device', async t => {
  const denied=new DOMException('Permission denied','NotAllowedError');let calls=0;
  mockNavigator(t, () => {calls++;return Promise.reject(denied);});
  await assert.rejects(getUserMediaBounded({video:true}), error => error===denied);
  await assert.rejects(getUserMediaBounded({video:true},{isCurrent:() => false}),{name:'AbortError'});
  assert.equal(calls,1);
});

test('Stopping tracks continues after one track throws', () => {
  let stopped=false;
  assert.equal(stopTracks({getTracks:() => [{stop(){throw new Error('broken');}},{stop(){stopped=true;}}]}),1);
  assert.equal(stopped,true);assert.equal(stopTracks(null),0);
});

test('Video metadata alone is insufficient; decoded frame readiness cleans handlers', async () => {
  const video=new VideoMock();video.videoWidth=1280;video.videoHeight=720;video.readyState=1;
  let done=false;const pending=waitForVideoFrame(video,{timeoutMs:1000}).then(result => {done=true;return result;});
  video.dispatchEvent(new Event('loadedmetadata'));await delay(0);assert.equal(done,false);
  video.ready();assert.equal(await pending,video);
  assert.equal(video.listeners.size,0);assert.equal(video.callbacks.size,0);assert.ok(video.cancelled.length);
});

test('A video frame callback can establish readiness without a loadeddata event', async () => {
  const video=new VideoMock();const pending=waitForVideoFrame(video);
  video.readyState=2;video.videoWidth=640;video.videoHeight=480;
  const [id,callback]=[...video.callbacks][0];video.callbacks.delete(id);callback();
  assert.equal(await pending,video);assert.equal(video.listeners.size,0);
});

test('Video timeout and decode errors remove callbacks and event listeners', async () => {
  const video=new VideoMock();await assert.rejects(waitForVideoFrame(video,{timeoutMs:10}),{name:'TimeoutError'});
  assert.equal(video.listeners.size,0);assert.equal(video.callbacks.size,0);
  const broken=new VideoMock();const pending=waitForVideoFrame(broken);broken.error={code:3};broken.dispatchEvent(new Event('error'));
  await assert.rejects(pending,{name:'EncodingError'});assert.equal(broken.listeners.size,0);
});

test('Recording MIME selection respects browser support', t => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'MediaRecorder');
  Object.defineProperty(globalThis,'MediaRecorder',{configurable:true,value:{isTypeSupported:mime => mime==='video/mp4'}});
  t.after(() => descriptor ? Object.defineProperty(globalThis,'MediaRecorder',descriptor) : delete globalThis.MediaRecorder);
  assert.equal(supportedRecordingMimeType(),'video/mp4');
  globalThis.MediaRecorder.isTypeSupported=() => false;assert.equal(supportedRecordingMimeType(),'');
});

test('Media URL validation accepts media sources and rejects executable or filesystem schemes', () => {
  for (const url of ['https://example.com/feed','http://127.0.0.1:8765/api/frame','/clip.mp4','blob:https://example.com/123','blob:null/123','data:image/png;base64,AA==','data:video/mp4;base64,AA==']) assert.equal(isSafeMediaUrl(url,'https://example.com'),true,url);
  for (const url of ['javascript:alert(1)','data:text/html,<script>alert(1)</script>','file:///secret','ftp://example.com/a','blob:javascript:alert(1)','ws://127.0.0.1:8765','','java\nscript:alert(1)']) assert.equal(isSafeMediaUrl(url,'https://example.com'),false,url);
});

test('Media errors provide concrete recovery actions', () => {
  assert.match(describeMediaError({name:'NotAllowedError'}),/site settings/);
  assert.match(describeMediaError({name:'NotReadableError'}),/other apps/);
  assert.match(describeMediaError({name:'OverconstrainedError',constraint:'frameRate'}),/frameRate.*Native/);
  assert.match(describeMediaError({name:'SecurityError'}),/HTTPS or localhost/);
});
