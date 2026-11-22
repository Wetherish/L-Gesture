import test from 'node:test';
import assert from 'node:assert/strict';
import {describeGazeReadiness,sceneCheckError} from '../dist/scene-pin-ui.js';

const main={kind:'main',label:'FaceTime HD Camera'},scene={kind:'scene',label:'LVNext Camera'};
const eye={signal:{type:'scene-gaze-feature'}};

test('connected main/scene pixels do not imply usable eyes or a calibration',()=>{
  assert.match(describeGazeReadiness().text,/Open a live camera/);
  for(const source of [main,scene]){
    const state=describeGazeReadiness({source,observation:{signal:null,reason:'One clearly visible face is needed for scene calibration.'}});
    assert.match(state.text,/eyes unavailable/);assert.equal(state.reason,'One clearly visible face is needed for scene calibration.');
  }
  const uncalibrated=describeGazeReadiness({source:main,observation:eye});
  assert.equal(uncalibrated.text,'Eyes ready · waiting for estimate');assert.match(uncalibrated.reason,/without a calibration/);
  const strict=describeGazeReadiness({source:main,observation:eye,mode:'calibrated'});
  assert.equal(strict.text,'Eyes ready · calibrate gaze');assert.match(strict.reason,/independent check/);
});

test('a ready seated estimate is identified as approximate and never as calibrated',()=>{
  const ready=describeGazeReadiness({source:scene,gazeSource:main,observation:eye,
    mapping:{status:'ready',calibrated:false,mappingMethod:'seated-estimate-v1'}});
  assert.equal(ready.text,'Seated estimate');assert.match(ready.reason,/not measured gaze accuracy/);
  const invalid=describeGazeReadiness({source:scene,gazeSource:main,observation:eye,
    mapping:{status:'source-mismatch',reason:'Camera image changed.'}});
  assert.equal(invalid.text,'Seated estimate unavailable');assert.equal(invalid.reason,'Camera image changed.');
});

test('stale or unusable eyes retain their actual reason even when a calibration exists',()=>{
  for(const reason of ['Both open eyes and their irises must be clear enough.','The captured face image is too old for scene selection.']){
    const state=describeGazeReadiness({source:main,observation:{signal:null,reason},calibration:{},mapping:{status:'ready'}});
    assert.match(state.text,/eyes unavailable/);assert.equal(state.reason,reason);
  }
});

test('only a currently mapped point is described as a calibrated estimate',()=>{
  assert.equal(describeGazeReadiness({source:main,observation:eye,calibration:{}}).text,'Calibration saved · waiting for gaze');
  const outside=describeGazeReadiness({source:scene,observation:eye,calibration:{},mapping:{status:'outside-calibration',reason:'Look inside the calibrated scene area.'}});
  assert.equal(outside.text,'Calibrated point unavailable');assert.equal(outside.reason,'Look inside the calibrated scene area.');
  const ready=describeGazeReadiness({source:main,observation:eye,calibration:{},mapping:{status:'ready'}});
  assert.equal(ready.text,'Calibrated estimate');assert.match(ready.reason,/approximate point/);
});

test('cross-camera readiness describes the eye camera independently of the crop camera',()=>{
  const unavailable=describeGazeReadiness({source:scene,gazeSource:main,observation:{reason:'Eyes closed'}});
  assert.equal(unavailable.text,'Main camera · eyes unavailable');
  assert.equal(unavailable.reason,'Eyes closed');
  const missing=describeGazeReadiness({source:scene,gazeSource:null});
  assert.equal(missing.text,'Eye camera unavailable');
  const ready=describeGazeReadiness({source:scene,gazeSource:main,observation:eye});
  assert.match(ready.reason,/Main camera eye observations/);
});

test('independent gaze checks use physical image aspect ratio in both orientations',()=>{
  const target={x:.35,y:.6};
  assert.ok(sceneCheckError({x:.48,y:.6},target,{width:1920,height:1080})>.16);
  assert.ok(sceneCheckError({x:.35,y:.73},target,{width:1080,height:1920})>.16);
  assert.ok(Math.abs(sceneCheckError({x:.48,y:.6},target,{width:1080,height:1920})-.13)<1e-12);
  assert.ok(Math.abs(sceneCheckError({x:.35,y:.73},target,{width:1920,height:1080})-.13)<1e-12);
  assert.equal(sceneCheckError(target,target,{width:1920,height:1080}),0);
  assert.equal(sceneCheckError({x:NaN,y:.6},target,{width:1920,height:1080}),Infinity);
  assert.equal(sceneCheckError(target,target,{width:0,height:1080}),Infinity);
});
