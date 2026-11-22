import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFrame, parseLandmarkInput, drawLandmarks, sampleLogitechFrame, POSE_CONNECTIONS} from '../dist/landmarks.js';

test('Logitech coordinates use stream pixels, not the face rectangle', () => {
  const frame = normalizeFrame({api_version:2, timestamp_ms:99, faces:[{bbox:[100,50,300,200], confidence:0.91, landmarks:[[640,360,-128],[1280,720,0]]}]});
  assert.equal(frame.faces[0].points[0].x, 0.5);
  assert.equal(frame.faces[0].points[0].y, 0.5);
  assert.equal(frame.faces[0].points[0].z, -0.1);
  assert.equal(frame.faces[0].bbox.width, 300 / 1280);
  assert.equal(frame.timestampMs, 99);
  assert.match(frame.warnings[0], /negotiated RGB/);
});

test('SDK capture wrapper and YUV dimensions override a caller fallback', () => {
  const wrapped = normalizeFrame({image_resolution:[1920,1080], device_ai_data:{api_version:2, faces:[{landmarks:[[960,540,-100]]}]}});
  assert.equal(wrapped.width, 1920);
  assert.equal(wrapped.faces[0].points[0].x, 0.5);
  const yuv = normalizeFrame({api_version:2,yuv_width:640,yuv_height:480,faces:[{landmarks:[[320,240]]}]});
  assert.equal(yuv.faces[0].points[0].y, 0.5);
});

test('Hands Tracker converts y and preserves already mirrored x without inventing a skeleton', () => {
  const frame = normalizeFrame({type:'hand_telemetry',timestamp_ms:1000,image:{width:1024,height:768,coordinate_space:'normalized_mirrored'},hands:[{handedness:'Right',thumb_tip:{x:0.677,y:0.411},index_tip:{x:0.705,y:0.461},index_thumb_midpoint:{x:0.691,y:0.436},index_thumb_distance:0.057}]});
  assert.equal(frame.pointCount, 3);
  assert.equal(frame.hands[0].points[0].x, 0.677);
  assert.equal(frame.hands[0].points[0].y, 1 - 0.411);
  assert.equal(frame.hands[0].points[1].landmarkIndex, 8);
  assert.equal(frame.hands[0].sparse, true);
  assert.equal(frame.hands[0].mirrored, true);
  assert.deepEqual(frame.hands[0].connections, [[0,1]]);
  assert.match(frame.warnings[0], /cropped/);
});

test('Gaze remains screen-space, including off-screen predictions', () => {
  const frame = normalizeFrame({type:'snapshot',timestamp_ms:12,screen:{width_px:1728,height_px:1117},camera:{width_px:1280,height_px:720},gaze:{x_px:-10,y_px:1200,source:'geometric'},face:{bounding_box_norm:{x:0.3,y:0.2,width:0.3,height:0.4}}});
  assert.equal(frame.gaze.x, -10 / 1728);
  assert.equal(frame.gaze.y, 1200 / 1117);
  assert.equal(frame.gaze.space, 'screen');
  assert.equal(frame.width, 1280);
  assert.equal(frame.faces[0].bbox.x, 0.3);
});

test('Empty detections remain valid; invalid points do not shift topology indexes', () => {
  assert.equal(normalizeFrame({api_version:2,plugin_loaded:false,faces:[]}).pointCount, 0);
  assert.equal(normalizeFrame({type:'hand_telemetry',hands:[]}).hands.length, 0);
  const frame = normalizeFrame({faceLandmarks:[[{x:0.1,y:0.2}, {x:NaN,y:0.3}, {x:0.4,y:0.5}]]});
  assert.deepEqual(frame.faces[0].points.map(point => point.index), [0,2]);
  assert.equal(frame.pointCount, 2);
  assert.match(frame.warnings[0], /malformed/);
});

test('MediaPipe face and hand groups are recognized together', () => {
  const frame = normalizeFrame({faceLandmarks:[[{x:0.1,y:0.2,z:-0.01}]],handLandmarks:[Array.from({length:21}, (_,i) => ({x:i/21,y:0.5,z:0}))],handednesses:[[{categoryName:'Left',score:0.9}]]});
  assert.equal(frame.pointCount, 22);
  assert.equal(frame.hands[0].handedness, 'Left');
  assert.equal(frame.hands[0].sparse, false);
});

test('JSONL and bundles preserve capture order and handle 32-bit camera timestamp wrap', () => {
  const text = [{api_version:2,timestamp_ms:4294967290,faces:[]},{api_version:2,timestamp_ms:9,faces:[]}].map(JSON.stringify).join('\n');
  const frames = parseLandmarkInput(text);
  assert.equal(frames[1].timestampMs, 9);
  assert.equal(frames[1].timelineMs, 15);
  const bundle = parseLandmarkInput(JSON.stringify({image_resolution:{width:640,height:480},frames:[{api_version:2,timestamp_ms:100,faces:[{landmarks:[[320,240]]}]},{api_version:2,timestamp_ms:133,faces:[]}]}));
  assert.equal(bundle[0].faces[0].points[0].x, 0.5);
  assert.equal(bundle[1].timelineMs, 33);
});

test('Parser reports malformed inputs without accepting protocol acknowledgments', () => {
  assert.throws(() => parseLandmarkInput(''), /Paste JSON/);
  assert.throws(() => parseLandmarkInput('[]'), /does not contain/);
  assert.throws(() => parseLandmarkInput('{"faces":[]}\n{broken}'), /line 2/);
  assert.throws(() => normalizeFrame({type:'ack',status:'streaming'}), /No landmark fields/);
  assert.throws(() => normalizeFrame(null), /JSON object/);
});

test('Sample is deterministic, visibly synthetic, and has exactly 478 points', () => {
  const sample = sampleLogitechFrame();
  assert.deepEqual(sample, sampleLogitechFrame());
  assert.equal(sample.faces[0].landmarks.length, 478);
  const frame = normalizeFrame(sample);
  assert.equal(frame.pointCount, 478);
  assert.equal(frame.synthetic, true);
  assert.equal(frame.faces[0].topology, 'synthetic');
  assert.match(frame.warnings[0], /Synthetic/);
});

test('Canvas draw does not overlay gaze by default or fabricate sparse-hand segments', () => {
  const calls = [];
  const ctx = new Proxy({canvas:{width:640,height:360}}, {get:(obj,key) => key in obj ? obj[key] : (...args) => calls.push([key,...args])});
  const frame = normalizeFrame({type:'snapshot',screen:{width_px:1920,height_px:1080},gaze:{x_px:960,y_px:540}});
  drawLandmarks(ctx, frame);
  assert.equal(calls.filter(call => call[0] === 'arc').length, 0);
  drawLandmarks(ctx, frame, {showGaze:true});
  assert.ok(calls.some(call => call[0] === 'arc' && call[1] === 320 && call[2] === 180));
});

test('Browser inference keeps provenance and face, hand and pose metadata without changing raw output', () => {
  const raw = {
    type:'browser_inference', provenance:'Browser inference', coordinate_space:'normalized',
    timestamp_ms:1234, frame_timestamp_ms:1234, captured_at_ms:1760000000000,
    image_resolution:{width:1920,height:1080},
    inference:{location:'browser',engine:'MediaPipe',sourceId:'camera-a',sourceLabel:'FaceTime HD',generation:7,delegate:'GPU',latencyMs:23},
    faceLandmarks:[[{x:0.1,y:0.2,z:-0.05}]],
    faceBlendshapes:[{categories:[{categoryName:'jawOpen',score:0.7}]}],
    facialTransformationMatrixes:[{rows:4,columns:4,data:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],
    handLandmarks:[Array.from({length:21},(_,i)=>({x:i/21,y:0.5,z:0}))],
    handWorldLandmarks:[[{x:-0.04,y:0.02,z:0.01}]],
    handedness:[[{categoryName:'Right',score:0.92}]],
    poseLandmarks:[Array.from({length:33},(_,i)=>({x:i/33,y:0.5,z:-0.1,visibility:0.9,presence:0.8}))],
    poseWorldLandmarks:[[{x:-0.23,y:0.43,z:-0.31,visibility:0.9}]],
    rawResults:{face:{sentinel:'untouched'}}
  };
  const original = structuredClone(raw), frame = normalizeFrame(raw);
  assert.equal(frame.source, 'Browser inference');
  assert.equal(frame.provenance, 'Browser inference');
  assert.strictEqual(frame.inference, raw.inference);
  assert.strictEqual(frame.raw, raw);
  assert.equal(frame.pointCount, 55);
  assert.equal(frame.poses.length, 1);
  assert.strictEqual(frame.faces[0].blendshapes, raw.faceBlendshapes[0]);
  assert.strictEqual(frame.faces[0].transformationMatrix, raw.facialTransformationMatrixes[0]);
  assert.strictEqual(frame.hands[0].worldLandmarks, raw.handWorldLandmarks[0]);
  assert.strictEqual(frame.poses[0].worldLandmarks, raw.poseWorldLandmarks[0]);
  assert.equal(frame.hands[0].handedness, 'Right');
  assert.equal(frame.poses[0].points[0].visibility, 0.9);
  assert.equal(frame.poses[0].points[0].presence, 0.8);
  assert.equal(frame.pluginLoaded, null);
  assert.equal(frame.raw.synchronized, undefined);
  assert.deepEqual(raw, original);
});

test('Explicit normalized coordinates remain out of frame rather than being mistaken for pixels', () => {
  const point = {x:2.6,y:-3.2,z:-4};
  const frame = normalizeFrame({coordinate_space:'normalized',image_resolution:[1920,1080],
    faceLandmarks:[[point]], handLandmarks:[[point]], poseLandmarks:[[point]]});
  for (const entity of [...frame.faces,...frame.hands,...frame.poses]) {
    assert.equal(entity.points[0].x, point.x);
    assert.equal(entity.points[0].y, point.y);
    assert.equal(entity.points[0].z, point.z);
  }
  const face = normalizeFrame({faces:[{coordinate_space:'normalized',landmarks:[point],bbox:[-2,-3,4,5]}]}).faces[0];
  assert.equal(face.points[0].x, 2.6);
  assert.deepEqual(face.bbox, {x:-2,y:-3,width:4,height:5});
  const browser = normalizeFrame({inference:{location:'browser'},poseLandmarks:[[point]]});
  assert.equal(browser.poses[0].points[0].x, 2.6);
  // Unmarked legacy pixel inputs retain their established interpretation.
  const legacy = normalizeFrame({faceLandmarks:[[{x:640,y:360}]]});
  assert.equal(legacy.faces[0].points[0].x, 0.5);
  assert.equal(legacy.source, 'Generic / MediaPipe');
});

test('Pose-only frames draw the 33-point skeleton and include every finite point in counts', () => {
  const landmarks = Array.from({length:33},(_,i)=>({x:(i+1)/100,y:(i+1)/50,visibility:1}));
  const frame = normalizeFrame({poseLandmarks:[landmarks]});
  const calls = [], ctx = canvasRecorder(calls);
  drawLandmarks(ctx, frame, {width:1000,height:1000,confidenceThreshold:0.5});
  assert.equal(frame.pointCount, 33);
  assert.equal(frame.faces.length, 0);
  assert.equal(frame.hands.length, 0);
  assert.equal(calls.filter(call=>call[0]==='arc').length, 33);
  assert.equal(calls.filter(call=>call[0]==='lineTo').length, 35);
  assert.equal(POSE_CONNECTIONS.length, 35);
  assert.ok(calls.some(call=>call[0]==='lineTo'&&call[1]===330&&call[2]===660));

  landmarks[1] = {x:NaN,y:0.5};
  const invalid = normalizeFrame({poseLandmarks:[landmarks]});
  assert.equal(invalid.pointCount, 32);
  assert.deepEqual(invalid.poses[0].points.slice(0,3).map(point=>point.index), [0,2,3]);
  calls.length = 0;
  drawLandmarks(ctx, invalid, {showPoints:false});
  assert.equal(calls.filter(call=>call[0]==='lineTo').length, 33);
});

test('Visibility and presence hide both pose points and connections to those points', () => {
  const landmarks = Array.from({length:33},(_,i)=>({x:i/100,y:i/50,visibility:0,presence:1}));
  for (const index of [11,12,13,15]) landmarks[index].visibility = 1;
  landmarks[12].visibility = 0.2;
  landmarks[15].presence = 0.1;
  const calls = [], ctx = canvasRecorder(calls);
  drawLandmarks(ctx, normalizeFrame({poseLandmarks:[landmarks]}), {width:1000,height:1000,confidenceThreshold:0.5});
  assert.deepEqual(calls.filter(call=>call[0]==='arc').map(call=>call.slice(1,3)), [[110,220],[130,260]]);
  assert.deepEqual(calls.filter(call=>call[0]==='lineTo'), [['lineTo',130,260]]);
});

test('Connection filtering also applies to custom face/hand connections and missing endpoint indexes', () => {
  const calls = [], ctx = canvasRecorder(calls);
  const points = [{index:0,x:0.1,y:0.1,visibility:1},{index:1,x:0.2,y:0.2,visibility:0.1},{index:2,x:0.3,y:0.3,visibility:1}];
  drawLandmarks(ctx, {faces:[{points,confidence:1,connections:[[0,1],{start:0,end:2},[0,99]]}],hands:[]}, {width:100,height:100,showPoints:false,confidenceThreshold:0.5});
  assert.deepEqual(calls.filter(call=>call[0]==='lineTo'), [['lineTo',30,30]]);
});

test('World-only pose results remain inspectable without being projected as image coordinates', () => {
  const world = [[{x:0.2,y:-0.4,z:1.3}]];
  const frame = normalizeFrame({poseWorldLandmarks:world});
  assert.equal(frame.pointCount, 0);
  assert.equal(frame.poses.length, 1);
  assert.deepEqual(frame.poses[0].points, []);
  assert.strictEqual(frame.poses[0].worldLandmarks, world[0]);
  const calls = [];
  drawLandmarks(canvasRecorder(calls), frame);
  assert.equal(calls.filter(call=>call[0]==='arc'||call[0]==='lineTo').length, 0);
  assert.deepEqual(normalizeFrame({poseLandmarks:[],poseWorldLandmarks:[]}).poses, []);
});

test('Browser source generations and reset timestamps survive replay; no empty result reuses prior detections', () => {
  const records = [
    {timestamp_ms:900,inference:{location:'browser',sourceId:'a',generation:1},poseLandmarks:[[{x:0.4,y:0.5}]]},
    {timestamp_ms:12,inference:{location:'browser',sourceId:'b',generation:2},poseLandmarks:[]}
  ];
  const frames = parseLandmarkInput(JSON.stringify(records), {fps:20});
  assert.equal(frames[0].inference.sourceId, 'a');
  assert.equal(frames[1].inference.sourceId, 'b');
  assert.equal(frames[1].inference.generation, 2);
  assert.equal(frames[1].timestampMs, 12);
  assert.equal(frames[1].timelineMs, 50);
  assert.equal(frames[1].pointCount, 0);
  assert.deepEqual(frames[1].poses, []);
  assert.equal(frames[0].pointCount, 1);
  assert.equal(normalizeFrame({provenance:'Browser inference',faceLandmarks:[]}).source, 'Browser inference');
  assert.equal(normalizeFrame({api_version:2,faces:[]}).source, 'Logitech LogiInsight');
});

test('hand labels are opt-in and name all five genuine fingertips from the provider side',()=>{
  const frame=normalizeFrame({coordinate_space:'normalized',handLandmarks:[Array.from({length:21},(_,index)=>({x:0.2+index/100,y:0.3+index/100,z:0}))],
    handedness:[[{categoryName:'Left',score:0.9}]]});
  const calls=[],ctx=canvasRecorder(calls);
  drawLandmarks(ctx,frame);
  assert.equal(calls.filter(call=>call[0]==='fillText').length,0);
  calls.length=0;
  drawLandmarks(ctx,frame,{handLabels:true,fingerLabels:true,showConnections:false,showPoints:false});
  assert.deepEqual(calls.filter(call=>call[0]==='fillText').map(call=>call[1]),['Left hand','Thumb','Index','Middle','Ring','Pinky']);
  const backgrounds=calls.filter(call=>call[0]==='fillRect');
  assert.equal(backgrounds.length,6);
  assert.ok(backgrounds.every(([,x,y,width,height])=>x>=0&&y>=0&&x+width<=640&&y+height<=360));
});

test('sparse tracker labels include only the observed thumb and index, without treating midpoint as a finger',()=>{
  const frame=normalizeFrame({type:'hand_telemetry',hands:[{handedness:'Right',thumb_tip:{x:0.2,y:0.5},index_tip:{x:0.3,y:0.6},index_thumb_midpoint:{x:0.25,y:0.55}}]});
  const calls=[];
  drawLandmarks(canvasRecorder(calls),frame,{handLabels:true,fingerLabels:true,showConnections:false,showPoints:false});
  assert.deepEqual(calls.filter(call=>call[0]==='fillText').map(call=>call[1]),['Right hand','Thumb','Index']);
  const unknown=normalizeFrame({hands:[{points:[{x:0.2,y:0.5}]}]});
  calls.length=0;
  drawLandmarks(canvasRecorder(calls),unknown,{handLabels:true,fingerLabels:true,showPoints:false});
  assert.deepEqual(calls.filter(call=>call[0]==='fillText').map(call=>call[1]),['Unknown hand']);
});

test('mirrored labels move their anchors without reversing text or changing handedness',()=>{
  const frame=normalizeFrame({coordinate_space:'normalized',handLandmarks:[Array.from({length:21},(_,index)=>({x:0.15+index/200,y:0.4,z:0}))],
    handedness:[[{categoryName:'Right',score:0.9}]]});
  const normal=[],mirrored=[];
  const options={width:1000,height:600,handLabels:true,fingerLabels:true,showConnections:false,showPoints:false};
  drawLandmarks(canvasRecorder(normal),frame,options);
  drawLandmarks(canvasRecorder(mirrored),frame,{...options,mirror:true});
  const anchorA=normal.filter(call=>call[0]==='moveTo'),anchorB=mirrored.filter(call=>call[0]==='moveTo');
  assert.equal(anchorA.length,6);assert.equal(anchorB.length,6);
  anchorA.forEach(([,x,y],index)=>{assert.ok(Math.abs(anchorB[index][1]-(1000-x))<1e-9);assert.equal(anchorB[index][2],y);});
  assert.deepEqual(normal.filter(call=>call[0]==='fillText').map(call=>call[1]),mirrored.filter(call=>call[0]==='fillText').map(call=>call[1]));
  assert.equal(mirrored.some(call=>['scale','transform','setTransform'].includes(call[0])),false);
});

test('hand and fingertip labels respect supplied classification and point confidence gates',()=>{
  const raw={coordinate_space:'normalized',handLandmarks:[Array.from({length:21},()=>({x:0.3,y:0.4,z:0,visibility:1,presence:1}))],
    handedness:[[{categoryName:'Right',score:0.9}]]};
  raw.handLandmarks[0][4].visibility=0.2;raw.handLandmarks[0][8].presence=0.1;
  const calls=[],ctx=canvasRecorder(calls),options={handLabels:true,fingerLabels:true,confidenceThreshold:0.5,showConnections:false,showPoints:false};
  drawLandmarks(ctx,normalizeFrame(raw),options);
  assert.deepEqual(calls.filter(call=>call[0]==='fillText').map(call=>call[1]),['Right hand','Middle','Ring','Pinky']);
  raw.handedness[0][0].score=0.2;calls.length=0;
  drawLandmarks(ctx,normalizeFrame(raw),options);
  assert.equal(calls.filter(call=>call[0]==='fillText').length,0);
});

test('a malformed hand point does not erase or shift labels for the remaining fingertips',()=>{
  const points=Array.from({length:21},(_,index)=>({x:0.2+index/100,y:0.4,z:0}));
  points[8]={x:NaN,y:0.5};
  const frame=normalizeFrame({handLandmarks:[points],handedness:[[{categoryName:'Left',score:0.9}]]});
  const calls=[];
  drawLandmarks(canvasRecorder(calls),frame,{fingerLabels:true,showConnections:false,showPoints:false});
  assert.deepEqual(calls.filter(call=>call[0]==='fillText').map(call=>call[1]),['Thumb','Middle','Ring','Pinky']);
});

test('combined overlay labels read each hand provider rather than the unrelated last raw packet',()=>{
  const rawPoints=Array.from({length:21},(_,index)=>({x:0.2+index/100,y:0.4,z:0}));
  rawPoints[8]={x:NaN,y:0.5};rawPoints[4].confidence=0.1;
  const handFrame=normalizeFrame({coordinate_space:'normalized',handLandmarks:[rawPoints],handedness:[[{categoryName:'Right',score:0.9}]]});
  const unrelated=normalizeFrame({handLandmarks:[Array.from({length:21},()=>({x:0.7,y:0.2,z:0}))],handedness:[[{categoryName:'Left',score:0.1}]]});
  const combined={...unrelated,hands:handFrame.hands,handSources:[{frame:handFrame,handIndex:0}]};
  const calls=[];
  drawLandmarks(canvasRecorder(calls),combined,{handLabels:true,fingerLabels:true,confidenceThreshold:0.5,showConnections:false,showPoints:false});
  assert.deepEqual(calls.filter(call=>call[0]==='fillText').map(call=>call[1]),['Right hand','Middle','Ring','Pinky']);
});

test('real SDK-shaped zero-visibility hand placeholders draw two skeletons and all fingertip labels',()=>{
  const landmarks=Array.from({length:2},(_,side)=>Array.from({length:21},(_,i)=>({x:0.1+side*0.45+i/100,y:0.3+i/200,z:-i/1000,visibility:0})));
  const worldLandmarks=landmarks.map(hand=>hand.map(point=>({...point})));
  const handedness=[[{categoryName:'Left',score:0.9584}],[{categoryName:'Right',score:0.9351}]];
  const raw={type:'browser_landmarks',coordinate_space:'normalized',provenance:'Browser inference',
    inference:{engine:'mediapipe',location:'browser',sourceId:'two-hands-photo',generation:1},image_resolution:{width:1920,height:1080},
    handLandmarks:landmarks,handWorldLandmarks:worldLandmarks,handedness,rawResults:{hands:{landmarks,worldLandmarks,handedness}},
    faceLandmarks:[Array.from({length:478},()=>({x:0.5,y:0.2,z:0}))],poseLandmarks:[Array.from({length:33},()=>({x:0.5,y:0.4,z:0,visibility:0}))]};
  const before=structuredClone(raw),frame=normalizeFrame(raw),handsOnly={...frame,faces:[],poses:[]},calls=[],ctx=canvasRecorder(calls);
  assert.equal(frame.pointCount,553);assert.equal(frame.poses[0].points[0].visibility,0);
  drawLandmarks(ctx,handsOnly,{confidenceThreshold:0.5});
  assert.equal(calls.filter(call=>call[0]==='arc').length,42);
  assert.equal(calls.filter(call=>call[0]==='lineTo').length,42);
  calls.length=0;
  drawLandmarks(ctx,handsOnly,{confidenceThreshold:0.5,showPoints:false,showConnections:false,handLabels:true,fingerLabels:true});
  assert.deepEqual(calls.filter(call=>call[0]==='fillText').map(call=>call[1]),['Left hand','Thumb','Index','Middle','Ring','Pinky','Right hand','Thumb','Index','Middle','Ring','Pinky']);
  calls.length=0;
  drawLandmarks(ctx,{...frame,faces:[],hands:[]},{confidenceThreshold:0.5});
  assert.equal(calls.filter(call=>call[0]==='arc'||call[0]==='lineTo').length,0); // Pose visibility is real and remains gated.
  assert.deepEqual(raw,before);
  raw.handedness[1][0].score=0.2;calls.length=0;
  drawLandmarks(ctx,{...normalizeFrame(raw),faces:[],poses:[]},{confidenceThreshold:0.5});
  assert.equal(calls.filter(call=>call[0]==='arc').length,21); // The genuinely uncertain Right hand stays hidden.
});

function canvasRecorder(calls) {
  return new Proxy({canvas:{width:640,height:360}}, {get:(obj,key)=>key in obj?obj[key]:(...args)=>calls.push([key,...args])});
}
