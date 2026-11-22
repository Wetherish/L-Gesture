import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSceneRegion} from '../dist/scene-region.js';

const scene = {sourceId: 'scene', generation: 1, width: 1280, height: 720};
const descriptor = value => ({...value, mirrored: false, revision: null});
const point = (x = .5, y = .5, source = scene) => ({x, y, space: 'scene-normalized', calibrated: true,
  calibrationId: 'calibration-1', scene: descriptor(source), observedAtMs: 1000, selectedAtMs: 1020, timestampMs: 10, estimate: true});
const context = (source = scene) => ({scene: source, capturedAtMs: 1020});
const bounded = crop => assert.ok(crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= 1 + 1e-12 && crop.y + crop.height <= 1 + 1e-12);
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-12,`${actual} should equal ${expected}`);

test('default is a fixed 0.3 by 0.3 scene crop with no invented object or confidence', () => {
  const input = {point: point(), scene}, original = structuredClone(input);
  const result = selectSceneRegion(input);
  assert.equal(result.status, 'ready');assert.deepEqual(result.crop, {x: .35, y: .35, width: .3, height: .3});
  assert.equal(result.label, 'Scene region');assert.equal(result.object, null);assert.equal(result.score, null);
  assert.equal(result.fixed, true);assert.equal(result.selection, 'region');assert.deepEqual(input, original);
});

test('edge crops shift inside the image without shrinking; customized sizes stay bounded', () => {
  for (const [x, y] of [[0, 0], [1, 1], [.02, .99], [.99, .02]]) {
    const result = selectSceneRegion({point: point(x, y), scene});bounded(result.crop);
    assert.equal(result.crop.width, .3);assert.equal(result.crop.height, .3);
    assert.ok(x >= result.crop.x && x <= result.crop.x + result.crop.width + 1e-12);
    assert.ok(y >= result.crop.y && y <= result.crop.y + result.crop.height + 1e-12);
  }
  const custom = selectSceneRegion({point: point(.9, .1), scene}, {cropWidth: .5, cropHeight: .2});
  assert.deepEqual(custom.crop, {x: .5, y: 0, width: .5, height: .2});
});

test('unmapped, off-image, wrong-source and invalid size inputs never create a crop', () => {
  for (const invalid of [{...point(), calibrated: false}, {...point(), space: 'screen'}, point(-.01, .5), point(.5, 1.01)])
    assert.equal(selectSceneRegion({point: invalid, scene}).status, 'mapping-required');
  assert.equal(selectSceneRegion({point: point(), scene: {...scene, generation: 2}}).status, 'scene-mismatch');
  assert.equal(selectSceneRegion({point: point(), scene: {...scene, width: 1920}}).status, 'scene-mismatch');
  assert.equal(selectSceneRegion({point: point(), scene}, {cropWidth: 0}).status, 'invalid-options');
  assert.equal(selectSceneRegion({point: point(), scene}, {cropHeight: 2}).status, 'invalid-options');
});

test('object refinement is optional and accepts any real confident label without requiring a class', () => {
  const detection = {label: 'Custom instrument', score: .8, bbox: {x: .4, y: .4, width: .2, height: .2}};
  assert.equal(selectSceneRegion({point: point(), scene, detections: [detection]}).selection, 'region');
  const selected = selectSceneRegion({point: point(), scene, detections: [detection], detectionContext: context()}, {preferObject: true});
  assert.equal(selected.selection, 'object');assert.equal(selected.label, 'Custom instrument');
  assert.equal(selected.score, .8);assert.ok(selected.crop.width > detection.bbox.width);bounded(selected.crop);
});

test('absent, distant, low confidence, enormous or ambiguous objects retain the gaze-centered fixed crop', () => {
  const a = {label: 'cup', score: .8, bbox: {x: .4, y: .4, width: .2, height: .2}};
  for (const detections of [[], [{...a, score: .2}], [{...a, bbox: {x: .1, y: .1, width: .1, height: .1}}],
    [{...a, bbox: {x: 0, y: 0, width: 1, height: 1}}], [a, {...a, label: 'bowl', score: .99}]]) {
    const result = selectSceneRegion({point: point(), scene, detections, detectionContext: context()}, {preferObject: true});
    assert.equal(result.selection, 'region');assert.equal(result.label, 'Scene region');assert.equal(result.object, null);
    assert.deepEqual(result.crop, {x: .35, y: .35, width: .3, height: .3});
  }
});

test('near-point distance is measured in aspect-correct source pixels', () => {
  const wide = {...scene, width: 2000, height: 500};
  const horizontal = {label: 'object', score: .9, bbox: {x: .51, y: .45, width: .1, height: .1}};
  const vertical = {label: 'object', score: .9, bbox: {x: .45, y: .51, width: .1, height: .1}};
  assert.equal(selectSceneRegion({point: point(.5, .5, wide), scene: wide, detections: [horizontal], detectionContext: context(wide)}, {preferObject: true}).selection, 'region');
  assert.equal(selectSceneRegion({point: point(.5, .5, wide), scene: wide, detections: [vertical], detectionContext: context(wide)}, {preferObject: true}).selection, 'object');
});

test('duplicate boxes do not create ambiguity and edge padding remains clipped', () => {
  const a = {label: 'drawing', score: .7, bbox: {x: -.05, y: .1, width: .2, height: .3}};
  const result = selectSceneRegion({point: point(.02, .2), scene, detections: [a, {...a, score: .9}], detectionContext: context()}, {preferObject: true});
  assert.equal(result.selection, 'object');assert.equal(result.score, .9);bounded(result.crop);assert.equal(result.crop.x, 0);
  near(result.crop.x+result.crop.width,.153);near(result.crop.y,.094);near(result.crop.height,.312);
});

test('final detector crops add only a two percent object border across scene sizes and retain large notebook bounds',()=>{
  for(const source of [scene,{...scene,width:3840,height:2160}])for(const bbox of [
    {x:.48,y:.48,width:.03,height:.04},{x:.12,y:.1,width:.76,height:.7}]){
    const detection={label:'notebook',score:.9,bbox};
    const result=selectSceneRegion({point:point(bbox.x+bbox.width/2,bbox.y+bbox.height/2,source),scene:source,
      detections:[detection],detectionContext:context(source)},{requireObject:true});
    assert.equal(result.status,'ready');assert.equal(result.selection,'object');bounded(result.crop);
    near(result.crop.x,bbox.x-bbox.width*.02);near(result.crop.y,bbox.y-bbox.height*.02);
    near(result.crop.width,bbox.width*1.04);near(result.crop.height,bbox.height*1.04);
    for(const key of ['x','y','width','height'])near(result.object.bbox[key],bbox[key]);
  }
});

test('wrong-source or stale detector boxes cannot refine an otherwise valid fixed gaze crop', () => {
  const detection = {label: 'cup', score: .99, bbox: {x: .4, y: .4, width: .2, height: .2}};
  for (const detectionContext of [undefined, context({...scene, sourceId: 'other'}), context({...scene, generation: 2}),
    {...context(), capturedAtMs: 900}, {...context(), capturedAtMs: 2000}]) {
    const result = selectSceneRegion({point: point(), scene, detections: [detection], detectionContext}, {preferObject: true});
    assert.equal(result.selection, 'region');assert.equal(result.reason, 'unbound-detections');
    assert.equal(result.object, null);assert.deepEqual(result.crop, {x: .35, y: .35, width: .3, height: .3});
  }
});

test('automatic object-only selection never falls back to a guessed 30 percent region', () => {
  const near = {label:'book',score:.8,bbox:{x:.4,y:.4,width:.2,height:.2}};
  for(const detections of [[],[{...near,score:.2}],[{...near,bbox:{x:.1,y:.1,width:.1,height:.1}}],
    [{...near,bbox:{x:0,y:0,width:1,height:1}}],[near,{...near,label:'cup'}]]){
    const result=selectSceneRegion({point:point(),scene,detections,detectionContext:context()},{requireObject:true});
    assert.equal(result.crop,null);assert.notEqual(result.status,'ready');
    assert.equal(result.status,detections.length===2?'ambiguous-object':'no-object');
  }
});

test('automatic selection requires same-frame object provenance and preserves the real class label', () => {
  const detection={label:'book',score:.92,bbox:{x:.4,y:.4,width:.2,height:.2}};
  for(const detectionContext of [undefined,context({...scene,generation:2}),{...context(),capturedAtMs:900}]){
    const result=selectSceneRegion({point:point(),scene,detections:[detection],detectionContext},{requireObject:true});
    assert.equal(result.status,'unbound-detections');assert.equal(result.crop,null);
  }
  const selected=selectSceneRegion({point:point(),scene,detections:[detection],detectionContext:context()},{requireObject:true});
  assert.equal(selected.status,'ready');assert.equal(selected.selection,'object');assert.equal(selected.label,'book');bounded(selected.crop);
});

test('people, body parts and background furnishings cannot become the automatic gaze object', () => {
  const detection={score:.99,bbox:{x:.4,y:.4,width:.2,height:.2}};
  for(const label of ['person','Person','hand','background','dining_table','wall','chair']){
    const result=selectSceneRegion({point:point(),scene,detections:[{...detection,label}],detectionContext:context()},{requireObject:true});
    assert.equal(result.status,'no-object');assert.equal(result.crop,null);
  }
  const result=selectSceneRegion({point:point(),scene,detections:[{...detection,label:'Custom instrument'}],detectionContext:context()},{requireObject:true});
  assert.equal(result.selection,'object');assert.equal(result.label,'Custom instrument');
});

test('laptop, keyboard and displays cannot replace the separate desk object even with valid same-frame gaze',()=>{
  const detection={score:.99,bbox:{x:.3,y:.3,width:.4,height:.4}};
  for(const label of ['laptop','Laptop computer','keyboard','Computer_Keyboard','screen','monitor','computer monitor','TV','tvmonitor','television']){
    const result=selectSceneRegion({point:point(),scene,detections:[{...detection,label}],detectionContext:context()},
      {requireObject:true,rankObjects:true,nearPointFraction:.15});
    assert.equal(result.status,'no-object',label);assert.equal(result.crop,null);assert.equal(result.candidates.length,0);
  }
  const notebook={label:'notebook',score:.65,bbox:{x:.44,y:.43,width:.12,height:.14}};
  const selected=selectSceneRegion({point:point(),scene,detections:[{...detection,label:'keyboard'},notebook],detectionContext:context()},
    {requireObject:true,rankObjects:true,nearPointFraction:.15});
  assert.equal(selected.status,'ready');assert.equal(selected.label,'notebook');near(selected.crop.width,.1248);
});

const ranked={requireObject:true,rankObjects:true,objectMinScore:.35,nearPointFraction:.15,objectMaxArea:.8};
test('ranked fallback accepts a real moderate-score nearby proposal within approximate calibrated gaze error',()=>{
  const detection={label:'book',score:.42,bbox:{x:.53,y:.4,width:.12,height:.2}};
  const result=selectSceneRegion({point:point(),scene,detections:[detection],detectionContext:context()},ranked);
  assert.equal(result.status,'ready');assert.equal(result.score,.42);assert.equal(result.label,'book');
  assert.notEqual(result.object.rankingScore,result.score,'ranking is not presented as model confidence');
});
test('a containing or clearly closer object wins over a second plausible proposal',()=>{
  const book={label:'book',score:.45,bbox:{x:.4,y:.4,width:.2,height:.2}};
  const cup={label:'cup',score:.99,bbox:{x:.54,y:.4,width:.1,height:.2}};
  const result=selectSceneRegion({point:point(),scene,detections:[cup,book],detectionContext:context()},ranked);
  assert.equal(result.status,'ready');assert.equal(result.label,'book');assert.equal(result.candidates.length,2);
});
test('duplicate category boxes and nested foreground boxes need not make the physical crop ambiguous',()=>{
  const book={label:'book',score:.6,bbox:{x:.45,y:.45,width:.1,height:.1}};
  const broad={label:'open notebook',score:.9,bbox:{x:.25,y:.25,width:.5,height:.5}};
  const specific=selectSceneRegion({point:point(),scene,detections:[broad,book],detectionContext:context()},ranked);
  assert.equal(specific.status,'ready');assert.equal(specific.label,'book');
  const same=selectSceneRegion({point:point(),scene,detections:[book,{...book,label:'cell phone',score:.75}],detectionContext:context()},ranked);
  assert.equal(same.status,'ready');assert.equal(same.score,.75);assert.equal(same.label,'cell phone');assert.equal(same.candidates.length,1);
});
test('ranked fallback still rejects genuinely tied distinct objects and unbound results',()=>{
  const book={label:'book',score:.8,bbox:{x:.35,y:.4,width:.1,height:.2}};
  const cup={label:'cup',score:.8,bbox:{x:.55,y:.4,width:.1,height:.2}};
  const result=selectSceneRegion({point:point(),scene,detections:[cup,book],detectionContext:context()},ranked);
  assert.equal(result.status,'ambiguous-object');assert.equal(result.crop,null);
  assert.equal(selectSceneRegion({point:point(),scene,detections:[book]},ranked).status,'unbound-detections');
});

const seatedPoint = (source = scene) => ({x:.5,y:.5,space:'scene-normalized',calibrated:false,estimate:true,
  mappingMethod:'seated-estimate-v1',method:'browser-iris-head-v1',scene:descriptor(source),
  gazeSource:{sourceId:'face',generation:3,inputSignature:'face:1280x720:unmirrored'},
  cameraRelationship:'assumed-aligned-cameras',timestampMs:1000,observedAtMs:1000,selectedAtMs:1020,
  quality:{kind:'seated-assumption',confidence:null},
  uncertainty:{kind:'qualitative-search-prior',space:'scene-normalized',measured:false,radiusX:.375,radiusY:.375}});
const nearbyBook = {label:'book',score:.65,bbox:{x:.53,y:.4,width:.12,height:.2}};

test('a typed seated estimate can select a real nearby object without becoming calibrated',()=>{
  const estimate=seatedPoint(),original=structuredClone(estimate);
  const result=selectSceneRegion({point:estimate,scene,detections:[nearbyBook],detectionContext:context()},ranked);
  assert.equal(result.status,'ready');assert.equal(result.selection,'object');assert.equal(result.label,'book');
  assert.equal(result.point.calibrated,false);assert.equal(result.point.mappingMethod,'seated-estimate-v1');
  assert.equal(result.point.quality.confidence,null);assert.equal(result.point.calibrationId,undefined);
  assert.equal(result.score,nearbyBook.score);bounded(result.crop);assert.deepEqual(estimate,original);
});

test('a seated marker alone cannot bypass method, freshness and provenance requirements',()=>{
  const mutations=[
    value=>{delete value.mappingMethod;},
    value=>{value.method='logitech-screen-geometric';},
    value=>{value.calibrationId='invented-fit';},
    value=>{value.estimate=false;},
    value=>{value.quality.confidence=.9;},
    value=>{value.quality.kind='calibrated-screen-feature';},
    value=>{value.uncertainty.measured=true;},
    value=>{value.uncertainty.radiusX=NaN;},
    value=>{value.gazeSource.inputSignature='screen:1280x720';},
    value=>{delete value.gazeSource.generation;},
    value=>{value.gazeSource.live=false;},
    value=>{value.gazeSource.replay=true;},
    value=>{value.synthetic=true;},
    value=>{value.replay=true;},
    value=>{value.cameraRelationship='same-camera';},
    value=>{value.timestampMs=1021;},
    value=>{value.observedAtMs=1001;},
    value=>{value.observedAtMs=519;},
    value=>{value.selectedAtMs=NaN;},
  ];
  for(const mutate of mutations){
    const estimate=seatedPoint();mutate(estimate);
    const result=selectSceneRegion({point:estimate,scene,detections:[nearbyBook],detectionContext:context()},ranked);
    assert.equal(result.status,'mapping-required',mutate.toString());assert.equal(result.crop,null);
  }
});

test('same-camera seated estimates require the actual source session and image dimensions',()=>{
  const estimate=seatedPoint();estimate.cameraRelationship='same-camera';
  estimate.gazeSource={sourceId:scene.sourceId,generation:scene.generation,inputSignature:`face:${scene.width}x${scene.height}:unmirrored`};
  assert.equal(selectSceneRegion({point:estimate,scene,detections:[nearbyBook],detectionContext:context()},ranked).status,'ready');
  for(const gazeSource of [{...estimate.gazeSource,generation:2},{...estimate.gazeSource,inputSignature:'face:720x1280:unmirrored'}]){
    assert.equal(selectSceneRegion({point:{...estimate,gazeSource},scene,detections:[nearbyBook],detectionContext:context()},ranked).status,'mapping-required');
  }
  const mirrored={...scene,mirrored:true};
  assert.equal(selectSceneRegion({point:seatedPoint(mirrored),scene:mirrored,detections:[nearbyBook],detectionContext:context(mirrored)},ranked).status,'mapping-required');
});

test('seated automatic selection still requires a bounded object from the same frozen capture',()=>{
  for(const detections of [[],[{...nearbyBook,label:'table'}],[{...nearbyBook,bbox:{x:0,y:0,width:1,height:1}}]]){
    const result=selectSceneRegion({point:seatedPoint(),scene,detections,detectionContext:context()},ranked);
    assert.equal(result.status,'no-object');assert.equal(result.crop,null);
  }
  for(const detectionContext of [undefined,context({...scene,generation:2}),{...context(),capturedAtMs:900},{...context(),capturedAtMs:2000}]){
    const result=selectSceneRegion({point:seatedPoint(),scene,detections:[nearbyBook],detectionContext},ranked);
    assert.equal(result.status,'unbound-detections');assert.equal(result.crop,null);
  }
  assert.equal(selectSceneRegion({point:seatedPoint(),scene:{...scene,generation:2},detections:[nearbyBook],detectionContext:context()},ranked).status,'scene-mismatch');
});
