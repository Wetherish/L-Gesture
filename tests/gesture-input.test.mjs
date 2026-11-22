import test from 'node:test';
import assert from 'node:assert/strict';
import {selectGestureInput} from '../dist/gesture-input.js';
import {createDoublePinchDetector} from '../dist/pinch-gesture.js';
import {normalizeFrame} from '../dist/landmarks.js';

function fixture() {
  const frame={source:'Browser inference',hands:[],raw:{inference:{sourceId:'camera:1',generation:2}}};
  const entry={frame,live:true,changedAt:950,receivedAt:950};
  return {source:{type:'camera'},sourceId:'camera:1',entries:new Map([['browser',entry]]),now:1000,trackingStatus:'running',frame,entry};
}
test('current live browser hands work without a developer-mode dependency',()=>{
  const h=fixture(), result=selectGestureInput(h);
  assert.equal(result.frame,h.frame);assert.equal(result.sourceId,'camera:1');
});
test('stale, paused, future, synthetic, imported and previous-camera data cannot trigger actions',()=>{
  for (const change of [h=>h.now=1600,h=>h.trackingStatus='paused',h=>h.entry.changedAt=1100,h=>h.frame.synthetic=true,h=>h.entry.live=false,h=>h.sourceId='camera:2']) {
    const h=fixture();change(h);assert.equal(selectGestureInput(h),null);
  }
  for (const source of [{type:'file'},{type:'sample'},{type:'landmarks'},{type:'image',streaming:false},{type:'camera',synthetic:true}]) {
    assert.equal(selectGestureInput({...fixture(),source}),null);
  }
});
test('live native streams are eligible but imported frames are not a fallback',()=>{
  const h=fixture(),native={source:'Logitech LogiInsight',hands:[],raw:{sourceId:'camera:1'}};
  h.entries.set('native',{frame:native,live:true,changedAt:980,receivedAt:980});
  h.allowedNativeFrames=[native];
  assert.equal(selectGestureInput(h).frame,h.frame,'empty browser result clears the gesture');
  h.trackingStatus='error';assert.equal(selectGestureInput(h).frame,native);
  h.allowedNativeFrames=[];assert.equal(selectGestureInput(h),null);
  h.allowedNativeFrames=[native];h.entries.get('native').live=false;assert.equal(selectGestureInput(h),null);
});
test('an unrelated or unbound socket cannot issue gestures after a camera switch',()=>{
  const h=fixture(),frame={source:'Custom live landmarks',hands:[]};
  h.entries.delete('browser');h.entries.set('socket',{frame,live:true,receivedAt:990,changedAt:990});h.allowedNativeFrames=[frame];
  assert.equal(selectGestureInput(h),null);
  frame.raw={sourceId:'camera:1'};assert.equal(selectGestureInput(h).frame,frame);
  h.sourceId='camera:2';assert.equal(selectGestureInput(h),null);
});
test('source selection preserves the original frame generation for the detector',()=>{
  const h=fixture();
  h.frame.raw.inference.generation=3;assert.equal(selectGestureInput(h).frame.raw.inference.generation,3);
  h.source={type:'image',streaming:true};assert.ok(selectGestureInput(h));
});

test('the real frame selector and detector recognize double pinch together',()=>{
  const detector=createDoublePinchDetector(),h=fixture();
  let now=0,recognized=0;
  for(const ratio of [0.8,0.8,0.15,0.15,0.8,0.8,0.15,0.15,0.8,0.8]){
    now+=80;
    const points=Array.from({length:21},()=>({x:0.5,y:0.5,z:0}));
    points[0]={x:0.5,y:0.7};points[9]={x:0.5,y:0.5};
    points[5]={x:0.42,y:0.55};points[17]={x:0.58,y:0.55};
    points[4]={x:0.5-ratio*0.1,y:0.38};points[8]={x:0.5+ratio*0.1,y:0.38};
    const frame=normalizeFrame({type:'browser_inference',provenance:'Browser inference',coordinate_space:'normalized',timestamp_ms:now,
      image_resolution:{width:1000,height:1000},inference:{sourceId:'camera:1',generation:2,engine:'MediaPipe',location:'browser'},
      handLandmarks:[points],handedness:[[{categoryName:'Right',score:0.96}]]});
    h.entries.set('browser',{frame,live:true,changedAt:now,receivedAt:now});h.now=now;
    const input=selectGestureInput(h),result=detector.update(input.frame,{sourceId:input.sourceId,now});
    assert.notEqual(result.reason,'source-mismatch');recognized+=Number(result.triggered);
  }
  assert.equal(recognized,1);assert.equal(detector.getState().completed,2);
});
