import test from 'node:test';
import assert from 'node:assert/strict';
import {createScenePins} from '../dist/scene-pins.js';
import {fitSceneCalibration,mapSceneGaze} from '../dist/scene-gaze.js';
import {normalizeFps} from '../dist/capture-store.js';
import {parseDeskObjectResponse} from '../dist/openai-scene.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const book={label:'book',score:.83,bbox:{x:.3,y:.4,width:.2,height:.3}};
const result=(frame,detections=[book])=>({width:frame.width,height:frame.height,detections});
function fixture(overrides={}){
  let now=1000,current,blocked=null,active=true,roleKey='main:auto',gazeMode='auto';
  let gaze={sourceId:'rgb',generation:1,width:1280,height:720,kind:'main',type:'camera',live:true};
  let signal={type:'scene-gaze-feature',live:true,feature:{x:.4,y:.6},sourceId:'rgb',generation:1,
    timestampMs:990,observedAtMs:990,method:'browser-iris-head-v1',inputSignature:'face:1280x720:unmirrored',
    geometry:{centerX:.5,centerY:.4,eyeSpan:.2,roll:0}};
  const events=[],added=[],frames=[],leases=[],mapped=[],detections=[],crops=[],releases=new Map();
  const source={sourceId:'cpd',generation:2,width:512,height:640,label:'LVNext CPD Camera',kind:'scene',isActive:()=>active,
    capture(){const frame={width:512,height:640,pixels:'frozen-scene'};frames.push(frame);return frame;},
    async retain(){const lease={stopped:0,stop(){this.stopped++;}};leases.push(lease);return lease;}};
  current=source;
  // Synthetic unit-test gaze observations exercise the real calibration mapper;
  // detector outputs below are explicit fixtures, not claims of model inference.
  const targets=[{x:.15,y:.15},{x:.85,y:.15},{x:.85,y:.85},{x:.15,y:.85},{x:.5,y:.5}];
  const fitted=fitSceneCalibration(targets.map((target,index)=>({target,signal:{...signal,feature:{...target},
    timestampMs:100+index*100,observedAtMs:100+index*100}})),{scene:source});
  assert.equal(fitted.status,'ready');const calibration=fitted.calibration;
  const controller=createScenePins({getSource:()=>current,getGazeSource:()=>gaze,getSelectionKey:()=>roleKey,getGazeMode:()=>gazeMode,
    getSignal:()=>signal,clock:()=>now,getBlockReason:()=>blocked,
    detector:{getState:()=>({busy:false}),async detect(frame,options){detections.push({frame,options});return result(frame);}},
    addPin:(lease,options)=>{added.push({lease,options,fps:normalizeFps(options.fps)});return {index:added.length-1};},
    onState:s=>events.push(s),mapGaze:(...args)=>{mapped.push(args);return mapSceneGaze(...args);},
    cropFrame:(frame,region)=>{const crop={canvas:{width:Math.round(frame.width*region.width),height:Math.round(frame.height*region.height)},region:{...region}};crops.push(crop);return crop;},
    releaseFrame:frame=>{if(frame){releases.set(frame,(releases.get(frame)||0)+1);frame.width=1;frame.height=1;}},
    ...overrides});
  controller.setCalibration(calibration);
  return {controller,source,signal,calibration,events,added,frames,leases,mapped,detections,crops,releases,
    time:x=>now=x,sourceTo:x=>current=x,gazeTo:x=>gaze=x,signalTo:x=>signal=x,rolesTo:x=>roleKey=x,modeTo:x=>gazeMode=x,
    block:x=>blocked=x,end:()=>active=false};
}

// Explicit observation fixture, including both eyes, exercises the real seated
// mapper. It represents normalized, unmirrored geometry from a 1000×800 frame.
function seatedFixture(overrides={}){
  const h=fixture(overrides);
  const signal={type:'scene-gaze-feature',live:true,synthetic:false,replay:false,sourceId:'rgb',generation:1,
    timestampMs:990,observedAtMs:990,method:'browser-iris-head-v1',inputSignature:'face:1000x800:unmirrored',feature:{x:0,y:1/15},
    quality:{kind:'uncalibrated-eye-feature',confidence:null,eyeOpenness:.4,eyeAgreementX:0,eyeAgreementY:0},
    geometry:{centerX:.5,centerY:.375,eyeSpan:.375,roll:0,imageWidth:1000,imageHeight:800,coordinateSpace:'normalized-top-left',noseX:0,noseY:1/3,
      eyes:[.35,.65].map(centerX=>({centerX,centerY:.375,irisX:0,irisY:0,lidMidpointY:0,openness:.4,widthPx:100,axisX:1,axisY:0}))}};
  h.controller.clearCalibration();h.signalTo(signal);
  h.gazeTo({sourceId:'rgb',generation:1,width:1000,height:800,kind:'main',type:'camera',live:true});
  return {...h,seatedSignal:signal};
}

test('default auto mode uses observed seated eyes without calibration and retains the actual scene source for a fixed 10 fps pin',async()=>{
  const h=seatedFixture(),intent=h.controller.freezeIntent();
  assert.equal(intent.gazeMode,'auto');assert.equal(intent.calibration,null);
  const outcome=await h.controller.pin(intent);
  assert.equal(outcome.status,'pinned');assert.equal(outcome.method,'seated-gaze-object');assert.equal(outcome.label,'book');
  assert.equal(outcome.calibrated,false);assert.equal(outcome.mappingMethod,'seated-estimate-v1');
  assert.equal(outcome.gazeQuality.confidence,null);assert.equal(outcome.uncertainty.measured,false);assert.ok(outcome.assumptions.length>0);
  assert.equal(h.mapped.length,0);assert.equal(h.detections.length,1);assert.equal(h.leases.length,1);assert.equal(h.leases[0].stopped,0);
  assert.equal(outcome.sourceId,'cpd');assert.equal(h.added[0].fps,10);assert.notDeepEqual(outcome.crop,h.crops[0].region);
  assert.equal(h.releases.get(intent.frame),1);assert.equal(h.releases.get(h.crops[0].canvas),1);
});

test('seated eye validation fails before inference when eyes, provenance, freshness or source geometry are invalid',async()=>{
  for(const change of [h=>h.signalTo(null),h=>h.seatedSignal.geometry.eyes=[],h=>h.seatedSignal.replay=true,
    h=>h.seatedSignal.observedAtMs=499,h=>h.seatedSignal.observedAtMs=1001,
    h=>h.seatedSignal.geometry.eyes[0].openness=0,h=>h.seatedSignal.geometry.imageWidth=1200,
    h=>h.gazeTo({sourceId:'rgb',generation:1,width:1000,height:800,live:true,mirrored:true})]){
    let picks=0;const h=seatedFixture({pickRegion(){picks++;}});change(h);
    const outcome=await h.controller.pin(h.controller.freezeIntent());
    assert.equal(outcome.status,'not-found');assert.equal(h.detections.length,0);assert.equal(h.leases.length,0);assert.equal(picks,0);
  }
});

test('auto mode prefers an existing fit and never replaces a rejected fit with the seated prior',async()=>{
  let estimated=0;
  const h=fixture({estimateGaze(){estimated++;throw new Error('An existing fit must remain authoritative.');}});
  assert.equal((await h.controller.pin(h.controller.freezeIntent())).method,'calibrated-gaze-object');
  h.controller.setCalibration({...h.calibration,coefficients:[[NaN,0,0],[0,1,0]]});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'not-found');assert.equal(outcome.reason,'calibration-required');assert.equal(estimated,0);
  assert.equal(h.mapped.length,2);assert.equal(h.detections.length,1);assert.equal(h.added.length,1);
});

test('frozen seated jobs cannot save after mode, gaze orientation or capture source changes during inference',async()=>{
  for(const change of [h=>h.modeTo('calibrated'),h=>h.sourceTo({...h.source,generation:3}),
    h=>h.gazeTo({sourceId:'rgb',generation:1,width:1000,height:800,live:true,mirrored:true})]){
    const waiting=deferred();let frozen;
    const h=seatedFixture({segmenter:{segment(frame){frozen=frame;return waiting.promise;}}});
    const intent=h.controller.freezeIntent(),run=h.controller.pin(intent);change(h);waiting.resolve(segmented(frozen));
    assert.equal((await run).status,'cancelled');assert.equal(h.leases.length,0);assert.equal(h.added.length,0);assert.equal(h.detections.length,0);
    assert.equal(h.releases.get(intent.frame),1);assert.equal(h.releases.get(frozen),1);
  }
});

test('independent main-camera gaze selects a real scene object from frozen pixels once and keeps the 10 fps default',async()=>{
  const h=fixture(),intent=h.controller.freezeIntent();h.time(9000);
  const outcome=await h.controller.pin(intent);
  assert.equal(outcome.status,'pinned');assert.equal(outcome.method,'calibrated-gaze-object');assert.equal(outcome.label,'book');
  assert.equal(outcome.sourceId,'cpd');assert.equal(h.mapped[0][0].sourceId,'rgb');assert.equal(h.mapped[0][2].nowMs,1000);
  assert.equal(h.detections.length,1);assert.strictEqual(h.detections[0].frame,h.crops[0].canvas);assert.equal(h.detections[0].options.includeHands,false);
  assert.equal(h.crops[0].region.width,.75);assert.equal(h.crops[0].region.height,.75);
  assert.equal(h.added[0].options.present,false);assert.equal(h.added[0].options.quiet,true);assert.equal(h.added[0].fps,10);
  assert.equal(h.added[0].options.fps,undefined,'CaptureBoard retains control of the chosen default rate');
  const roi=h.crops[0].region;
  assert.ok(Math.abs(h.added[0].options.region.x-(roi.x+.3*roi.width-.2*roi.width*.02))<1e-10);
  assert.ok(Math.abs(h.added[0].options.region.width-.2*roi.width*1.04)<1e-10);
  assert.equal(h.leases[0].stopped,0);assert.equal(h.releases.get(intent.frame),1);
  h.controller.getCalibration();assert.equal(h.detections.length,1,'live pin ownership starts no further inference');
});
test('intent copies gaze, source identity and calibration before model latency can change them',async()=>{
  const h=fixture(),intent=h.controller.freezeIntent();h.signal.feature.x=.8;h.calibration.coefficients[0][2]=50;h.source.label='Renamed';
  assert.equal(Object.isFrozen(intent),true);assert.equal(Object.isFrozen(intent.signal.feature),true);
  assert.equal(intent.signal.feature.x,.4);assert.equal(intent.source.label,'LVNext CPD Camera');
  assert.equal((await h.controller.pin(intent)).status,'pinned');assert.equal(h.added[0].options.sourceLabel,'LVNext CPD Camera');
});
test('multiple successful pins retain independent leases and never replace earlier pins',async()=>{
  const h=fixture();for(let i=0;i<3;i++)assert.equal((await h.controller.pin(h.controller.freezeIntent())).status,'pinned');
  assert.equal(h.added.length,3);assert.equal(new Set(h.leases).size,3);assert.ok(h.leases.every(x=>x.stopped===0));
  h.leases[0].stop();assert.equal(h.leases[1].stopped,0);
});
test('no capture camera and explicit calibrated mode without a fit return not-found without a picker or retained lease',async()=>{
  let picks=0;const h=fixture({pickRegion:async()=>{picks++;return null;}});
  h.sourceTo(null);assert.equal((await h.controller.pin(h.controller.freezeIntent())).reason,'capture-unavailable');
  h.sourceTo(h.source);h.controller.clearCalibration();h.modeTo('calibrated');
  const missing=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(missing.reason,'calibration-required');assert.match(missing.message,/seated estimate/);
  assert.equal(picks,0);assert.equal(h.detections.length,0);assert.equal(h.leases.length,0);
});
test('stale, future, pre-calibration, wrong-source and absent gaze cannot start object inference or open a picker',async()=>{
  const changes=[s=>({...s,observedAtMs:499}),s=>({...s,observedAtMs:1001}),s=>({...s,timestampMs:500}),
    s=>({...s,sourceId:'other'}),()=>null];
  for(const change of changes){
    let picks=0;const h=fixture({pickRegion:()=>{picks++;}});h.signalTo(change(h.signal));
    const outcome=await h.controller.pin(h.controller.freezeIntent());
    assert.equal(outcome.status,'not-found');assert.equal(h.detections.length,0);assert.equal(h.leases.length,0);assert.equal(picks,0);
    assert.equal(h.releases.get(h.frames[0]),1);
  }
});
test('gaze outside its actual calibration area is rejected without a guessed crop',async()=>{
  const h=fixture();h.signal.feature={x:.99,y:.99};
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'not-found');assert.equal(outcome.reason,'outside-calibration');assert.equal(h.detections.length,0);assert.equal(h.added.length,0);
});
test('missing or distant detections get one generous-ROI fallback pass, never an arbitrary region or picker',async()=>{
  for(const boxes of [[],[{...book,bbox:{x:.02,y:.02,width:.1,height:.1}}]]){
    let count=0,picks=0;const h=fixture({detector:{async detect(frame){count++;return result(frame,boxes);}},pickRegion:()=>{picks++;}});
    const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.equal(outcome.status,'not-found');assert.equal(outcome.reason,'no-object');assert.equal(count,1);assert.equal(picks,0);
    assert.equal(outcome.message,'Couldn’t find a clear object where you’re looking.');
    assert.equal(h.added.length,0);assert.equal(h.leases.length,0);assert.equal(h.releases.get(intent.frame),1);
    assert.equal(h.crops.length,1);assert.equal(h.releases.get(h.crops[0].canvas),1);
  }
});
test('equally plausible distinct objects still stop without another model retry or a manual picker',async()=>{
  const boxes=[{...book,bbox:{x:.25,y:.35,width:.2,height:.3}},{...book,label:'cup',bbox:{x:.55,y:.35,width:.2,height:.3}}];
  let count=0,picks=0;const h=fixture({detector:{async detect(frame){count++;return result(frame,boxes);}},pickRegion:()=>{picks++;}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'not-found');assert.equal(outcome.reason,'ambiguous-object');assert.equal(count,1);
  assert.equal(h.crops.length,1);assert.equal(h.leases.length,0);assert.equal(picks,0);
});
test('focused detection maps a complete small book back to the original source and never saves the search crop',async()=>{
  let count=0;const focusedBox={label:'book',score:.91,bbox:{x:.3,y:.2,width:.4,height:.55}};
  const h=fixture({detector:{async detect(frame){count++;return result(frame,[focusedBox]);}}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'pinned');assert.equal(count,1);assert.equal(h.crops.length,1);
  const roi=h.crops[0].region,crop=h.added[0].options.region;
  const objectX=roi.x+.3*roi.width,objectWidth=.4*roi.width;
  assert.ok(Math.abs(crop.x-(objectX-objectWidth*.02))<1e-10);
  assert.ok(Math.abs(crop.width-objectWidth*1.04)<1e-10);assert.notDeepEqual(crop,roi);
  assert.equal(h.releases.get(h.crops[0].canvas),1);assert.equal(h.added[0].options.title,'Pin · book');
});
test('object boxes cut by an artificial focused-image edge never become a saved pin',async()=>{
  let count=0;const h=fixture({detector:{async detect(frame){count++;return result(frame,[{...book,bbox:{x:0,y:.2,width:.8,height:.6}}]);}}});
  assert.equal((await h.controller.pin(h.controller.freezeIntent())).status,'not-found');
  assert.equal(count,1);assert.equal(h.leases.length,0);assert.equal(h.added.length,0);
});
test('a mismatched object result cannot bind to the frozen frame',async()=>{
  const h=fixture({detector:{async detect(frame){return {...result(frame),width:frame.width+1};}}});
  assert.equal((await h.controller.pin(h.controller.freezeIntent())).status,'error');assert.equal(h.leases.length,0);assert.equal(h.crops.length,1);
});
test('a busy shared detector is not invoked again and does not acquire a camera lease',async()=>{
  let calls=0;const h=fixture({detector:{getState:()=>({busy:true}),detect(){calls++;}}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.reason,'detector-busy');assert.equal(calls,0);assert.equal(h.leases.length,0);
});
test('source, gaze session, dimensions or routing-policy changes during detection cancel the obsolete capture',async()=>{
  for(const change of [h=>h.sourceTo({...h.source,generation:3}),h=>h.source.width=1024,
    h=>h.gazeTo({sourceId:'rgb',generation:2,width:1280,height:720,kind:'main',type:'camera',live:true}),
    h=>h.rolesTo('main:scene'),h=>h.controller.clearCalibration()]){
    const waiting=deferred();let frozen;const h=fixture({detector:{detect(frame){frozen=frame;return waiting.promise;}}});
    const run=h.controller.pin(h.controller.freezeIntent());change(h);waiting.resolve(result(frozen));
    assert.equal((await run).status,'cancelled');assert.equal(h.leases.length,0);assert.equal(h.added.length,0);assert.equal(h.releases.get(frozen),1);
  }
});
test('explicit cancellation aborts one-time detection and ignores a late result',async()=>{
  const waiting=deferred();let frozen,signal;const h=fixture({detector:{detect(frame,options){frozen=frame;signal=options.signal;return waiting.promise;}}});
  const run=h.controller.pin(h.controller.freezeIntent());h.controller.cancel();assert.equal(signal.aborted,true);
  waiting.resolve(result(frozen));assert.equal((await run).status,'cancelled');assert.equal(h.leases.length,0);assert.equal(h.releases.get(frozen),1);
});
test('the frozen gaze remains authoritative if a later eye observation disappears during model work',async()=>{
  const waiting=deferred();let frozen;const h=fixture({detector:{detect(frame){frozen=frame;return waiting.promise;}}});
  const run=h.controller.pin(h.controller.freezeIntent());h.signalTo(null);h.time(15000);waiting.resolve(result(frozen));
  assert.equal((await run).status,'pinned');assert.equal(h.added.length,1);
});
test('manual:true works without gaze or calibration and never invokes object detection',async()=>{
  let picks=0;const h=fixture({pickRegion:async()=>{picks++;return {region:{x:0,y:0,width:1,height:1}};}});
  h.controller.clearCalibration();h.gazeTo(null);h.signalTo(null);
  assert.equal((await h.controller.pin(h.controller.freezeIntent(),{manual:true})).status,'pinned');
  assert.equal(picks,1);assert.equal(h.mapped.length,0);assert.equal(h.detections.length,0);assert.equal(h.added[0].fps,10);
});
test('cancelled explicit crop picker saves nothing and releases its frozen frame once',async()=>{
  const h=fixture({pickRegion:async()=>null}),intent=h.controller.freezeIntent();
  assert.equal((await h.controller.pin(intent,{manual:true})).status,'cancelled');
  assert.equal(h.added.length,0);assert.equal(h.releases.get(intent.frame),1);
});
test('capture source switching while an explicit picker is open cannot pin its replacement',async()=>{
  const wait=deferred(),h=fixture({pickRegion:()=>wait.promise});
  const run=h.controller.pin(h.controller.freezeIntent(),{manual:true});h.sourceTo({...h.source,generation:3});
  wait.resolve({region:{x:0,y:0,width:1,height:1}});
  assert.equal((await run).status,'cancelled');assert.equal(h.added.length,0);
});
test('explicit manual cancellation aborts its crop selector and cannot overwrite a newer HUD',async()=>{
  const old=deferred(),next=deferred();let count=0,signal;
  const h=fixture({pickRegion:options=>{signal=options.signal;return ++count===1?old.promise:next.promise;}});
  const first=h.controller.pin(h.controller.freezeIntent(),{manual:true});h.controller.cancel();assert.equal(signal.aborted,true);
  const second=h.controller.pin(h.controller.freezeIntent(),{manual:true}),before=h.events.length;
  old.resolve(null);await first;assert.equal(h.events.length,before);assert.equal(h.events.at(-1).actionState,'choosing');
  next.resolve(null);await second;
});
test('cancellation during lease acquisition releases the late lease exactly once',async()=>{
  const wait=deferred(),h=fixture();let stopped=0;h.source.retain=()=>wait.promise;
  const run=h.controller.pin(h.controller.freezeIntent());await flush();h.controller.cancel();wait.resolve({stop(){stopped++;}});
  assert.equal((await run).status,'cancelled');assert.equal(stopped,1);assert.equal(h.added.length,0);
});
test('board capacity is rechecked after an asynchronous source retain',async()=>{
  const wait=deferred(),h=fixture();let stopped=0;h.source.retain=()=>wait.promise;
  const run=h.controller.pin(h.controller.freezeIntent());await flush();h.block('All keys full');wait.resolve({stop(){stopped++;}});
  assert.equal((await run).status,'error');assert.equal(stopped,1);assert.equal(h.added.length,0);
});
test('failed board insertion releases the pin lease and captured frame',async()=>{
  const h=fixture({addPin:()=>null}),intent=h.controller.freezeIntent();
  assert.equal((await h.controller.pin(intent)).status,'error');assert.equal(h.leases[0].stopped,1);assert.equal(h.releases.get(intent.frame),1);
});
test('repeated triggers do not queue or release the active intent; a new extra frame is released',async()=>{
  const wait=deferred();let frozen;const h=fixture({detector:{detect(frame){frozen=frame;return wait.promise;}}});
  const intent=h.controller.freezeIntent(),run=h.controller.pin(intent);
  assert.equal((await h.controller.pin(intent)).status,'busy');assert.equal(intent.isReleased(),false);
  const extra=h.controller.freezeIntent();assert.equal((await h.controller.pin(extra)).status,'busy');assert.equal(h.releases.get(extra.frame),1);
  wait.resolve(result(frozen));assert.equal((await run).status,'pinned');assert.equal(h.releases.get(intent.frame),1);
});
test('calibration is invalidated by either camera session, capture dimensions or orientation',()=>{
  const h=fixture();assert.deepEqual(h.controller.getCalibration(),h.calibration);assert.notStrictEqual(h.controller.getCalibration(),h.calibration);
  for(const source of [{...h.source,width:1024},{...h.source,generation:3},{...h.source,mirrored:true}]){
    h.sourceTo(source);assert.equal(h.controller.getCalibration(),null);
  }
  h.sourceTo(h.source);h.gazeTo({sourceId:'other',generation:1,live:true});assert.equal(h.controller.getCalibration(),null);
});
test('changing only the object-snapshot role preserves the independent gaze calibration',()=>{
  const h=fixture(),calibration=h.controller.getCalibration();h.rolesTo('main:scene:main');
  assert.strictEqual(h.controller.getCalibration(),calibration);
});
test('failure while freezing metadata releases already captured pixels',async()=>{
  const h=fixture({getSignal(){throw new Error('Gaze provider unavailable.');}}),intent=h.controller.freezeIntent();
  assert.equal(h.releases.get(h.frames[0]),1);assert.equal((await h.controller.pin(intent)).status,'not-found');
  assert.equal(h.releases.get(h.frames[0]),1);assert.equal(h.leases.length,0);
});
test('unplugged cameras, released intents and destroy cannot create a pin',async()=>{
  const h=fixture(),intent=h.controller.freezeIntent();h.end();assert.equal((await h.controller.pin(intent)).status,'cancelled');
  assert.equal((await h.controller.pin(intent)).status,'cancelled');assert.equal(h.detections.length,0);assert.equal(h.added.length,0);assert.equal(h.releases.get(intent.frame),1);
  const other=fixture(),unused=other.controller.freezeIntent();other.controller.destroy();
  assert.equal((await other.controller.pin(unused)).status,'cancelled');assert.equal(other.releases.get(unused.frame),1);
});

function probabilityMask(rect={x:.35,y:.3,width:.3,height:.4},{width=80,height=100}={}){
  const data=new Float32Array(width*height);
  if(rect)for(let y=Math.floor(rect.y*height);y<Math.ceil((rect.y+rect.height)*height-1e-9);y++)
    for(let x=Math.floor(rect.x*width);x<Math.ceil((rect.x+rect.width)*width-1e-9);x++)data[y*width+x]=.92;
  return {width,height,data};
}
const segmented=(frame,mask=probabilityMask())=>({width:frame.width,height:frame.height,mask,
  model:{name:'Explicit test mask',id:'test-fixture'},delegate:'CPU',latencyMs:12});
function contrastCopy(frame){return {changed:true,canvas:{width:frame.width,height:frame.height,contrast:true},statistics:{method:'linear-contrast',gain:4}};}

test('point segmentation uses the generous frozen ROI and pins tight real component bounds without a semantic confidence',async()=>{
  const calls=[];
  const h=fixture({segmenter:{async segment(frame,options){calls.push({frame,options});return segmented(frame);}}});
  const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
  assert.equal(outcome.status,'pinned');assert.equal(outcome.method,'calibrated-gaze-segmentation');assert.equal(outcome.score,null);
  assert.equal(outcome.label,'Segmented region');assert.equal(calls.length,1);assert.equal(h.detections.length,0);
  assert.strictEqual(calls[0].frame,h.crops[0].canvas);assert.equal(calls[0].options.point.x,.5);assert.ok(Math.abs(calls[0].options.point.y-.5)<1e-12);
  assert.ok(outcome.crop.width<.25&&outcome.crop.height<.33);assert.notDeepEqual(outcome.crop,h.crops[0].region);
  assert.ok(Math.abs(outcome.crop.width-.234)<1e-12);assert.ok(Math.abs(outcome.crop.height-.312)<1e-12);
  assert.equal(h.added[0].fps,10);assert.equal(h.releases.get(intent.frame),1);assert.equal(h.releases.get(h.crops[0].canvas),1);
});
test('a foreground cut by the ROI expands to the same full frozen frame exactly once',async()=>{
  const calls=[];let normalization=0;
  const h=fixture({segmenter:{async segment(frame,options){calls.push({frame,options});return segmented(frame,calls.length===1
    ?probabilityMask({x:0,y:.3,width:.7,height:.4}):probabilityMask({x:0,y:.3,width:.65,height:.5}));}},
    normalizeContrast(){normalization++;return {changed:false};}});
  const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
  assert.equal(outcome.status,'pinned');assert.equal(calls.length,2);assert.strictEqual(calls[1].frame,intent.frame);
  assert.equal(calls[1].options.point.x,.4);assert.ok(Math.abs(calls[1].options.point.y-.6)<1e-12);
  assert.equal(normalization,0);assert.equal(outcome.crop.x,0,'true camera-image edge is allowed');assert.equal(h.detections.length,0);
});
test('useful contrast retry followed by full-frame boundary rescue has a hard three-segmentation-call budget',async()=>{
  const calls=[],normalized=[];
  const h=fixture({segmenter:{async segment(frame){calls.push(frame);return segmented(frame,calls.length===1?probabilityMask(null)
    :calls.length===2?probabilityMask({x:0,y:.3,width:.7,height:.4}):probabilityMask({x:.2,y:.3,width:.4,height:.5}));}},
    normalizeContrast(frame){const value=contrastCopy(frame);normalized.push(value.canvas);return value;}});
  const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
  assert.equal(outcome.status,'pinned');assert.equal(calls.length,3);assert.equal(normalized.length,2);
  assert.strictEqual(calls[1],normalized[0]);assert.strictEqual(calls[2],normalized[1]);assert.equal(h.detections.length,0);
  for(const frame of [intent.frame,h.crops[0].canvas,...normalized])assert.equal(h.releases.get(frame),1);
});
test('failed raw, normalized and full-frame segmentation permits just one detector fallback and never an arbitrary crop',async()=>{
  let segments=0,detects=0,pickers=0;
  const h=fixture({segmenter:{async segment(frame){segments++;return segmented(frame,segments===1?probabilityMask(null)
    :probabilityMask({x:0,y:0,width:1,height:1}));}},normalizeContrast:contrastCopy,
    detector:{async detect(frame){detects++;return result(frame,[]);}},pickRegion(){pickers++;}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'not-found');assert.equal(segments,3);assert.equal(detects,1);assert.equal(pickers,0);assert.equal(h.added.length,0);
  for(const times of h.releases.values())assert.equal(times,1);
});
test('uniform or already contrasted input does not spend another segmentation pass after an empty mask',async()=>{
  let segments=0,normalizations=0;
  const h=fixture({segmenter:{async segment(frame){segments++;return segmented(frame,probabilityMask(null));}},
    normalizeContrast(){normalizations++;return {changed:false,canvas:null};}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'pinned');assert.equal(outcome.method,'calibrated-gaze-object');assert.equal(segments,1);assert.equal(normalizations,1);
  assert.equal(h.detections.length,1);assert.equal(outcome.score,.83);
});
test('segmentation backend failure and malformed masks can use a real ranked detector box without fabricated mask evidence',async()=>{
  for(const segment of [async()=>{throw new Error('Graphics context unavailable');},async frame=>({...segmented(frame),width:frame.width+1}),
    async frame=>segmented(frame,{width:80,height:100,data:new Float32Array(1)})]){
    const h=fixture({segmenter:{segment}}),outcome=await h.controller.pin(h.controller.freezeIntent());
    assert.equal(outcome.status,'pinned');assert.equal(outcome.method,'calibrated-gaze-object');assert.equal(outcome.label,'book');assert.equal(h.detections.length,1);
  }
});
test('explicit local GPU failure stops before detector fallback, manual pickers or retained camera leases',async()=>{
  let segments=0,pickers=0;
  const failure=Object.assign(new Error('Start the local GPU service on this laptop.'),{allowDetectorFallback:false});
  const h=fixture({segmenter:{async segment(){segments++;throw failure;}},pickRegion(){pickers++;}});
  const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
  assert.equal(outcome.status,'error');assert.equal(outcome.message,failure.message);assert.equal(segments,1);
  assert.equal(h.detections.length,0);assert.equal(pickers,0);assert.equal(h.leases.length,0);assert.equal(h.added.length,0);
  assert.equal(h.events.at(-1).actionState,'error');assert.equal(h.releases.get(intent.frame),1);
  assert.equal(h.crops.length,1);assert.equal(h.releases.get(h.crops[0].canvas),1);
});
test('source, gaze, debug/action key or calibration changes during segmentation abort before fallback and camera retention',async()=>{
  for(const change of ['source','gaze','action','calibration']){
    const wait=deferred();let frozen,signal,key='same';
    const h=fixture({getDebugSourceKey:()=>key,segmenter:{segment(frame,options){frozen=frame;signal=options.signal;return wait.promise;}}});
    const run=h.controller.pin(h.controller.freezeIntent());
    if(change==='source')h.sourceTo({...h.source,generation:3});
    else if(change==='gaze')h.gazeTo({sourceId:'other',generation:1,live:true});
    else if(change==='action')key='different';else h.controller.clearCalibration();
    wait.resolve(segmented(frozen));assert.equal((await run).status,'cancelled');
    assert.equal(h.detections.length,0);assert.equal(h.leases.length,0);assert.equal(h.releases.get(frozen),1);
    assert.ok(signal instanceof AbortSignal);
  }
});
test('explicit cancellation aborts the segmenter signal and discards late mask pixels',async()=>{
  const wait=deferred();let frozen,signal;
  const h=fixture({segmenter:{segment(frame,options){frozen=frame;signal=options.signal;return wait.promise;}}});
  const intent=h.controller.freezeIntent(),run=h.controller.pin(intent);h.controller.cancel();assert.equal(signal.aborted,true);
  wait.resolve(segmented(frozen));assert.equal((await run).status,'cancelled');assert.equal(h.added.length,0);assert.equal(h.detections.length,0);
  assert.equal(h.releases.get(frozen),1);assert.equal(h.releases.get(intent.frame),1);
});

function debugCanvas(){
  const canvas={width:0,height:0};
  canvas.getContext=()=>({drawImage(input){canvas.copiedFrom=input;},createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(image){canvas.pixels=image.data;}});
  return canvas;
}
test('debug emits immutable metadata and separately owned thumbnails, releases them after callback and preserves raw processing pixels',async()=>{
  const traces=[],borrowed=[];let observedOriginal;
  const h=fixture({isDebugEnabled:()=>true,getDebugSourceKey:()=>'camera-roles-and-sessions',createCanvas:debugCanvas,
    onDebug(event){
      assert.equal(Object.isFrozen(event),true);if(event.gaze)assert.equal(Object.isFrozen(event.gaze),true);
      assert.equal(event.sourceKey,'camera-roles-and-sessions');
      if(event.frame){borrowed.push(event.frame);assert.notStrictEqual(event.frame,event.frame.copiedFrom);assert.ok(event.frame.width<=640&&event.frame.height<=480);}
      if(event.mask?.image)borrowed.push(event.mask.image);
      traces.push({stage:event.stage,operation:event.operation,confidence:event.confidence,mask:!!event.mask,image:event.frame,region:event.frameRegion});
    },segmenter:{async segment(frame){observedOriginal={width:frame.width,height:frame.height};return segmented(frame);}}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());assert.equal(outcome.status,'pinned');
  assert.deepEqual(observedOriginal,{width:384,height:480});
  assert.deepEqual(traces.map(value=>value.stage),['capture','roi','model','model','result']);
  assert.ok(traces.some(value=>value.mask));assert.ok(traces.every(value=>value.confidence==null));
  for(const canvas of borrowed){assert.equal(canvas.width,1);assert.equal(canvas.height,1);assert.equal(h.releases.get(canvas),1);}
});
test('CUDA debug keeps actual mask IoU separate from semantic confidence and labels binary membership honestly',async()=>{
  const traces=[],qualityScore=.3001441955566406;
  const h=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,
    onDebug(event){traces.push({stage:event.stage,confidence:event.confidence,qualityScore:event.qualityScore,
      qualityScoreKind:event.qualityScoreKind,maskStatistics:event.maskStatistics,semantics:event.mask?.semantics,threshold:event.mask?.threshold});},
    segmenter:{async segment(frame){
      const mask=probabilityMask();mask.data=Uint8Array.from(mask.data,value=>value>0?1:0);
      return {...segmented(frame,mask),delegate:'CUDA',maskSemantics:'binary',qualityScore,qualityScoreKind:'predicted-mask-iou',
        model:{id:'sam2.1-tiny',name:'SAM 2.1 Tiny'}};
    }}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'pinned');assert.equal(outcome.score,null);assert.equal(outcome.qualityScore,qualityScore);
  assert.equal(outcome.qualityScoreKind,'predicted-mask-iou');assert.equal(h.detections.length,0);
  const model=traces.find(event=>event.semantics==='binary');assert.ok(model);
  assert.equal(model.threshold,null);assert.equal(model.qualityScore,qualityScore);assert.ok(model.maskStatistics);
  assert.equal(Object.hasOwn(model.maskStatistics,'meanForegroundProbability'),false);
  assert.ok(traces.every(event=>event.confidence==null));assert.equal(traces.at(-1).qualityScore,qualityScore);
  assert.equal(traces.at(-1).qualityScoreKind,'predicted-mask-iou');
});
test('debug disabled allocates no snapshots; debug callback exceptions never change selection or pin ownership',async()=>{
  const disabled=fixture({isDebugEnabled:()=>false,createCanvas(){throw new Error('Debug must not allocate');},onDebug(){throw new Error('Debug must not emit');},
    segmenter:{async segment(frame){return segmented(frame);}}});
  assert.equal((await disabled.controller.pin(disabled.controller.freezeIntent())).status,'pinned');
  const throwing=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug(){throw new Error('Renderer closed');},
    segmenter:{async segment(frame){return segmented(frame);}}});
  assert.equal((await throwing.controller.pin(throwing.controller.freezeIntent())).status,'pinned');assert.equal(throwing.leases[0].stopped,0);
});
test('debug reports invalid gaze after its capture stage without starting models',async()=>{
  const stages=[],h=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>stages.push(event.stage)});
  h.signalTo(null);assert.equal((await h.controller.pin(h.controller.freezeIntent())).status,'not-found');
  assert.deepEqual(stages,['capture','error']);assert.equal(h.detections.length,0);
});

test('seated mapping stays explicitly approximate through model previews and final pin metadata',async()=>{
  const traces=[];
  const h=seatedFixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
    segmenter:{async segment(frame){return segmented(frame);}}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'pinned');assert.equal(outcome.method,'seated-gaze-segmentation');assert.equal(outcome.score,null);
  assert.deepEqual(traces.map(event=>event.stage),['capture','roi','model','model','result']);
  for(const event of traces.slice(1)){
    assert.equal(event.calibrated,false);assert.equal(event.mappingMethod,'seated-estimate-v1');assert.equal(event.gazeQuality.confidence,null);
    assert.equal(event.confidence,null);assert.ok(event.assumptions.length);assert.equal(event.uncertainty.measured,false);
    assert.equal(Object.isFrozen(event.assumptions),true);assert.equal(Object.isFrozen(event.uncertainty),true);
  }
  assert.match(traces.findLast(event=>event.stage==='model').message,/near the seated estimate/);
  assert.deepEqual(traces.at(-1).assumptions,outcome.assumptions);assert.deepEqual(traces.at(-1).uncertainty,outcome.uncertainty);
});

const fallbackObject=frame=>({status:'ready',width:frame.width,height:frame.height,crop:{x:.2,y:.25,width:.4,height:.5},label:'Notebook',
  model:{id:'test-scene-model',name:'Explicit scene fixture'}});
function documentObject(frame){
  const quad=[{x:.2,y:.25},{x:.6,y:.25},{x:.6,y:.75},{x:.2,y:.75}];
  return {...fallbackObject(frame),documentKind:'notebook',quad,transform:{type:'perspective',quad,rotationDegrees:180},
    orientation:{status:'software-rotated',method:'page-corners-plus-180',clockwiseDegrees:180}};
}

test('valid local keyboard or laptop detections reach one configured desk-object fallback instead of becoming the pin',async()=>{
  for(const label of ['keyboard','laptop','TV']){
    let localCalls=0;const calls=[];
    const h=fixture({detector:{async detect(frame){localCalls++;return result(frame,[{...book,label,score:.99}]);}},
      selectFallbackRegion:async request=>{calls.push(request);return fallbackObject(request.frame);}});
    const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.equal(outcome.status,'pinned');assert.equal(outcome.method,'scene-object-fallback');assert.equal(outcome.label,'Notebook');
    assert.equal(localCalls,1);assert.equal(calls.length,1);assert.equal(calls[0].reason,'no-object');assert.strictEqual(calls[0].frame,intent.frame);
    assert.equal(h.crops[0].region.width,.75);assert.equal(h.crops[0].region.height,.75,'recognition still receives the broad search image');
    assert.equal(h.added.length,1);assert.equal(h.leases.length,1);
  }
});

test('an opt-in scene fallback can select from the frozen frame when gaze is absent, stale, or not mappable',async()=>{
  for(const change of [h=>h.signalTo(null),h=>h.signalTo({...h.signal,observedAtMs:499}),
    h=>{h.controller.clearCalibration();h.modeTo('calibrated');},h=>h.controller.clearCalibration()]){
    const calls=[];let picks=0;
    const h=fixture({selectFallbackRegion:async request=>{calls.push(request);return fallbackObject(request.frame);},pickRegion(){picks++;}});
    change(h);const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.equal(outcome.status,'pinned');assert.equal(outcome.method,'scene-object-fallback');assert.equal(outcome.mappingMethod,'scene-object-model');
    assert.equal(outcome.calibrated,null);assert.equal(outcome.gazeQuality,null);assert.equal(outcome.score,null);
    assert.equal(calls.length,1);assert.strictEqual(calls[0].frame,intent.frame);assert.equal(calls[0].source.sourceId,'cpd');
    assert.equal(calls[0].gaze,null);assert.ok(calls[0].signal instanceof AbortSignal);
    assert.equal(h.detections.length,0);assert.equal(h.leases.length,1);assert.equal(h.added[0].fps,10);assert.equal(picks,0);
    assert.equal(h.releases.get(intent.frame),1);
  }
});

test('gaze-model misses try one configured scene fallback without emitting a premature terminal debug error',async()=>{
  const calls=[],traces=[];
  const h=fixture({detector:{async detect(frame){return result(frame,[]);}},
    selectFallbackRegion:async request=>{calls.push(request);return fallbackObject(request.frame);},
    isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event)});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.method,'scene-object-fallback');assert.equal(calls.length,1);assert.equal(calls[0].reason,'no-object');
  assert.equal(calls[0].gaze.calibrated,true);assert.equal(traces.some(event=>event.stage==='error'),false);
  const fallback=traces.find(event=>event.pass==='scene-object-fallback');
  assert.ok(fallback);assert.equal(fallback.gaze,null);assert.equal(fallback.roi,null);assert.equal(fallback.calibrated,null);
  assert.equal(traces.at(-1).mappingMethod,'scene-object-model');assert.equal(h.leases.length,1);
});

test('an explicitly configured scene fallback may handle a GPU-service failure without substituting the local detector',async()=>{
  let fallbackCalls=0;
  const error=Object.assign(new Error('Selected local GPU service is unavailable.'),{allowDetectorFallback:false});
  const h=fixture({segmenter:{async segment(){throw error;}},selectFallbackRegion:async request=>{fallbackCalls++;return fallbackObject(request.frame);}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.method,'scene-object-fallback');assert.equal(fallbackCalls,1);assert.equal(h.detections.length,0);assert.equal(h.leases.length,1);
});

test('an unconfigured optional fallback preserves the original miss or precise backend failure',async()=>{
  const noGaze=fixture({selectFallbackRegion:async()=>null});noGaze.signalTo(null);
  const missing=await noGaze.controller.pin(noGaze.controller.freezeIntent());
  assert.equal(missing.status,'not-found');assert.equal(missing.reason,'gaze-missing');assert.equal(noGaze.added.length,0);
  const error=Object.assign(new Error('Start the selected GPU service.'),{allowDetectorFallback:false});
  const failed=fixture({segmenter:{async segment(){throw error;}},selectFallbackRegion:async()=>null});
  const outcome=await failed.controller.pin(failed.controller.freezeIntent());
  assert.equal(outcome.status,'error');assert.equal(outcome.message,error.message);assert.equal(failed.detections.length,0);
});

test('mode, camera and explicit cancellation discard late scene fallback results before retaining a source',async()=>{
  for(const change of [h=>h.modeTo('calibrated'),h=>h.sourceTo({...h.source,generation:3}),h=>h.controller.cancel()]){
    const wait=deferred();let request;
    const h=fixture({selectFallbackRegion:value=>{request=value;return wait.promise;}});h.signalTo(null);
    const intent=h.controller.freezeIntent(),run=h.controller.pin(intent);change(h);wait.resolve(fallbackObject(request.frame));
    assert.equal((await run).status,'cancelled');assert.equal(h.leases.length,0);assert.equal(h.added.length,0);assert.equal(h.releases.get(intent.frame),1);
  }
});

test('fallback frame mismatch, invalid crops or malformed perspective geometry cannot become live pins',async()=>{
  const quad=[{x:.2,y:.25},{x:.6,y:.25},{x:.6,y:.75},{x:.2,y:.75}];
  for(const extra of [{width:1},{crop:{x:-.1,y:.1,width:.3,height:.4}},
    {quad:[quad[0],quad[2],quad[1],quad[3]]},{quad:[{x:0,y:0},...quad.slice(1)]},
    {transform:{type:'unknown',quad}},{quad,transform:{type:'perspective',quad:[{x:.21,y:.25},...quad.slice(1)]}}]){
    const h=fixture({selectFallbackRegion:async({frame})=>({...fallbackObject(frame),...extra})});h.signalTo(null);
    assert.equal((await h.controller.pin(h.controller.freezeIntent())).status,'error');assert.equal(h.leases.length,0);assert.equal(h.added.length,0);
  }
});

test('validated fixed perspective geometry is preserved through pin creation without unrelated transform fields',async()=>{
  const quad=[{x:.22,y:.27},{x:.58,y:.26},{x:.59,y:.73},{x:.21,y:.74}],transform={type:'perspective',quad};
  const h=fixture({selectFallbackRegion:async({frame})=>({...fallbackObject(frame),quad,transform:{...transform,privateMetadata:'must-not-survive'}})});
  h.signalTo(null);const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'pinned');assert.deepEqual(outcome.quad,quad);assert.deepEqual(outcome.transform,transform);
  assert.deepEqual(h.added[0].options.transform,transform);assert.deepEqual(h.added[0].options.quad,quad);
  assert.equal(Object.isFrozen(h.added[0].options.transform),true);
  quad[0].x=.5;assert.equal(outcome.quad[0].x,.22,'model output cannot later alter the fixed crop geometry');
});

test('parsed page geometry and the software 180-degree turn reach the live pin, debug result and outcome unchanged',async()=>{
  for(const corners of [
    [{x:200,y:250},{x:600,y:250},{x:600,y:750},{x:200,y:750}],
    [{x:250,y:280},{x:580,y:250},{x:600,y:700},{x:200,y:750}],
  ]){
    const traces=[];let selection,expectedTransform,expectedOrientation;
    const h=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
      selectFallbackRegion:async({frame})=>{
        const value={status:'found',label:'Notebook',document_type:'notebook',corners};
        const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]};
        selection=parseDeskObjectResponse(response,{width:frame.width,height:frame.height,model:'explicit-response-fixture'});
        expectedTransform=structuredClone(selection.transform);expectedOrientation={...selection.orientation};
        selection.transform.privateMetadata='not-for-storage';selection.orientation.rawResponse='not-for-debug';return selection;
      }});
    h.signalTo(null);const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.equal(outcome.status,'pinned');assert.equal(h.leases.length,1);assert.equal(h.added.length,1);
    assert.equal(expectedTransform.rotationDegrees,180);
    assert.deepEqual(expectedOrientation,{status:'software-rotated',method:'page-corners-plus-180',clockwiseDegrees:180});
    assert.deepEqual(h.added[0].options.transform,expectedTransform);assert.deepEqual(outcome.transform,expectedTransform);
    assert.deepEqual(outcome.orientation,expectedOrientation);assert.equal(Object.isFrozen(outcome.orientation),true);
    assert.deepEqual(traces.find(event=>event.pass==='scene-object-fallback').orientation,expectedOrientation);
    assert.deepEqual(traces.at(-1).transform,expectedTransform);assert.deepEqual(traces.at(-1).orientation,expectedOrientation);
    assert.equal(traces.at(-1).stage,'result');assert.equal(Object.isFrozen(traces.at(-1).orientation),true);
    selection.transform.quad[0].x=0;selection.orientation.clockwiseDegrees=0;
    assert.deepEqual(outcome.transform,expectedTransform);assert.deepEqual(outcome.orientation,expectedOrientation);
    assert.deepEqual(h.added[0].options.transform,expectedTransform);assert.equal(h.releases.get(intent.frame),1);
  }
});

test('malformed reading metadata cannot claim an upright result and invalid rotations fail before a camera lease',async()=>{
  const quad=[{x:.2,y:.25},{x:.6,y:.25},{x:.6,y:.75},{x:.2,y:.75}];
  const traces=[],h=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
    selectFallbackRegion:async({frame})=>({...fallbackObject(frame),orientation:{status:'unknown',method:'rotation',clockwiseDegrees:180,rawResponse:'discard'}})});
  h.signalTo(null);const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.status,'pinned');assert.equal(outcome.orientation,undefined);assert.equal(traces.at(-1).orientation,undefined);
  for(const rotationDegrees of [null,NaN,181,-181,'180']){
    const invalid=fixture({selectFallbackRegion:async({frame})=>({...fallbackObject(frame),transform:{type:'perspective',quad,rotationDegrees}})});
    invalid.signalTo(null);const intent=invalid.controller.freezeIntent(),result=await invalid.controller.pin(intent);
    assert.equal(result.status,'error');assert.match(result.message,/reading rotation/);
    assert.equal(invalid.leases.length,0);assert.equal(invalid.added.length,0);assert.equal(invalid.releases.get(intent.frame),1);
  }
});

test('typed scene fallback failure reports its reason without a picker, source lease or saved region',async()=>{
  let picks=0;
  const h=fixture({selectFallbackRegion:async()=>({status:'not-found',reason:'api-key-missing',message:'Add your API key in the eye menu.'}),pickRegion(){picks++;}});
  h.signalTo(null);const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(outcome.reason,'api-key-missing');assert.equal(outcome.message,'Add your API key in the eye menu.');
  assert.equal(picks,0);assert.equal(h.leases.length,0);assert.equal(h.added.length,0);
});

function budgetTimers(){
  let next=0;const pending=new Map(),scheduled=[],cleared=[];
  return {pending,scheduled,cleared,
    setTimer(callback,ms){const id=++next;pending.set(id,callback);scheduled.push({id,ms});return id;},
    clearTimer(id){cleared.push(id);pending.delete(id);},
    fire(){const [id,callback]=pending.entries().next().value||[];assert.ok(callback,'one local budget must be active');pending.delete(id);callback();}
  };
}

test('configured cloud fallback gets one frozen image after the total local 12-second budget expires',async()=>{
  const timers=budgetTimers(),waiting=deferred(),requests=[];let localSignal;
  const h=fixture({...timers,getFallbackAvailable:()=>true,
    segmenter:{segment(_frame,{signal}){localSignal=signal;return waiting.promise;}},
    selectFallbackRegion:async request=>{requests.push(request);return fallbackObject(request.frame);}});
  const intent=h.controller.freezeIntent(),run=h.controller.pin(intent);
  assert.equal(timers.scheduled.length,1);assert.equal(timers.scheduled[0].ms,12000);
  timers.fire();const outcome=await run;
  assert.equal(outcome.method,'scene-object-fallback');assert.equal(requests.length,1);
  assert.equal(requests[0].reason,'local-gaze-timeout');assert.strictEqual(requests[0].frame,intent.frame);
  assert.equal(localSignal.aborted,true);assert.notStrictEqual(requests[0].signal,localSignal);
  assert.equal(requests[0].signal.aborted,false,'the cloud keeps the live outer transaction signal');
  assert.equal(h.detections.length,0);assert.equal(h.added.length,1);assert.equal(timers.pending.size,0);
  assert.equal(timers.cleared.length,1);assert.equal(h.releases.get(intent.frame),1);
  waiting.resolve(null);await flush();
});

test('outer cancellation ends a budgeted local provider that ignores abort without invoking cloud',async()=>{
  const timers=budgetTimers(),waiting=deferred();let cloudCalls=0,signal;
  const h=fixture({...timers,getFallbackAvailable:()=>true,
    segmenter:{segment(_frame,options){signal=options.signal;return waiting.promise;}},
    selectFallbackRegion:async request=>{cloudCalls++;return fallbackObject(request.frame);}});
  const intent=h.controller.freezeIntent(),run=h.controller.pin(intent);h.controller.cancel();
  assert.equal((await run).status,'cancelled');assert.equal(signal.aborted,true);assert.equal(cloudCalls,0);
  assert.equal(h.leases.length,0);assert.equal(timers.pending.size,0);assert.equal(timers.cleared.length,1);
  assert.equal(h.releases.get(intent.frame),1);waiting.resolve(null);await flush();
});

test('a late local segmentation success after timeout cannot write debug stages or add a second pin',async()=>{
  const timers=budgetTimers(),waiting=deferred(),traces=[];let late;
  const h=fixture({...timers,getFallbackAvailable:()=>true,isDebugEnabled:()=>true,createCanvas:debugCanvas,
    onDebug:event=>traces.push({stage:event.stage,pass:event.pass}),
    segmenter:{segment(frame){late=segmented(frame);return waiting.promise;}},
    selectFallbackRegion:async request=>fallbackObject(request.frame)});
  const run=h.controller.pin(h.controller.freezeIntent());timers.fire();assert.equal((await run).status,'pinned');
  const before=structuredClone(traces),events=h.events.length;waiting.resolve(late);await flush();
  assert.deepEqual(traces,before);assert.equal(h.events.length,events);assert.equal(h.added.length,1);assert.equal(h.detections.length,0);
  assert.equal(traces.filter(event=>event.pass==='scene-object-fallback').length,1);
});

test('without a configured fallback the normal local provider timeout remains in control',async()=>{
  const timers=budgetTimers(),waiting=deferred();let late,signal,cloudCalls=0;
  const h=fixture({...timers,getFallbackAvailable:()=>false,
    segmenter:{segment(frame,options){late=segmented(frame);signal=options.signal;return waiting.promise;}},
    selectFallbackRegion:async()=>{cloudCalls++;return null;}});
  const run=h.controller.pin(h.controller.freezeIntent());h.time(25000);assert.equal(timers.scheduled.length,0);
  waiting.resolve(late);const outcome=await run;assert.equal(outcome.method,'calibrated-gaze-segmentation');
  assert.equal(signal.aborted,false);assert.equal(cloudCalls,0);assert.equal(timers.cleared.length,0);
});

test('one local deadline covers both segmentation and the detector fallback and ignores late detector boxes',async()=>{
  const timers=budgetTimers(),waiting=deferred();let localSignal,late;const requests=[];
  const h=fixture({...timers,getFallbackAvailable:()=>true,
    segmenter:{async segment(frame){return segmented(frame,probabilityMask(null));}},normalizeContrast:()=>({changed:false}),
    detector:{detect(frame,{signal}){late=result(frame);localSignal=signal;return waiting.promise;}},
    selectFallbackRegion:async request=>{requests.push(request);return fallbackObject(request.frame);}});
  const run=h.controller.pin(h.controller.freezeIntent());await flush();assert.ok(localSignal);
  assert.equal(timers.scheduled.length,1);timers.fire();assert.equal((await run).method,'scene-object-fallback');
  assert.equal(localSignal.aborted,true);assert.equal(requests.length,1);waiting.resolve(late);await flush();
  assert.equal(h.added.length,1);assert.equal(timers.pending.size,0);
});

test('successful local selection clears the optional budget before retaining the live pin source',async()=>{
  const timers=budgetTimers();let cloudCalls=0;
  const h=fixture({...timers,getFallbackAvailable:()=>true,
    selectFallbackRegion:async request=>{cloudCalls++;return fallbackObject(request.frame);}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());assert.equal(outcome.method,'calibrated-gaze-object');
  assert.equal(cloudCalls,0);assert.equal(timers.scheduled.length,1);assert.equal(timers.cleared.length,1);assert.equal(timers.pending.size,0);
});

test('successful local gaze selection receives one document-corner refinement after its budget closes and preserves gaze provenance',async()=>{
  for(const {make,segmenter,method,calibrated} of [
    {make:fixture,method:'calibrated-gaze-object',calibrated:true},
    {make:seatedFixture,method:'seated-gaze-object',calibrated:false},
    {make:fixture,segmenter:{async segment(frame){return segmented(frame);}},method:'calibrated-gaze-segmentation',calibrated:true},
  ]){
    const timers=budgetTimers(),calls=[],traces=[],pins=[];let response;
    const h=make({...timers,...(segmenter?{segmenter}:{}),getFallbackAvailable:()=>true,
      selectFallbackRegion(){assert.fail('local success must not run object-only fallback');},
      isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
      refineSelectedRegion(request){
        calls.push(request);assert.equal(timers.pending.size,0,'the local timeout is already closed');
        assert.equal(timers.cleared.length,1);assert.equal(h.leases.length,0,'no camera lease is retained before geometry finishes');
        assert.strictEqual(request.frame,intent.frame);assert.equal(request.frame.pixels,'frozen-scene');
        assert.deepEqual([request.frame.width,request.frame.height],[512,640]);
        assert.strictEqual(request.source,intent.source);assert.equal(request.signal.aborted,false);
        assert.equal(Object.isFrozen(request.regionHint),true);assert.ok(request.regionHint.width<1&&request.regionHint.height<1);
        assert.equal(request.allowSceneFallback,true);
        assert.ok(request.gaze);response=documentObject(request.frame);
        response.crop.privateMetadata='discard';response.quad[0].privateMetadata='discard';response.transform.privateMetadata='discard';
        response.orientation.rawResponse='discard';response.rawResponse='discard';return response;
      },
      addPin:(lease,options)=>{pins.push({lease,options});return {index:5,scanEnhanced:options.scanEnhanced};}});
    const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.equal(outcome.status,'pinned');assert.equal(outcome.method,method);assert.equal(outcome.calibrated,calibrated);
    assert.equal(calls.length,1);assert.equal(h.frames.length,1);assert.equal(h.leases.length,1);assert.equal(pins.length,1);
    assert.equal(pins[0].lease,h.leases[0]);assert.equal(h.leases[0].stopped,0);
    assert.equal(pins[0].options.transform.rotationDegrees,180);assert.deepEqual(pins[0].options.transform.quad,response.quad.map(({x,y})=>({x,y})));
    assert.equal(pins[0].options.documentKind,'notebook');assert.equal(pins[0].options.scanEnhanced,true);
    assert.equal(pins[0].options.transform.privateMetadata,undefined);assert.equal(pins[0].options.region.privateMetadata,undefined);
    assert.equal(pins[0].options.quad[0].privateMetadata,undefined);assert.equal(pins[0].options.rawResponse,undefined);
    assert.equal(Object.isFrozen(pins[0].options.transform),true);assert.equal(Object.isFrozen(pins[0].options.transform.quad[0]),true);
    assert.deepEqual(outcome.orientation,{status:'software-rotated',method:'page-corners-plus-180',clockwiseDegrees:180});
    const cornerPass=traces.find(event=>event.pass==='document-corners');assert.ok(cornerPass);
    assert.equal(traces.filter(event=>event.pass==='document-corners').length,1);assert.equal(cornerPass.calibrated,calibrated);
    assert.equal(cornerPass.method,method);assert.equal(cornerPass.mappingMethod,outcome.mappingMethod);assert.ok(cornerPass.gaze);
    assert.equal(cornerPass.transform.rotationDegrees,180);assert.deepEqual(cornerPass.transform,pins[0].options.transform);
    assert.deepEqual(traces.at(-1).transform,pins[0].options.transform);assert.equal(traces.at(-1).stage,'result');
    assert.equal(traces.at(-1).calibrated,calibrated);assert.equal(h.events.filter(event=>event.message==='Finding object boundaries.').length,1);
    assert.equal(h.releases.get(intent.frame),1);
    response.transform.quad[0].x=0;response.orientation.clockwiseDegrees=0;
    assert.equal(pins[0].options.transform.quad[0].x,.2);assert.equal(outcome.orientation.clockwiseDegrees,180);
    h.controller.getCalibration();assert.equal(calls.length,1,'live pin ownership never repeats the model request');
  }
});

test('manual regions and already-used object fallback do not receive a second document model request',async()=>{
  const manual=fixture({pickRegion:async()=>({region:{x:.1,y:.2,width:.4,height:.5}}),
    refineSelectedRegion(){assert.fail('manual crop must not invoke document refinement');}});
  manual.signalTo(null);
  assert.equal((await manual.controller.pin(manual.controller.freezeIntent(),{manual:true})).method,'manual');
  assert.equal(manual.detections.length,0);assert.equal(manual.leases.length,1);
  let fallbackCalls=0;
  const automatic=fixture({selectFallbackRegion:async request=>{fallbackCalls++;return documentObject(request.frame);},
    refineSelectedRegion(){assert.fail('fallback already supplied document geometry');}});
  automatic.signalTo(null);const outcome=await automatic.controller.pin(automatic.controller.freezeIntent());
  assert.equal(outcome.method,'scene-object-fallback');assert.equal(outcome.transform.rotationDegrees,180);
  assert.equal(fallbackCalls,1);assert.equal(automatic.leases.length,1);assert.equal(automatic.added.length,1);
});

test('an unconfigured refinement callback can decline without cloud traffic or changing a valid local selection',async()=>{
  const baseline=fixture(),original=await baseline.controller.pin(baseline.controller.freezeIntent());let calls=0;
  const h=fixture({refineSelectedRegion:async()=>{calls++;return null;}});
  const outcome=await h.controller.pin(h.controller.freezeIntent());
  assert.equal(calls,1);assert.equal(outcome.status,'pinned');assert.equal(outcome.method,original.method);
  assert.deepEqual(outcome.crop,original.crop);assert.equal(outcome.label,original.label);assert.equal(outcome.transform,undefined);
  assert.equal(h.leases.length,1);assert.equal(h.detections.length,1);assert.equal(h.added.length,1);
});

test('ordinary bounding-box results pin through fallback and refinement without document transforms or enhancement',async()=>{
  for(const route of ['fallback','refinement'])for(const label of ['Dental floss box','Chocolate box','Coffee cup']){
    const requests=[],traces=[];
    const select=request=>{
      requests.push(request);
      return {status:'ready',width:request.frame.width,height:request.frame.height,label,model:'ordinary-object-fixture',
        crop:route==='refinement'?{x:request.regionHint.x+.02,y:request.regionHint.y+.02,width:.004,height:.06}
          :{x:.5,y:.5,width:.004,height:.06},targetMatched:false,scanEnhanced:true};
    };
    const h=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
      ...(route==='fallback'?{selectFallbackRegion:select}:{refineSelectedRegion:select})});
    if(route==='fallback')h.signalTo(null);
    const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.equal(outcome.status,'pinned');assert.equal(outcome.label,label);assert.equal(requests.length,1);
    assert.strictEqual(requests[0].frame,intent.frame);assert.equal(h.frames.length,1);assert.equal(h.leases.length,1);
    assert.deepEqual(h.added[0].options.region,outcome.crop);assert.equal(outcome.crop.width,.004);
    for(const key of ['quad','transform','documentKind','scanEnhanced']){
      assert.equal(h.added[0].options[key],undefined);assert.equal(outcome[key],undefined);
    }
    if(route==='refinement'){
      assert.equal(requests[0].allowSceneFallback,true);assert.equal(Object.isFrozen(requests[0].regionHint),true);
      assert.equal(outcome.method,'calibrated-gaze-object');assert.equal(outcome.calibrated,true,
        'computed overlap wins over an untrusted false targetMatched flag');
      const event=traces.find(event=>event.pass==='object-boundaries');assert.ok(event?.gaze);assert.ok(event.roi);
      assert.equal(event.confidence,null);assert.equal(event.quad,undefined);assert.equal(event.transform,undefined);
    }else assert.equal(outcome.method,'scene-object-fallback');
    assert.equal(traces.at(-1).scanEnhanced,false);assert.equal(h.releases.get(intent.frame),1);
  }
});

test('a foreground rescue outside the local gaze crop clears gaze provenance using computed overlap',async()=>{
  for(const make of [fixture,seatedFixture]){
    const requests=[],traces=[];let fallbacks=0;
    const h=make({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
      selectFallbackRegion(){fallbacks++;assert.fail('refinement already supplied an object');},
      refineSelectedRegion(request){requests.push(request);return {status:'ready',width:request.frame.width,height:request.frame.height,
        crop:{x:.82,y:.03,width:.1,height:.1},label:'Chocolate box',model:'foreground-fixture',targetMatched:true};}});
    const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.equal(outcome.status,'pinned');assert.equal(requests.length,1);assert.equal(requests[0].allowSceneFallback,true);
    assert.strictEqual(requests[0].frame,intent.frame);assert.equal(fallbacks,0);assert.equal(h.leases.length,1);
    assert.equal(outcome.method,'scene-object-fallback');assert.equal(outcome.calibrated,null);
    assert.equal(outcome.mappingMethod,'scene-object-model');assert.equal(outcome.gazeQuality,null);
    assert.deepEqual(outcome.assumptions,[]);assert.equal(outcome.uncertainty,null);assert.equal(outcome.score,null);
    const event=traces.find(event=>event.pass==='object-boundaries');
    assert.equal(event.gaze,null);assert.equal(event.roi,null);assert.equal(event.calibrated,null);
    assert.equal(event.mappingMethod,'scene-object-model');assert.match(event.message,/outside the gaze target/);
    assert.equal(traces.at(-1).mappingMethod,'scene-object-model');assert.equal(h.releases.get(intent.frame),1);
  }
});

test('a semantic AI no-object miss preserves a real same-frame ordinary category detection without another request',async()=>{
  for(const label of ['Dental floss box','Chocolate box','cup']){
    const detector={async detect(frame){return {...result(frame,[{...book,label}]),model:{id:'local-detector-fixture'}};}};
    const baseline=fixture({detector}),original=await baseline.controller.pin(baseline.controller.freezeIntent());
    const traces=[],requests=[];let fallbacks=0;
    const h=fixture({detector,isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
      selectFallbackRegion(){fallbacks++;assert.fail('retained local detection needs no further model request');},
      refineSelectedRegion(request){requests.push(request);return {status:'not-found',reason:'scene-object-missing',message:'No desk object found.'};}});
    const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.equal(outcome.status,'pinned');assert.equal(requests.length,1);assert.strictEqual(requests[0].frame,intent.frame);
    assert.equal(fallbacks,0);assert.equal(h.frames.length,1);assert.equal(h.leases.length,1);assert.equal(h.added.length,1);
    assert.equal(outcome.label,label);assert.deepEqual(outcome.crop,original.crop);assert.equal(outcome.score,original.score);
    assert.equal(outcome.method,original.method);assert.equal(outcome.calibrated,true);assert.equal(outcome.mappingMethod,original.mappingMethod);
    assert.deepEqual(h.added[0].options.region,original.crop);assert.equal(h.added[0].options.transform,undefined);
    assert.equal(h.added[0].options.documentKind,undefined);assert.equal(h.added[0].options.scanEnhanced,undefined);
    const event=traces.find(event=>event.pass==='local-object-recovery');assert.ok(event?.gaze);assert.ok(event.roi);
    assert.equal(event.confidence,.83);assert.equal(event.scoreKind,'detector-category-score');
    assert.equal(event.model.id,'local-detector-fixture');assert.equal(event.boxes[0].label,label);assert.equal(event.boxes[0].score,.83);
    assert.match(event.message,/AI found no object; kept/);assert.equal(traces.some(event=>event.stage==='error'),false);
    assert.equal(h.events.at(-1).actionState,'pinned');assert.equal(h.releases.get(intent.frame),1);
  }
});

test('AI no-object misses cannot recover unlabeled segmentation, documents, generic objects, bodies or camera hardware',async()=>{
  const miss=()=>({status:'not-found',reason:'scene-object-missing',message:'No desk object found.'});
  const segmentedCase=fixture({segmenter:{async segment(frame){return segmented(frame);}},refineSelectedRegion:miss});
  assert.equal((await segmentedCase.controller.pin(segmentedCase.controller.freezeIntent())).status,'not-found');
  assert.equal(segmentedCase.leases.length,0);assert.equal(segmentedCase.added.length,0);
  for(const label of ['book','Notebook','paper','document','unknown object','Segmented region','hand','laptop','desk','background']){
    let calls=0;
    // A deliberately supplied category result isolates the recovery guard even
    // for categories rejected earlier by the production ranked detector filter.
    const crop={x:.2,y:.3,width:.2,height:.2},object={label,score:.9,bbox:crop};
    const h=fixture({selectRegion:()=>({status:'ready',selection:'object',object,crop,label,score:.9}),
      refineSelectedRegion(){calls++;return miss();}});
    const outcome=await h.controller.pin(h.controller.freezeIntent());
    assert.equal(calls,1);assert.equal(outcome.status,'not-found',label);assert.equal(outcome.reason,'scene-object-missing');
    assert.equal(h.leases.length,0);assert.equal(h.added.length,0);
  }
});

test('ordinary local detections cannot hide document-corner failures, API errors or invalid model geometry',async()=>{
  for(const refineSelectedRegion of [
    async()=>({status:'not-found',reason:'scene-corners-unavailable',message:'Four paper corners are required.'}),
    async()=>({status:'not-found',reason:'openai-key-required',message:'Add an API key.'}),
    async()=>{throw Object.assign(new Error('The API key was rejected.'),{code:'OPENAI_REQUEST_FAILED'});},
    async()=>{throw Object.assign(new Error('Could not connect.'),{code:'OPENAI_CONNECTION_FAILED'});},
    async()=>({status:'unexpected'}),
    async({frame})=>({...fallbackObject(frame),label:'cup',width:1}),
    async({frame})=>({...fallbackObject(frame),label:'cup',crop:{x:-.1,y:.2,width:.3,height:.3}}),
  ]){
    let calls=0;
    const h=fixture({detector:{async detect(frame){return result(frame,[{...book,label:'cup'}]);}},
      refineSelectedRegion:request=>{calls++;return refineSelectedRegion(request);},
      selectFallbackRegion(){assert.fail('a refinement error must not send another model request');}});
    const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.ok(['not-found','error'].includes(outcome.status));assert.equal(calls,1);
    assert.equal(h.leases.length,0);assert.equal(h.added.length,0);assert.equal(h.releases.get(intent.frame),1);
  }
});

test('cancellation and source changes cannot save late ordinary foreground rescue or local recovery results',async()=>{
  for(const change of [h=>h.controller.cancel(),h=>h.sourceTo({...h.source,generation:3}),h=>h.rolesTo('other-role')])
    for(const response of ['ready','missing']){
      const waiting=deferred();let request;
      const h=fixture({detector:{async detect(frame){return result(frame,[{...book,label:'cup'}]);}},
        refineSelectedRegion:value=>{request=value;return waiting.promise;}});
      const intent=h.controller.freezeIntent(),run=h.controller.pin(intent);await flush();assert.ok(request);
      change(h);waiting.resolve(response==='ready'?{...fallbackObject(request.frame),label:'Chocolate box',crop:{x:.8,y:.05,width:.1,height:.1}}
        :{status:'not-found',reason:'scene-object-missing'});
      assert.equal((await run).status,'cancelled');assert.equal(h.leases.length,0);assert.equal(h.added.length,0);
      assert.equal(h.releases.get(intent.frame),1);assert.equal(h.releases.get(h.crops[0].canvas),1);
    }
});

test('document refinement misses, invalid geometry and service failures stop without silently saving the local crop',async()=>{
  for(const refineSelectedRegion of [
    async()=>({status:'not-found',reason:'scene-corners-unavailable',message:'Keep all four notebook corners visible.'}),
    async()=>{throw new Error('The selected model is unavailable.');},
    async()=>({status:'unexpected'}),
    async({frame})=>({...documentObject(frame),width:1}),
    async({frame})=>({...documentObject(frame),crop:{x:-.1,y:.1,width:.4,height:.5}}),
    async({frame})=>({...documentObject(frame),transform:null}),
    async({frame})=>({...documentObject(frame),transform:{...documentObject(frame).transform,rotationDegrees:0}}),
    async({frame})=>({...documentObject(frame),quad:documentObject(frame).quad.toReversed()}),
  ]){
    let fallbackCalls=0;
    const h=fixture({refineSelectedRegion,selectFallbackRegion:async()=>{fallbackCalls++;return null;}});
    const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    assert.ok(['not-found','error'].includes(outcome.status));assert.ok(outcome.message);
    assert.equal(h.leases.length,0);assert.equal(h.added.length,0);assert.equal(fallbackCalls,0,'refinement failure is reported, not sent to another paid attempt');
    assert.equal(h.releases.get(intent.frame),1);assert.equal(h.events.at(-1).actionState,outcome.status);
  }
});

test('explicit document results without fixed correction are rejected on the shared fallback path too',async()=>{
  for(const transform of [undefined,null,{type:'perspective',quad:documentObject({width:512,height:640}).quad,rotationDegrees:0}]){
    const h=fixture({selectFallbackRegion:async({frame})=>({...documentObject(frame),transform})});h.signalTo(null);
    const outcome=await h.controller.pin(h.controller.freezeIntent());
    assert.equal(outcome.status,'error');assert.equal(h.added.length,0);assert.equal(h.leases.length,0);
  }
});

test('cancellation and camera or gaze changes discard a late refinement before retaining a live source',async()=>{
  for(const change of [h=>h.controller.cancel(),h=>h.sourceTo({...h.source,generation:3}),
    h=>h.gazeTo({sourceId:'rgb',generation:2,width:1280,height:720,live:true}),h=>h.rolesTo('different-role'),
    h=>h.modeTo('calibrated'),h=>h.controller.clearCalibration()]){
    const waiting=deferred();let request;
    const h=fixture({refineSelectedRegion:value=>{request=value;return waiting.promise;}});
    const intent=h.controller.freezeIntent(),run=h.controller.pin(intent);await flush();assert.ok(request);
    change(h);waiting.resolve(documentObject(request.frame));const outcome=await run;
    assert.equal(outcome.status,'cancelled');assert.equal(h.leases.length,0);assert.equal(h.added.length,0);
    assert.equal(h.releases.get(intent.frame),1);assert.equal(h.releases.get(h.crops[0].canvas),1);
  }
});

test('only explicitly classified paper or notebook fallback captures request automatic scan enhancement',async()=>{
  for(const documentKind of ['paper','notebook',undefined,null,'book','Paper','phone',true,{kind:'paper'}]){
    const calls=[],pins=[],traces=[];
    const h=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
      selectFallbackRegion:async request=>{calls.push(request);return {...documentObject(request.frame),documentKind,
        scanEnhanced:true,originalFrame:'must-not-transfer',apiKey:'must-not-transfer',privateMetadata:'must-not-transfer'};},
      addPin:(lease,options)=>{pins.push({lease,options});return {index:7,scanEnhanced:options.scanEnhanced===true};}});
    h.signalTo(null);const intent=h.controller.freezeIntent(),outcome=await h.controller.pin(intent);
    const expected=documentKind==='paper'||documentKind==='notebook';
    assert.equal(outcome.status,'pinned');assert.equal(pins.length,1);assert.equal(pins[0].lease,h.leases[0]);
    assert.equal(pins[0].options.documentKind,expected?documentKind:undefined);
    assert.equal(pins[0].options.scanEnhanced,expected?true:undefined);
    assert.equal(outcome.documentKind,expected?documentKind:undefined);assert.equal(outcome.scanEnhanced,expected?true:undefined);
    for(const key of ['originalFrame','apiKey','privateMetadata'])assert.equal(Object.hasOwn(pins[0].options,key),false);
    assert.equal(traces.at(-1).documentKind,expected?documentKind:undefined);assert.equal(traces.at(-1).scanEnhanced,expected);
    assert.equal(calls.length,1);assert.strictEqual(calls[0].frame,intent.frame);
    assert.equal(h.frames.length,1);assert.equal(h.leases.length,1);assert.equal(h.detections.length,0);
    assert.equal(h.leases[0].stopped,0);assert.equal(h.releases.get(intent.frame),1);
  }
});

test('scene debug reports the actual saved filter state when enhancement fails without retrying inference or retaining another camera',async()=>{
  for(const scanEnhanced of [false,undefined]){
    const requests=[],pins=[],traces=[];
    const h=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
      selectFallbackRegion:async request=>{requests.push(request);return documentObject(request.frame);},
      addPin:(lease,options)=>{pins.push({lease,options});return {index:3,...(scanEnhanced!==undefined?{scanEnhanced}:{})};}});
    h.signalTo(null);const outcome=await h.controller.pin(h.controller.freezeIntent());
    assert.equal(pins[0].options.scanEnhanced,true,'creation asks the board for document enhancement');
    assert.equal(outcome.status,'pinned');assert.equal(outcome.scanEnhanced,false);
    assert.equal(traces.at(-1).stage,'result');assert.equal(traces.at(-1).scanEnhanced,false);
    assert.equal(requests.length,1);assert.equal(h.leases.length,1);assert.equal(h.frames.length,1);
    assert.equal(h.detections.length,0);assert.equal(h.leases[0].stopped,0);
  }
});

test('scene corner-verification metadata is copied, whitelisted and immutable in debug output',async()=>{
  for(const [supplied,expected] of [
    [{method:'edge-refined',verifiedEdges:4,rawResponse:'discard'},{method:'edge-refined',verifiedEdges:4}],
    [{method:'model-corners',verifiedEdges:2,privateImage:'discard'},{method:'model-corners',verifiedEdges:2}],
    [{method:'edge-refined',verifiedEdges:3},undefined],
    [{method:'model-corners',verifiedEdges:5},undefined],
    [{method:'guessed',verifiedEdges:4},undefined],
  ]){
    const traces=[];
    const h=fixture({isDebugEnabled:()=>true,createCanvas:debugCanvas,onDebug:event=>traces.push(event),
      selectFallbackRegion:async({frame})=>({...documentObject(frame),documentKind:'paper',cornerRefinement:supplied})});
    h.signalTo(null);const outcome=await h.controller.pin(h.controller.freezeIntent());
    assert.equal(outcome.status,'pinned');
    const model=traces.find(event=>event.pass==='scene-object-fallback'),final=traces.at(-1);
    assert.deepEqual(model.cornerRefinement,expected);assert.deepEqual(final.cornerRefinement,expected);
    if(expected){
      assert.equal(Object.isFrozen(model.cornerRefinement),true);assert.equal(Object.isFrozen(final.cornerRefinement),true);
      assert.notEqual(final.cornerRefinement,supplied);supplied.verifiedEdges=0;
      assert.deepEqual(final.cornerRefinement,expected);assert.deepEqual(model.cornerRefinement,expected);
    }
    assert.equal(h.added[0].options.cornerRefinement,undefined,'diagnostics are not persisted as capture options');
    assert.equal(h.leases.length,1);
  }
});
