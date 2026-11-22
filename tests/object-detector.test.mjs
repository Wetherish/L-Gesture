import test from 'node:test';
import assert from 'node:assert/strict';
import {createObjectDetector,normalizeObjectDetections,objectImageDimensions,OBJECT_DETECTION_MODEL} from '../dist/object-detector.js';
import {createObjectDetectorWorkerRuntime,installObjectNetworkPolicy,installObjectModuleLoader,inspectObjectGraphics} from '../dist/object-detector-worker.js';

const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const bitmap=(width=640,height=480)=>({width,height,closed:0,close(){this.closed++;}});
const canvas=()=>({width:640,height:480});
const rawDetection=(box={originX:64,originY:48,width:320,height:240},score=.9,label='cup')=>({boundingBox:box,categories:[{index:47,categoryName:label,score}]});
const handFrame=(width=640,height=480)=>({type:'browser_inference',provenance:'Browser inference',coordinate_space:'normalized',
  image_resolution:{width,height},handLandmarks:[],handWorldLandmarks:[],handedness:[],inference:{location:'browser',engine:'MediaPipe'}});

function harness(options={}){
  let clock=1,nextTimer=0;const timers=new Map(),workers=[],states=[],images=[];
  class Worker {
    messages=[];terminated=false;
    constructor(url,config){this.url=url;this.config=config;workers.push(this);}
    postMessage(message,transfer){this.messages.push({message,transfer});}
    emit(message){this.onmessage?.({data:message});}
    terminate(){this.terminated=true;}
  }
  const controller=createObjectDetector({WorkerClass:Worker,now:()=>clock,
    createBitmap:async image=>{const value=bitmap(image.width,image.height);images.push(value);return value;},
    onState:value=>states.push(value),startupTimeoutMs:1000,bitmapTimeoutMs:100,inferenceTimeoutMs:200,
    setTimer:(callback,ms)=>{const id=++nextTimer;timers.set(id,{callback,at:clock+ms});return id;},clearTimer:id=>timers.delete(id),...options});
  const worker=()=>workers.at(-1);
  const generation=()=>worker().messages.find(row=>row.message.type==='init').message.generation;
  function ready(){worker().emit({type:'ready',generation:generation(),delegate:'GPU'});}
  async function prepare(){const pending=controller.prepare();ready();await pending;return worker();}
  function lastFrame(){return worker()?.messages.filter(row=>row.message.type==='detect').at(-1)?.message;}
  function result(frame=lastFrame(),extra={}){
    worker().emit({type:'result',generation:frame.generation,id:frame.id,width:frame.width,height:frame.height,
      raw:{detections:[rawDetection()]},handFrame:frame.includeHands?handFrame(frame.width,frame.height):null,delegate:'GPU',latencyMs:20,...extra});
  }
  async function advance(ms){clock+=ms;for(const [id,timer] of [...timers])if(timer.at<=clock){timers.delete(id);timer.callback();}await settle();}
  return {controller,workers,worker,states,images,timers,prepare,ready,lastFrame,result,advance};
}

test('model and input limits are explicit; CSS-like or oversized images are rejected',()=>{
  assert.equal(OBJECT_DETECTION_MODEL.inputWidth,448);assert.equal(OBJECT_DETECTION_MODEL.bytes,12138859);
  assert.deepEqual(objectImageDimensions(canvas()),{width:640,height:480});
  for(const value of [null,{width:0,height:2},{width:2.5,height:4},{width:20000,height:2},{width:8192,height:8192}])
    assert.throws(()=>objectImageDimensions(value));
});

test('pixel boxes normalize against the input, clip partially visible boxes, and retain categories',()=>{
  const row=rawDetection({originX:-20,originY:50,width:120,height:300});
  row.categories.push({index:1,categoryName:'bottle',displayName:'Bottle',score:.95});
  const result=normalizeObjectDetections({detections:[row]},200,200);
  assert.deepEqual(result[0].bbox,{x:0,y:.25,width:.5,height:.75});
  assert.deepEqual(result[0].pixelBox,{originX:-20,originY:50,width:120,height:300});
  assert.equal(result[0].label,'Bottle');assert.equal(result[0].score,.95);assert.equal(result[0].categories[1].categoryName,'cup');
});

test('empty detection is valid, but malformed results and impossible candidates never become objects',()=>{
  assert.deepEqual(normalizeObjectDetections({detections:[]},640,480),[]);
  assert.throws(()=>normalizeObjectDetections({},640,480),{code:'OBJECT_RESULT_INVALID'});
  const bad=[rawDetection({originX:700,originY:0,width:10,height:10}),rawDetection({originX:0,originY:0,width:-1,height:30}),
    rawDetection({originX:NaN,originY:0,width:10,height:30}),rawDetection(undefined,NaN),rawDetection(undefined,1.2)];
  assert.deepEqual(normalizeObjectDetections({detections:bad},640,480),[]);
});

test('prepare is lazy, shares one model load, and never opens a media source',async()=>{
  const h=harness();assert.equal(h.workers.length,0);assert.equal(h.controller.getState().ready,false);
  const first=h.controller.prepare(),second=h.controller.prepare();
  assert.equal(h.workers.length,1);assert.equal(h.worker().messages.length,1);assert.equal(h.worker().config.type,'module');
  h.ready();await Promise.all([first,second]);
  await h.controller.prepare();assert.equal(h.workers.length,1);assert.equal(h.controller.getState().status,'ready');
  h.controller.destroy();assert.equal(h.worker().terminated,true);assert.equal(h.timers.size,0);
});

test('detect freezes before loading, transfers one image, and returns matched raw-input coordinates',async()=>{
  const h=harness();const source=canvas();
  const pending=h.controller.detect(source);assert.equal(h.images.length,1,'bitmap creation starts synchronously');
  source.width=100;h.ready();await settle();const frame=h.lastFrame();
  assert.equal(frame.width,640);assert.equal(frame.includeHands,true);assert.equal(frame.timestampMs,1);
  assert.deepEqual(h.worker().messages.at(-1).transfer,[h.images[0]]);
  h.result();const result=await pending;
  assert.deepEqual(result.detections[0].bbox,{x:.1,y:.1,width:.5,height:.5});
  assert.equal(result.width,640);assert.equal(result.model.id,OBJECT_DETECTION_MODEL.id);assert.equal(result.handFrame.inference.location,'browser');
  assert.equal(h.controller.getState().completed,1);assert.equal(h.controller.getState().busy,false);h.controller.destroy();
});

test('ROI calls skip hand execution and empty object results do not reuse a previous frame',async()=>{
  const h=harness();await h.prepare();
  const first=h.controller.detect(canvas());await settle();h.result();await first;
  const second=h.controller.detect({width:200,height:300},{includeHands:false});await settle();
  assert.equal(h.lastFrame().includeHands,false);h.result(undefined,{raw:{detections:[]}});
  const result=await second;assert.deepEqual(result.detections,[]);assert.equal(result.handFrame,null);
  assert.equal(h.controller.getState().lastDetectionCount,0);h.controller.destroy();
});

test('only one detection can be pending; unrelated and late worker replies cannot release it',async()=>{
  const h=harness();await h.prepare();
  const pending=h.controller.detect(canvas());await settle();const frame=h.lastFrame();
  await assert.rejects(h.controller.detect(canvas()),{name:'BusyError'});assert.equal(h.images.length,1);
  h.result(frame,{id:frame.id+1});h.result(frame,{generation:frame.generation-1});assert.equal(h.controller.getState().busy,true);
  h.result(frame);await pending;assert.equal(h.controller.getState().completed,1);
  h.result(frame);assert.equal(h.controller.getState().completed,1);h.controller.destroy();
});

test('cancellation rejects preload and detection immediately and closes a bitmap arriving later',async()=>{
  const pendingBitmap=deferred(),h=harness({createBitmap:()=>pendingBitmap.promise});
  const loading=h.controller.prepare(),detecting=h.controller.detect(canvas());
  const rejectedLoad=assert.rejects(loading,{name:'AbortError'}),rejectedImage=assert.rejects(detecting,{name:'AbortError'});
  const oldWorker=h.worker();h.controller.cancel('Source switched.');await Promise.all([rejectedLoad,rejectedImage]);
  assert.equal(oldWorker.terminated,true);assert.equal(h.controller.getState().busy,false);assert.equal(h.timers.size,0);
  const image=bitmap();pendingBitmap.resolve(image);await settle();assert.equal(image.closed,1);assert.equal(oldWorker.messages.length,1);
  await h.prepare();assert.equal(h.workers.length,2);h.controller.destroy();
});

test('an abort after prepare completes does not cancel future work, but a detection abort does',async()=>{
  const h=harness(),preloadSignal=new AbortController();
  const preload=h.controller.prepare({signal:preloadSignal.signal});h.ready();await preload;
  preloadSignal.abort();assert.equal(h.controller.getState().ready,true);
  const abort=new AbortController(),pending=h.controller.detect(canvas(),{signal:abort.signal});await settle();
  const rejected=assert.rejects(pending,{name:'AbortError'});abort.abort();await rejected;
  assert.equal(h.worker().terminated,true);assert.equal(h.timers.size,0);h.controller.destroy();
});

test('already-aborted and invalid requests neither load a worker nor allocate a bitmap',async()=>{
  const h=harness(),abort=new AbortController();abort.abort();
  await assert.rejects(h.controller.prepare({signal:abort.signal}),{name:'AbortError'});
  await assert.rejects(h.controller.detect(canvas(),{signal:abort.signal}),{name:'AbortError'});
  await assert.rejects(h.controller.detect({width:0,height:1}),{code:'OBJECT_IMAGE_INVALID'});
  assert.equal(h.workers.length,0);assert.equal(h.images.length,0);h.controller.destroy();
});

test('model, bitmap and inference timeouts settle all work and permit a fresh worker',async()=>{
  const load=harness();const loading=load.controller.prepare();const loadReject=assert.rejects(loading,{code:'OBJECT_MODEL_TIMEOUT'});
  await load.advance(1001);await loadReject;assert.equal(load.worker().terminated,true);assert.equal(load.timers.size,0);load.controller.destroy();
  const bitmapPending=deferred(),image=harness({createBitmap:()=>bitmapPending.promise});await image.prepare();
  const capturing=image.controller.detect(canvas()),imageReject=assert.rejects(capturing,{code:'OBJECT_BITMAP_TIMEOUT'});
  await image.advance(101);await imageReject;const late=bitmap();bitmapPending.resolve(late);await settle();assert.equal(late.closed,1);image.controller.destroy();
  const inference=harness();await inference.prepare();const detecting=inference.controller.detect(canvas());await settle();
  const detectReject=assert.rejects(detecting,{code:'OBJECT_INFERENCE_TIMEOUT'});await inference.advance(201);await detectReject;
  assert.equal(inference.worker().terminated,true);await inference.prepare();assert.equal(inference.workers.length,2);inference.controller.destroy();
});

test('source mismatch in result dimensions fails instead of providing an incorrect crop',async()=>{
  const h=harness();await h.prepare();const pending=h.controller.detect(canvas());await settle();
  const rejected=assert.rejects(pending,{code:'OBJECT_RESULT_SIZE'});h.result(undefined,{width:448});await rejected;
  assert.equal(h.controller.getState().completed,0);assert.equal(h.worker().terminated,true);h.controller.destroy();
});

test('missing same-frame hand output is an error rather than a fallback to old landmarks',async()=>{
  const h=harness();await h.prepare();const pending=h.controller.detect(canvas());await settle();
  const rejected=assert.rejects(pending,{code:'OBJECT_HAND_RESULT_INVALID'});h.result(undefined,{handFrame:null});await rejected;h.controller.destroy();
});

function matchedPartialHands(frame){
  return {...handFrame(frame.width,frame.height),timestamp_ms:frame.timestampMs,frame_timestamp_ms:frame.timestampMs,
    inference:{location:'browser',engine:'MediaPipe',generation:frame.generation}};
}
const partialIssue={code:'OBJECT_MODEL_RUN',message:'Object model unavailable.\nTry again.',stage:'objects:detect:CPU'};

test('a matched partial hand result is accepted only for an explicit hand-enabled frozen capture',async()=>{
  const h=harness();await h.prepare();const pending=h.controller.detect(canvas());await settle();const frame=h.lastFrame();
  h.result(frame,{raw:{detections:[]},handFrame:matchedPartialHands(frame),objectError:partialIssue});
  const result=await pending;assert.deepEqual(result.detections,[]);assert.equal(result.handFrame.frame_timestamp_ms,frame.timestampMs);
  assert.equal(result.objectError.message,'Object model unavailable. Try again.');assert.equal(result.objectError.stage,'objects:detect:CPU');
  assert.equal(h.controller.getState().objectError.message,result.objectError.message);assert.equal(h.controller.getState().completed,1);
  h.controller.destroy();
});

test('partial object failure cannot become a silent empty success in an object-only gaze operation',async()=>{
  const h=harness();await h.prepare();const pending=h.controller.detect(canvas(),{includeHands:false});await settle();
  const rejected=assert.rejects(pending,{code:'OBJECT_MODEL_RUN'});h.result(undefined,{raw:{detections:[]},objectError:partialIssue});
  await rejected;assert.equal(h.controller.getState().completed,0);h.controller.destroy();
});

test('partial hand results reject previous-image timestamps, wrong workers and mixed invented detections',async()=>{
  for(const change of ['timestamp','worker','coordinates','detections']){
    const h=harness();await h.prepare();const pending=h.controller.detect(canvas());await settle();const frame=h.lastFrame(),hands=matchedPartialHands(frame);
    if(change==='timestamp')hands.frame_timestamp_ms=frame.timestampMs-1;
    if(change==='worker')hands.inference.generation--;
    if(change==='coordinates')hands.coordinate_space='normalized-mirrored';
    const rejected=assert.rejects(pending,{code:'OBJECT_HAND_RESULT_INVALID'});
    h.result(frame,{handFrame:hands,raw:{detections:change==='detections'?[rawDetection()]:[]},objectError:partialIssue});
    await rejected;assert.equal(h.controller.getState().completed,0);h.controller.destroy();
  }
});

test('a partial capture after model teardown resolves safely and the next request starts a fresh worker',async()=>{
  const h=harness();await h.prepare();const pending=h.controller.detect(canvas());await settle();const frame=h.lastFrame(),worker=h.worker();
  h.result(frame,{handFrame:matchedPartialHands(frame),raw:{detections:[]},objectError:partialIssue,reloadRequired:true});
  assert.equal((await pending).detections.length,0);assert.equal(worker.terminated,true);assert.equal(h.controller.getState().ready,false);
  await h.prepare();assert.equal(h.workers.length,2);assert.equal(h.controller.getState().objectError,null);h.controller.destroy();
});

test('synchronous cancellation from status prevents worker startup and stale bitmap transmission',async()=>{
  let controller;const h=harness({onState:state=>{if(state.status==='loading')controller.cancel('Source changed in callback.');}});controller=h.controller;
  await assert.rejects(controller.detect(canvas()),{name:'AbortError'});await settle();
  assert.equal(h.workers.length,0);assert.equal(h.images[0].closed,1);assert.equal(h.timers.size,0);controller.destroy();
});

test('destroy is final and an unavailable worker reports an actionable failure',async()=>{
  const h=harness({WorkerClass:null});await assert.rejects(h.controller.prepare(),{code:'OBJECT_WORKER_UNAVAILABLE'});
  assert.equal(h.controller.getState().status,'error');h.controller.destroy();h.controller.destroy();
  await assert.rejects(h.controller.prepare(),{code:'OBJECT_DETECTOR_DESTROYED'});
  await assert.rejects(h.controller.detect(canvas()),{code:'OBJECT_DETECTOR_DESTROYED'});
});

const graphicsCanvas=()=>({getContext:()=>({isContextLost:()=>false,getParameter:()=> 'Mock WebGL'})});
function sdkMock({create,detect}={}){
  const records=[];
  const factory=name=>({createFromOptions:async(fileset,options)=>{
    const record={name,fileset,options,closed:0,calls:[]};records.push(record);
    if(create)await create(record);
    return {detect(image){record.calls.push(image);return detect?detect(record,image):name==='objects'?{detections:[rawDetection()]}:
      {landmarks:[[{x:.2,y:.3,z:0}]],worldLandmarks:[[{x:1,y:2,z:3}]],handedness:[[{categoryName:'Left',score:.95}]]};},
      close(){record.closed++;}};
  }});
  return {records,sdk:{FilesetResolver:{forVisionTasks:async(path,module)=>{assert.equal(module,true);return {path};}},
    ObjectDetector:factory('objects'),HandLandmarker:factory('hands')}};
}
function runtimeHarness(options={}){
  const messages=[],mock=sdkMock(options);
  const runtime=createObjectDetectorWorkerRuntime({post:value=>messages.push(value),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas,...options.runtime});
  const initialize=()=>runtime.handle({type:'init',generation:7});
  const detect=(image=bitmap(),extra={})=>runtime.handle({type:'detect',generation:7,id:1,bitmap:image,width:image.width,height:image.height,includeHands:true,timestampMs:123,...extra});
  return {runtime,messages,...mock,initialize,detect};
}

test('worker prepares separate IMAGE-mode tasks and samples hands and objects on the exact same bitmap',async()=>{
  const h=runtimeHarness();await h.initialize();assert.equal(h.messages.at(-1).type,'ready');
  assert.equal(h.records.length,2);assert.notEqual(h.records[0].options.canvas,h.records[1].options.canvas);
  for(const record of h.records){assert.equal(record.options.runningMode,'IMAGE');assert.equal(record.options.baseOptions.delegate,'GPU');}
  assert.equal(h.records[0].options.scoreThreshold,.25);assert.equal(h.records[1].options.numHands,2);
  const image=bitmap();await h.detect(image);const result=h.messages.at(-1);
  assert.equal(h.records[0].calls[0],image);assert.equal(h.records[1].calls[0],image);assert.equal(image.closed,1);
  assert.equal(result.handFrame.handLandmarks[0][0].x,.2);assert.equal(result.handFrame.handedness[0][0].categoryName,'Left');
  assert.equal(result.handFrame.handWorldLandmarks[0][0].z,3);assert.equal(result.handFrame.timestamp_ms,123);
  assert.deepEqual(result.handFrame.image_resolution,{width:640,height:480});
  h.runtime.dispose();assert.ok(h.records.every(record=>record.closed===1));
});

test('ROI detection skips hands without restarting either loaded task',async()=>{
  const h=runtimeHarness();await h.initialize();await h.detect(bitmap(200,300),{includeHands:false});
  assert.equal(h.records.length,2);assert.equal(h.records[0].calls.length,1);assert.equal(h.records[1].calls.length,0);
  assert.equal(h.messages.at(-1).handFrame,null);h.runtime.dispose();
});

test('partial GPU model initialization closes its successful task before the common CPU fallback',async()=>{
  const h=runtimeHarness({create:record=>{if(record.name==='hands'&&record.options.baseOptions.delegate==='GPU')throw new Error('GPU hand setup failed');}});
  await h.initialize();assert.equal(h.messages.at(-1).delegate,'CPU');assert.equal(h.records[0].closed,1);
  assert.equal(h.records.filter(record=>record.options.baseOptions.delegate==='CPU').length,2);
  assert.equal(h.messages.at(-1).diagnostics.previousFailures.length,1);h.runtime.dispose();
});

test('a GPU execution failure retries both tasks on the same image, never mixes old hand results',async()=>{
  const h=runtimeHarness({detect:(record,image)=>{
    if(record.name==='objects'&&record.options.baseOptions.delegate==='GPU')throw new Error('GPU lost');
    return record.name==='objects'?{detections:[]}:{landmarks:[[{x:record.options.baseOptions.delegate==='GPU'?.1:.8,y:.2}]],worldLandmarks:[],handedness:[]};
  }});
  await h.initialize();const image=bitmap();await h.detect(image);const result=h.messages.at(-1);
  assert.equal(result.type,'result');assert.equal(result.delegate,'CPU');assert.equal(result.handFrame.handLandmarks[0][0].x,.8);
  assert.ok(h.records.every(record=>record.calls.every(value=>value===image)));assert.equal(image.closed,1);
  assert.ok(h.records.slice(0,2).every(record=>record.closed===1));h.runtime.dispose();
});

test('objects failing on GPU and CPU retain genuine same-image hands as an explicit partial result',async()=>{
  const h=runtimeHarness({detect:record=>{
    if(record.name==='objects')throw new Error('Object inference unavailable');
    return {landmarks:[[{x:.4,y:.3}]],worldLandmarks:[],handedness:[[{categoryName:'Left',score:.95}]]};
  }});
  await h.initialize();const image=bitmap();await h.detect(image);const result=h.messages.at(-1);
  assert.equal(result.type,'result');assert.deepEqual(result.raw.detections,[]);assert.equal(result.handFrame.handLandmarks[0][0].x,.4);
  assert.equal(result.handFrame.frame_timestamp_ms,123);assert.equal(result.objectError.code,'OBJECT_MODEL_RUN');
  assert.equal(result.handFrame.inference.delegate,'CPU');assert.equal(result.reloadRequired,false);assert.equal(image.closed,1);
  await h.detect(bitmap(),{includeHands:false});assert.equal(h.messages.at(-1).type,'error','object-only requests remain strict');
  h.runtime.dispose();
});

test('missing object assets can initialize hands alone and preserve frozen-image selection',async()=>{
  const h=runtimeHarness({create:record=>{if(record.name==='objects')throw new Error('Object asset unavailable');}});
  await h.initialize();const ready=h.messages.at(-1);assert.equal(ready.type,'ready');assert.equal(ready.objectError.code,'OBJECT_MODEL_LOAD');
  assert.match(ready.message,/hands ready/);const image=bitmap();await h.detect(image);const result=h.messages.at(-1);
  assert.equal(result.type,'result');assert.deepEqual(result.raw.detections,[]);assert.equal(result.objectError.code,'OBJECT_MODEL_LOAD');
  assert.equal(result.handFrame.handLandmarks[0][0].x,.2);assert.equal(image.closed,1);
  await h.detect(bitmap(),{includeHands:false});assert.equal(h.messages.at(-1).type,'error');h.runtime.dispose();
});

test('if CPU reconstruction fails after real GPU hand sampling, only that same-image evidence may survive',async()=>{
  const h=runtimeHarness({create:record=>{if(record.name==='objects'&&record.options.baseOptions.delegate==='CPU')throw new Error('CPU object asset unavailable');},
    detect:record=>{if(record.name==='objects')throw new Error('GPU object inference failed');
      return {landmarks:[[{x:.3,y:.2}]],worldLandmarks:[],handedness:[]};}});
  await h.initialize();const image=bitmap();await h.detect(image);const result=h.messages.at(-1);
  assert.equal(result.type,'result');assert.equal(result.handFrame.handLandmarks[0][0].x,.3);assert.equal(result.reloadRequired,true);
  assert.equal(result.delegate,'GPU');assert.equal(result.handFrame.frame_timestamp_ms,123);assert.equal(image.closed,1);h.runtime.dispose();
});

test('dispose during asynchronous model construction closes a late task and never emits ready',async()=>{
  const gate=deferred(),h=runtimeHarness({create:()=>gate.promise});const loading=h.initialize();await settle();
  h.runtime.dispose();gate.resolve();await loading;
  assert.equal(h.records[0].closed,1);assert.equal(h.messages.some(row=>row.type==='ready'),false);
});

test('cancelled GPU fallback closes its late CPU model and the retained frozen image',async()=>{
  const gate=deferred(),h=runtimeHarness({create:record=>record.options.baseOptions.delegate==='CPU'?gate.promise:undefined,
    detect:()=>{throw new Error('GPU failed');}});
  await h.initialize();const image=bitmap(),running=h.detect(image);await settle();h.runtime.dispose();gate.resolve();await running;
  assert.equal(image.closed,1);assert.equal(h.messages.some(row=>row.type==='result'),false);
  assert.ok(h.records.every(record=>record.closed===1));
});

test('wrong-generation bitmaps are released, and CPU failure is reported without fabricated detections',async()=>{
  const h=runtimeHarness({detect:()=>{throw new Error('Unsupported image');}});await h.initialize();
  const stale=bitmap();await h.detect(stale,{generation:6});assert.equal(stale.closed,1);assert.equal(h.records[0].calls.length,0);
  const image=bitmap();await h.detect(image);assert.equal(image.closed,1);assert.equal(h.messages.at(-1).type,'error');
  assert.equal(h.messages.at(-1).code,'OBJECT_MODEL_RUN');assert.equal(h.messages.some(row=>row.type==='result'),false);h.runtime.dispose();
});

test('missing graphics is explicit because CPU compute does not bypass image-upload requirements',async()=>{
  assert.throws(()=>inspectObjectGraphics({getContext:()=>null}),{code:'OBJECT_GRAPHICS_UNAVAILABLE'});
  const h=runtimeHarness({runtime:{createCanvas:()=>({getContext:()=>null})}});await h.initialize();
  assert.equal(h.messages.at(-1).code,'OBJECT_GRAPHICS_UNAVAILABLE');assert.equal(h.records.length,0);h.runtime.dispose();
});

test('object-worker privacy policy allows local model GETs but blocks analytics and cross-origin redirects',async()=>{
  const calls=[],original=async(...args)=>{calls.push(args);return 'local';};
  const scope={location:{href:'https://app.example/object-detector-worker.js'},fetch:original};
  const restore=installObjectNetworkPolicy(scope,'https://app.example');
  assert.equal(await scope.fetch('/vendor/mediapipe/models/example.tflite'),'local');
  assert.equal(calls[0][1].redirect,'error');
  await assert.rejects(scope.fetch('https://odml.pa.googleapis.com/v1/log',{method:'POST'}),{name:'SecurityError'});
  await assert.rejects(scope.fetch('/analytics',{method:'POST'}),{name:'SecurityError'});
  await assert.rejects(scope.fetch('https://elsewhere.example/model.tflite'),{name:'SecurityError'});
  await assert.rejects(scope.fetch('data:application/wasm;base64,AA=='),{name:'SecurityError'});
  assert.equal(calls.length,1);restore();assert.equal(scope.fetch,original);
});

test('module hook restores a cached factory for each model and rejects paths outside vendor WASM',async()=>{
  const factory=()=>{},scope={},imports=[];
  const restore=installObjectModuleLoader(scope,async url=>{imports.push(url);return {default:factory};},new URL('https://app.example/vendor/mediapipe/wasm/'));
  await scope.import('vision_wasm_module_internal.js');assert.equal(scope.ModuleFactory,factory);delete scope.ModuleFactory;
  await scope.import('vision_wasm_module_internal.js');assert.equal(scope.ModuleFactory,factory);
  for(const value of ['../other.js','https://elsewhere.example/loader.js','https://user:pass@app.example/vendor/mediapipe/wasm/loader.js','file.wasm'])
    await assert.rejects(scope.import(value),{name:'SecurityError'});
  assert.equal(imports.length,2);restore();assert.equal(scope.import,undefined);
});
