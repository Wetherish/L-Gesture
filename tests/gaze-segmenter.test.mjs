import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {createGazeSegmenter,GAZE_SEGMENTATION_MODEL,segmentationImageDimensions,segmentationPoint,validateSegmentationMask} from '../dist/gaze-segmenter.js';
import {createGazeSegmenterWorkerRuntime,loadMagicTouchModel} from '../dist/gaze-segmenter-worker.js';
import {installVisionNetworkPolicy,installVisionModuleLoader} from '../dist/vision-worker-utils.js';

const settle=async()=>{for(let n=0;n<14;n++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const bitmap=(width=64,height=48)=>({width,height,closed:0,close(){this.closed++;}});
const canvas=()=>({width:64,height:48});
const mask=(width=64,height=48)=>({width,height,data:new Float32Array(width*height).fill(.75)});
const point=()=>({x:.4,y:.6});

function harness(options={}){
  let clock=1,nextTimer=0;const timers=new Map(),workers=[],images=[],states=[];
  class Worker {
    messages=[];terminated=false;
    constructor(url,config){this.url=url;this.config=config;workers.push(this);}
    postMessage(message,transfer){this.messages.push({message,transfer});}
    emit(message){this.onmessage?.({data:message});}
    terminate(){this.terminated=true;}
  }
  const controller=createGazeSegmenter({WorkerClass:Worker,now:()=>clock,
    createBitmap:image=>{const frozen=bitmap(image.width,image.height);images.push(frozen);return Promise.resolve(frozen);},
    onState:state=>states.push(state),startupTimeoutMs:1000,bitmapTimeoutMs:100,inferenceTimeoutMs:200,
    setTimer:(callback,ms)=>{const id=++nextTimer;timers.set(id,{callback,at:clock+ms});return id;},clearTimer:id=>timers.delete(id),...options});
  const worker=()=>workers.at(-1),generation=()=>worker().messages.find(row=>row.message.type==='init').message.generation;
  const ready=()=>worker().emit({type:'ready',generation:generation(),delegate:'GPU'});
  const frame=()=>worker()?.messages.filter(row=>row.message.type==='segment').at(-1)?.message;
  const result=(extra={})=>{const job=frame();worker().emit({type:'result',generation:job.generation,id:job.id,
    width:job.width,height:job.height,mask:mask(job.width,job.height),delegate:'GPU',latencyMs:8,...extra});};
  async function prepare(){const job=controller.prepare();ready();await job;return worker();}
  async function advance(ms){clock+=ms;for(const [id,timer] of [...timers])if(timer.at<=clock){timers.delete(id);timer.callback();}await settle();}
  return {controller,workers,worker,generation,ready,frame,result,prepare,advance,timers,images,states};
}

test('model is pinned, chunked below the host limit, and gaze inputs have bounded real dimensions',()=>{
  assert.equal(GAZE_SEGMENTATION_MODEL.version,2);assert.equal(GAZE_SEGMENTATION_MODEL.bytes,30525312);
  assert.equal(GAZE_SEGMENTATION_MODEL.parts.reduce((sum,part)=>sum+part.bytes,0),GAZE_SEGMENTATION_MODEL.bytes);
  assert.ok(GAZE_SEGMENTATION_MODEL.parts.every(part=>part.bytes<25*1024*1024));
  assert.deepEqual(segmentationImageDimensions(canvas()),canvas());
  for(const image of [null,{width:0,height:1},{width:1.1,height:4},{width:8192,height:8192}])assert.throws(()=>segmentationImageDimensions(image));
  for(const value of [null,{x:NaN,y:.1},{x:-.1,y:.5},{x:.2,y:1.01}])assert.throws(()=>segmentationPoint(value));
  assert.deepEqual(segmentationPoint({x:0,y:1,z:5}),{x:0,y:1});
});

test('prepare is lazy and shared; it neither owns a camera nor starts segmentation',async()=>{
  const h=harness();assert.equal(h.workers.length,0);
  const a=h.controller.prepare(),b=h.controller.prepare();assert.equal(h.workers.length,1);assert.equal(h.worker().config.type,'module');
  h.ready();await Promise.all([a,b]);await h.controller.prepare();assert.equal(h.worker().messages.length,1);
  assert.equal(h.controller.getState().ready,true);h.controller.destroy();assert.equal(h.timers.size,0);
});

test('segment freezes source and prompt synchronously and returns unmodified owned probabilities',async()=>{
  const h=harness(),source=canvas(),seed=point();const job=h.controller.segment(source,{point:seed});
  assert.equal(h.images.length,1);source.width=2;seed.x=.99;h.ready();await settle();
  assert.equal(h.frame().width,64);assert.deepEqual(h.frame().point,point());
  assert.deepEqual(h.worker().messages.at(-1).transfer,[h.images[0]]);
  const original=mask();h.result({mask:original});const output=await job;
  assert.equal(output.mask,original);assert.equal(output.mask.data[0],.75);assert.deepEqual(output.point,point());
  assert.equal(output.model.id,'magic-touch-v2-int8');assert.equal(h.controller.getState().completed,1);h.controller.destroy();
});

test('one image at a time, exact generation and operation replies, no previous mask reuse',async()=>{
  const h=harness();await h.prepare();const job=h.controller.segment(canvas(),{point:point()});await settle();
  await assert.rejects(h.controller.segment(canvas(),{point:point()}),{name:'BusyError'});
  h.result({id:h.frame().id+1});h.result({generation:h.frame().generation-1});assert.equal(h.controller.getState().busy,true);
  const empty=mask();empty.data.fill(0);h.result({mask:empty});assert.equal((await job).mask.data[0],0);
  h.result();assert.equal(h.controller.getState().completed,1);h.controller.destroy();
});

test('cancel settles loading and pending work; late bitmap is closed and cannot reach a new worker',async()=>{
  const deferredBitmap=deferred(),h=harness({createBitmap:()=>deferredBitmap.promise});
  const preload=h.controller.prepare(),job=h.controller.segment(canvas(),{point:point()});
  const rejected=[assert.rejects(preload,{name:'AbortError'}),assert.rejects(job,{name:'AbortError'})];
  const previous=h.worker();h.controller.cancel('Source changed.');await Promise.all(rejected);
  const late=bitmap();deferredBitmap.resolve(late);await settle();assert.equal(late.closed,1);assert.equal(previous.terminated,true);
  await h.prepare();assert.equal(h.workers.length,2);assert.equal(h.timers.size,0);h.controller.destroy();
});

test('abort signals are removed after prepare, while active segmentation abort resets only its worker',async()=>{
  const h=harness(),preload=new AbortController();const loading=h.controller.prepare({signal:preload.signal});h.ready();await loading;
  preload.abort();assert.equal(h.controller.getState().ready,true);
  const action=new AbortController(),job=h.controller.segment(canvas(),{point:point(),signal:action.signal});await settle();
  const rejected=assert.rejects(job,{name:'AbortError'});action.abort();await rejected;assert.equal(h.worker().terminated,true);h.controller.destroy();
});

test('invalid and pre-aborted requests allocate no image or worker',async()=>{
  const h=harness(),controller=new AbortController();controller.abort();
  await assert.rejects(h.controller.prepare({signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(h.controller.segment(canvas(),{point:point(),signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(h.controller.segment(canvas(),{point:{x:2,y:0}}),{code:'SEGMENTATION_POINT_INVALID'});
  await assert.rejects(h.controller.segment({width:0,height:2},{point:point()}),{code:'SEGMENTATION_IMAGE_INVALID'});
  assert.equal(h.workers.length,0);assert.equal(h.images.length,0);h.controller.destroy();
});

test('load, bitmap and inference timeouts reject and permit a clean subsequent worker',async()=>{
  const loading=harness(),load=loading.controller.prepare(),loadFailure=assert.rejects(load,{code:'SEGMENTATION_MODEL_TIMEOUT'});
  await loading.advance(1001);await loadFailure;assert.equal(loading.timers.size,0);loading.controller.destroy();
  const lateBitmap=deferred(),frozen=harness({createBitmap:()=>lateBitmap.promise});await frozen.prepare();
  const capture=frozen.controller.segment(canvas(),{point:point()}),captureFailure=assert.rejects(capture,{code:'SEGMENTATION_BITMAP_TIMEOUT'});
  await frozen.advance(101);await captureFailure;const late=bitmap();lateBitmap.resolve(late);await settle();assert.equal(late.closed,1);frozen.controller.destroy();
  const h=harness();await h.prepare();const job=h.controller.segment(canvas(),{point:point()});await settle();
  const failure=assert.rejects(job,{code:'SEGMENTATION_INFERENCE_TIMEOUT'});await h.advance(201);await failure;await h.prepare();assert.equal(h.workers.length,2);h.controller.destroy();
});

test('foreign dimensions and corrupt probabilities fail instead of producing a plausible crop',async()=>{
  for(const override of [{width:1},{mask:{width:64,height:48,data:new Float32Array(1)}},{mask:{...mask(),data:new Float32Array(64*48).fill(NaN)}}]){
    const h=harness();await h.prepare();const job=h.controller.segment(canvas(),{point:point()});await settle();
    const rejected=assert.rejects(job,{name:'DataError'});h.result(override);await rejected;assert.equal(h.worker().terminated,true);h.controller.destroy();
  }
  assert.throws(()=>validateSegmentationMask({width:1,height:1,data:new Float32Array([1.1])},1,1));
});

test('status callback cancellation prevents stale initialization and closes the bitmap',async()=>{
  let controller;const h=harness({onState:state=>{if(state.status==='loading')controller.cancel('Role changed.');}});controller=h.controller;
  await assert.rejects(controller.segment(canvas(),{point:point()}),{name:'AbortError'});await settle();
  assert.equal(h.workers.length,0);assert.equal(h.images[0].closed,1);assert.equal(h.timers.size,0);controller.destroy();
});

test('destroy is final and missing worker support is actionable',async()=>{
  const h=harness({WorkerClass:null});await assert.rejects(h.controller.prepare(),{code:'SEGMENTATION_WORKER_UNAVAILABLE'});
  h.controller.destroy();h.controller.destroy();await assert.rejects(h.controller.prepare(),{code:'SEGMENTER_DESTROYED'});
});

function runtimeHarness({create,run,loadModel,...options}={}){
  const records=[],messages=[],transfers=[];
  const sdk={FilesetResolver:{forVisionTasks:async(path,module)=>{assert.equal(module,true);return {path};}},
    InteractiveSegmenter:{createFromOptions:async(fileset,configuration)=>{
      const record={fileset,configuration,closed:0,images:[],strokes:[],masks:[]};records.push(record);if(create)await create(record);
      return {setImage(image){record.images.push(image);},segment(strokes){record.strokes.push(strokes);
        if(run)return run(record,strokes);
        const image=record.images.at(-1),data=new Float32Array(image.width*image.height).fill(.8);
        const result={width:image.width,height:image.height,closed:0,getAsFloat32Array:()=>data,
          close(){this.closed++;data.fill(0);}};record.masks.push(result);return result;},close(){record.closed++;}};
    }}};
  const runtime=createGazeSegmenterWorkerRuntime({post:(value,transfer)=>{messages.push(value);transfers.push(transfer);},
    importModule:async()=>sdk,createCanvas:()=>({tag:'separate-canvas'}),loadModel:loadModel||(async()=>new Uint8Array([1,2,3])),...options});
  const initialize=()=>runtime.handle({type:'init',generation:7});
  const segment=(image=bitmap(),extra={})=>runtime.handle({type:'segment',generation:7,id:1,bitmap:image,width:image.width,height:image.height,point:point(),...extra});
  return {runtime,records,messages,transfers,initialize,segment};
}

test('worker uses v2 setImage plus a positive point stroke and copies/closes the real mask',async()=>{
  const h=runtimeHarness();await h.initialize();assert.equal(h.messages.at(-1).type,'ready');
  const record=h.records[0];assert.equal(record.configuration.baseOptions.delegate,'GPU');assert.ok(record.configuration.baseOptions.modelAssetBuffer instanceof Uint8Array);
  assert.equal('runningMode' in record.configuration,false);assert.equal('modelAssetPath' in record.configuration.baseOptions,false);
  const image=bitmap();await h.segment(image);const result=h.messages.at(-1);
  assert.equal(record.images[0],image);assert.deepEqual(record.strokes[0],[{brushMode:1,point:[point()],isCompleted:true}]);
  assert.equal(record.masks[0].closed,1);assert.ok(result.mask.data[0]>.79);assert.equal(image.closed,1);
  assert.deepEqual(h.transfers.at(-1),[result.mask.data.buffer]);h.runtime.dispose();assert.equal(record.closed,1);
});

test('GPU creation failure falls back once to CPU without requiring a WebGL preflight',async()=>{
  const h=runtimeHarness({create:record=>{if(record.configuration.baseOptions.delegate==='GPU')throw new Error('GPU unavailable');}});
  await h.initialize();assert.deepEqual(h.records.map(record=>record.configuration.baseOptions.delegate),['GPU','CPU']);
  assert.equal(h.messages.at(-1).delegate,'CPU');await h.segment();assert.equal(h.messages.at(-1).type,'result');h.runtime.dispose();
});

test('failed asset loading never claims verified model integrity',async()=>{
  const h=runtimeHarness({loadModel:async()=>{throw Object.assign(new Error('Chunk hash mismatch'),{code:'SEGMENTATION_MODEL_INTEGRITY'});}});
  await h.initialize();assert.equal(h.messages.at(-1).code,'SEGMENTATION_MODEL_INTEGRITY');
  assert.equal(h.messages.at(-1).diagnostics.modelIntegrity,'not verified');assert.equal(h.records.length,0);h.runtime.dispose();
  const ready=runtimeHarness();await ready.initialize();assert.equal(ready.messages.at(-1).diagnostics.modelIntegrity,'SHA-256 verified');ready.runtime.dispose();
});

test('invalid native mask dimensions are rejected before reading or copying its pixels',async()=>{
  let reads=0,closes=0;const h=runtimeHarness({run:()=>({width:100000,height:100000,
    getAsFloat32Array(){reads++;throw new Error('This should not be read.');},close(){closes++;}})});
  await h.initialize();await h.segment();assert.equal(h.messages.at(-1).code,'SEGMENTATION_MASK_INVALID');
  assert.equal(reads,0);assert.equal(closes,2);h.runtime.dispose();
});

test('GPU inference failure retries the exact image and point only once, then closes failed tasks',async()=>{
  const h=runtimeHarness({run:record=>{if(record.configuration.baseOptions.delegate==='GPU')throw new Error('Context lost');
    const image=record.images.at(-1);return {width:image.width,height:image.height,getAsFloat32Array:()=>mask(image.width,image.height).data,close(){}};}});
  await h.initialize();const image=bitmap();await h.segment(image);
  assert.equal(h.records.length,2);assert.equal(h.records[0].closed,1);
  assert.equal(h.records[1].images[0],image);assert.deepEqual(h.records[1].strokes[0],h.records[0].strokes[0]);
  assert.equal(h.messages.at(-1).type,'result');assert.equal(h.messages.at(-1).delegate,'CPU');assert.equal(image.closed,1);h.runtime.dispose();
});

test('two failed delegates do not loop; a corrupt native mask is closed before rejection',async()=>{
  let masksClosed=0;const h=runtimeHarness({run:record=>{const image=record.images.at(-1);return {width:image.width,height:image.height,
    getAsFloat32Array:()=>new Float32Array(image.width*image.height).fill(NaN),close(){masksClosed++;}};}});
  await h.initialize();const image=bitmap();await h.segment(image);
  assert.equal(h.records.length,2);assert.equal(masksClosed,2);assert.equal(image.closed,1);assert.equal(h.messages.at(-1).type,'error');
  assert.equal(h.messages.at(-1).code,'SEGMENTATION_MASK_INVALID');assert.ok(h.records.every(record=>record.closed===1));h.runtime.dispose();
});

test('dispose during asynchronous task construction closes late task and emits no obsolete ready state',async()=>{
  const gate=deferred(),h=runtimeHarness({create:()=>gate.promise});const starting=h.initialize();await settle();
  h.runtime.dispose();gate.resolve();await starting;assert.equal(h.records[0].closed,1);assert.equal(h.messages.length,0);
  const late=bitmap();await h.segment(late);assert.equal(late.closed,1);
});

test('old generation and mismatched frozen image cannot produce a mask',async()=>{
  const h=runtimeHarness();await h.initialize();const old=bitmap();await h.segment(old,{generation:6});assert.equal(old.closed,1);
  assert.equal(h.records[0].images.length,0);const bad=bitmap();await h.segment(bad,{width:2});
  assert.equal(h.messages.at(-1).code,'SEGMENTATION_RESULT_SIZE');assert.equal(bad.closed,1);h.runtime.dispose();
});

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const testParts=[new Uint8Array([1,2,3]),new Uint8Array([4,5])];
const testModel={bytes:5,sha256:sha(new Uint8Array([1,2,3,4,5])),parts:testParts.map(data=>({bytes:data.length,sha256:sha(data)}))};
function loaderOptions(overrides={}){return {urls:['https://same.test/1','https://same.test/2'],model:testModel,
  digest:(...args)=>webcrypto.subtle.digest(...args),fetcher:async url=>({ok:true,arrayBuffer:async()=>testParts[Number(url.slice(-1))-1].slice().buffer}),...overrides};}

test('model loader verifies individual parts and exact joined bundle before native execution',async()=>{
  const bytes=await loadMagicTouchModel(loaderOptions());assert.deepEqual([...bytes],[1,2,3,4,5]);
  await assert.rejects(loadMagicTouchModel(loaderOptions({model:{...testModel,sha256:'0'.repeat(64)}})),{code:'SEGMENTATION_MODEL_INTEGRITY'});
  await assert.rejects(loadMagicTouchModel(loaderOptions({fetcher:async()=>({ok:true,arrayBuffer:async()=>new Uint8Array([9,9,9]).buffer})})),{code:'SEGMENTATION_MODEL_INTEGRITY'});
  await assert.rejects(loadMagicTouchModel(loaderOptions({fetcher:async()=>({ok:false,status:404})})),{code:'SEGMENTATION_MODEL_DOWNLOAD'});
});

test('model loading honors cancellation before fetching and after asynchronous hashing',async()=>{
  const first=new AbortController();first.abort();let calls=0;
  await assert.rejects(loadMagicTouchModel(loaderOptions({signal:first.signal,fetcher:()=>{calls++;}})),{name:'AbortError'});assert.equal(calls,0);
  const second=new AbortController();await assert.rejects(loadMagicTouchModel(loaderOptions({signal:second.signal,digest:async(...args)=>{
    const hash=await webcrypto.subtle.digest(...args);second.abort();return hash;}})),{name:'AbortError'});
});

test('pure network policy blocks analytics, external requests and redirects before transport',async()=>{
  const seen=[],scope={location:{href:'https://roofcat.test/gaze-segmenter-worker.js'},fetch:async(...args)=>{seen.push(args);return 'ok';}};
  const restore=installVisionNetworkPolicy(scope,'https://roofcat.test');
  for(const [url,options] of [['https://odml.pa.googleapis.com/v1/log',{method:'POST'}],['https://other.test/model'],['https://roofcat.test/upload',{method:'POST'}],['data:text/plain,test']])
    await assert.rejects(scope.fetch(url,options),{name:'SecurityError'});
  assert.equal(seen.length,0);await scope.fetch('/vendor/mediapipe/model',{method:'GET'});
  assert.equal(seen[0][1].redirect,'error');restore();
});

test('pure module hook restores the cached factory for GPU-to-CPU creation without another worker handler',async()=>{
  const previous=()=>{},scope={import:previous},factory=()=>{};
  const restore=installVisionModuleLoader(scope,async()=>({default:factory}),new URL('https://roofcat.test/vendor/mediapipe/wasm/'));
  await scope.import('vision_wasm_module_internal.js');assert.equal(scope.ModuleFactory,factory);delete scope.ModuleFactory;
  await scope.import('vision_wasm_module_internal.js');assert.equal(scope.ModuleFactory,factory);
  await assert.rejects(scope.import('https://other.test/a.js'),{name:'SecurityError'});
  await assert.rejects(scope.import('../outside.js'),{name:'SecurityError'});assert.equal('onmessage' in scope,false);restore();assert.equal(scope.import,previous);
});
