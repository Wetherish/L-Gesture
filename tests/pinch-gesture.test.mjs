import test from 'node:test';
import assert from 'node:assert/strict';
import {createDoublePinchDetector} from '../dist/pinch-gesture.js';
import {normalizeFrame} from '../dist/landmarks.js';

function handFrame(ratio,timestamp,{width=1000,height=1000,scale=1,offset=0,labels=['Right'],confidence=0.96,
  sourceId='camera-a',generation=1,handId,placeholder=false,rawExtra={},sparse=false}={}){
  const unit=Math.min(width,height)*0.2*scale;
  const hands=labels.map((handedness,side)=>{
    const x=width*(0.5+offset+(handedness==='Left'?-0.2:0)),y=height*0.5;
    const p=(dx,dy)=>({x:(x+dx*unit)/width,y:(y+dy*unit)/height,z:0,...(placeholder?{visibility:0}:{})});
    const points=Array.from({length:21},()=>p(0,0));
    points[0]=p(0,1);points[9]=p(0,0);points[5]=p(-0.4,0.25);points[17]=p(0.4,0.25);
    points[4]=p(-ratio/2,-0.6);points[8]=p(ratio/2,-0.6);
    return {handedness,confidence,landmarks:points,...(handId!==undefined?{trackingId:handId}:{})};
  });
  const landmarks=hands.map(hand=>hand.landmarks),handedness=hands.map(hand=>[{categoryName:hand.handedness,score:confidence}]);
  const raw={type:'browser_inference',provenance:'Browser inference',coordinate_space:'normalized',timestamp_ms:timestamp,
    image_resolution:{width,height},inference:{engine:'MediaPipe',location:'browser',sourceId,generation},
    hands,handLandmarks:landmarks,handedness,rawResults:{hands:{landmarks,handedness}},...rawExtra};
  const frame=normalizeFrame(raw);
  if(sparse){frame.hands.forEach(hand=>{hand.points=hand.points.filter(p=>[4,8].includes(p.index)).map(p=>({...p,landmarkIndex:p.index}));hand.sparse=true;});}
  return frame;
}
function harness(config={}){
  const events=[],detector=createDoublePinchDetector({...config,onTrigger:event=>{events.push(event);config.onTrigger?.(event);}});
  let now=0,timestamp=0,lastFrame=null;
  function fresh(ratio,options={}){
    const {delta=80,context={},...frameOptions}=options;now+=delta;timestamp+=delta;
    // These baseline cases exercise the ordinary multi-frame path. Fast-edge
    // regressions below explicitly supply a high-confidence observation.
    lastFrame=handFrame(ratio,timestamp,{confidence:0.85,...frameOptions});
    return detector.update(lastFrame,{now,sourceId:'camera-a',...context});
  }
  function hold(ratio,options={},count=2){let result;for(let i=0;i<count;i++)result=fresh(ratio,options);return result;}
  function repeat(delta=16,context={}){now+=delta;return detector.update(lastFrame,{now,sourceId:'camera-a',...context});}
  function missing(delta=80){now+=delta;return detector.update(null,{now,sourceId:'camera-a'});}
  function double(options={}){hold(0.8,options);hold(0.15,options);hold(0.8,options);hold(0.15,options);return hold(0.8,options);}
  return {detector,events,fresh,hold,repeat,missing,double,getNow:()=>now,getTimestamp:()=>timestamp,getFrame:()=>lastFrame};
}

test('triggers exactly once after close-open-close-open, with two-step feedback',()=>{
  const h=harness();assert.equal(h.hold(0.8).phase,'ready');
  let result=h.hold(0.15);assert.equal(result.phase,'first-closed');assert.equal(result.completed,0);assert.equal(result.progress,0.25);
  result=h.hold(0.8);assert.equal(result.phase,'second-ready');assert.equal(result.completed,1);assert.equal(result.progress,0.5);
  result=h.hold(0.15);assert.equal(result.phase,'second-closed');assert.equal(result.progress,0.75);assert.equal(h.events.length,0);
  assert.equal(h.fresh(0.8).triggered,false);
  result=h.fresh(0.8);assert.equal(result.triggered,true);assert.equal(result.phase,'cooldown');assert.equal(result.completed,2);assert.equal(result.progress,1);
  assert.equal(result.pinched,false);assert.equal(result.rightVisible,true);assert.equal(result.scaleBasis,'palm-span');
  assert.equal(h.events.length,1);assert.deepEqual(h.events[0],result);
  assert.equal(h.detector.getState().triggered,false);assert.equal(h.repeat().triggered,false);assert.equal(h.events.length,1);
});

test('a hand that starts closed must release and arm before any pinch is counted',()=>{
  const h=harness();let state=h.hold(0.1);assert.equal(state.phase,'waiting');assert.equal(state.completed,0);
  assert.equal(h.hold(0.8).phase,'ready');h.hold(0.1);
  state=h.hold(0.8);assert.equal(state.completed,1);assert.equal(h.events.length,0);
});

test('RAF repeats and timestamp-identical clones cannot confirm edges or keep a frozen frame fresh',()=>{
  const h=harness();h.fresh(0.8);
  for(let i=0;i<12;i++)assert.equal(h.repeat().phase,'waiting');
  const clone=structuredClone(h.getFrame());
  assert.equal(h.detector.update(clone,{now:h.getNow()+20,sourceId:'camera-a'}).phase,'waiting');
  const stale=h.repeat(800);assert.equal(stale.reason,'stale');assert.equal(stale.completed,0);assert.equal(stale.rightVisible,false);
  assert.equal(h.events.length,0);
});

test('both stable duration and a minimum number of unique observations are required',()=>{
  const h=harness({stableFrames:3});
  assert.equal(h.hold(0.8).phase,'waiting');assert.equal(h.repeat(100).phase,'waiting');assert.equal(h.fresh(0.8).phase,'ready');
  const fast=harness();for(let i=0;i<12;i++)assert.equal(fast.fresh(0.8,{delta:1}).phase,'waiting');
  assert.equal(fast.repeat(60).phase,'waiting');assert.equal(fast.fresh(0.8,{delta:1}).phase,'ready');
});

test('hysteresis and consecutive observations reject jitter and one-frame releases',()=>{
  const h=harness();h.hold(0.8);
  for(const ratio of [0.15,0.4,0.15,0.8,0.4,0.15,0.4])assert.equal(h.fresh(ratio).phase,'ready');
  h.hold(0.15);
  for(const ratio of [0.3,0.45,0.5,0.8,0.4]){
    const state=h.fresh(ratio);assert.equal(state.phase,'first-closed');assert.equal(state.pinched,true);assert.equal(state.completed,0);
  }
  assert.equal(h.hold(0.8).completed,1);assert.equal(h.events.length,0);
});

test('palm normalization works across camera resolution, aspect ratio and hand scale',()=>{
  for(const options of [{width:1920,height:1080,scale:0.5},{width:640,height:480,scale:1.5},{width:720,height:1280,scale:0.8}]){
    const h=harness(),open=h.hold(0.8,options);assert.ok(Math.abs(open.ratio-0.8)<1e-10);
    h.hold(0.15,options);h.hold(0.8,options);h.hold(0.15,options);
    assert.equal(h.hold(0.8,options).triggered,true);assert.equal(h.events.length,1);
  }
});

test('only the unique Right hand participates; Left, missing, ambiguous and low confidence reset progress',()=>{
  for(const options of [{labels:['Left']},{labels:['Unknown']},{labels:[]},{labels:['Right','Right']},{confidence:0.2}]){
    const h=harness();h.hold(0.8);h.hold(0.15);assert.equal(h.hold(0.8).completed,1);
    const invalid=h.fresh(0.15,options);assert.equal(invalid.completed,0);assert.equal(invalid.rightVisible,false);
    h.hold(0.8);h.hold(0.15);assert.equal(h.hold(0.8).completed,1);assert.equal(h.events.length,0);
  }
});

test('left/right array reordering does not disrupt the same Right hand',()=>{
  const h=harness();h.hold(0.8,{labels:['Left','Right']});h.hold(0.15,{labels:['Right','Left']});
  h.hold(0.8,{labels:['Left','Right']});h.hold(0.15,{labels:['Right','Left']});
  assert.equal(h.hold(0.8,{labels:['Left','Right']}).triggered,true);
});

test('explicit tracking identity or abrupt spatial replacement cannot combine two Right hands',()=>{
  for(const changed of [{handId:'b'},{offset:0.4},{scale:0.3}]){
    const initial=changed.handId?{handId:'a'}:{};
    const h=harness();h.hold(0.8,initial);h.hold(0.15,initial);h.hold(0.8,initial);
    const state=h.fresh(0.15,changed);assert.equal(state.reason,'hand-changed');assert.equal(state.completed,0);
    h.hold(0.8,changed);h.hold(0.15,changed);assert.equal(h.hold(0.8,changed).completed,1);assert.equal(h.events.length,0);
  }
});

test('source changes, inference generations and mismatched source metadata cannot share a gesture',()=>{
  for(const change of [{sourceId:'camera-b',context:{sourceId:'camera-b'}},{generation:2}]){
    const h=harness();h.hold(0.8);h.hold(0.15);h.hold(0.8);
    assert.equal(h.fresh(0.15,change).completed,0);
    h.hold(0.8,change);h.hold(0.15,change);assert.equal(h.hold(0.8,change).completed,1);assert.equal(h.events.length,0);
  }
  const h=harness();h.hold(0.8);h.hold(0.15);
  assert.equal(h.fresh(0.8,{context:{sourceId:'different-camera'}}).reason,'source-mismatch');assert.equal(h.detector.getState().completed,0);
});

test('lost hands, slow sampling gaps and sequence timeouts require a fresh open re-arm',()=>{
  const h=harness();h.hold(0.8);h.hold(0.15);h.hold(0.8);assert.equal(h.missing().completed,0);
  h.hold(0.15);assert.equal(h.hold(0.8).phase,'ready');assert.equal(h.events.length,0);
  h.hold(0.15);h.hold(0.8);assert.equal(h.fresh(0.15,{delta:800}).completed,0);
  const timed=harness({sequenceTimeoutMs:600});timed.hold(0.8);timed.hold(0.15);timed.hold(0.8);
  for(let i=0;i<7;i++)timed.fresh(0.8);
  assert.equal(timed.detector.getState().completed,0);timed.hold(0.15);assert.equal(timed.hold(0.8).completed,1);assert.equal(timed.events.length,0);
});

test('cooldown survives hand loss and demands fresh open observations before another complete gesture',()=>{
  const h=harness();assert.equal(h.double().triggered,true);h.missing();
  assert.equal(h.hold(0.15).phase,'cooldown');h.hold(0.8);assert.equal(h.events.length,1);
  h.hold(0.15,{delta:400}); // Cooldown expires while the hand is closed; this is not a first pinch.
  assert.equal(h.hold(0.8).phase,'ready');assert.equal(h.events.length,1);
  h.hold(0.15);h.hold(0.8);h.hold(0.15);assert.equal(h.hold(0.8).triggered,true);assert.equal(h.events.length,2);
});

test('inactive updates reset progress and can resume; static frames never make a sequence',()=>{
  const h=harness();h.hold(0.8);h.hold(0.15);
  assert.equal(h.repeat(10,{active:false}).phase,'inactive');
  assert.equal(h.hold(0.8).phase,'ready');assert.equal(h.detector.getState().completed,0);
  for(let i=0;i<30;i++)h.fresh(0.8);assert.equal(h.events.length,0);
  const closed=harness();for(let i=0;i<30;i++)closed.fresh(0.1);assert.equal(closed.events.length,0);assert.equal(closed.detector.getState().completed,0);
});

test('marked synthetic/replay/stale frames and untimestamped input cannot advance',()=>{
  for(const rawExtra of [{synthetic:true},{replay:true},{isReplay:true},{stale:true}]){
    const h=harness();h.hold(0.8);h.hold(0.15);const state=h.fresh(0.8,{rawExtra});assert.equal(state.completed,0);assert.equal(state.rightVisible,false);
  }
  const detector=createDoublePinchDetector(),frame=handFrame(0.8,1);frame.timelineMs=0;
  assert.equal(detector.update(frame,{now:1}).reason,'replay');
  delete frame.timelineMs;frame.timestampMs=null;delete frame.raw.timestamp_ms;
  assert.equal(detector.update(frame,{now:2}).reason,'timestamp-unavailable');
});

test('backwards source timestamps and host clocks reset instead of completing an old gesture',()=>{
  const h=harness();h.hold(0.8);h.hold(0.15);h.hold(0.8);
  const reset=handFrame(0.15,10);assert.equal(h.detector.update(reset,{now:h.getNow()+10,sourceId:'camera-a'}).reason,'timestamp-reset');
  assert.equal(h.detector.getState().completed,0);
  assert.equal(h.detector.update(handFrame(0.8,20),{now:1,sourceId:'camera-a'}).reason,'clock-reset');assert.equal(h.events.length,0);
});

test('unscaled sparse thumb/index is rejected rather than learning a fabricated palm from the moving tips',()=>{
  const h=harness();const state=h.hold(0.8,{sparse:true});
  assert.equal(state.reason,'palm-scale-unavailable');assert.equal(state.rightVisible,true);assert.equal(state.completed,0);
  h.double({sparse:true});assert.equal(h.events.length,0);
});

test('sparse fingertips with independently labeled palm anchors can be normalized safely',()=>{
  const detector=createDoublePinchDetector();let now=0,event;
  for(const ratio of [0.8,0.8,0.15,0.15,0.8,0.8,0.15,0.15,0.8,0.8]){
    now+=80;const frame=handFrame(ratio,now,{confidence:0.85}),hand=frame.hands[0];
    hand.points=hand.points.filter(p=>[0,4,8,9].includes(p.index)).map(p=>({...p,landmarkIndex:p.index}));hand.sparse=true;
    event=detector.update(frame,{now,sourceId:'camera-a'});
  }
  assert.equal(event.triggered,true);assert.equal(event.scaleBasis,'wrist-middle-mcp');
});

test('the known MediaPipe visibility placeholder is supported, while real low endpoint/palm scores are rejected',()=>{
  const h=harness();assert.equal(h.double({placeholder:true}).triggered,true);
  for(const id of [4,8,0,9,5,17]){
    const detector=createDoublePinchDetector(),frame=handFrame(0.8,1);
    frame.hands[0].points.find(p=>p.index===id).presence=0;
    if([0,9].includes(id))frame.hands[0].points.find(p=>p.index===5).presence=0;
    if([5,17].includes(id))frame.hands[0].points.find(p=>p.index===0).presence=0;
    const state=detector.update(frame,{now:1});assert.equal(state.completed,0);
    assert.equal(state.reason,[4,8].includes(id)?'low-confidence':'palm-scale-unavailable');
  }
});

test('off-frame endpoints and a degenerate/tiny palm do not generate commands',()=>{
  const h=harness();assert.equal(h.fresh(0.8,{offset:0.6}).reason,'off-frame');
  assert.equal(h.fresh(0.8,{scale:0.001}).reason,'palm-scale-unavailable');assert.equal(h.events.length,0);
});

test('reset is deterministic, snapshots are isolated, input is untouched, and unsafe options are rejected',()=>{
  const detector=createDoublePinchDetector(),frame=handFrame(0.8,1),before=structuredClone(frame);
  const state=detector.update(frame,{now:1});state.completed=2;assert.equal(detector.getState().completed,0);assert.deepEqual(frame,before);
  assert.equal(detector.reset('user-reset').reason,'user-reset');assert.equal(detector.getState().sourceId,null);
  assert.throws(()=>createDoublePinchDetector({stableFrames:1}),RangeError);
  assert.throws(()=>createDoublePinchDetector({closeRatio:0.6,openRatio:0.4}),RangeError);
  assert.throws(()=>detector.update(frame,{now:NaN}),TypeError);
});

test('clear confident double pinches finish on the second release at actual 15, 30 and 60 fps',()=>{
  for(const fps of [15,30,60]){
    const h=harness(),sample={confidence:0.96,delta:1000/fps};
    assert.equal(h.fresh(0.8,sample).phase,'waiting'); // Initial arming is never single-frame.
    assert.equal(h.fresh(0.8,sample).phase,'ready');
    assert.equal(h.fresh(0.12,sample).phase,'first-closed');
    assert.equal(h.fresh(0.8,sample).completed,1);
    assert.equal(h.fresh(0.12,sample).phase,'second-closed');assert.equal(h.events.length,0);
    const released=h.fresh(0.8,sample);
    assert.equal(released.triggered,true);assert.equal(released.completed,2);assert.equal(h.events.length,1);
    assert.equal(h.repeat(5).triggered,false);assert.equal(h.events.length,1);
  }
});

test('ordinary edges confirm in two real 30 or 60 fps observations without a third-sample delay',()=>{
  for(const fps of [30,60]){
    const h=harness(),sample={confidence:0.96,delta:1000/fps};h.hold(0.8,sample);
    assert.equal(h.fresh(0.24,sample).phase,'ready');assert.equal(h.fresh(0.24,sample).phase,'first-closed');
    assert.equal(h.fresh(0.6,sample).phase,'first-closed');assert.equal(h.fresh(0.6,sample).completed,1);
    assert.equal(h.fresh(0.24,sample).phase,'second-ready');assert.equal(h.fresh(0.24,sample).phase,'second-closed');
    assert.equal(h.fresh(0.6,sample).triggered,false);assert.equal(h.fresh(0.6,sample).triggered,true);
    assert.equal(h.events.length,1);
  }
});

test('brief confident close/release samples beyond the old fast thresholds still form two observed cycles',()=>{
  for(const fps of [30,60]){
    const h=harness(),sample={confidence:0.96,delta:1000/fps};h.hold(0.8,sample);
    const start=h.getNow();
    assert.equal(h.fresh(0.20,sample).phase,'first-closed');
    assert.equal(h.fresh(0.64,sample).completed,1);
    assert.equal(h.fresh(0.20,sample).phase,'second-closed');assert.equal(h.events.length,0);
    assert.equal(h.fresh(0.64,sample).triggered,true);assert.equal(h.events.length,1);
    assert.ok(Math.abs(h.getNow()-start-4000/fps)<1e-8);
    for(let i=0;i<8;i++)assert.equal(h.fresh(i%2?0.64:0.20,sample).triggered,false);
    assert.equal(h.events.length,1,'rapid continuing movement cannot bypass cooldown');
  }
});

test('rapid sampling cannot invent a closed state or a release that the camera never observed',()=>{
  for(const ratios of [[.29,.64,.29,.64],[.20,.5,.20,.64],[.20,.64,.29,.64]]){
    const h=harness(),sample={confidence:.96,delta:1000/60};h.hold(.8,sample);
    for(const ratio of ratios)assert.equal(h.fresh(ratio,sample).triggered,false);
    assert.equal(h.events.length,0);
  }
  for(const confidence of [.85,.89]){
    const h=harness(),sample={confidence,delta:1000/60};h.hold(.8,sample);
    for(const ratio of [.20,.64,.20,.64])assert.equal(h.fresh(ratio,sample).triggered,false);
    assert.equal(h.events.length,0,'brief low-confidence crossings still need consecutive confirmation');
  }
});

test('isolated borderline jitter and a lower-confidence extreme do not count a pinch',()=>{
  for(const fps of [30,60]){
    const h=harness(),sample={confidence:0.96,delta:1000/fps};h.hold(0.8,sample);
    for(const ratio of [0.24,0.8,0.27,0.4,0.8,0.22,0.5,0.8]){
      const state=h.fresh(ratio,sample);assert.equal(state.phase,'ready');assert.equal(state.completed,0);
    }
    assert.equal(h.fresh(0.1,{...sample,confidence:0.84}).phase,'ready');
    assert.equal(h.fresh(0.8,sample).phase,'ready');assert.equal(h.events.length,0);
    h.fresh(0.20,sample);
    for(const ratio of [0.60,0.20,0.61,0.20]){
      const state=h.fresh(ratio,sample);assert.equal(state.phase,'first-closed');assert.equal(state.completed,0);
    }
    assert.equal(h.events.length,0,'borderline single-frame releases retain their confirmation requirement');
  }
});

test('a single clear pinch/outlier and a held closure cannot become a double gesture',()=>{
  const h=harness(),sample={confidence:0.96,delta:1000/30};h.hold(0.8,sample);
  h.fresh(0.12,sample);assert.equal(h.fresh(0.8,sample).completed,1);assert.equal(h.events.length,0);
  for(let i=0;i<100;i++)h.fresh(0.8,sample);
  assert.equal(h.detector.getState().completed,0);assert.equal(h.events.length,0);
  h.fresh(0.12,sample);
  for(let i=0;i<30;i++){const state=h.fresh(0.12,sample);assert.equal(state.completed,0);assert.equal(state.triggered,false);}
  assert.equal(h.fresh(0.8,sample).completed,1);assert.equal(h.events.length,0);
});

test('fast edges require current and previous confidence plus recent, stable palm observations',()=>{
  const sample={confidence:0.96,delta:1000/30};
  for(const change of [{delta:200},{offset:0.16},{scale:1.6}]){
    const h=harness();h.hold(0.8,sample);
    const first=h.fresh(0.12,{...sample,...change});assert.equal(first.phase,'ready');assert.equal(first.completed,0);
    h.fresh(0.8,{...sample,...change});assert.equal(h.events.length,0);
  }
  const h=harness();h.hold(0.8,{...sample,confidence:0.84});
  assert.equal(h.fresh(0.12,sample).phase,'ready'); // A sudden confidence jump alone is insufficient.
  h.fresh(0.8,sample);assert.equal(h.events.length,0);

  const detector=createDoublePinchDetector();let now=0;
  for(let i=0;i<2;i++){now+=34;detector.update(handFrame(0.8,now),{now});}
  now+=34;const weakPalm=handFrame(0.12,now);
  weakPalm.hands[0].points.find(p=>p.index===0).presence=0.8;
  weakPalm.hands[0].points.find(p=>p.index===5).presence=0.8;
  assert.equal(detector.update(weakPalm,{now}).phase,'ready'); // Palm confidence participates in the fast path too.

  for(const slowClock of ['capture','host']){
    const guarded=createDoublePinchDetector();
    guarded.update(handFrame(0.8,0),{now:0});guarded.update(handFrame(0.8,34),{now:34});
    const timestamp=slowClock==='capture'?234:68,hostTime=slowClock==='host'?234:68;
    assert.equal(guarded.update(handFrame(0.12,timestamp),{now:hostTime}).phase,'ready');
  }

  const unscored=createDoublePinchDetector();
  for(const [timestamp,ratio] of [[0,0.8],[34,0.8],[68,0.12]]){
    const frame=handFrame(ratio,timestamp);delete frame.raw.hands[0].confidence;delete frame.raw.handedness[0][0].score;
    const state=unscored.update(frame,{now:timestamp});
    if(timestamp===68){assert.equal(state.phase,'ready');assert.equal(state.confidence,null);}
  }
});

test('fast edges still reset on source/loss and cannot skip cooldown or open re-arming',()=>{
  const sample={confidence:0.96,delta:1000/30};
  const lost=harness();lost.hold(0.8,sample);lost.fresh(0.12,sample);lost.fresh(0.8,sample);lost.missing(10);
  assert.equal(lost.fresh(0.12,sample).phase,'waiting');assert.equal(lost.fresh(0.8,sample).phase,'waiting');
  assert.equal(lost.fresh(0.8,sample).phase,'ready');assert.equal(lost.events.length,0);
  lost.fresh(0.12,sample);lost.fresh(0.8,sample);
  const switched=lost.fresh(0.12,{...sample,generation:2});assert.equal(switched.completed,0);assert.equal(switched.phase,'waiting');

  const h=harness();h.hold(0.8,sample);h.fresh(0.12,sample);h.fresh(0.8,sample);h.fresh(0.12,sample);assert.equal(h.fresh(0.8,sample).triggered,true);
  for(let i=0;i<35;i++)h.fresh(0.12,sample);
  assert.equal(h.events.length,1);assert.equal(h.fresh(0.8,sample).phase,'waiting');
  assert.equal(h.fresh(0.8,sample).phase,'ready');
  h.fresh(0.12,sample);h.fresh(0.8,sample);h.fresh(0.12,sample);assert.equal(h.fresh(0.8,sample).triggered,true);
  assert.equal(h.events.length,2);
});

test('fast confirmation never uses duplicate timestamps and still requires two distinct releases',()=>{
  const h=harness(),sample={confidence:0.96,delta:1000/30};h.hold(0.8,sample);h.fresh(0.12,sample);
  const fakeRelease=handFrame(0.8,h.getTimestamp());
  assert.equal(h.detector.update(fakeRelease,{now:h.getNow()+1,sourceId:'camera-a'}).phase,'first-closed');
  const firstRelease=h.fresh(0.8,sample);assert.equal(firstRelease.completed,1);assert.equal(firstRelease.triggered,false);
  for(let i=0;i<5;i++)assert.equal(h.repeat(1).completed,1);
  assert.equal(h.events.length,0);h.fresh(0.12,sample);assert.equal(h.fresh(0.8,sample).triggered,true);assert.equal(h.events.length,1);
});

test('early hands and complete inference packets from one frame remain one gesture observation',()=>{
  const cases=[
    {ratios:[.8,.8,.25,.25,.6,.6,.25,.25,.6,.6],
      phases:['waiting','ready','ready','first-closed','first-closed','second-ready','second-ready','second-closed','second-closed','cooldown']},
    {ratios:[.8,.8,.2,.64,.2,.64],
      phases:['waiting','ready','first-closed','second-ready','second-closed','cooldown']},
  ];
  for(const {ratios,phases} of cases){
    const events=[],detector=createDoublePinchDetector({onTrigger:event=>events.push(event)});
    for(const [index,ratio] of ratios.entries()){
      const timestamp=index*1000/60,capturedAt=1700000000000+timestamp;
      const packet=phase=>handFrame(ratio,timestamp,{rawExtra:{
        frame_timestamp_ms:timestamp,captured_at_ms:capturedAt,source_timestamp_ms:timestamp,
        inference:{engine:'MediaPipe',location:'browser',sourceId:'camera-a',generation:1,phase,
          taskSamples:{hands:{timestampMs:timestamp,sourceTimestampMs:timestamp,capturedAtMs:capturedAt,ageMs:0,updated:true,stale:false}}},
      }});
      const early=detector.update(packet('hands'),{now:timestamp});
      assert.equal(early.phase,phases[index]);
      // A delayed body/face result must not supply the second ordinary sample,
      // extend a fast gesture, or fire again after its hand-only result fired.
      const complete=detector.update(packet('complete'),{now:timestamp+14});
      assert.equal(complete.phase,early.phase);assert.equal(complete.completed,early.completed);
      assert.equal(complete.triggered,false);
    }
    assert.equal(events.length,1);
  }
});
