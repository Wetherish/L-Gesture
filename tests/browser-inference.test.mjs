import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserInference,inferenceFrameSize,normalizeInferenceOptions} from '../dist/browser-inference.js';
import {createInferenceWorkerRuntime,browserInferenceResult,installInferenceNetworkPolicy,installInferenceModuleLoader,inspectInferenceGraphics} from '../dist/browser-inference-worker.js';

const settle = async () => {for(let i=0;i<8;i++)await Promise.resolve();};
const bitmap = () => ({closed:0,close(){this.closed++;}});
const camera = () => ({videoWidth:1920,videoHeight:1080,readyState:2,currentTime:0,paused:false});
const graphicsCanvas = () => ({getContext:()=>({isContextLost:()=>false,getParameter:()=>"Mock WebGL"})});
function decodedCamera() {
  const element=camera(),callbacks=new Map(),cancelled=[];let id=0,frames=0;
  element.requestVideoFrameCallback=callback=>{callbacks.set(++id,callback);return id;};
  element.cancelVideoFrameCallback=handle=>{cancelled.push(handle);callbacks.delete(handle);};
  return {element,callbacks,cancelled,decode(mediaTime){
    element.currentTime=mediaTime;
    for(const [key,callback] of [...callbacks]){callbacks.delete(key);callback(0,{mediaTime,presentedFrames:++frames});}
  }};
}

function harness({createBitmap,onResult=()=>{},startupTimeoutMs=1000,frameTimeoutMs=500} = {}) {
  let clock=1,id=0;
  const timers=new Map(),rafs=new Map(),workers=[],results=[],statuses=[],bitmaps=[];
  class Worker {
    messages=[];terminated=false;
    constructor(){workers.push(this);}
    postMessage(message,transfer){this.messages.push({message,transfer});}
    emit(message){this.onmessage?.({data:message});}
    terminate(){this.terminated=true;}
  }
  const controller=createBrowserInference({WorkerClass:Worker,onResult:value=>{results.push(value);onResult(value);},onStatus:value=>statuses.push(value),
    createBitmap:createBitmap || (async()=>{const image=bitmap();bitmaps.push(image);return image;}),
    now:()=>clock,wallNow:()=>1700000000000+clock,
    requestFrame:fn=>{const key=++id;rafs.set(key,fn);return key;},cancelFrame:key=>rafs.delete(key),
    setTimer:(fn,ms)=>{const key=++id;timers.set(key,{fn,at:clock+ms});return key;},clearTimer:key=>timers.delete(key),
    startupTimeoutMs,frameTimeoutMs});
  async function advance(ms=0){clock+=ms;for(const [key,timer] of [...timers])if(timer.at<=clock){timers.delete(key);timer.fn();}await settle();}
  async function paint(){for(const [key,fn] of [...rafs]){rafs.delete(key);fn(clock);}await settle();}
  async function start(element=camera(),options={}) {
    const pending=controller.start({element,sourceId:'source-a',sourceName:'FaceTime HD'},options);
    const worker=workers.at(-1),generation=worker.messages[0].message.generation;
    worker.emit({type:'ready',generation,delegate:'GPU'});assert.equal(await pending,true);
    await advance();await paint();return {worker,generation,element};
  }
  const lastFrame = () => workers.at(-1)?.messages.filter(row=>row.message.type==='frame').at(-1)?.message;
  function result(frame=lastFrame(),latencyMs=20){const worker=workers.at(-1);worker.emit({type:'result',generation:frame.generation,id:frame.id,result:{timestamp_ms:frame.timestampMs,inference:{sourceId:frame.source.id,generation:frame.generation,delegate:'GPU',latencyMs}}});}
  return {controller,workers,results,statuses,bitmaps,advance,paint,start,lastFrame,result,timers,rafs,get time(){return clock;}};
}

test('frame sizing preserves original coordinates while limiting the transferred bitmap dimensions', () => {
  assert.deepEqual(inferenceFrameSize(camera()),{width:1920,height:1080,inputWidth:1280,inputHeight:720});
  assert.deepEqual(inferenceFrameSize({naturalWidth:512,naturalHeight:640}),{width:512,height:640,inputWidth:512,inputHeight:640});
  assert.equal(inferenceFrameSize({...camera(),readyState:1}),null);
  assert.equal(inferenceFrameSize({naturalWidth:0,naturalHeight:0,width:100,height:100}),null,'CSS dimensions are not decoded image dimensions');
  assert.equal(inferenceFrameSize({width:0,height:100}),null);
  const options=normalizeInferenceOptions({face:true,hands:true,maxFps:99,maxDimension:1,numHands:99});
  assert.equal(options.maxFps,60);assert.equal(options.maxDimension,256);assert.equal(options.numHands,4);
});

test('only one transferable frame is in flight and results retain the selected source identity', async () => {
  const h=harness();const {worker}=await h.start();
  const first=h.lastFrame();assert.equal(first.source.id,'source-a');assert.equal(first.source.label,'FaceTime HD');
  assert.deepEqual(first.imageResolution,{width:1920,height:1080});assert.equal(first.sourceTimestampMs,0);
  assert.deepEqual(worker.messages.at(-1).transfer,[first.bitmap]);
  await h.advance(100);await h.paint();await h.paint();assert.equal(h.bitmaps.length,1,'no pending bitmap queue is created');
  h.result(first);assert.equal(h.controller.getState().framesProcessed,1);
  assert.equal(h.results.filter(Boolean).length,1);h.controller.destroy();
});

test('slow inference adds adaptive headroom and uses the latest video time when ready', async () => {
  const h=harness({frameTimeoutMs:1000});const {element}=await h.start(undefined,{maxFps:30});
  await h.advance(200);element.currentTime=3;h.result(h.lastFrame(),200);
  await h.advance(29);await h.paint();assert.equal(h.bitmaps.length,1);
  await h.advance(1);await h.paint();assert.equal(h.bitmaps.length,2);
  assert.equal(h.lastFrame().sourceTimestampMs,3000);h.controller.destroy();
});

test('switching sources closes a late bitmap and ignores results from the terminated worker', async () => {
  let resolveBitmap;const late=bitmap();
  const h=harness({createBitmap:()=>new Promise(resolve=>{resolveBitmap=resolve;})});
  const {worker,generation}=await h.start();const staleHandler=worker.onmessage;
  const pending=h.controller.start({element:camera(),sourceId:'source-b',sourceName:'LVNext Camera'});
  assert.equal(worker.terminated,true);resolveBitmap(late);await settle();assert.equal(late.closed,1);
  staleHandler({data:{type:'result',generation,id:1,result:{inference:{sourceId:'source-a'}}}});
  assert.equal(h.results.filter(Boolean).length,0);
  h.controller.stop();assert.equal(await pending,false);assert.equal(h.controller.getState().status,'stopped');
});

test('stop clears results and pending initialization without stopping the source media', async () => {
  const h=harness(),element=camera();let trackStops=0;element.srcObject={getTracks:()=>[{stop(){trackStops++;}}]};
  const pending=h.controller.start({element,sourceId:'pending'});h.controller.stop();
  assert.equal(await pending,false);assert.equal(h.workers[0].terminated,true);assert.equal(trackStops,0);
  assert.equal(h.results.at(-1),null);assert.equal(h.timers.size,0);assert.equal(h.rafs.size,0);
});

test('startup timeout rejects with a retryable error and ignores late worker readiness', async () => {
  const h=harness(),pending=h.controller.start({element:camera(),sourceId:'a'});
  const rejected=assert.rejects(pending,error=>error.code==='INFERENCE_LOAD_TIMEOUT');
  const worker=h.workers[0],handler=worker.onmessage,generation=worker.messages[0].message.generation;
  await h.advance(1001);await rejected;
  handler({data:{type:'ready',generation,delegate:'GPU'}});
  assert.equal(h.controller.getState().status,'error');assert.equal(h.rafs.size,0);
});

test('a stalled bitmap conversion is bounded and its eventual bitmap is released', async () => {
  let complete;const image=bitmap(),h=harness({createBitmap:()=>new Promise(resolve=>{complete=resolve;})});
  await h.start();await h.advance(501);
  assert.equal(h.controller.getState().status,'error');assert.equal(h.controller.getState().error.code,'INFERENCE_FRAME_TIMEOUT');
  complete(image);await settle();assert.equal(image.closed,1);assert.equal(h.workers[0].messages.filter(m=>m.message.type==='frame').length,0);
});

test('unchanged paused video is skipped, while a looping video keeps monotonic inference timestamps', async () => {
  const h=harness();const {element}=await h.start();const first=h.lastFrame();h.result(first);
  element.paused=true;await h.advance(100);await h.paint();assert.equal(h.bitmaps.length,1);assert.equal(h.controller.getState().status,'paused');
  element.paused=false;element.currentTime=10;await h.advance(100);await h.paint();const beforeLoop=h.lastFrame();h.result(beforeLoop);
  element.currentTime=0;await h.advance(100);await h.paint();const afterLoop=h.lastFrame();
  assert.ok(afterLoop.timestampMs>beforeLoop.timestampMs);assert.equal(afterLoop.sourceTimestampMs,0);h.controller.destroy();
});

test('rate changes reuse the worker; enabling a new task cancels the old generation and clears output', async () => {
  const h=harness();await h.start();h.result();
  assert.equal(await h.controller.configure({maxFps:5}),true);assert.equal(h.workers.length,1);
  const previous=h.workers[0],pending=h.controller.configure({hands:true});
  assert.equal(previous.terminated,true);assert.equal(h.workers.length,2);assert.equal(h.results.at(-1),null);
  const worker=h.workers[1],init=worker.messages[0].message;
  assert.equal(init.options.hands,true);worker.emit({type:'ready',generation:init.generation,delegate:'CPU'});
  assert.equal(await pending,true);assert.equal(h.controller.getState().delegate,'CPU');h.controller.destroy();
});

test('all disabled tasks create no worker and can be re-enabled for the retained source', async () => {
  const h=harness();assert.equal(await h.controller.start({element:camera(),sourceId:'still'},{face:false,hands:false,pose:false}),false);
  assert.equal(h.workers.length,0);const pending=h.controller.configure({pose:true});
  const worker=h.workers[0],init=worker.messages[0].message;assert.equal(init.options.pose,true);assert.equal(init.options.face,false);
  worker.emit({type:'ready',generation:init.generation,delegate:'GPU'});assert.equal(await pending,true);h.controller.destroy();
});

test('gesture sampling forwards independent visual cadence without reloading a worker', async () => {
  const h=harness(); const {element}=await h.start(undefined,{face:true,hands:true,pose:true,maxFps:30,visualMaxFps:15,prioritizeHands:true});
  assert.deepEqual(h.lastFrame().timing,{maxFps:30,visualMaxFps:15,prioritizeHands:true});
  h.result(); await h.controller.configure({visualMaxFps:5});
  element.currentTime=1/30; await h.advance(34); await h.paint();
  assert.equal(h.workers.length,1); assert.deepEqual(h.lastFrame().timing,{maxFps:30,visualMaxFps:5,prioritizeHands:true});
  assert.equal(h.controller.getState().options.maxFps,30); h.controller.destroy();
});

test('a duplicate video frame does not impose the old 40 ms wait on gesture sampling', async () => {
  const h=harness(); const {element}=await h.start(undefined,{face:false,hands:true,maxFps:30,visualMaxFps:15,prioritizeHands:true});
  h.result(); await h.advance(34); await h.paint();
  assert.equal(h.bitmaps.length,1, 'the unchanged video must not be counted as another observation');
  element.currentTime=1/30; await h.advance(17); await h.paint();
  assert.equal(h.bitmaps.length,2, 'the newly decoded camera frame is sampled within half a target period');
  await h.advance(100); await h.paint(); assert.equal(h.bitmaps.length,2, 'only one frame remains in flight');
  h.controller.destroy();
});

test('60 fps gesture sampling starts at its deadline without an additional animation frame or latency wait', async () => {
  const h=harness();const {element}=await h.start(undefined,{face:false,hands:true,maxFps:60,prioritizeHands:true});
  assert.equal(h.bitmaps.length,1);assert.equal(h.rafs.size,0);
  await h.advance(4);h.result(h.lastFrame(),4);element.currentTime=1/60;
  await h.advance(12);assert.equal(h.bitmaps.length,1);
  await h.advance(1);assert.equal(h.bitmaps.length,2,'the next fresh frame starts at the 60 Hz deadline without painting');
  assert.equal(h.rafs.size,0);assert.equal(h.lastFrame().sourceTimestampMs,1000/60);
  await h.advance(50);element.currentTime=.1;h.result(h.lastFrame(),50);await settle();
  assert.equal(h.bitmaps.length,3,'slow hand inference takes the latest frame immediately, without adding dead time');
  assert.equal(h.lastFrame().sourceTimestampMs,100);
  h.controller.destroy();
});

test('raising the hand target replaces a lower-rate pending deadline without rebuilding the worker', async () => {
  const h=harness();const {element}=await h.start(undefined,{face:false,hands:true,maxFps:15,prioritizeHands:true});
  h.result();element.currentTime=1/60;await h.advance(10);
  await h.controller.configure({maxFps:60});
  await h.advance(6);assert.equal(h.bitmaps.length,1);
  await h.advance(1);assert.equal(h.bitmaps.length,2);assert.equal(h.workers.length,1);
  assert.equal(h.lastFrame().timing.maxFps,60);assert.equal(h.rafs.size,0);
  h.controller.destroy();
});

test('decoded-frame metadata prevents continuous media-clock changes from fabricating hand samples', async () => {
  const video=decodedCamera(),h=harness();
  await h.start(video.element,{face:false,hands:true,maxFps:60,prioritizeHands:true});
  assert.equal(h.bitmaps.length,0,'wait for a decoded frame before capturing video');
  video.decode(0);await settle();assert.equal(h.bitmaps.length,1);assert.equal(h.lastFrame().sourceTimestampMs,0);
  h.result();video.element.currentTime=.01;
  await h.advance(20);assert.equal(h.bitmaps.length,1,'currentTime advancing is not evidence of a new decoded frame');
  video.decode(0);await settle();assert.equal(h.bitmaps.length,1,'repeated presentation timestamp is not another observation');
  video.decode(1/60);await settle();assert.equal(h.bitmaps.length,2);assert.equal(h.lastFrame().sourceTimestampMs,1000/60);
  assert.equal(video.callbacks.size,1,'only one lightweight video callback is registered');
  const staleCallback=[...video.callbacks.values()][0];h.controller.stop();
  assert.equal(video.callbacks.size,0);assert.equal(video.cancelled.length,1);assert.equal(h.timers.size,0);
  staleCallback(0,{mediaTime:1,presentedFrames:99});await settle();assert.equal(h.bitmaps.length,2);
});

test('decoded frames arriving while the worker is busy replace metadata without queueing old pixels', async () => {
  const video=decodedCamera(),h=harness();
  await h.start(video.element,{face:false,hands:true,maxFps:60,prioritizeHands:true});
  video.decode(0);await settle();const first=h.lastFrame();
  for(const time of [1/60,2/60,3/60]){await h.advance(17);video.decode(time);await settle();}
  assert.equal(h.bitmaps.length,1);assert.equal(h.controller.getState().sentFrames,1);
  h.result(first,51);await settle();assert.equal(h.bitmaps.length,2);
  assert.equal(h.lastFrame().sourceTimestampMs,50,'the newest decoded frame is captured as soon as the worker is free');
  h.controller.destroy();assert.equal(video.callbacks.size,0);
});

test('early hand results publish once without releasing the worker slot or counting an extra processed frame', async () => {
  const h=harness();const {element,worker}=await h.start(undefined,{face:true,hands:true,maxFps:60,visualMaxFps:15,prioritizeHands:true});
  const input=h.lastFrame(),result={timestamp_ms:input.timestampMs,inference:{phase:'hands',generation:input.generation,sourceId:'source-a'}};
  const partial={type:'hands-result',generation:input.generation,id:input.id,result};
  worker.emit({...partial,id:input.id+1});worker.emit({...partial,generation:input.generation-1});
  assert.equal(h.results.filter(Boolean).length,0);
  worker.emit(partial);worker.emit(partial);
  assert.equal(h.results.filter(Boolean).length,1);assert.equal(h.results.at(-1),result);
  assert.equal(h.controller.getState().framesProcessed,0);
  element.currentTime=1/60;await h.advance(34);assert.equal(h.bitmaps.length,1,'visual work still owns the frame slot');
  h.result(input,34);await settle();assert.equal(h.controller.getState().framesProcessed,1);
  assert.equal(h.results.filter(Boolean).length,2);assert.equal(h.bitmaps.length,2);
  worker.emit(partial);assert.equal(h.results.filter(Boolean).length,2,'late partial from the completed frame is ignored');
  h.controller.destroy();
});

test('a consumer stopping on an early hand result prevents every later packet and cancels frame observation', async () => {
  const video=decodedCamera();let h;
  h=harness({onResult:value=>{if(value?.inference?.phase==='hands')h.controller.stop();}});
  const {worker,generation}=await h.start(video.element,{face:true,hands:true,maxFps:60,visualMaxFps:15,prioritizeHands:true});
  video.decode(0);await settle();const input=h.lastFrame(),handler=worker.onmessage;
  handler({data:{type:'hands-result',generation,id:input.id,result:{inference:{phase:'hands'}}}});
  assert.equal(worker.terminated,true);assert.equal(video.callbacks.size,0);assert.equal(h.results.at(-1),null);
  handler({data:{type:'result',generation,id:input.id,result:{inference:{phase:'complete'}}}});
  await h.advance(100);assert.equal(h.results.filter(Boolean).length,1);assert.equal(h.bitmaps.length,1);assert.equal(h.timers.size,0);
});

test('a cross-origin pixel read error becomes actionable and clears the previous result', async () => {
  const h=harness({createBitmap:async()=>{throw new DOMException('Tainted input','SecurityError');}});
  await h.start();assert.equal(h.controller.getState().status,'error');assert.match(h.controller.getState().message,/CORS/);
  assert.equal(h.results.at(-1),null);assert.equal(h.workers[0].terminated,true);
});

function sdkMock({create,detect} = {}) {
  const created=[];
  const sdk={FilesetResolver:{forVisionTasks:async(...args)=>({args})}};
  for(const [name,key] of [['face','FaceLandmarker'],['hands','HandLandmarker'],['pose','PoseLandmarker']])sdk[key]={createFromOptions:async(fileset,options)=>{
    if(create)await create(name,options);
    const task={name,options,fileset,closed:0,close(){this.closed++;},detectForVideo(image,timestamp){return detect?.(name,options,image,timestamp)||{};}};created.push(task);return task;
  }};
  return {sdk,created};
}
const frame = (generation=1) => ({type:'frame',generation,id:7,bitmap:bitmap(),timestampMs:15,capturedAtMs:1700000000015,
  sourceTimestampMs:1200,imageResolution:{width:1920,height:1080},source:{id:'camera-3',label:'LVNext Camera'}});

test('fresh hands are delivered before slow visual inference with one unchanged frame identity', async () => {
  const messages=[],events=[];let clock=0;
  const mock=sdkMock({detect:name=>{events.push(name);clock+=name==='hands'?4:40;
    return name==='face'?{faceLandmarks:[[{x:.1,y:.2}]]}:{landmarks:[[{x:.3,y:.4}]]};}});
  const runtime=createInferenceWorkerRuntime({post:message=>{messages.push(message);if(message.type.endsWith('result'))events.push(message.type);},
    now:()=>clock,importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,maxFps:60,visualMaxFps:15,prioritizeHands:true}});
  const input=frame();await runtime.handle(input);
  assert.deepEqual(events,['hands','hands-result','face','result']);
  const partial=messages.find(message=>message.type==='hands-result'),complete=messages.at(-1);
  assert.equal(partial.id,complete.id);assert.equal(partial.generation,complete.generation);
  assert.equal(partial.result.timestamp_ms,complete.result.timestamp_ms);
  assert.equal(partial.result.inference.phase,'hands');assert.equal(complete.result.inference.phase,'complete');
  assert.equal(partial.result.inference.latencyMs,4);assert.equal(complete.result.inference.latencyMs,44);
  assert.equal(partial.result.faceLandmarks.length,0);assert.equal(partial.result.inference.taskSamples.face.stale,true);
  assert.equal(complete.result.faceLandmarks.length,1);assert.equal(complete.result.inference.taskSamples.face.updated,true);
  assert.equal(partial.result.rawResults.face,undefined,'publishing a later face result cannot mutate an already delivered hand packet');
  assert.deepEqual(partial.result.inference.taskSamples.hands,complete.result.inference.taskSamples.hands);
  assert.equal(input.bitmap.closed,1);runtime.dispose();
});

test('60 Hz hands keep face and body at 15 Hz without starving either visual task', async () => {
  const messages=[],calls=[],mock=sdkMock({detect:(name,_options,_image,timestamp)=>{
    calls.push({name,timestamp});return name==='face'?{faceLandmarks:[[{x:.1,y:.2}]]}:{landmarks:[[{x:.3,y:.4}]]};
  }});
  const runtime=createInferenceWorkerRuntime({post:message=>messages.push(message),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,pose:true,maxFps:60,visualMaxFps:15,prioritizeHands:true}});
  for(let i=0;i<60;i++)await runtime.handle({...frame(),id:i,timestampMs:i*1000/60,sourceTimestampMs:i*1000/60});
  assert.equal(calls.filter(call=>call.name==='hands').length,60);
  for(const name of ['face','pose'])assert.equal(calls.filter(call=>call.name===name).length,15);
  const complete=messages.filter(message=>message.type==='result'),partials=messages.filter(message=>message.type==='hands-result');
  assert.equal(complete.length,60);assert.equal(partials.length,30,'no redundant early packet when no visual work is due');
  for(const packet of [...complete,...partials]){
    const result=packet.result;
    assert.deepEqual(result.inference.targetFps,{hands:60,face:15,pose:15});
    assert.equal(result.inference.taskSamples.hands.timestampMs,result.timestamp_ms);
    assert.equal(result.inference.taskSamples.hands.updated,true);
  }
  const held=partials[2].result.inference.taskSamples.face;
  assert.equal(held.updated,false);assert.equal(held.timestampMs,0);assert.ok(held.ageMs>66&&held.ageMs<67);
  assert.equal(mock.created.length,3,'one bounded set of model tasks is reused');runtime.dispose();
});

test('GPU fallback after publishing hands never emits a second partial for the same frame', async () => {
  const messages=[],mock=sdkMock({detect:(name,options)=>{
    if(name==='face'&&options.baseOptions.delegate==='GPU')throw new Error('Visual GPU failure');
    return name==='face'?{faceLandmarks:[[{x:.1,y:.2}]]}:{landmarks:[[{x:.3,y:.4}]]};
  }});
  const runtime=createInferenceWorkerRuntime({post:message=>messages.push(message),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,maxFps:60,visualMaxFps:15,prioritizeHands:true}});
  const input=frame();await runtime.handle(input);
  const partials=messages.filter(message=>message.type==='hands-result'),complete=messages.at(-1);
  assert.equal(partials.length,1);assert.equal(partials[0].result.inference.delegate,'GPU');
  assert.equal(complete.type,'result');assert.equal(complete.result.inference.delegate,'CPU');
  assert.equal(partials[0].result.timestamp_ms,complete.result.timestamp_ms);assert.equal(input.bitmap.closed,1);
  runtime.dispose();
});

test('hands use every real frame while face and body alternate at the requested cadence with honest timestamps', async () => {
  const messages=[],calls=[],mock=sdkMock({detect:(name,_options,_image,timestamp)=>{
    calls.push({name,timestamp}); const points=[[{x:timestamp/1000,y:.2,z:0}]];
    return name==='face'?{faceLandmarks:points}:{landmarks:points};
  }});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,pose:true,maxFps:30,visualMaxFps:15,prioritizeHands:true}});
  for(let i=0;i<12;i++){
    const input={...frame(),id:i,timestampMs:i*1000/30,sourceTimestampMs:i*1000/30,capturedAtMs:1700000000000+i*1000/30};
    await runtime.handle(input);
    assert.equal(input.bitmap.closed,1);
  }
  assert.equal(calls.filter(c=>c.name==='hands').length,12);
  assert.equal(calls.filter(c=>c.name==='face').length,6); assert.equal(calls.filter(c=>c.name==='pose').length,6);
  for(let i=0;i<12;i++)assert.equal(calls[i*2].name,'hands','hands run before either visual model');
  const results=messages.filter(m=>m.type==='result').map(m=>m.result);
  for(let i=0;i<results.length;i++){
    const result=results[i],samples=result.inference.taskSamples;
    assert.equal(samples.hands.timestampMs,result.timestamp_ms); assert.equal(samples.hands.updated,true); assert.equal(samples.hands.ageMs,0);
    assert.equal(result.faceLandmarks.length,1,'skipping a face inference must not flicker its recent result');
    if(i)assert.equal(result.poseLandmarks.length,1,'pose remains visible after its first actual observation');
    const held=i%2===1?samples.face:samples.pose;
    if(i){assert.equal(held.updated,false); assert.ok(held.ageMs>30&&held.ageMs<34);assert.equal(held.sourceTimestampMs,held.timestampMs);}
    assert.deepEqual(result.inference.targetFps,{hands:30,face:15,pose:15});
  }
  runtime.dispose();
});

test('held visual observations expire after a sampling gap and never cross sources or dimensions', async () => {
  const messages=[],mock=sdkMock({detect:name=>name==='face'?{faceLandmarks:[[{x:.1,y:.2}]]}:{landmarks:[[{x:.3,y:.4}]]}});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,pose:true,maxFps:30,visualMaxFps:15,prioritizeHands:true}});
  const send=async(timestamp,change={})=>{await runtime.handle({...frame(),timestampMs:timestamp,...change});return messages.at(-1).result;};
  await send(0); await send(34);
  const afterGap=await send(1000);
  assert.equal(afterGap.poseLandmarks.length,0); assert.equal(afterGap.inference.taskSamples.pose.stale,true);
  assert.equal(afterGap.inference.taskSamples.pose.timestampMs,34);
  const fresh=await send(1034); assert.equal(fresh.poseLandmarks.length,1); assert.equal(fresh.inference.taskSamples.pose.updated,true);
  const nextSource=await send(1068,{source:{id:'different-camera',label:'Another camera'}});
  assert.equal(nextSource.poseLandmarks.length,0); assert.equal(nextSource.inference.taskSamples.pose.timestampMs,null);
  await send(1102,{source:{id:'different-camera',label:'Another camera'}});
  const resized=await send(1136,{source:{id:'different-camera',label:'Another camera'},imageResolution:{width:640,height:480}});
  assert.equal(resized.poseLandmarks.length,0); assert.equal(resized.inference.taskSamples.pose.timestampMs,null);
  runtime.dispose();
});

test('visual cadence changes take effect on the next real frame without rebuilding models', async () => {
  const messages=[],calls=[],mock=sdkMock({detect:(name,_options,_image,timestamp)=>{
    calls.push({name,timestamp});return name==='face'?{faceLandmarks:[[{x:.1,y:.2}]]}:{landmarks:[[{x:.3,y:.4}]]};
  }});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,maxFps:30,visualMaxFps:15,prioritizeHands:true}});
  await runtime.handle({...frame(),timestampMs:0}); await runtime.handle({...frame(),timestampMs:34});
  await runtime.handle({...frame(),timestampMs:68,timing:{maxFps:30,visualMaxFps:5,prioritizeHands:true}});
  let result=messages.at(-1).result;
  assert.equal(result.inference.targetFps.face,5); assert.equal(result.inference.taskSamples.face.timestampMs,0);
  assert.equal(result.inference.taskSamples.face.updated,false); assert.equal(result.inference.taskSamples.hands.timestampMs,68);
  await runtime.handle({...frame(),timestampMs:201}); result=messages.at(-1).result;
  assert.equal(result.inference.taskSamples.face.updated,true);
  assert.deepEqual(calls.filter(c=>c.name==='face').map(c=>c.timestamp),[0,201]);
  assert.deepEqual(calls.filter(c=>c.name==='hands').map(c=>c.timestamp),[0,34,68,201]);
  assert.equal(mock.created.length,2,'the same face and hand models remain alive');runtime.dispose();
});

test('an explicit empty face result replaces the held detection while hands continue updating', async () => {
  const messages=[],mock=sdkMock({detect:(name,_options,_image,timestamp)=>name==='face'
    ?{faceLandmarks:timestamp<60?[[{x:.1,y:.2}]]:[]}: {landmarks:[[{x:.3,y:.4}]]}});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,maxFps:30,visualMaxFps:15,prioritizeHands:true}});
  for(const timestampMs of [0,34,68,102])await runtime.handle({...frame(),timestampMs});
  const results=messages.filter(m=>m.type==='result').map(m=>m.result);
  assert.deepEqual(results.map(result=>result.faceLandmarks.length),[1,1,0,0]);
  assert.ok(results.every(result=>result.inference.taskSamples.hands.updated));
  assert.equal(results[3].inference.taskSamples.face.updated,false); assert.equal(results[3].inference.taskSamples.face.timestampMs,68);
  runtime.dispose();
});

test('GPU fallback discards held results from the previous delegate', async () => {
  const messages=[],mock=sdkMock({detect:(name,options,_image,timestamp)=>{
    if(name==='hands'&&options.baseOptions.delegate==='GPU'&&timestamp>=68)throw new Error('GPU lost');
    return name==='face'?{faceLandmarks:[[{x:.1,y:.2}]]}:{landmarks:[[{x:.3,y:.4}]]};
  }});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,pose:true,maxFps:30,visualMaxFps:15,prioritizeHands:true}});
  for(const timestampMs of [0,34,68])await runtime.handle({...frame(),timestampMs});
  const result=messages.at(-1).result;
  assert.equal(result.inference.delegate,'CPU'); assert.equal(result.handLandmarks.length,1);
  assert.equal(result.poseLandmarks.length,0); assert.equal(result.inference.taskSamples.pose.timestampMs,null);
  assert.equal(result.inference.taskSamples.face.updated,true);
  runtime.dispose();
});

test('GPU initialization failure closes partial tasks and starts all requested tasks on CPU', async () => {
  const messages=[],mock=sdkMock({create:(name,options)=>{if(name==='hands'&&options.baseOptions.delegate==='GPU')throw new Error('No GPU');}});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,hands:true,pose:true}});
  assert.equal(mock.created[0].closed,1);assert.deepEqual(mock.created.filter(t=>t.options.baseOptions.delegate==='CPU').map(t=>t.name),['face','hands','pose']);
  assert.equal(messages.at(-1).type,'ready');assert.equal(messages.at(-1).delegate,'CPU');
  const face=mock.created.find(t=>t.name==='face'&&t.options.baseOptions.delegate==='CPU');
  assert.equal(face.options.outputFaceBlendshapes,true);assert.equal(face.options.outputFacialTransformationMatrixes,true);assert.equal(face.options.runningMode,'VIDEO');
  assert.equal(face.fileset.args[1],true,'ES module WASM loader selected');runtime.dispose();
});

test('runtime GPU failure retries the same bitmap on CPU and releases it exactly once', async () => {
  const messages=[],seen=[],mock=sdkMock({detect:(name,options,image,timestamp)=>{seen.push({image,timestamp,delegate:options.baseOptions.delegate});if(options.baseOptions.delegate==='GPU')throw new Error('GPU texture failed');return {faceLandmarks:[[{x:.1,y:.2,z:0}]]};}});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true}});const input=frame();await runtime.handle(input);
  assert.deepEqual(seen.map(row=>row.delegate),['GPU','CPU']);assert.equal(seen[0].image,seen[1].image);assert.equal(seen[0].timestamp,seen[1].timestamp);
  const result=messages.find(m=>m.type==='result');assert.equal(result.result.inference.delegate,'CPU');assert.equal(input.bitmap.closed,1);assert.equal(mock.created[0].closed,1);runtime.dispose();
});

test('all face, hand and pose outputs survive with browser provenance and original image dimensions', () => {
  const raw={face:{faceLandmarks:[[{x:1.1,y:-.1,z:.2}]],faceBlendshapes:[{categories:[{categoryName:'eyeBlinkLeft',score:.4}]}],facialTransformationMatrixes:[{rows:4,columns:4,data:[1,0,0,0]}]},
    hands:{landmarks:[[{x:.2,y:.3,z:0}]],worldLandmarks:[[{x:.01,y:.02,z:.03}]],handedness:[[{categoryName:'Left',score:.98}]]},
    pose:{landmarks:[[{x:.7,y:.4,z:-.1,visibility:.8,presence:.9}]],worldLandmarks:[[{x:0,y:1,z:0,visibility:.7}]]}};
  const result=browserInferenceResult(raw,frame(),{generation:1,delegate:'GPU',options:normalizeInferenceOptions({hands:true,pose:true}),latencyMs:42});
  assert.equal(result.provenance,'Browser inference');assert.equal(result.coordinate_space,'normalized');assert.equal(result.inference.location,'browser');
  assert.equal(result.inference.sourceId,'camera-3');assert.deepEqual(result.image_resolution,{width:1920,height:1080});
  assert.equal(result.faceLandmarks[0][0].x,1.1);assert.equal(result.poseLandmarks[0][0].visibility,.8);assert.equal(result.poseLandmarks[0][0].presence,.9);
  assert.deepEqual(result.faceBlendshapes,raw.face.faceBlendshapes);assert.deepEqual(result.facialTransformationMatrixes,raw.face.facialTransformationMatrixes);
  assert.deepEqual(result.handWorldLandmarks,raw.hands.worldLandmarks);assert.deepEqual(result.handedness,raw.hands.handedness);assert.deepEqual(result.poseWorldLandmarks,raw.pose.worldLandmarks);
  assert.equal(result.rawResults,raw);assert.ok(!('api_version' in result));assert.ok(!('synchronized' in result));
});

test('obsolete worker frames are closed without inference or a result', async () => {
  const messages=[],mock=sdkMock({detect:()=>{throw new Error('Must not infer obsolete source');}});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:2,options:{face:true}});const old=frame(1);await runtime.handle(old);
  assert.equal(old.bitmap.closed,1);assert.equal(messages.filter(m=>m.type==='result').length,0);runtime.dispose();
});

test('disposing during model load closes the late task and never reports ready', async () => {
  const messages=[];let finish;const mock=sdkMock({create:()=>new Promise(resolve=>{finish=resolve;})});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  const pending=runtime.handle({type:'init',generation:1,options:{face:true}});await settle();runtime.dispose();finish();await pending;
  assert.equal(mock.created[0].closed,1);assert.equal(messages.filter(m=>m.type==='ready').length,0);
});

test('CPU failure is reported honestly and releases the frame and models', async () => {
  const messages=[],mock=sdkMock({detect:()=>{throw new Error('Unsupported pixels');}});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true,delegate:'CPU'}});const input=frame();await runtime.handle(input);
  assert.equal(input.bitmap.closed,1);assert.equal(mock.created[0].closed,1);assert.equal(messages.at(-1).code,'INFERENCE_MODEL_RUN');assert.equal(messages.filter(m=>m.type==='result').length,0);runtime.dispose();
});

test('worker network policy allows same-origin model GETs while blocking SDK analytics and uploads', async () => {
  const calls=[],scope={location:{href:'https://app.example/browser-inference-worker.js'},fetch:async function(input,init){calls.push({input,init,scope:this});return 'model';}};
  const original=scope.fetch,restore=installInferenceNetworkPolicy(scope,'https://app.example');
  assert.equal(await scope.fetch('./vendor/mediapipe/model.task'),'model');assert.equal(calls[0].scope,scope);
  await assert.rejects(scope.fetch('https://odml.pa.googleapis.com/v1/log',{method:'POST',body:'metrics'}),{name:'SecurityError'});
  await assert.rejects(scope.fetch('https://app.example/upload',{method:'POST',body:'pixels'}),{name:'SecurityError'});
  await assert.rejects(scope.fetch('https://elsewhere.example/model.task'),{name:'SecurityError'});
  await assert.rejects(scope.fetch(new Request('https://app.example/upload',{method:'POST',body:'pixels'})),{name:'SecurityError'});
  assert.equal(calls.length,1);restore();assert.equal(scope.fetch,original);
});

test('module loader restores cached ModuleFactory for each task and rejects external or unrelated scripts', async () => {
  const scope={},factory=()=>{},module={default:factory},imports=[];
  const restore=installInferenceModuleLoader(scope,async url=>{imports.push(url);return module;},new URL('https://app.example/vendor/mediapipe/wasm/'));
  await scope.import('vision_wasm_module_internal.js');assert.equal(scope.ModuleFactory,factory);
  scope.ModuleFactory=undefined;await scope.import('vision_wasm_module_internal.js');assert.equal(scope.ModuleFactory,factory,'cached imports still restore the factory that the SDK clears');
  await assert.rejects(scope.import('https://elsewhere.example/loader.js'),{name:'SecurityError'});
  await assert.rejects(scope.import('https://app.example/other.js'),{name:'SecurityError'});
  await assert.rejects(scope.import('../vision_bundle.mjs'),{name:'SecurityError'});
  assert.equal(imports.length,2);restore();assert.equal(scope.import,undefined);
});

test('CPU fallback cannot publish a result after disposal during replacement-model loading', async () => {
  const messages=[];let finishCpu;
  const mock=sdkMock({create:(_name,options)=>{if(options.baseOptions.delegate==='CPU')return new Promise(resolve=>{finishCpu=resolve;});},
    detect:()=>{throw new Error('GPU failed');}});
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:graphicsCanvas});
  await runtime.handle({type:'init',generation:1,options:{face:true}});const input=frame(),pending=runtime.handle(input);await settle();runtime.dispose();finishCpu();await pending;
  assert.equal(input.bitmap.closed,1);assert.ok(mock.created.every(task=>task.closed===1));assert.equal(messages.filter(m=>m.type==='result').length,0);
});

test('graphics preflight distinguishes a usable context from unavailable or lost image transport', () => {
  const requested=[],context={isContextLost:()=>false,RENDERER:1,VERSION:2,getParameter:parameter=>parameter===1?'Browser renderer':'WebGL 2.0'};
  const result=inspectInferenceGraphics({getContext:(type,attributes)=>{requested.push({type,attributes});return context;}});
  assert.equal(result.webglVersion,2);assert.equal(result.contextLost,false);assert.equal(result.renderer,'Browser renderer');
  assert.equal(requested[0].type,'webgl2');assert.equal(requested[0].attributes.failIfMajorPerformanceCaveat,false);
  assert.throws(()=>inspectInferenceGraphics({getContext:()=>null}),error=>error.code==='INFERENCE_GRAPHICS_UNAVAILABLE'&&error.graphics.webglVersion===0&&/including when compute is set to CPU/.test(error.message));
  assert.throws(()=>inspectInferenceGraphics({getContext:()=>({...context,isContextLost:()=>true})}),error=>error.code==='INFERENCE_GRAPHICS_UNAVAILABLE'&&error.graphics.contextLost===true);
});

test('missing worker graphics fails before any model loads and does not promise a CPU bypass', async () => {
  const messages=[],mock=sdkMock();
  const runtime=createInferenceWorkerRuntime({post:m=>messages.push(m),importModule:async()=>mock.sdk,createCanvas:()=>({getContext:()=>null})});
  await runtime.handle({type:'init',generation:1,options:{face:true,delegate:'GPU'}});
  const error=messages.at(-1);
  assert.equal(error.type,'error');assert.equal(error.code,'INFERENCE_GRAPHICS_UNAVAILABLE');assert.equal(mock.created.length,0);
  assert.equal(error.diagnostics.stage,'face:graphics:GPU');assert.equal(error.diagnostics.graphics.webglVersion,0);
  assert.match(error.message,/Camera preview can continue/);assert.ok(error.diagnostics.stack);
  assert.equal(messages.filter(message=>message.type==='ready').length,0);
  assert.equal(messages.filter(message=>message.message?.includes('loading CPU models')).length,0);runtime.dispose();
});

test('worker graphics diagnostics survive into controller status for the help and activity views', async () => {
  const h=harness(),pending=h.controller.start({element:camera(),sourceId:'a'});
  const rejected=assert.rejects(pending,error=>error.code==='INFERENCE_GRAPHICS_UNAVAILABLE');
  const worker=h.workers[0],generation=worker.messages[0].message.generation;
  const diagnostics={stage:'face:graphics:GPU',stack:'Error: WebGL unavailable',graphics:{webglVersion:0},previousFailures:[]};
  worker.emit({type:'error',generation,code:'INFERENCE_GRAPHICS_UNAVAILABLE',message:'WebGL image support is unavailable.',diagnostics});
  await rejected;
  assert.equal(h.controller.getState().status,'error');assert.deepEqual(h.controller.getState().error.diagnostics,diagnostics);
  assert.deepEqual(h.statuses.at(-1).diagnostics,diagnostics);assert.equal(worker.terminated,true);assert.equal(h.results.at(-1),null);
});
