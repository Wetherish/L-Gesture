import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {normalizeFrame} from '../dist/landmarks.js';
import {selectTrackingSource,landmarkFrameMatchesSource} from '../dist/tracking-source.js';

// Execute the actual app's dependency-free selection helpers in isolation.
// Importing app.js itself would initialize cameras, DOM controls and workers.
const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const start=app.indexOf('function pairedLandmarkEntry(){'),end=app.indexOf('function captureCurrentFrame(');
assert.ok(start>=0&&end>start,'Camera frame helper block must be present');
const helpers=app.slice(start,end);
const points=()=>Array.from({length:21},(_,i)=>({x:0.2+i/100,y:0.4,z:-i/1000}));
const generic=(hands=[{handedness:'Right',points:points()}],extra={})=>normalizeFrame({coordinate_space:'normalized',image_resolution:{width:1920,height:1080},sourceId:'1:camera-a',timestamp_ms:10,hands,...extra});
const browser=(extra={})=>normalizeFrame({type:'browser_inference',coordinate_space:'normalized',provenance:'Browser inference',
  image_resolution:{width:1920,height:1080},timestamp_ms:30,
  inference:{location:'browser',engine:'MediaPipe',sourceId:'1:camera-a',generation:2},
  handLandmarks:[points()],handedness:[[{categoryName:'Right',score:0.92}]],...extra});
function harness(){
  let now=1000,allowed=true,status='running',scene=null,sceneState={connected:false};
  const state={token:1,source:{id:'camera-a',type:'camera',name:'Camera a'},telemetry:new Map()};
  const api=vm.runInNewContext(helpers+'\n({cameraOverlayFrame,cameraHandFrame,trackingHandFrame,trackingSource,mainVisualSource,sourceOverlayFrames});',{
    state,performance:{now:()=>now},video:{videoWidth:1280,videoHeight:720},$:()=>({}),
    selectTrackingSource,landmarkFrameMatchesSource,secondaryController:{getTrackingSource:()=>scene,getState:()=>sceneState},
    browserTracking:{getState:()=>({status})},sourceCameraRole:()=>allowed?'rgb':'ir'
  });
  function put(key,frame,{live=false,receivedAt=now,changedAt=receivedAt}={}){state.telemetry.set(key,{frame,live,receivedAt,changedAt});return frame;}
  return {...api,state,put,setNow:value=>now=value,setAllowed:value=>allowed=value,setStatus:value=>status=value,
    setScene(value,nextState){scene=value;sceneState=nextState||{connected:!!value};state.trackingRole='scene';}};
}

test('graph hands retain their original raw data, dimensions, timestamp and inference when overlays combine providers',()=>{
  const h=harness(),imported=h.put('import',generic()),inferred=h.put('browser',browser(),{live:true,receivedAt:900});
  h.put('faces',normalizeFrame({sourceId:'1:camera-a',faceLandmarks:[[{x:0.2,y:0.4}]],image_resolution:{width:320,height:180},timestamp_ms:800}),{receivedAt:1000});
  const graph=h.cameraHandFrame(),overlay=h.cameraOverlayFrame();
  assert.strictEqual(graph,inferred);assert.strictEqual(graph.raw,inferred.raw);assert.strictEqual(graph.inference,inferred.inference);
  assert.equal(graph.width,1920);assert.equal(graph.height,1080);assert.equal(graph.timestampMs,30);assert.equal(graph.provenance,'Browser inference');
  assert.equal(overlay.hands.length,2);assert.strictEqual(overlay.hands[0],imported.hands[0]);assert.strictEqual(overlay.hands[1],inferred.hands[0]);
  assert.strictEqual(overlay.handSources[0].frame,imported);assert.equal(overlay.handSources[0].handIndex,0);
  assert.strictEqual(overlay.handSources[1].frame,inferred);assert.equal(overlay.handSources[1].handIndex,0);
  assert.equal(overlay.faces.length,1);assert.equal(overlay.width,1280); // Canvas uses its source; graphs retain inference resolution.
});

test('empty or stale browser detections produce gaps instead of resurrecting a different hand stream',()=>{
  const h=harness();h.put('import',generic(),{receivedAt:950});
  const empty=h.put('browser',browser({handLandmarks:[],handedness:[]}),{live:true});
  assert.strictEqual(h.cameraHandFrame(),empty);assert.equal(h.cameraHandFrame().hands.length,0);
  h.setNow(3300);assert.equal(h.cameraHandFrame(),null);
  h.setStatus('paused');assert.strictEqual(h.cameraHandFrame(),empty); // Existing paused-frame guard; graph history deduplicates and expires it.
  h.setStatus('running');
  const resumed=h.put('browser',browser({timestamp_ms:31}),{live:true,receivedAt:3300});
  assert.strictEqual(h.cameraHandFrame(),resumed);
});

test('source switches reject prior browser output, while imported landmark previews keep their recorded identity',()=>{
  const h=harness(),frame=h.put('browser',browser(),{live:true});
  h.state.token=2;assert.equal(h.cameraHandFrame(),null);
  h.state.source={type:'landmarks',id:'recording'};assert.strictEqual(h.cameraHandFrame(),frame);
  h.state.source=null;assert.equal(h.cameraHandFrame(),null);
});

test('other hand providers are selected by receipt time, including empty channels, with no stale fallback',()=>{
  const h=harness(),older=h.put('old-import',generic(),{receivedAt:900});
  const latest=h.put('websocket',generic([],{timestamp_ms:1}),{live:true,receivedAt:1000});
  h.put('face-only',normalizeFrame({faces:[],timestamp_ms:999999}),{receivedAt:1100});
  assert.strictEqual(h.cameraHandFrame(),latest);assert.equal(h.cameraHandFrame().hands.length,0);
  h.setNow(3300);assert.equal(h.cameraHandFrame(),null);
  h.state.telemetry.delete('websocket');assert.strictEqual(h.cameraHandFrame(),older);
});

test('tracker crop/screen coordinates and disallowed RGB metadata remain outside the camera graph',()=>{
  const h=harness();
  h.put('hands-tracker',normalizeFrame({type:'hand_telemetry',hands:[{handedness:'Right',thumb_tip:{x:0.3,y:0.4},index_tip:{x:0.5,y:0.6}}]}));
  h.put('gaze-tracker',normalizeFrame({type:'snapshot',screen:{width_px:1920,height_px:1080},gaze:{x_px:300,y_px:400}}));
  assert.equal(h.cameraHandFrame(),null);
  const native=h.put('native',generic(undefined,{api_version:2}));
  assert.strictEqual(h.cameraHandFrame(),native);
  h.setAllowed(false);assert.equal(h.cameraHandFrame(),null);
});

test('paired snapshots remain authoritative despite later browser/native traffic',()=>{
  const h=harness(),paired=h.put('paired-1',generic(undefined,{api_version:2,synchronized:true,image_resolution:{width:1024,height:768}}));
  h.state.source={id:'snapshot',type:'image',pairedLandmarkKey:'paired-1'};
  h.put('browser',browser({inference:{location:'browser',engine:'MediaPipe',sourceId:'1:snapshot',generation:3}}),{live:true,receivedAt:1100});
  h.put('native',generic(undefined,{api_version:2}),{live:true,receivedAt:1200});
  assert.strictEqual(h.cameraHandFrame(),paired);assert.equal(h.cameraOverlayFrame().hands.length,1);
  h.setNow(9000);assert.strictEqual(h.cameraHandFrame(),paired);
  h.put('paired-1',normalizeFrame({api_version:2,synchronized:true,faces:[]}));
  assert.equal(h.cameraHandFrame(),null);
});

test('scene graphs retain scene raw/time/dimensions and never use main hands, including when main is off',()=>{
  const h=harness(),main=h.put('main-provider',generic());
  const scene={sourceId:'scene:7:browser:cpd',generation:7,sourceName:'Scene CPD',type:'camera',streaming:true,width:512,height:640,element:{videoWidth:512,videoHeight:640},mirror:false,role:'ir'};
  h.setScene(scene);
  const observed=h.put('browser',browser({image_resolution:{width:512,height:640},timestamp_ms:444,
    inference:{sourceId:scene.sourceId,generation:20,engine:'MediaPipe',location:'browser'}}),{live:true});
  const graph=h.trackingHandFrame();
  assert.strictEqual(graph,observed);assert.strictEqual(graph.raw,observed.raw);assert.equal(graph.timestampMs,444);
  assert.equal(graph.width,512);assert.equal(graph.height,640);assert.equal(h.trackingSource().mirror,false);
  assert.strictEqual(h.cameraHandFrame(),main);assert.equal(h.cameraOverlayFrame().hands.length,1);
  assert.strictEqual(h.cameraOverlayFrame().handSources[0].frame,main);
  h.state.source=null;assert.strictEqual(h.trackingHandFrame(),observed);assert.equal(h.cameraOverlayFrame().hands.length,0);
});

test('an empty, stale, reconnecting or differently shaped scene result creates a graph gap without main fallback',()=>{
  const h=harness();h.put('main',browser(),{live:true});
  const scene={sourceId:'scene:7:browser:cpd',generation:7,type:'camera',width:512,height:640,element:{},role:'ir'};
  h.setScene(scene);assert.equal(h.trackingHandFrame(),null);
  const empty=h.put('browser',browser({image_resolution:{width:512,height:640},handLandmarks:[],handedness:[],
    inference:{sourceId:scene.sourceId,generation:4,engine:'MediaPipe',location:'browser'}}),{live:true});
  assert.strictEqual(h.trackingHandFrame(),empty);
  h.setNow(3300);assert.equal(h.trackingHandFrame(),null);
  h.setNow(1000);h.setScene({...scene,sourceId:'scene:8:browser:cpd',generation:8});assert.equal(h.trackingHandFrame(),null);
  h.setScene(null,{connecting:true});assert.equal(h.trackingSource(),null);assert.equal(h.trackingHandFrame(),null);
  h.setScene({...scene,width:640,height:480});assert.equal(h.trackingHandFrame(),null);
});

test('unbound imported or SDK data stays inspectable but cannot overlay live camera pixels',()=>{
  const h=harness(),unbound=h.put('unbound',generic(undefined,{sourceId:null}));
  h.put('sdk',generic(undefined,{sourceId:null,api_version:2}));
  assert.equal(h.cameraOverlayFrame().hands.length,0);assert.equal(h.trackingHandFrame(),null);
  assert.strictEqual(h.state.telemetry.get('unbound').frame,unbound);
  h.state.source={type:'landmarks',id:'coordinate-preview'};
  assert.equal(h.cameraOverlayFrame().hands.length,2);assert.ok(h.trackingHandFrame());
});

test('an explicit main coordinate preview cannot absorb live scene inference',()=>{
  for(const type of ['sample','landmarks']){
    const h=harness(),imported=h.put('import',generic());h.state.source={type,id:'coordinate-preview'};
    const scene={sourceId:'scene:7:browser:cpd',generation:7,type:'camera',width:512,height:640,element:{},role:'ir'};
    h.setScene(scene);
    const sceneFrame=h.put('browser',browser({image_resolution:{width:512,height:640},
      inference:{sourceId:scene.sourceId,generation:4,engine:'MediaPipe',location:'browser'}}),{live:true});
    const overlay=h.cameraOverlayFrame();assert.equal(overlay.hands.length,1);assert.strictEqual(overlay.handSources[0].frame,imported);
    assert.strictEqual(h.trackingHandFrame(),sceneFrame);
  }
});
