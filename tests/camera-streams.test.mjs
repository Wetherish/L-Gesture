import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraRoleFromLabel, isLogitechCameraLabel, sourceCameraRole, allowsLogitechOverlay,
  browserCameraConstraints, buildCameraInventory, probeBrowserCameras
} from '../dist/camera-streams.js';

const device = (deviceId, label, groupId = 'shared-usb') => ({kind:'videoinput', deviceId, label, groupId});
const expected = rows => rows.filter(row => row.transport === 'expected').map(row => row.role);
const evidence = name => `Observed OS device name: ${name}`;

test('camera roles follow observed names, including LogiInsight, rather than portrait dimensions or profiles', () => {
  assert.equal(cameraRoleFromLabel('LVNext Camera (046d:094f)'), 'rgb');
  assert.equal(cameraRoleFromLabel('LogiInsight Camera'), 'rgb');
  assert.equal(cameraRoleFromLabel('LVNext CPD Camera'), 'ir');
  assert.equal(cameraRoleFromLabel('LVNext Hello Camera'), 'hello');
  assert.equal(cameraRoleFromLabel('FaceTime HD Camera (2C0E:82E3)'), 'video');
  assert.equal(isLogitechCameraLabel('USB RGB Camera'), false);
  const rows = buildCameraInventory({native:[{index:2, name:'Native camera 2', receivedFrame:true,
    role:'unknown', roleEvidence:'No sensor identity has been established.', negotiated:{width:512,height:640}}]});
  assert.equal(rows[0].role, 'video');
});

test('all browser inputs survive duplicate names and group IDs, while audio is excluded', () => {
  const rows = buildCameraInventory({devices:[device('a','LVNext Camera'),device('b','LVNext Camera'),
    device('c',''), {kind:'audioinput',deviceId:'mic',label:'Microphone'}]});
  assert.deepEqual(rows.filter(row => row.transport === 'browser').map(row => row.id), ['browser:a','browser:b','browser:c']);
  assert.deepEqual(expected(rows), ['ir','hello']);
  assert.ok(rows.every(row => !/wide/i.test(row.name)));
});

test('expected Logitech interfaces stay distinct from unrelated RGB, infrared and Hello cameras', () => {
  const rows = buildCameraInventory({devices:[device('cpd','LVNext CPD Camera'),device('rgb','USB RGB Camera'),
    device('hello','External Windows Hello Camera')]});
  assert.deepEqual(expected(rows), ['rgb','hello']);
  const rgbOnly = buildCameraInventory({devices:[device('logi','LVNext Camera'),device('other-ir','USB Infrared Camera')]});
  assert.deepEqual(expected(rgbOnly), ['ir','hello']);
  assert.deepEqual(expected(buildCameraInventory({devices:[device('mac','FaceTime HD Camera')]})), []);
});

test('a native named Logitech interface satisfies its expected row and preserves failed attempts', () => {
  const native = [{id:'native:avfoundation:1',index:1,name:'LVNext CPD Camera',role:'ir',roleEvidence:evidence('LVNext CPD Camera'),
    status:'unavailable',receivedFrame:false,error:'Driver denied capture',formats:[{width:256,height:320}]}];
  const rows = buildCameraInventory({devices:[device('rgb','LVNext Camera')],native});
  assert.deepEqual(expected(rows), ['hello']);
  const ir = rows.find(row => row.transport === 'native');
  assert.equal(ir.status, 'unavailable');
  assert.equal(ir.error, 'Driver denied capture');
  assert.deepEqual(ir.formats, [{width:256,height:320}]);
});

test('native boolean frame evidence uses negotiated dimensions and cannot become Live without an active stream', () => {
  const native = [{index:0,backend:'avfoundation',status:'available',receivedFrame:true,negotiated:{width:512,height:640}}];
  const row = buildCameraInventory({native})[0];
  assert.equal(row.status, 'received');
  assert.equal(row.liveTarget, null);
  assert.deepEqual(row.receivedFrame, {width:512,height:640});
  const source = {type:'image',nativeId:row.id,streaming:false};
  assert.equal(buildCameraInventory({native,source})[0].status, 'received', 'a single captured frame has no open camera');
  assert.equal(buildCameraInventory({native,source:{...source,streaming:true}})[0].status, 'live');
  assert.equal(buildCameraInventory({native,secondary:{nativeId:row.id,connected:true,streaming:false}})[0].status, 'received');
});

test('simultaneous main and secondary browser inputs retain their separate live targets', () => {
  const devices = [device('rgb','LVNext Camera'),device('ir','LVNext CPD Camera')];
  const rows = buildCameraInventory({devices,source:{type:'camera',id:'rgb'},secondary:{connected:true,deviceId:'ir'}});
  assert.deepEqual(rows.filter(row => row.transport === 'browser').map(row => [row.status,row.liveTarget]), [['live','main'],['live','secondary']]);
});

test('LogiInsight overlays require an observed Logitech RGB identity for browser and native images', () => {
  const unknown = {type:'image',name:'Hands Tracker frame',origin:'tracker',cameraRole:'ir'};
  assert.equal(sourceCameraRole(unknown), 'video');
  assert.equal(allowsLogitechOverlay(unknown), false);
  assert.equal(allowsLogitechOverlay({type:'image',name:'Native infrared camera 0'}), false);
  const nativeRgb = {type:'image',name:'LVNext Camera',cameraRole:'rgb',roleEvidence:evidence('LVNext Camera')};
  assert.equal(sourceCameraRole(nativeRgb), 'rgb');
  assert.equal(allowsLogitechOverlay(nativeRgb), true);
  assert.equal(allowsLogitechOverlay({...nativeRgb,cameraRole:'ir'}), false);
  assert.equal(allowsLogitechOverlay({type:'camera',name:'LVNext Hello Camera'}), false);
  assert.equal(allowsLogitechOverlay({type:'camera',name:'LVNext Camera (046d:094f)'}), true);
  assert.equal(allowsLogitechOverlay({type:'camera',name:'LogiInsight Camera'}), true);
  assert.equal(allowsLogitechOverlay({type:'camera',name:'LVNext CPD Camera'}), false);
  assert.equal(allowsLogitechOverlay({type:'camera',name:'FaceTime HD Camera'}), false, 'SDK coordinates do not describe the MacBook sensor');
  assert.equal(allowsLogitechOverlay({type:'camera',name:'USB RGB Camera'}), false, 'RGB alone does not identify the SDK camera');
  assert.equal(allowsLogitechOverlay({type:'camera',name:'Logitech BRIO'}), false, 'other Logitech webcams do not establish a LogiInsight match');
  assert.equal(allowsLogitechOverlay({...nativeRgb,name:'USB RGB Camera'}), false);
  assert.equal(allowsLogitechOverlay({...nativeRgb,roleEvidence:null}), false);
  assert.equal(allowsLogitechOverlay({...nativeRgb,type:'url'}), true);
  assert.equal(allowsLogitechOverlay({type:'file',name:'LVNext Camera.mp4'}), false, 'a filename does not establish that footage matches live SDK detections');
  assert.equal(allowsLogitechOverlay(unknown,true), true, 'a timestamp-paired SDK snapshot carries its own matching metadata');
});

test('SDK landmark coordinate previews and synthetic samples remain drawable without claiming camera identity', () => {
  assert.equal(allowsLogitechOverlay({type:'landmarks',name:'Landmark coordinate preview'}), true);
  assert.equal(allowsLogitechOverlay({type:'sample',name:'Synthetic face mesh'}), true);
  assert.equal(allowsLogitechOverlay(null), false);
  // This gate is exclusively for SDK frames; generic and browser inference
  // overlays are matched to their own source by the application.
  assert.equal(sourceCameraRole({type:'camera',name:'FaceTime HD Camera'}), 'video');
});

test('device-default requests preserve exact IDs without imposing RGB dimensions on infrared', () => {
  assert.deepEqual(browserCameraConstraints('ir','native'), {video:{deviceId:{exact:'ir'}},audio:false});
  const native = browserCameraConstraints('ir','native',false,{resizeMode:true});
  assert.deepEqual(native.video, {deviceId:{exact:'ir'},resizeMode:{ideal:'none'}});
  assert.equal(browserCameraConstraints('ir','512,640,30',true).video.width.exact, 512);
  assert.ok(!('resizeMode' in browserCameraConstraints('rgb','1920,1080,30').video));
});

function mockStream(label, id) {
  let stops = 0;
  const track = {label,readyState:'live',getSettings:()=>({deviceId:id,width:640,height:480,frameRate:30}),getCapabilities:()=>({width:{min:320,max:1920}}),stop(){stops++;this.readyState='ended';}};
  return {getTracks:()=>[track],getVideoTracks:()=>[track],track,get stops(){return stops;}};
}
function mockVideo() {
  return {muted:false,playsInline:false,srcObject:null,videoWidth:640,videoHeight:480,play:async()=>{},pause(){},removeAttribute(){},load(){}};
}

test('discovery attempts every exact input, retains errors and closes each temporary camera', async () => {
  const devices = [device('rgb','LVNext Camera'),device('bad','LVNext Hello Camera'),device('ir','LVNext CPD Camera')];
  const calls = [], streams = [], delivered = [];
  const results = await probeBrowserCameras(devices,{supported:{resizeMode:true},makeVideo:mockVideo,waitFrame:async()=>{},
    getMedia:async constraints=>{const id=constraints.video.deviceId.exact;calls.push(id);if(id==='bad')throw new DOMException('OS denied Hello','NotReadableError');const stream=mockStream(devices.find(d=>d.deviceId===id).label,id);streams.push(stream);return stream;},
    onResult:result=>delivered.push(result)});
  assert.deepEqual(calls, ['rgb','bad','ir']);
  assert.deepEqual(results.map(result=>result.success), [true,false,true]);
  assert.equal(delivered.length,3);
  assert.match(results[1].error.message,/OS denied/);
  assert.deepEqual(results[2].receivedFrame,{width:640,height:480});
  assert.deepEqual(streams.map(stream=>stream.stops),[1,1]);
  assert.ok(results.every(result=>!('width' in result.requested.video)));
});

test('discovery reuses an active decoded reader without opening or stopping it', async () => {
  const active = mockStream('LVNext Camera','rgb');
  let calls = 0;
  const results = await probeBrowserCameras([device('rgb','LVNext Camera')],{
    getActiveResult:()=>({settings:active.track.getSettings(),receivedFrame:{width:1280,height:720}}),
    getMedia:async()=>{calls++;throw new Error('Must not reopen the active reader');},makeVideo:mockVideo,waitFrame:async()=>{}
  });
  assert.equal(calls,0);assert.equal(active.stops,0);assert.equal(results[0].reusedActiveStream,true);
  assert.deepEqual(results[0].receivedFrame,{width:1280,height:720});
});

test('cancel during decoded-frame wait releases the temporary stream and does not try the next input', async () => {
  const controller = new AbortController(), opened = mockStream('LVNext CPD Camera','ir');
  let calls = 0;
  const pending = probeBrowserCameras([device('ir','LVNext CPD Camera'),device('hello','LVNext Hello Camera')],{
    signal:controller.signal,getMedia:async()=>{calls++;return opened;},makeVideo:mockVideo,
    waitFrame:async(_video,{signal})=>{controller.abort();if(signal.aborted)throw new DOMException('Cancelled','AbortError');}
  });
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(calls,1);assert.equal(opened.stops,1);
});

test('a grant that arrives after cancellation is closed before creating a preview', async () => {
  const controller = new AbortController(), opened = mockStream('LVNext CPD Camera','ir');
  let grant, videos = 0;
  const pending = probeBrowserCameras([device('ir','LVNext CPD Camera')],{
    signal:controller.signal,getMedia:()=>new Promise(resolve=>{grant=resolve;}),
    makeVideo:()=>{videos++;return mockVideo();},waitFrame:async()=>{}
  });
  controller.abort();grant(opened);
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(opened.stops,1);assert.equal(videos,0);
});

test('a decoded-frame failure cannot count a connected handle as received footage', async () => {
  const opened = mockStream('LVNext Camera','rgb');
  const results = await probeBrowserCameras([device('rgb','LVNext Camera')],{
    getMedia:async()=>opened,makeVideo:()=>({...mockVideo(),videoWidth:0,videoHeight:0}),waitFrame:async()=>{}
  });
  assert.equal(results[0].success,false);assert.match(results[0].error.message,/decoded video frame/);assert.equal(opened.stops,1);
});
