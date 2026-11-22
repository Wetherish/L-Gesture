import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveHandMetrics, handFingertips, handednessLabel, HAND_FINGERTIPS} from '../dist/hand-metrics.js';
import {normalizeFrame} from '../dist/landmarks.js';

const points = () => Array.from({length:21},(_,i)=>({x:0.1+i/100,y:0.2+i/200,z:-i/1000}));
const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
function browserFrame(labels=['Right'],extra={}) {
  return normalizeFrame({type:'browser_inference',provenance:'Browser inference',coordinate_space:'normalized',
    image_resolution:{width:1000,height:500},timestamp_ms:123,
    inference:{engine:'MediaPipe',location:'browser',sourceId:'camera:1',generation:7},
    handLandmarks:labels.map(()=>points()),handedness:labels.map(label=>[{categoryName:label,score:0.9}]),...extra});
}
function sdkHandsRaw(){
  const landmarks=[points(),points()].map(hand=>hand.map(point=>({...point,visibility:0})));
  const worldLandmarks=[points(),points()].map(hand=>hand.map(point=>({...point,visibility:0})));
  worldLandmarks[1][4]={x:0,y:0,z:0,visibility:0};worldLandmarks[1][8]={x:0.03,y:0.04,z:0.12,visibility:0};
  const handedness=[[{categoryName:'Left',score:0.9584}],[{categoryName:'Right',score:0.9351}]];
  return {type:'browser_landmarks',coordinate_space:'normalized',provenance:'Browser inference',timestamp_ms:123,
    inference:{engine:'mediapipe',location:'browser',sourceId:'photo-two-hands',generation:1},image_resolution:{width:1920,height:1080},
    handLandmarks:landmarks,handWorldLandmarks:worldLandmarks,handedness,
    rawResults:{hands:{landmarks,worldLandmarks,handedness}}};
}

test('five anatomical fingertips retain source coordinates, depth and image pixels',()=>{
  const sourcePoints=points();sourcePoints[4]={x:1.25,y:-0.2,z:-0.07,visibility:0.84,presence:0.73};
  const frame=browserFrame(['Right'],{handLandmarks:[sourcePoints]});
  const before=structuredClone(frame),metrics=deriveHandMetrics(frame),tips=metrics.hands[0].fingertips;
  assert.deepEqual(tips.map(tip=>tip.index),[4,8,12,16,20]);
  assert.deepEqual(tips.map(tip=>tip.name),['thumb','index','middle','ring','pinky']);
  assert.equal(tips[0].x,1.25);assert.equal(tips[0].y,-0.2);assert.equal(tips[0].z,-0.07);
  assert.equal(tips[0].pixelX,1250);assert.equal(tips[0].pixelY,-100);
  assert.equal(tips[0].visibility,0.84);assert.equal(tips[0].presence,0.73);assert.equal(tips[0].confidence,0.73);
  assert.equal(metrics.timestampMs,123);assert.equal(metrics.width,1000);assert.equal(metrics.height,500);
  assert.strictEqual(metrics.inference,frame.inference);assert.equal(metrics.provenance,'Browser inference');
  assert.equal(metrics.hands[0].handednessConfidence,0.9);
  assert.deepEqual(frame,before);
});

test('Right pinch uses aspect-correct pixels and explicitly normalizes by the image diagonal',()=>{
  const p=points();p[4]={x:0.1,y:0.1,z:-0.2};p[8]={x:0.2,y:0.2,z:0.9};
  const metrics=deriveHandMetrics(browserFrame(['Right'],{handLandmarks:[p]}));
  assert.equal(metrics.rightPinch.status,'ok');
  near(metrics.rightPinch.distancePx,Math.hypot(100,50));
  near(metrics.rightPinch.distanceNormalized,0.1);
  assert.equal(metrics.rightPinch.normalization,'image-diagonal');
  assert.equal(metrics.rightPinch.distanceWorldCm,null); // image z is never metres
});

test('a real zero pinch is valid while absent Right hands remain null',()=>{
  const p=points();p[8]={...p[4]};
  const pinched=deriveHandMetrics(browserFrame(['Right'],{handLandmarks:[p]}));
  assert.equal(pinched.rightPinch.status,'ok');assert.equal(pinched.rightPinch.distancePx,0);
  for(const labels of [[],['Left'],['Unknown'],[''],['not-a-side']]){
    const result=deriveHandMetrics(browserFrame(labels));
    assert.equal(result.rightPinch.status,'missing');assert.equal(result.rightPinch.distancePx,null);
    assert.equal(result.rightPinch.distanceWorldCm,null);
  }
});

test('two Right classifications are ambiguous even if one is more confident or farther right',()=>{
  const frame=browserFrame(['Right','Right']);
  frame.raw.handedness[1][0].score=0.2;frame.hands[1].confidence=0.2;
  frame.hands[0].points.forEach(p=>p.x=0.95);frame.hands[1].points.forEach(p=>p.x=0.05);
  const metrics=deriveHandMetrics(frame);
  assert.equal(metrics.rightPinch.status,'ambiguous');assert.equal(metrics.rightPinch.distancePx,null);
  assert.equal(metrics.rightPinch.handId,null);assert.ok(metrics.hands.every(hand=>!hand.identityStable));
  assert.notEqual(metrics.hands[0].id,metrics.hands[1].id);
});

test('semantic IDs survive detection-order changes and reset with source or generation',()=>{
  const a=deriveHandMetrics(browserFrame(['Left','Right']),{sourceKey:'device-a'});
  const b=deriveHandMetrics(browserFrame(['Right','Left'],{timestamp_ms:456}),{sourceKey:'device-a'});
  for(const side of ['Left','Right'])assert.equal(a.hands.find(h=>h.handedness===side).id,b.hands.find(h=>h.handedness===side).id);
  assert.notEqual(a.rightPinch.handId,deriveHandMetrics(browserFrame(),{sourceKey:'device-b'}).rightPinch.handId);
  assert.notEqual(a.rightPinch.handId,deriveHandMetrics(browserFrame(['Right'],{inference:{sourceId:'device-a',generation:8}}),{sourceKey:'device-a'}).rightPinch.handId);
  assert.ok(a.hands.every(hand=>hand.identityStable));
  const unknownA=deriveHandMetrics(browserFrame(['Unknown']));
  const unknownB=deriveHandMetrics(browserFrame(['Unknown'],{timestamp_ms:124}));
  assert.equal(unknownA.hands[0].identityStable,false);assert.notEqual(unknownA.hands[0].id,unknownB.hands[0].id);
});

test('classification, endpoint visibility and endpoint presence gate pinch without deleting inspectable values',()=>{
  const lowHand=deriveHandMetrics(browserFrame(['Right'],{handedness:[[{categoryName:'Right',score:0.2}]]}));
  assert.equal(lowHand.rightPinch.status,'low-confidence');assert.equal(lowHand.rightPinch.distancePx,null);
  assert.equal(lowHand.hands[0].handednessConfidence,0.2);assert.equal(lowHand.hands[0].fingertips[0].x,0.14);
  for(const field of ['visibility','presence']){
    const p=points();p[8][field]=0.3;
    const result=deriveHandMetrics(browserFrame(['Right'],{handLandmarks:[p]}),{confidenceThreshold:0.5});
    assert.equal(result.rightPinch.status,'low-confidence');assert.equal(result.rightPinch.distancePx,null);
    assert.equal(result.hands[0].fingertips[1][field],0.3);
  }
});

test('unreported category confidence and unreported depth stay unknown instead of becoming fabricated defaults',()=>{
  const p=points();delete p[4].z;
  const result=deriveHandMetrics(browserFrame(['Right'],{handedness:[[{categoryName:'Right'}]],handLandmarks:[p]}));
  assert.equal(result.hands[0].handedness,'Right');assert.equal(result.hands[0].confidence,null);
  assert.equal(result.hands[0].handednessConfidence,null);assert.equal(result.hands[0].fingertips[0].z,null);
  assert.equal(result.hands[0].fingertips[1].z,p[8].z);assert.equal(result.rightPinch.status,'ok');
});

test('Hands Tracker exposes only its observed thumb/index, crop pixels and provided side',()=>{
  const frame=normalizeFrame({type:'hand_telemetry',timestamp_ms:42,image:{width:1024,height:768,coordinate_space:'normalized_mirrored'},hands:[{
    handedness:'Right',thumb_tip:{x:0.2,y:0.3},index_tip:{x:0.4,y:0.5},index_thumb_midpoint:{x:0.3,y:0.4},index_thumb_distance:0.2828
  }]});
  const result=deriveHandMetrics(frame),hand=result.hands[0],tips=hand.fingertips;
  assert.equal(hand.handedness,'Right');assert.equal(hand.mirrored,true);assert.equal(hand.topology,'sparse');
  assert.equal(hand.confidence,null);assert.equal(hand.handednessConfidence,null);
  near(tips[0].y,0.7);near(tips[0].pixelX,204.8);near(tips[0].pixelY,537.6);
  assert.equal(tips[0].z,null);assert.equal(tips[1].z,null);
  assert.deepEqual(tips.slice(2).map(tip=>[tip.status,tip.x,tip.y,tip.z]),Array.from({length:3},()=>['missing',null,null,null]));
  near(result.rightPinch.distancePx,Math.hypot(0.2*1024,0.2*768));
  assert.match(result.warnings.join(' '),/processed image.*cropped and mirrored/);
});

test('unlabelled sparse positions never imply fingertip IDs; explicit names and IDs do',()=>{
  const anonymous={sparse:true,points:Array.from({length:5},(_,index)=>({index,x:index/10,y:0.2,z:0}))};
  assert.ok(handFingertips(anonymous).every(tip=>tip.status==='missing'));
  const identified={sparse:true,points:[{index:0,name:'thumb_tip',x:0.1,y:0.2},{index:1,landmarkIndex:8,x:0.3,y:0.4},{index:2,name:'index_thumb_midpoint',x:0.2,y:0.3}]};
  const tips=handFingertips(identified,{width:100,height:200});
  assert.deepEqual(tips.map(tip=>tip.status),['ok','ok','missing','missing','missing']);
  assert.equal(tips[0].z,null);assert.equal(tips[0].pixelX,10);assert.equal(tips[1].pixelY,80);
});

test('dropped malformed landmarks keep anatomical indices and never shift fingertip names',()=>{
  const p=points();p[3]={x:NaN,y:0};p[8]={x:0,y:Infinity};
  const metrics=deriveHandMetrics(browserFrame(['Right'],{handLandmarks:[p]}));
  assert.equal(metrics.hands[0].fingertips[0].pointIndex,4);assert.equal(metrics.hands[0].fingertips[0].x,p[4].x);
  assert.equal(metrics.hands[0].fingertips[1].status,'missing');
  assert.equal(metrics.hands[0].fingertips[2].x,p[12].x);assert.equal(metrics.hands[0].fingertips[2].pointIndex,12);
  assert.equal(metrics.rightPinch.status,'missing-points');assert.equal(metrics.rightPinch.distancePx,null);
});

test('flat MediaPipe hand input retains raw depth and full topology',()=>{
  const p=points();const metrics=deriveHandMetrics(browserFrame(['Right'],{handLandmarks:p}));
  assert.equal(metrics.hands.length,1);assert.equal(metrics.hands[0].topology,'full');
  assert.equal(metrics.hands[0].fingertips[0].z,p[4].z);assert.equal(metrics.rightPinch.status,'ok');
});

test('21 valid MediaPipe world points yield an explicitly uncalibrated centimetre estimate',()=>{
  const world=points();world[4]={x:0,y:0,z:0};world[8]={x:0.03,y:0.04,z:0.12};
  const result=deriveHandMetrics(browserFrame(['Right'],{handWorldLandmarks:[world]}));
  assert.equal(result.rightPinch.worldStatus,'available');near(result.rightPinch.distanceWorldCm,13);
  near(result.rightPinch.worldEstimate.distanceCm,13);
  assert.deepEqual({...result.rightPinch.worldEstimate,distanceCm:13},{distanceCm:13,units:'cm',provenance:'MediaPipe world-landmark estimate',calibrated:false});
  assert.match(result.warnings.join(' '),/not a calibrated/);
});

test('world distance rejects incomplete/invalid/low-confidence data and unknown units',()=>{
  for(const bad of [points().slice(0,20),points().map((p,i)=>i===10?{...p,z:NaN}:p)]){
    const result=deriveHandMetrics(browserFrame(['Right'],{handWorldLandmarks:[bad]}));
    assert.equal(result.rightPinch.worldStatus,'invalid');assert.equal(result.rightPinch.distanceWorldCm,null);
    assert.equal(result.rightPinch.status,'ok');
  }
  const low=points();low[4].presence=0.1;
  const lowResult=deriveHandMetrics(browserFrame(['Right'],{handWorldLandmarks:[low]}));
  assert.equal(lowResult.rightPinch.worldStatus,'low-confidence');assert.equal(lowResult.rightPinch.distanceWorldCm,null);
  const generic=normalizeFrame({hands:[{handedness:'Right',landmarks:points(),worldLandmarks:points()}]});
  const unknown=deriveHandMetrics(generic);
  assert.equal(unknown.rightPinch.worldStatus,'units-unknown');assert.equal(unknown.rightPinch.distanceWorldCm,null);
  generic.raw.hands[0].worldUnits='m';
  assert.equal(deriveHandMetrics(generic).rightPinch.worldEstimate.provenance,'Provided world-landmark estimate');
});

test('invalid image dimensions and empty input never fabricate a zero measurement',()=>{
  const frame=browserFrame();frame.width=0;
  const result=deriveHandMetrics(frame);assert.equal(result.rightPinch.status,'invalid-dimensions');
  assert.equal(result.rightPinch.distancePx,null);assert.equal(result.hands[0].fingertips[0].pixelX,null);
  assert.equal(deriveHandMetrics(null).rightPinch.status,'missing');
  assert.deepEqual(deriveHandMetrics(null).hands,[]);
});

test('side labels preserve provider semantics and never depend on display mirroring or screen x',()=>{
  assert.equal(handednessLabel(' right '),'Right');assert.equal(handednessLabel([{categoryName:'Left',score:0.9}]),'Left');
  assert.equal(handednessLabel({classification:[{label:'Right'}]}),'Right');assert.equal(handednessLabel('leftmost'),'Unknown');
  const frame=browserFrame(['Left','Right']);frame.hands[0].mirrored=true;frame.hands[1].mirrored=true;
  frame.hands[0].points.forEach(p=>p.x=0.9);frame.hands[1].points.forEach(p=>p.x=0.1);
  assert.deepEqual(deriveHandMetrics(frame).hands.map(hand=>hand.handedness),['Left','Right']);
  assert.deepEqual(HAND_FINGERTIPS.map(tip=>tip.index),[4,8,12,16,20]);
});

test('observed MediaPipe hand visibility placeholders do not suppress real fingertip or world measurements',()=>{
  const raw=sdkHandsRaw(),before=structuredClone(raw),frame=normalizeFrame(raw),metrics=deriveHandMetrics(frame);
  assert.deepEqual(metrics.hands.map(hand=>hand.handednessConfidence),[0.9584,0.9351]);
  assert.ok(metrics.hands.flatMap(hand=>hand.fingertips).every(tip=>tip.status==='ok'&&tip.visibility===null&&tip.presence===null));
  assert.ok(frame.hands.flatMap(hand=>hand.points).every(point=>!Object.hasOwn(point,'visibility')));
  assert.equal(metrics.rightPinch.status,'ok');assert.ok(metrics.rightPinch.distancePx>0);
  assert.equal(metrics.rightPinch.worldStatus,'available');near(metrics.rightPinch.distanceWorldCm,13);
  assert.equal(metrics.rightPinch.worldEstimate.calibrated,false);
  assert.strictEqual(frame.raw,raw);assert.strictEqual(frame.hands[1].worldLandmarks,raw.handWorldLandmarks[1]);
  assert.deepEqual(raw,before);assert.equal(raw.rawResults.hands.landmarks[0][0].visibility,0);
  // Previously normalized frames can still be measured without mistaking the
  // exact, known placeholder for a fresh confidence signal.
  frame.hands.forEach(hand=>hand.points.forEach(point=>point.visibility=0));
  assert.equal(deriveHandMetrics(frame).rightPinch.status,'ok');
});

test('the placeholder exception does not override real handedness or explicitly supplied presence',()=>{
  const lowSide=sdkHandsRaw();lowSide.handedness[1][0].score=0.2;
  const low=deriveHandMetrics(normalizeFrame(lowSide));
  assert.equal(low.rightPinch.status,'low-confidence');assert.equal(low.rightPinch.distancePx,null);
  assert.equal(low.hands[1].handednessConfidence,0.2);
  const presence=sdkHandsRaw();presence.handLandmarks[1].forEach(point=>point.presence=0);
  const frame=normalizeFrame(presence),metrics=deriveHandMetrics(frame);
  assert.equal(frame.hands[1].points[0].presence,0);assert.equal(metrics.rightPinch.status,'low-confidence');
  assert.equal(metrics.hands[1].fingertips[0].presence,0);
  const worldPresence=sdkHandsRaw();worldPresence.handWorldLandmarks[1][4].presence=0;
  const world=deriveHandMetrics(normalizeFrame(worldPresence));
  assert.equal(world.rightPinch.status,'ok');assert.equal(world.rightPinch.worldStatus,'low-confidence');
  assert.equal(world.rightPinch.distanceWorldCm,null);
});

test('custom all-zero visibility and non-placeholder MediaPipe visibility remain meaningful',()=>{
  const custom=sdkHandsRaw();delete custom.rawResults;
  const customFrame=normalizeFrame(custom);
  assert.equal(customFrame.hands[1].points[4].visibility,0);
  assert.equal(deriveHandMetrics(customFrame).rightPinch.status,'low-confidence');
  const otherEngine=sdkHandsRaw();otherEngine.inference.engine='custom';
  assert.equal(deriveHandMetrics(normalizeFrame(otherEngine)).rightPinch.status,'low-confidence');
  const measured=sdkHandsRaw();measured.handLandmarks[1][0].visibility=0.9;
  const measuredFrame=normalizeFrame(measured);
  assert.equal(measuredFrame.hands[1].points[4].visibility,0);
  assert.equal(deriveHandMetrics(measuredFrame).rightPinch.status,'low-confidence');
  const worldMeasured=sdkHandsRaw();worldMeasured.handWorldLandmarks[1][0].visibility=0.9;
  const world=deriveHandMetrics(normalizeFrame(worldMeasured));
  assert.equal(world.rightPinch.status,'ok');assert.equal(world.rightPinch.worldStatus,'low-confidence');
});
