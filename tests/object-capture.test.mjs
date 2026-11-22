import test from 'node:test';
import assert from 'node:assert/strict';
import {createObjectCapture, cropFrozenFrame, mapDetectionsFromRegion} from '../dist/object-capture.js';
import {leftHandSearchRegion,selectHeldObject} from '../dist/held-object.js';

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const selected = {status: 'selected', label: 'cup', crop: {x: .2, y: .3, width: .2, height: .25}};
const handFrame = {type: 'browser_inference', coordinate_space: 'normalized', image_resolution: {width: 1000, height: 600}, handLandmarks: [], handedness: [], inference: {location: 'browser', engine: 'MediaPipe'}};
const detection = {bbox: {x: .1, y: .2, width: .3, height: .4}, label: 'cup', score: .9};

function harness(options = {}) {
  let sourceId = 'camera-1', blocked = null, shotCount = 0;
  const frames = [], calls = [], saved = [], states = [], released = [], crops = [];
  const detector = {
    detect(canvas, {signal, includeHands}) { const pending = deferred(); calls.push({canvas, signal, includeHands, ...pending}); return pending.promise; },
    cancel(reason) { this.cancellations.push(reason); },
    cancellations: [], destroyed: false,
    destroy() { this.destroyed = true; },
  };
  const controller = createObjectCapture({
    detector, getSourceId: () => sourceId, getBlockReason: () => blocked,
    captureFrame() { shotCount++; const frame = {width: 1000, height: 600, identity: `frozen-${shotCount}`}; frames.push(frame); return frame; },
    cropFrame(frame, region) { const canvas = {width: 200, height: 150, identity: `crop-${crops.length}`}; crops.push({frame, region, canvas}); return {canvas, region}; },
    addSnapshot(canvas, metadata) { saved.push({canvas, metadata}); return {index: 4}; },
    onState: state => states.push(state), releaseFrame: frame => { if (frame) released.push(frame); },
    searchRegion: () => ({status: 'ready', roi: {x: .1, y: .2, width: .4, height: .5}}),
    selectObject: () => selected,
    ...options,
  });
  const capture = () => controller.capture({sourceId, sourceLabel: 'Test camera'});
  return {controller, detector, capture, frames, calls, saved, states, released, crops,
    setSource: value => { sourceId = value; }, block: value => { blocked = value; }};
}

test('freezes once before loading/inference, then saves only the selected object from that same frame', async () => {
  const h = harness(), pending = h.capture();
  assert.equal(h.frames.length, 1);
  assert.equal(h.calls[0].canvas, h.frames[0]);
  assert.equal(h.calls[0].includeHands, true, 'fresh hands must be inferred on the same frozen image');
  assert.equal(h.states.at(-1).actionState, 'detecting');
  assert.equal(h.saved.length, 0);
  h.calls[0].resolve({handFrame, detections: [detection]});
  assert.deepEqual(await pending, {status: 'saved', label: 'cup', crop: selected.crop, key: 4, method: 'left-hand'});
  assert.equal(h.frames.length, 1, 'never recapture a later camera moment');
  assert.equal(h.crops[0].frame, h.frames[0]);
  assert.deepEqual(h.crops[0].region, selected.crop);
  assert.equal(h.saved[0].canvas, h.crops[0].canvas);
  assert.deepEqual(h.saved[0].metadata, {title: 'Snapshot · cup', sourceLabel: 'Test camera', present: false, quiet: true});
  assert.deepEqual(h.released, [h.crops[0].canvas, h.frames[0]]);
  assert.equal(h.controller.isBusy(), false);
});

test('a focused second pass maps detections back and still crops the original frozen image', async () => {
  const observations = [];
  const h = harness({selectObject: (_frame, detections) => { observations.push(detections); return observations.length === 1 ? {status: 'no-object'} : selected; }});
  const pending = h.capture();
  h.calls[0].resolve({handFrame, detections: []}); await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].canvas, h.crops[0].canvas);
  assert.equal(h.calls[1].includeHands, false, 'the ROI pass reuses full-image hands, without changing their coordinate system');
  assert.equal(h.crops[0].frame, h.frames[0]);
  h.calls[1].resolve({handFrame, detections: [detection]});
  assert.equal((await pending).status, 'saved');
  assert.deepEqual(observations[1], mapDetectionsFromRegion([detection], h.crops[0].region));
  assert.equal(h.crops[1].frame, h.frames[0], 'the final crop must not crop the already cropped detector input');
  assert.equal(h.saved.length, 1);
  assert.equal(h.released.length, 3);
});

test('no detections or actual Left-hand landmarks reports failure without saving an injected search region', async () => {
  const h = harness({selectObject: () => ({status: 'no-object'})}), pending = h.capture();
  h.calls[0].resolve({handFrame, detections: []}); await settle();
  h.calls[1].resolve({handFrame, detections: []});
  assert.equal((await pending).status, 'not-found');
  assert.equal(h.saved.length, 0);
  assert.equal(h.crops.length, 1, 'only a temporary detector input was cropped');
  assert.equal(h.states.at(-1).message, 'Couldn’t see your left hand or one clear prominent object.');
  assert.equal(h.released.length, 2);
});

test('ambiguous objects do not trigger a speculative retry or a saved crop', async () => {
  const h = harness({selectObject: () => ({status: 'ambiguous-object'})}), pending = h.capture();
  h.calls[0].resolve({handFrame, detections: [detection, detection]});
  assert.equal((await pending).status, 'not-found');
  assert.match(h.states.at(-1).message, /one object/);
  assert.equal(h.calls.length, 1); assert.equal(h.crops.length, 0); assert.equal(h.saved.length, 0);
});

test('a missing left hand in the frozen image never saves an arbitrary scene or runs an ROI retry', async () => {
  const h = harness({searchRegion: () => ({status: 'left-hand-missing'})});
  const pending = h.capture(); h.calls[0].resolve({handFrame, detections: []});
  assert.equal((await pending).status, 'not-found');
  assert.equal(h.calls.length, 1); assert.equal(h.saved.length, 0);
  assert.match(h.states.at(-1).message, /left hand/);
  assert.equal(h.released.length, 1);
});

test('repeated triggers cannot create a queue or duplicate snapshot while detection is pending', async () => {
  const h = harness(), first = h.capture();
  assert.deepEqual(await h.capture(), {status: 'busy'});
  assert.equal(h.frames.length, 1); assert.equal(h.calls.length, 1);
  h.calls[0].resolve({handFrame, detections: [detection]}); await first;
  assert.equal(h.saved.length, 1);
});

test('camera source replacement discards the old detector result', async () => {
  const h = harness(), pending = h.capture();
  h.setSource('camera-2'); h.calls[0].resolve({handFrame, detections: [detection]});
  assert.equal((await pending).status, 'cancelled');
  assert.equal(h.saved.length, 0); assert.equal(h.released.length, 1);
});

test('cancellation aborts the detector and a late old job cannot clear or overwrite a newer job', async () => {
  const h = harness(), first = h.capture();
  h.controller.cancel('Camera changed');
  assert.equal(h.calls[0].signal.aborted, true);
  assert.deepEqual(h.detector.cancellations, ['Camera changed']);
  const next = h.capture();
  h.calls[0].resolve({handFrame, detections: [detection]});
  assert.equal((await first).status, 'cancelled');
  assert.equal(h.controller.isBusy(), true);
  assert.equal(h.states.at(-1).actionState, 'detecting');
  h.calls[1].resolve({handFrame, detections: [detection]});
  assert.equal((await next).status, 'saved'); assert.equal(h.saved.length, 1);
});

test('busy or full board is checked before frame capture and again immediately before saving', async () => {
  const h = harness(); h.block('All nine keys are full.');
  assert.equal((await h.capture()).status, 'error'); assert.equal(h.frames.length, 0);
  h.block(null); const pending = h.capture();
  h.block('Finish the current capture.'); h.calls[0].resolve({handFrame, detections: [detection]});
  assert.equal((await pending).status, 'error');
  assert.equal(h.saved.length, 0); assert.equal(h.crops.length, 0);
  assert.equal(h.states.at(-1).message, 'Finish the current capture.');
});

test('detector failure releases the image and permits a later retry', async () => {
  const h = harness(), failed = h.capture();
  h.calls[0].reject(new Error('Object detection timed out.'));
  assert.equal((await failed).status, 'error'); assert.equal(h.released.length, 1);
  const retry = h.capture(); h.calls[1].resolve({handFrame, detections: [detection]});
  assert.equal((await retry).status, 'saved');
});

test('a refused snapshot is not reported as saved', async () => {
  const h = harness({addSnapshot: () => null}), pending = h.capture();
  h.calls[0].resolve({handFrame, detections: [detection]});
  assert.equal((await pending).status, 'error');
  assert.equal(h.states.at(-1).actionState, 'error'); assert.equal(h.released.length, 2);
});

test('missing same-image hand results fail instead of borrowing live landmarks from an older camera frame', async () => {
  const h = harness(), pending = h.capture();
  h.calls[0].resolve({detections: [detection]});
  assert.equal((await pending).status, 'error');
  assert.equal(h.saved.length, 0); assert.equal(h.crops.length, 0);
  assert.match(h.states.at(-1).message, /captured image/);
});

test('destroy is final and cannot publish late results or start another capture', async () => {
  const h = harness(), pending = h.capture(); h.controller.destroy();
  assert.equal(h.detector.destroyed, true);
  const stateCount = h.states.length;
  h.calls[0].resolve({handFrame, detections: [detection]});
  assert.equal((await pending).status, 'cancelled');
  assert.deepEqual(await h.capture(), {status: 'cancelled'});
  assert.equal(h.states.length, stateCount); assert.equal(h.saved.length, 0);
});

test('pixel-aligned crops preserve actual source coordinates without mirroring or overlays', () => {
  const calls = [], canvas = {getContext: () => ({drawImage: (...args) => calls.push(args)})};
  const frame = {width: 640, height: 480};
  const result = cropFrozenFrame(frame, {x: .101, y: .203, width: .3, height: .4}, {createCanvas: () => canvas});
  assert.deepEqual(calls[0], [frame, 64, 97, 193, 193, 0, 0, 193, 193]);
  assert.deepEqual(result.region, {x: 64 / 640, y: 97 / 480, width: 193 / 640, height: 193 / 480});
  assert.equal(result.canvas, canvas);
});

test('ROI detection mapping clips SDK edge boxes and removes their obsolete pixel coordinates', () => {
  const region = {x: .2, y: .3, width: .5, height: .4};
  const actual = mapDetectionsFromRegion([
    {...detection, bbox: {x: -.1, y: .5, width: .5, height: .8}, pixelBox: {originX: -10}},
    {...detection, bbox: {x: 2, y: 0, width: .1, height: .1}},
    {...detection, bbox: {x: NaN, y: 0, width: .1, height: .1}},
  ], region);
  assert.equal(actual.length, 1); assert.equal(actual[0].pixelBox, undefined);
  assert.deepEqual(actual[0].bbox, {x: .2, y: .5, width: .2, height: .2});
});

test('an object truncated by an artificial search-region edge is not treated as a complete object crop', () => {
  const edge = {...detection, bbox: {x: 0, y: .2, width: .3, height: .4}};
  assert.deepEqual(mapDetectionsFromRegion([edge], {x: .2, y: .3, width: .4, height: .5}, {rejectTruncated: true}), []);
  assert.equal(mapDetectionsFromRegion([edge], {x: 0, y: .3, width: .4, height: .5}, {rejectTruncated: true}).length, 1, 'the actual camera-image edge can be clamped');
});

const prominentBook={label:'book',score:.9,bbox:{x:.2,y:.2,width:.6,height:.6}};
const productionSelectors={searchRegion:leftHandSearchRegion,selectObject:selectHeldObject};
function frozenLeftHand(centerX=250,centerY=330){
  const points=[[0,80],[-28,40],[-50,10],[-60,-30],[-50,-60],[-20,0],[-20,-50],[-22,-80],[-20,-100],
    [0,-10],[10,-60],[15,-90],[12,-110],[20,0],[35,-40],[40,-70],[37,-90],[40,10],[50,-20],[55,-40],[52,-55]];
  return {...handFrame,handLandmarks:[points.map(([x,y])=>({x:(centerX+x*.75)/1000,y:(centerY+y*.75)/600,z:0}))],
    handedness:[[{categoryName:'Left',score:.95}]]};
}

test('a real Left hand produces a focused snapshot above its index base when both object passes find nothing',async()=>{
  const h=harness(productionSelectors),pending=h.capture(),hands=frozenLeftHand(750);
  h.calls[0].resolve({handFrame:hands,detections:[]});await settle();
  h.calls[1].resolve({handFrame:null,detections:[]});const result=await pending;
  assert.equal(result.status,'saved');assert.equal(result.method,'left-hand-region');assert.equal(result.label,'Left hand region');
  assert.equal(result.score,null);assert.equal(result.confidence,null);assert.ok(result.crop.x>.5);
  const points=hands.handLandmarks[0],base=points[5],bottom=result.crop.y+result.crop.height;
  assert.ok(Math.abs(bottom-base.y)<1e-12);
  assert.ok(result.crop.y<Math.min(...points.map(point=>point.y)),'the snapshot includes the area above the fingers');
  for(const point of points){
    assert.ok(point.x>=result.crop.x&&point.x<=result.crop.x+result.crop.width);
    if(point.y<=base.y)assert.ok(point.y>=result.crop.y&&point.y<=bottom+1e-12);
    else assert.ok(point.y>bottom,'lower palm and wrist are excluded');
  }
  assert.equal(h.frames.length,1);assert.equal(h.calls.length,2);assert.equal(h.saved.length,1);
  assert.equal(h.crops.at(-1).frame,h.frames[0]);assert.equal(h.released.length,3);
  assert.equal(h.saved[0].metadata.title,'Snapshot · Left hand region');
  assert.match(h.states.at(-1).message,/above your left hand/);
});

test('the production rasterizer saves no pixels below a fractional index base, including when the top is clipped',async()=>{
  for(const centerY of [330.45,100.25]){
    const draws=[],hands=frozenLeftHand(750,centerY),base=hands.handLandmarks[0][5];
    const h=harness({...productionSelectors,cropFrame:(frame,region)=>cropFrozenFrame(frame,region,{
      createCanvas:()=>({getContext:()=>({drawImage:(...args)=>draws.push(args)})}),
    })});
    const pending=h.capture();h.calls[0].resolve({handFrame:hands,detections:[]});await settle();
    h.calls[1].resolve({handFrame:null,detections:[]});const result=await pending;
    assert.equal(result.status,'saved');assert.equal(result.method,'left-hand-region');
    assert.equal(draws.length,2,'one broad detector crop and one final snapshot');
    const [source,sx,sy,sw,sh]=draws[1];
    assert.equal(source,h.frames[0]);assert.ok(sx>500,'anatomical Left remains on the original source side');
    assert.equal(sy+sh,Math.floor(base.y*source.height));
    assert.ok(sy+sh<=base.y*source.height,'the saved source rectangle ends above MCP5');
    assert.ok(sy<Math.min(...hands.handLandmarks[0].map(point=>point.y))*source.height);
    if(centerY===100.25)assert.equal(sy,0,'clipping the top must not push the bottom below the hand');
    assert.equal(h.saved.length,1);assert.equal(h.saved[0].canvas.width,sw);assert.equal(h.saved[0].canvas.height,sh);
    assert.equal(h.frames.length,1);assert.equal(h.released.length,3);
  }
});

test('a missing Left index base reports a usable failure instead of saving an arbitrary lower-hand fallback',async()=>{
  const hands=frozenLeftHand();hands.handLandmarks[0][5]={x:NaN,y:NaN,z:0};
  const h=harness(productionSelectors),pending=h.capture();
  h.calls[0].resolve({handFrame:hands,detections:[]});await settle();
  h.calls[1].resolve({handFrame:null,detections:[]});const result=await pending;
  assert.equal(result.status,'not-found');assert.equal(h.saved.length,0);
  assert.equal(h.crops.length,1,'only the broad detector input is cropped');
  assert.equal(h.released.length,2);assert.match(h.states.at(-1).message,/base of your left index finger/i);
  assert.match(result.reason,/base of your left index finger/i);assert.equal(result.message,h.states.at(-1).message);
});

test('ambiguous held objects choose the real Left-hand region before an unrelated prominent object',async()=>{
  const h=harness({...productionSelectors,selectObject:()=>({status:'ambiguous-object'}),
    selectProminent:()=>assert.fail('a visible Left hand has priority over unrelated scene objects')});
  const pending=h.capture();h.calls[0].resolve({handFrame:frozenLeftHand(),detections:[prominentBook]});
  const result=await pending;assert.equal(result.status,'saved');assert.equal(result.method,'left-hand-region');
  assert.equal(h.calls.length,1,'ambiguous object boxes do not trigger a speculative ROI retry');
  assert.equal(h.crops[0].frame,h.frames[0]);assert.equal(h.saved.length,1);
});

test('an ROI model failure still allows the exact-frame Left-hand snapshot',async()=>{
  const h=harness(productionSelectors),pending=h.capture();
  h.calls[0].resolve({handFrame:frozenLeftHand(),detections:[]});await settle();
  h.calls[1].reject(new Error('Object model failed on the cropped image.'));
  const result=await pending;assert.equal(result.status,'saved');assert.equal(result.method,'left-hand-region');
  assert.equal(h.crops.at(-1).frame,h.frames[0]);assert.equal(h.saved.length,1);assert.equal(h.released.length,3);
});

test('partial object failures use fresh frozen-image hands, skip ROI retry and retain no fabricated object score',async()=>{
  const h=harness(productionSelectors),pending=h.capture();
  h.calls[0].resolve({handFrame:frozenLeftHand(),detections:[],objectError:{code:'OBJECT_MODEL_RUN',message:'Object model unavailable.'}});
  const result=await pending;assert.equal(result.status,'saved');assert.equal(result.method,'left-hand-region');
  assert.equal(result.score,null);assert.equal(h.calls.length,1);assert.equal(h.saved.length,1);
  assert.equal(h.crops[0].frame,h.frames[0]);
  const absent=harness(productionSelectors),missing=absent.capture();
  absent.calls[0].resolve({handFrame,detections:[],objectError:{message:'Object model unavailable.'}});
  assert.equal((await missing).status,'error');assert.equal(absent.saved.length,0);
  assert.match(absent.states.at(-1).message,/Object model unavailable/);
});

test('cancelled or resized frozen images cannot save a late Left-hand fallback',async()=>{
  for(const change of ['cancel','resize']){
    const h=harness(productionSelectors),pending=h.capture();
    h.calls[0].resolve({handFrame:frozenLeftHand(),detections:[]});await settle();
    if(change==='cancel')h.controller.cancel('Camera changed');else h.frames[0].width=500;
    h.calls[1].resolve({handFrame:null,detections:[]});
    assert.equal((await pending).status,'cancelled');assert.equal(h.saved.length,0);assert.equal(h.released.length,2);
  }
});

test('same-image Left-hand association keeps priority over a larger prominent book',async()=>{
  const points=[[0,80],[-28,40],[-50,10],[-60,-30],[-50,-60],[-20,0],[-20,-50],[-22,-80],[-20,-100],
    [0,-10],[10,-60],[15,-90],[12,-110],[20,0],[35,-40],[40,-70],[37,-90],[40,10],[50,-20],[55,-40],[52,-55]];
  const frozenHands={...handFrame,handLandmarks:[points.map(([x,y])=>({x:(250+x*.75)/1000,y:(330+y*.75)/600,z:0}))],
    handedness:[[{categoryName:'Left',score:.95}]]};
  const phone={label:'cell phone',score:.86,bbox:{x:.20125,y:.375,width:.09,height:.25}};
  const h=harness({...productionSelectors,selectProminent:()=>assert.fail('a selected held object must win without invoking fallback')});
  const pending=h.capture();h.calls[0].resolve({handFrame:frozenHands,detections:[prominentBook,phone]});
  const result=await pending;
  assert.equal(result.status,'saved');assert.equal(result.label,'cell phone');assert.equal(result.method,'left-hand');
  assert.ok(result.crop.y+result.crop.height>frozenHands.handLandmarks[0][5].y,
    'a recognized object retains its complete detected bounds, including below the index base');
  assert.equal(h.calls.length,1);assert.equal(h.crops[0].frame,h.frames[0]);
  assert.match(h.states.at(-1).message,/from your left hand/);
});

test('a dominant book with no visible Left hand saves from the original full frame without extra inference',async()=>{
  const h=harness(productionSelectors),pending=h.capture();
  h.calls[0].resolve({handFrame,detections:[prominentBook]});
  const result=await pending;
  assert.equal(result.status,'saved');assert.equal(result.label,'book');assert.equal(result.method,'prominent-object');
  assert.equal(h.calls.length,1);assert.equal(h.frames.length,1);assert.equal(h.crops.length,1);
  assert.equal(h.crops[0].frame,h.frames[0]);assert.equal(h.saved.length,1);
  assert.equal(h.states.at(-1).message,'Saved prominent book.');
  assert.deepEqual(h.saved[0].metadata,{title:'Snapshot · book',sourceLabel:'Test camera',present:false,quiet:true});
});

test('small incidental detections, rival large objects and people remain not-found for gaze fallback',async()=>{
  for(const detections of [
    [{label:'book',score:.99,bbox:{x:.45,y:.45,width:.1,height:.1}}],
    [prominentBook,{label:'cup',score:.99,bbox:{x:.01,y:.01,width:.45,height:.45}}],
    [{...prominentBook,label:'person'}],
  ]){
    const h=harness(productionSelectors),pending=h.capture();h.calls[0].resolve({handFrame,detections});
    assert.equal((await pending).status,'not-found');assert.equal(h.saved.length,0);assert.equal(h.crops.length,0);
    assert.equal(h.calls.length,1);assert.equal(h.released.length,1);
    assert.equal(h.states.at(-1).actionState,'not-found');
  }
});

test('prominence uses original full-frame boxes after a failed hand ROI, never the magnified ROI alone',async()=>{
  const first=harness({selectObject:()=>({status:'no-object'})}),pending=first.capture();
  first.calls[0].resolve({handFrame,detections:[prominentBook]});await settle();
  first.calls[1].resolve({handFrame:null,detections:[]});
  assert.equal((await pending).method,'prominent-object');assert.equal(first.calls.length,2);
  assert.equal(first.crops.at(-1).frame,first.frames[0]);
  const small=harness({selectObject:()=>({status:'no-object'})}),missed=small.capture();
  small.calls[0].resolve({handFrame,detections:[]});await settle();
  small.calls[1].resolve({handFrame:null,detections:[prominentBook]});
  assert.equal((await missed).status,'not-found');assert.equal(small.saved.length,0);
});

test('cancellation or source replacement still discards a late dominant-object result',async()=>{
  for(const action of ['cancel','switch']){
    const h=harness(productionSelectors),pending=h.capture();
    if(action==='cancel')h.controller.cancel('Cancelled before object selection');else h.setSource('replacement-camera');
    h.calls[0].resolve({handFrame,detections:[prominentBook]});
    assert.equal((await pending).status,'cancelled');assert.equal(h.saved.length,0);assert.equal(h.crops.length,0);
    assert.equal(h.released.length,1);assert.equal(h.states.some(state=>state.actionState==='saved'),false);
  }
});
