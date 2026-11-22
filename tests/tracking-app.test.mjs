import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {selectCaptureSource, cameraRoleContextKey, cameraGazeContextKey, landmarkFrameMatchesSource} from '../dist/tracking-source.js';
import {selectGestureInput} from '../dist/gesture-input.js';
import {extractSceneGaze} from '../dist/scene-gaze.js';
import {borrowCameraSource} from '../dist/borrowed-camera-source.js';
import {normalizeCaptureSourceHint} from '../dist/capture-store.js';

const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const block=(start,end)=>{const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a);return app.slice(a,b);};
const scene={kind:'scene',sourceId:'scene:7:browser:cpd',generation:7,type:'camera',live:true,sourceName:'Scene',width:512,height:640,role:'ir',mirror:false};
const main={kind:'main',sourceId:'15:rgb',generation:15,type:'camera',live:true,sourceName:'RGB',width:1280,height:720,role:'rgb',mirror:true};
const frameFor=source=>({source:'Browser inference',width:source.width,height:source.height,faces:[],hands:[],poses:[],raw:{inference:{sourceId:source.sourceId,generation:91}}});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('every live tracking observation is consumed before telemetry rendering can replace its pinch edge',()=>{
  const state={source:{type:'camera'},telemetry:new Map(),lastUiUpdate:0},observed=[],order=[];
  const ingest=vm.runInNewContext(block('function ingestFrame(','function updateTelemetry(')+'\ningestFrame;',{
    state,trackingSource:()=>main,landmarkFrameMatchesSource,performance:{now:()=>1000},
    stopVisual(){assert.fail('camera input must stay active');},
    updateCaptureGesture(){observed.push(state.telemetry.get('browser').frame);order.push('gesture');},
    showLandmarkPreview(){order.push('preview');},updateTelemetry(){order.push('telemetry');}
  });
  const frames=[10,20,30,40,50].map(timestampMs=>({...frameFor(main),timestampMs}));
  for(const frame of frames)ingest(frame,{key:'browser',live:true});
  assert.deepEqual(observed,frames,'five results between paints must remain five gesture observations');
  assert.deepEqual(order.slice(0,3),['gesture','preview','telemetry']);
  assert.equal(order.filter(value=>value==='telemetry').length,1,'UI telemetry remains throttled');
  assert.equal(observed.at(-1).hands.length,0,'fresh hand loss is also consumed immediately');
  ingest({...frameFor(main),timestampMs:60},{key:'import',live:false});
  assert.equal(observed.length,5,'nonlive imports cannot drive capture actions');
});

test('actual scene gaze uses selected-camera eyes and camera-session generation, never an unbound SDK display stream',()=>{
  let selected=scene,preferred=null;const calls=[];
  const browser={frame:frameFor(scene),live:true,changedAt:950};
  const state={token:15,telemetry:new Map([['browser',browser],['sdk',{frame:{source:'Logitech Gaze Tracker',gaze:{x:.3,y:.4}},live:true,changedAt:999}]]),sockets:new Map([['sdk',{generation:'connection'}]])};
  const signal={sourceId:scene.sourceId,generation:7,method:'browser-iris',inputSignature:'512x640'};
  const get=vm.runInNewContext(block('function sceneGazeObservation(','async function pickSceneRegion(')+'\nsceneGazeSignal;',{
    state,performance:{now:()=>1000},trackingSource:()=>selected,browserTracking:{getState:()=>({status:'running',generation:91})},
    landmarkFrameMatchesSource,extractSceneGaze:(entry,options)=>{calls.push({entry,options});return {signal};},scenePins:{getCalibration:()=>preferred}
  });
  assert.strictEqual(get(),signal);assert.strictEqual(calls[0].entry,browser);
  assert.equal(calls[0].options.generation,7);assert.equal(calls[0].options.inferenceGeneration,91);
  state.telemetry.delete('browser');assert.equal(get(),null);assert.equal(calls.length,1);
  state.telemetry.set('browser',{frame:frameFor(main),live:true,changedAt:999});assert.equal(get(),null);
  state.telemetry.set('browser',browser);preferred={gazeSource:{...signal,sourceId:'gaze:sdk'}};assert.equal(get(),null);
  preferred=null;selected=null;assert.equal(get(),null);
});

test('with no scene, enabled main-camera face tracking supplies genuine iris features and missing eyes remain unavailable',()=>{
  const points=Array.from({length:478},(_,index)=>({index,x:.5,y:.5,z:0}));
  const set=(index,x,y)=>{points[index]={index,x,y,z:0};};set(1,.5,.52);
  for(const [ids,x]of [[[33,133,159,145,468,469,470,471,472],.35],[[362,263,386,374,473,474,475,476,477],.65]]){
    set(ids[0],x-.05,.36);set(ids[1],x+.05,.36);set(ids[2],x,.335);set(ids[3],x,.385);set(ids[4],x,.36);
    [[.01,0],[0,-.01],[-.01,0],[0,.01]].forEach(([dx,dy],i)=>set(ids[5+i],x+dx,.36+dy));
  }
  const frame=frameFor(main);frame.timestampMs=980;frame.faces=[{points,confidence:.95,topology:'mediapipe'}];
  Object.assign(frame.raw.inference,{engine:'MediaPipe',location:'browser',taskSamples:{face:{timestampMs:980,ageMs:0,stale:false}}});
  const state={telemetry:new Map([['browser',{frame,live:true,changedAt:995,receivedAt:995}]])};
  const get=vm.runInNewContext(block('function sceneGazeObservation(','async function pickSceneRegion(')+'\nsceneGazeSignal;',{
    state,performance:{now:()=>1000},trackingSource:()=>main,browserTracking:{getState:()=>({status:'running',generation:91})},
    landmarkFrameMatchesSource,extractSceneGaze,scenePins:{getCalibration:()=>null}
  });
  const result=get();assert.ok(result);assert.equal(result.sourceId,main.sourceId);assert.equal(result.generation,main.generation);
  assert.equal(result.workerGeneration,91);assert.equal(result.method,'browser-iris-head-v1');
  frame.faces=[];assert.equal(get(),null);
});

test('eye readiness preserves the actual extractor rejection instead of collapsing it to a connected-camera label',()=>{
  const frame=frameFor(main),state={telemetry:new Map([['browser',{frame,live:true,changedAt:995}]])};
  const failure={status:'iris-uncertain',reason:'Both open eyes and their irises must be clear enough.',signal:null};
  const api=vm.runInNewContext(block('function sceneGazeObservation(','async function pickSceneRegion(')+'\n({sceneGazeObservation,sceneGazeSignal});',{
    state,performance:{now:()=>1000},trackingSource:()=>main,browserTracking:{getState:()=>({status:'running',generation:91})},
    landmarkFrameMatchesSource,extractSceneGaze:()=>failure,scenePins:{getCalibration:()=>null}
  });
  assert.strictEqual(api.sceneGazeObservation(),failure);assert.equal(api.sceneGazeSignal(),null);
});

test('capture roles borrow existing streams independently of tracking and never create an auxiliary resume identity for main',async()=>{
  let current={...main,element:{videoWidth:1280,videoHeight:720,readyState:2}},secondary=null,secondaryState={connected:false};
  const state={objectRole:'main',captureRole:'auto'},sceneCapture={sourceId:'browser:cpd',generation:7,width:512,height:640,capture(){},retain(){},isActive:()=>true};
  const api=vm.runInNewContext(block('function gazeCaptureSource(){','function openGazeSettings(')+'\n({gazeCaptureSource,objectCaptureSource});',{
    state,mainVisualSource:()=>current,secondaryController:{getCaptureSource:()=>secondary,getState:()=>secondaryState},borrowCameraSource,selectCaptureSource
  });
  const get=api.gazeCaptureSource;
  const borrowed=get();assert.equal(borrowed.kind,'main');assert.equal(borrowed.sourceId,main.sourceId);assert.equal(borrowed.mirrored,false);
  const lease=await borrowed.retain();assert.equal(lease.kind,'camera');assert.equal(lease.stream,null);assert.equal(lease.resumeHint,undefined);
  assert.throws(()=>normalizeCaptureSourceHint(lease),/auxiliary camera/);
  secondary=sceneCapture;const activeScene=get();assert.equal(activeScene.kind,'scene');assert.equal(activeScene.sourceId,secondary.sourceId);assert.strictEqual(activeScene.retain,secondary.retain);
  assert.equal(api.objectCaptureSource().kind,'main','object snapshots stay on main even while gaze pins prefer scene');
  state.objectRole='scene';assert.equal(api.objectCaptureSource().sourceId,sceneCapture.sourceId);
  state.objectRole='main';
  state.captureRole='main';assert.equal(get().kind,'main');
  state.captureRole='scene';secondary=null;assert.equal(get(),null,'explicit missing scene does not borrow main');
  state.captureRole='auto';secondaryState={connecting:true};assert.equal(get(),null,'automatic capture waits for a scene which is opening');
  state.captureRole='main';assert.equal(get().kind,'main','an explicit main choice ignores scene startup');
  current=null;assert.equal(lease.isActive(),false,'main stop invalidates its borrowed pins');
  current={...main,type:'file',live:false};assert.equal(get(),null);
});

test('gaze demand follows the chosen tracking camera when capture, calibration or its dialog needs eyes',()=>{
  let selected=main,capture=scene,calibration=null;const demands=[];
  const state={trackingRole:'main',captureRole:'auto',gazeDialogOpen:false};
  const refresh=vm.runInNewContext(block('function refreshTrackingSource(){','function mainOverlaySource(')+'\nrefreshTrackingSource;',{
    state,trackingSource:()=>selected,gazeCaptureSource:()=>capture,objectCaptureSource:()=>main,cameraRoleContextKey,cameraGazeContextKey,objectWarmSource:null,gazeDebug:null,
    scenePins:{getCalibration:()=>calibration,clearCalibration(){calibration=null;}},dismissCaptureGesture(){},
    browserTracking:{setSceneGazeEnabled:value=>demands.push(value),sourceChanged:()=>true}
  });
  refresh();assert.equal(demands.at(-1),true,'default RGB eyes can map to independent scene capture');
  capture=null;refresh();assert.equal(demands.at(-1),false);
  state.gazeDialogOpen=true;refresh();assert.equal(demands.at(-1),true);
  state.gazeDialogOpen=false;refresh();assert.equal(demands.at(-1),false);
  calibration={gazeSource:{sourceId:main.sourceId,generation:main.generation}};refresh();assert.equal(demands.at(-1),true);
  calibration={gazeSource:{sourceId:main.sourceId,generation:main.generation-1}};refresh();assert.equal(demands.at(-1),false);
  selected=scene;refresh();assert.equal(demands.at(-1),false,'scene tracking alone does not imply an available capture target');
  capture=main;refresh();assert.equal(demands.at(-1),true,'roles also support scene eyes with main capture');
  selected=null;state.gazeDialogOpen=true;refresh();assert.equal(demands.at(-1),false);
});

test('role changes are immediate, cancel pending actions and preserve calibration for object-only changes',()=>{
  const state={trackingRole:'main',objectRole:'main',captureRole:'auto',gazeDialogOpen:false};
  let calibration=null,cancelled=0,cleared=0,reconciled=0;
  const scenePins={getCalibration:()=>calibration,clearCalibration(){calibration=null;cleared++;}};
  const api=vm.runInNewContext(block('function changeCameraRole(','function captureGestureFrame(')+
    block('function refreshTrackingSource(){','function mainOverlaySource(')+'\n({changeCameraRole,refreshTrackingSource});',{
    state,cameraRoleContextKey,cameraGazeContextKey,objectWarmSource:null,gazeDebug:null,scenePins,
    trackingSource:()=>state.trackingRole==='scene'?scene:main,
    objectCaptureSource:()=>state.objectRole==='scene'?scene:main,
    gazeCaptureSource:()=>state.captureRole==='main'?main:scene,
    dismissCaptureGesture(){cancelled++;},updateSignals(){},callWorkspace:{render(){}},
    browserTracking:{setSceneGazeEnabled(){},sourceChanged(){reconciled++;return new Promise(()=>{});}}
  });
  api.refreshTrackingSource();
  const saved={gazeSource:{sourceId:main.sourceId,generation:main.generation},scene};calibration=saved;
  const initial={cancelled,cleared,reconciled};
  assert.equal(api.changeCameraRole('object','scene'),true,'does not await pending model startup');
  assert.equal(state.objectRole,'scene');assert.equal(cancelled,initial.cancelled+1);assert.equal(reconciled,initial.reconciled+1);
  assert.strictEqual(calibration,saved);assert.equal(cleared,initial.cleared);
  api.refreshTrackingSource();assert.strictEqual(calibration,saved,'unchanged camera/model status preserves calibration');
  assert.equal(api.changeCameraRole('tracking','scene'),true);assert.equal(calibration,null);assert.equal(cleared,initial.cleared+1);
  assert.equal(api.changeCameraRole('capture','main',{signal:{aborted:true}}),false);assert.equal(state.captureRole,'auto');
  assert.equal(api.changeCameraRole('capture','main',{isCurrent:()=>false}),false);
  assert.throws(()=>api.changeCameraRole('object','auto'),/camera role/);
});

test('snapshot freezing uses only the chosen object camera in original unmirrored coordinates',()=>{
  const frames={main:{width:1280,height:720},scene:{width:512,height:640}},calls=[];
  let selected={label:'RGB',isActive:()=>true,capture(region,limits){calls.push({source:'main',region,limits});return frames.main;}};
  const freeze=vm.runInNewContext(block('function captureGestureFrame(){','function openGazeSettings(')+'\ncaptureGestureFrame;',{
    objectCaptureSource:()=>selected
  });
  assert.strictEqual(freeze(),frames.main);
  assert.equal(JSON.stringify(calls[0].region),JSON.stringify({x:0,y:0,width:1,height:1}));
  assert.equal(calls[0].limits.maxWidth,1600);assert.equal(calls[0].limits.maxHeight,1200);
  selected={label:'Scene',capture(region,limits){calls.push({source:'scene',region,limits});return frames.scene;}};
  assert.strictEqual(freeze(),frames.scene);assert.equal(calls[1].source,'scene');
  selected={isActive:()=>false,capture(){throw new Error('Stopped pixels must not be captured');}};
  assert.throws(freeze,/selected object camera/);
  selected=null;assert.throws(freeze,/selected object camera/);
});

function gestureHarness({capture={...scene,sourceId:'browser:cpd',label:'Scene'},object={...main,label:'RGB'},resultSource=main,gesture='snapshot'}={}){
  const calls={captures:[],inputs:[],pinInputs:[],pins:[],frozen:0,states:[]};let selected=main,captureSource=capture,objectSource=object,resolveCapture;
  const pending=new Promise(resolve=>{resolveCapture=resolve;});
  const intent={frame:{width:512,height:640}};
  const state={trackingRole:'main',objectRole:'main',captureRole:'auto',view:'call',probing:false,captureGesture:{actionState:'idle'},telemetry:new Map([['browser',{frame:frameFor(resultSource),live:true,changedAt:990,receivedAt:990}]])};
  const actionKey=()=>cameraRoleContextKey({...state,tracking:selected,object:objectSource,capture:captureSource});
  let busy=false;
  const context={state,performance:{now:()=>1000},trackingSource:()=>selected,objectCaptureSource:()=>objectSource,gazeCaptureSource:()=>captureSource,cameraRoleContextKey,cameraActionKey:actionKey,
    browserTracking:{getState:()=>({status:'running'})},document:{hidden:false,querySelector:()=>null},captureBoard:{isBusy:()=>false},
    selectGestureInput,sourceOverlayFrames:()=>[...state.telemetry.values()].filter(entry=>landmarkFrameMatchesSource(entry.frame,selected)).map(entry=>entry.frame),gestureActionSource:null,objectWarmSource:actionKey(),gestureResultTimer:null,gestureActionId:0,
    gestureDetector:{update(frame,options){calls.inputs.push({frame,options});return {triggered:options.active&&gesture==='snapshot',phase:'cooldown',completed:gesture==='snapshot'?2:0,pinched:false};}},
    pinGestureDetector:{update(frame,options){calls.pinInputs.push({frame,options});return {kind:'pin',triggered:options.active&&gesture==='pin',phase:'latched',holding:false};}},
    objectCapture:{isBusy:()=>busy,capture:options=>{calls.captures.push(options);return pending;}},
    objectDetector:{prepare:()=>Promise.resolve({model:{name:'test'}})},
    scenePins:{isBusy:()=>false,freezeIntent:()=>{calls.frozen++;return intent;},pin:async value=>{calls.pins.push(value);return {status:'pinned'};}},
    callWorkspace:{render(){}},dismissCaptureGesture(){},objectCaptureBlockReason:()=>null,objectCaptureChanged:value=>calls.states.push(value),clearGestureFeedback(){},
    clearTimeout(){},showView(){},log(){},finishGestureAction(){}};
  const update=vm.runInNewContext(block('function updateCaptureGesture(){','function showCallHelp(')+'\nupdateCaptureGesture;',context);
  return {calls,state,context,update,intent,resolveCapture,actionKey,setBusy:value=>{busy=value;},changeCapture:value=>{captureSource=value;},changeObject:value=>{objectSource=value;},changeTracking:value=>{selected=value;},changeRole:(role,value)=>{state[role+'Role']=value;}};
}

test('double pinch freezes only the selected snapshot camera and never starts a gaze pin',async()=>{
  for(const outcome of [{status:'saved',method:'left-hand-region'},{status:'not-found'},{status:'error',message:'Object model unavailable'}]){
    const h=gestureHarness();h.update();
    assert.equal(h.calls.inputs[0].options.sourceId,main.sourceId);
    assert.equal(h.calls.inputs[0].frame.raw.inference.sourceId,main.sourceId);
    assert.equal(h.calls.captures[0].sourceId,h.actionKey());assert.equal(h.calls.captures[0].sourceLabel,'RGB');
    h.resolveCapture(outcome);await flush();assert.equal(h.calls.pins.length,0);assert.equal(h.calls.frozen,0);
    assert.equal(h.state.captureGesture.kind,'snapshot');
  }
});

test('missing snapshot camera or wrong-camera hands cannot turn a double pinch into a pin',async()=>{
  const unavailable=gestureHarness({object:null});unavailable.update();await flush();
  assert.equal(unavailable.calls.captures.length,0);assert.equal(unavailable.calls.pins.length,0);assert.equal(unavailable.calls.frozen,0);
  assert.match(unavailable.calls.states.at(-1).message,/snapshot camera/);
  const wrong=gestureHarness({resultSource:scene});wrong.update();await flush();
  assert.equal(wrong.calls.inputs[0].options.active,false);assert.equal(wrong.calls.captures.length,0);assert.equal(wrong.calls.pins.length,0);
});

test('a completed two-finger hold creates only one scene pin and does not run snapshot inference',async()=>{
  const h=gestureHarness({gesture:'pin'});h.update();await flush();
  assert.equal(h.calls.captures.length,0);assert.equal(h.calls.frozen,1);assert.strictEqual(h.calls.pins[0],h.intent);
  assert.equal(h.state.captureGesture.kind,'pin');assert.equal(h.state.captureGesture.actionState,'pinning');
  assert.strictEqual(h.calls.pinInputs[0].frame,h.calls.inputs[0].frame);
});

test('busy work disables pin triggers but continues observing release so held poses cannot repeat',async()=>{
  const h=gestureHarness({gesture:'pin'});h.setBusy(true);h.update();await flush();
  assert.equal(h.calls.pinInputs.length,1);assert.equal(h.calls.pinInputs[0].options.active,false);
  assert.ok(h.calls.pinInputs[0].frame);assert.equal(h.calls.captures.length,0);assert.equal(h.calls.pins.length,0);
  h.context.document.hidden=true;h.setBusy(false);h.update();assert.equal(h.calls.pinInputs.at(-1).options.active,false);
});

test('actual overlay rendering fits scene pixels and never applies the main mirror to scene labels',()=>{
  const calls=[];
  const makeCanvas=()=>({hidden:true,style:{},getContext:()=>({setTransform(){},clearRect(){}})});
  const mainCanvas=makeCanvas(),sceneCanvas=makeCanvas();
  const mainFrame={faces:[],hands:[],poses:[]},sceneFrame={faces:[],hands:[{}],poses:[]};
  const elements={overlay:mainCanvas,videoStage:{clientWidth:1280,clientHeight:720},overlayBadge:{},sampleCanvas:{},remoteImage:{}};
  const sceneTarget={canvas:sceneCanvas,stage:{clientWidth:1280,clientHeight:720},element:{videoWidth:512,videoHeight:640}};
  const draw=vm.runInNewContext(block('function drawSourceOverlay(','function drawTracker(')+'\ndrawOverlay;',{
    state:{source:{type:'camera'},mirror:true},$:id=>elements[id],video:{videoWidth:1280,videoHeight:720},devicePixelRatio:1,
    overlayEnabled:()=>true,overlayOptions:()=>({mirror:true,handLabels:true,fingerLabels:true}),cameraOverlayFrame:()=>mainFrame,
    trackingSource:()=>scene,sourceOverlayFrames:()=>[sceneFrame],combinedOverlayFrame:frames=>frames[0],
    secondaryController:{getOverlayTarget:()=>sceneTarget},drawLandmarks:(ctx,frame,options)=>calls.push({frame,options})
  });
  draw();assert.equal(mainCanvas.hidden,true);assert.equal(sceneCanvas.hidden,false);assert.equal(calls.length,1);
  assert.strictEqual(calls[0].frame,sceneFrame);assert.equal(calls[0].options.mirror,false);
  assert.equal(calls[0].options.width,576);assert.equal(calls[0].options.height,720);assert.equal(sceneCanvas.style.left,'352px');
});

test('stopping the main reader keeps scene inference and its original telemetry, then reconciles with no main source',()=>{
  for(const keepScene of [true,false]){
    let stops=0,trackStops=0,reconciles=0;
    const selected=keepScene?scene:main,entry={frame:frameFor(selected),live:true,changedAt:1};
    const state={source:{id:'rgb',type:'camera'},token:15,stream:{getTracks:()=>[{stop(){trackStops++;}}]},frameCallback:null,imageToken:0,telemetry:new Map([['browser',entry]]),frames:[]};
    const element={classList:{remove(){}},pause(){},removeAttribute(){},load(){}};
    const source=block('function clearTelemetry(','function stopRecording(')+block('function stopVisual(','function activateSource(');
    const stop=vm.runInNewContext(source+'\nstopVisual;',{
      state,trackingSource:()=>keepScene?scene:state.source?main:null,landmarkFrameMatchesSource,
      browserTracking:{stopSource(){stops++;}},browserPhoto:{stop(){}},captureBoard:{stopPrimaryPins(){}},nativeController:{stop(){}},
      objectDetector:{cancel(){}},objectWarmSource:null,dismissCaptureGesture(){},stopRecording(){},stopTracks:stream=>stream?.getTracks().forEach(track=>track.stop()),
      video:element,$:()=>element,clearTimeout(){},refreshTrackingSource(){reconciles++;assert.equal(state.source,null);},
      updateTelemetry(){},renderDevices(){},renderControls(){},updateSignals(){}
    });
    stop();assert.equal(trackStops,1);assert.equal(stops,keepScene?0:1);assert.equal(reconciles,1);
    assert.equal(state.telemetry.size,keepScene?1:0);if(keepScene)assert.strictEqual(state.telemetry.get('browser'),entry);
  }
});

test('a scene inference frame cannot create a coordinate-only main preview after main camera is stopped',()=>{
  const state={source:null};
  const preview=vm.runInNewContext(block('function showLandmarkPreview(','function ingestFrame(')+'\nshowLandmarkPreview;',{
    state,trackingSource:()=>scene,landmarkFrameMatchesSource,$(){throw new Error('Main preview must not be accessed');}
  });
  preview(frameFor(scene),{live:true});assert.equal(state.source,null);
});
