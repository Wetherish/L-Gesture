import test from 'node:test';
import assert from 'node:assert/strict';
import {leftHandSearchRegion,selectHeldObject,selectLeftHandRegion,selectProminentObject} from '../dist/held-object.js';
import {normalizeFrame} from '../dist/landmarks.js';

const HAND_POINTS=[[0,80],[-28,40],[-50,10],[-60,-30],[-50,-60],[-20,0],[-20,-50],[-22,-80],[-20,-100],
  [0,-10],[10,-60],[15,-90],[12,-110],[20,0],[35,-40],[40,-70],[37,-90],[40,10],[50,-20],[55,-40],[52,-55]];
function fixture({width=1000,height=800,leftX=0.3,rightX=0.75,centerY=0.55,labels=['Left','Right'],confidence=0.95,partial=null,placeholder=false}={}){
  const scale=height/800;
  const groups=labels.map(side=>HAND_POINTS.map(([x,y],index)=>{
    const center=(side==='Left'?leftX:rightX)*width;
    return {x:side==='Left'&&partial&&!partial.includes(index)?NaN:(center+x*scale)/width,y:(height*centerY+y*scale)/height,z:0,...(placeholder?{visibility:0}:{})};
  }));
  const handedness=labels.map(label=>[{categoryName:label,...(confidence===null?{}:{score:confidence})}]);
  const raw={type:'browser_inference',coordinate_space:'normalized',provenance:'Browser inference',timestamp_ms:100,
    image_resolution:{width,height},inference:{engine:'MediaPipe',location:'browser',sourceId:'camera-a',generation:1},
    handLandmarks:groups,handedness,rawResults:{hands:{landmarks:groups,handedness}}};
  const box=(dx,dy,w,h,side='Left')=>({x:((side==='Left'?leftX:rightX)*width+dx*scale)/width,y:(height*centerY+dy*scale)/height,width:w*scale/width,height:h*scale/height});
  return {frame:normalizeFrame(raw),raw,box,
    phone:{label:'cell phone',score:0.86,bbox:box(-65,-140,120,200)},
    cup:{label:'cup',score:0.64,bbox:box(-75,-110,150,140)}};
}
const bounded=box=>assert.ok(box&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0&&box.x+box.width<=1+1e-12&&box.y+box.height<=1+1e-12);
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('a unique held phone or cup produces a padded detected-object crop',()=>{
  const {frame,phone,cup}=fixture();
  for(const detection of [phone,cup]){
    const result=selectHeldObject(frame,[detection]);assert.equal(result.status,'selected');
    assert.equal(result.label,detection.label);assert.equal(result.score,detection.score);assert.equal(result.handedness,'Left');
    assert.ok(result.contactGroups>=2);bounded(result.crop);bounded(result.roi);
    assert.ok(result.crop.x<detection.bbox.x&&result.crop.y<detection.bbox.y);
    assert.ok(result.crop.x+result.crop.width>detection.bbox.x+detection.bbox.width);
    assert.ok(result.crop.y+result.crop.height>detection.bbox.y+detection.bbox.height);
  }
});

test('search ROI contains the observed Left hand while object selection still requires a detected object',()=>{
  const {frame}=fixture(),search=leftHandSearchRegion(frame);assert.equal(search.status,'ready');bounded(search.roi);
  for(const point of frame.hands[0].points){assert.ok(point.x>=search.roi.x&&point.x<=search.roi.x+search.roi.width);assert.ok(point.y>=search.roi.y&&point.y<=search.roi.y+search.roi.height);}
  assert.equal(search.handedness,'Left');assert.equal(search.pointCount,21);near(search.palmSpanPx,90);
  const empty=selectHeldObject(frame,[]);assert.equal(empty.status,'no-object');assert.equal(empty.crop,null);assert.equal(empty.object,null);bounded(empty.roi);
});

test('explicit Left-hand fallback ends at the index base and captures above it without inventing an object or confidence',()=>{
  for(const options of [{leftX:.75,rightX:.25,labels:['Right','Left']},{leftX:.07},{leftX:.93},{width:900,height:1600},{width:2000,height:600}]){
    const {frame}=fixture(options),before=structuredClone(frame),result=selectLeftHandRegion(frame);
    assert.equal(result.status,'selected');assert.equal(result.method,'left-hand-region');assert.equal(result.handedness,'Left');
    assert.equal(result.object,null);assert.equal(result.score,null);assert.equal(result.confidence,null);
    assert.equal(result.label,'Left hand region');assert.equal(result.handConfidence,.95);bounded(result.crop);
    const hand=frame.hands.find(hand=>hand.handedness==='Left'),indexBase=hand.points[5];
    const bottom=result.crop.y+result.crop.height;
    near(bottom,indexBase.y);
    assert.ok(result.crop.y<Math.min(...hand.points.map(point=>point.y)),'space above the fingers is included');
    for(const point of hand.points)if(point.x>=0&&point.x<=1&&point.y>=0&&point.y<=1){
      assert.ok(point.x>=result.crop.x&&point.x<=result.crop.x+result.crop.width+1e-12);
      if(point.y<=indexBase.y)assert.ok(point.y>=result.crop.y&&point.y<=bottom+1e-12);
      else assert.ok(point.y>bottom,'wrist and palm pixels below the index base are excluded');
    }
    assert.ok(hand.points[0].y>bottom,'the wrist is below the saved snapshot');
    if(options.leftX===.75)assert.ok(result.crop.x>.5,'provider Left is respected on either side of the image');
    assert.deepEqual(frame,before);assert.deepEqual(selectLeftHandRegion(frame,{mirror:true}).crop,result.crop);
  }
});

test('saved Left-hand fallback shifts its tighter footprint upward while leaving the broad detector search unchanged',()=>{
  for(const dimensions of [{width:1000,height:800},{width:900,height:1600},{width:2000,height:600}]){
    const {frame,box}=fixture({...dimensions,leftX:.5}),result=selectLeftHandRegion(frame),aboveHand=box(-65,-200,120,180);
    const search=leftHandSearchRegion(frame),legacy=selectLeftHandRegion(frame,{fallbackPaddingPalm:1.5});
    assert.equal(result.status,'selected');assert.deepEqual(result.roi,search.roi);
    assert.ok(result.crop.width*result.crop.height<legacy.crop.width*legacy.crop.height*.5,
      'the final snapshot must remove most of the old excess area');
    assert.ok(result.crop.x<=aboveHand.x&&result.crop.y<=aboveHand.y);
    assert.ok(result.crop.x+result.crop.width>=aboveHand.x+aboveHand.width);
    assert.ok(result.crop.y+result.crop.height>=aboveHand.y+aboveHand.height);
    const points=frame.hands[0].points,left=Math.min(...points.map(p=>p.x));
    const handHeight=(Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y)))*dimensions.height;
    near((left-result.crop.x)*dimensions.width,result.palmSpanPx*.6);
    near(result.crop.height*dimensions.height,handHeight+result.palmSpanPx*1.2);
    near(result.crop.y+result.crop.height,points[5].y);
    assert.ok(search.roi.y+search.roi.height>points[0].y,'the search still includes the palm and wrist');
    const widerSearch=selectLeftHandRegion(frame,{roiPaddingPalm:2});
    assert.deepEqual(widerSearch.crop,result.crop,'search tuning must not enlarge the saved snapshot');
    assert.ok(widerSearch.roi.width>=result.roi.width);
    const scaled=selectLeftHandRegion(frame,{width:dimensions.width/2,height:dimensions.height/2});
    for(const key of ['x','y','width','height'])near(scaled.crop[key],result.crop[key]);
  }
  const {frame}=fixture({leftX:.07}),edge=selectLeftHandRegion(frame);bounded(edge.crop);assert.equal(edge.crop.x,0);
  for(const fallbackPaddingPalm of [-1,NaN,Infinity])
    assert.throws(()=>selectLeftHandRegion(frame,{fallbackPaddingPalm}),RangeError);
});

test('top-edge clipping reduces the above-hand fallback without moving its index-base boundary downward',()=>{
  for(const dimensions of [{width:1000,height:800},{width:900,height:1600},{width:2000,height:600}]){
    const {frame}=fixture({...dimensions,centerY:.25}),result=selectLeftHandRegion(frame),base=frame.hands[0].points[5];
    assert.equal(result.status,'selected');bounded(result.crop);assert.equal(result.crop.y,0);
    near(result.crop.height,base.y);
    assert.ok(result.crop.height<selectLeftHandRegion(fixture(dimensions).frame).crop.height);
    assert.ok(frame.hands[0].points[0].y>result.crop.y+result.crop.height);
  }
});

test('fractional index-base boundaries are rounded inward in source pixels, never below the hand',()=>{
  const {frame}=fixture({width:1280,height:721,centerY:.551}),base=frame.hands[0].points[5];
  for(const height of [721,360]){
    const result=selectLeftHandRegion(frame,{height,width:frame.width*height/frame.height});
    assert.equal(result.status,'selected');bounded(result.crop);
    const bottom=(result.crop.y+result.crop.height)*height;
    near(bottom,Math.floor(base.y*height));
    assert.ok(bottom<=base.y*height,'the boundary cannot enter pixels below MCP5');
    assert.ok(base.y*height-bottom<1,'rounding sacrifices less than one source pixel');
  }
});

test('above-hand fallback requires a uniquely observed, confident and in-frame Left index base',()=>{
  const cases=[
    ['missing',hand=>{hand.points=hand.points.filter(point=>point.index!==5);}],
    ['nonfinite',hand=>{hand.points[5].x=NaN;}],
    ['off-frame',hand=>{hand.points[5].x=-.01;}],
    ['low visibility',hand=>{hand.points[5].visibility=.64;}],
    ['low presence',hand=>{hand.points[5].presence=.64;}],
    ['low confidence',hand=>{hand.points[5].confidence=.64;}],
    ['duplicate',hand=>{hand.points.push({...hand.points[5]});}],
  ];
  for(const [name,alter] of cases){
    const {frame}=fixture();alter(frame.hands[0]);const before=structuredClone(frame);
    assert.equal(leftHandSearchRegion(frame).status,'ready',name+' still has enough observed geometry for object detection');
    const result=selectLeftHandRegion(frame);
    assert.equal(result.status,'left-index-base-unavailable',name);assert.equal(result.crop,null);
    assert.match(result.reason,/base of your Left index finger/);assert.deepEqual(frame,before);
  }
});

test('an index base at the top image edge cannot create an invented area below it',()=>{
  const {frame}=fixture();frame.hands[0].points[5].y=0;
  assert.equal(leftHandSearchRegion(frame).status,'ready');
  const result=selectLeftHandRegion(frame);
  assert.equal(result.status,'left-hand-region-empty');assert.equal(result.crop,null);
  assert.match(result.reason,/area above it is visible/);
});

test('Left-hand region fallback rejects replay, stale, ambiguous, low-confidence and incomplete observations',()=>{
  for(const options of [{labels:['Right']},{labels:['Left','Left']},{confidence:.3},{confidence:null},{partial:[0,4,5,9]}]){
    const result=selectLeftHandRegion(fixture(options).frame);assert.notEqual(result.status,'selected');assert.equal(result.crop,null);
  }
  const {frame}=fixture();
  for(const override of [{synthetic:true},{replay:true},{stale:true},{source:'Logitech Hands Tracker'},{coordinateSpace:'normalized-mirrored-top-left'}]){
    const result=selectLeftHandRegion({...frame,...override});assert.equal(result.status,'invalid-frame');assert.equal(result.crop,null);
  }
});

test('missing, ambiguous, uncertain or incomplete Left hands do not produce an arbitrary crop',()=>{
  for(const [options,status] of [
    [{labels:['Right']},'left-hand-missing'],[{labels:['Unknown','Right']},'left-hand-missing'],
    [{labels:['Left','Left']},'left-hand-ambiguous'],[{confidence:0.3},'left-hand-uncertain'],
    [{confidence:null},'left-hand-uncertain'],[{partial:[0,4,5,9]},'left-hand-incomplete']
  ]){
    const {frame,phone}=fixture(options),result=selectHeldObject(frame,[phone]);
    assert.equal(result.status,status);assert.equal(result.crop,null);assert.equal(leftHandSearchRegion(frame).status,status);
  }
});

test('empty-hand scenes containing only people, scenery or furniture are rejected',()=>{
  const {frame,phone}=fixture();
  for(const label of ['person',' Person ','background','wall','dining_table','chair','sofa']){
    const result=selectHeldObject(frame,[{...phone,label}]);assert.equal(result.status,'no-object');assert.equal(result.crop,null);
  }
  const result=selectHeldObject(frame,[{label:'person',score:0.99,bbox:{x:0.05,y:0.05,width:0.9,height:0.9}}]);
  assert.equal(result.status,'no-object');
});

test('objects at the Right hand or separated background positions cannot win on high score',()=>{
  const {frame,box}=fixture();
  for(const bbox of [box(-65,-140,120,200,'Right'),{x:0.45,y:0.08,width:0.15,height:0.2},{x:0.1,y:0.78,width:0.2,height:0.2}]){
    const result=selectHeldObject(frame,[{label:'cup',score:0.99,bbox}]);assert.equal(result.status,'no-object');assert.equal(result.crop,null);
  }
});

test('an object contacting both hands is rejected when association with the other hand is as strong',()=>{
  const {frame}=fixture({rightX:0.39});
  const rightObject={label:'bottle',score:0.95,bbox:{x:0.325,y:0.4125,width:0.13,height:0.2}};
  const result=selectHeldObject(frame,[rightObject]);assert.equal(result.status,'no-object');assert.equal(result.crop,null);
});

test('two plausible nearby objects remain ambiguous even when one model score is higher',()=>{
  const {frame,phone,cup}=fixture(),result=selectHeldObject(frame,[{...phone,score:0.97},{...cup,score:0.48}]);
  assert.equal(result.status,'ambiguous-object');assert.equal(result.candidateCount,2);assert.equal(result.crop,null);assert.equal(result.label,null);
  const twoCups=[{label:'cup',score:0.85,bbox:{x:0.23,y:0.40,width:0.075,height:0.2}},{label:'cup',score:0.87,bbox:{x:0.29,y:0.40,width:0.075,height:0.2}}];
  assert.equal(selectHeldObject(frame,twoCups).status,'ambiguous-object');
});

test('near-identical same-label detector retries are deduplicated without hiding distinct candidates',()=>{
  const {frame,phone}=fixture(),copy={...phone,score:0.92,bbox:{...phone.bbox,x:phone.bbox.x+0.0002}};
  const result=selectHeldObject(frame,[phone,copy]);assert.equal(result.status,'selected');assert.equal(result.candidateCount,1);assert.equal(result.score,0.92);
  assert.equal(selectHeldObject(frame,[phone,{...phone,label:'book'}]).status,'ambiguous-object');
});

test('image-edge detection boxes and padding are safely clamped',()=>{
  const {frame}=fixture({leftX:0.07}),detection={label:'cell phone',score:0.8,bbox:{x:-0.02,y:0.375,width:0.15,height:0.25}};
  const result=selectHeldObject(frame,[detection]);assert.equal(result.status,'selected');bounded(result.crop);bounded(result.object.bbox);bounded(result.roi);
  assert.equal(result.crop.x,0);assert.equal(result.object.bbox.x,0);near(result.object.bbox.width,0.13);
  assert.ok(result.crop.width>result.object.bbox.width);assert.equal(detection.bbox.x,-0.02);
});

test('tiny noise and giant boxes are rejected while plausible small and large handheld objects remain eligible',()=>{
  const {frame,box}=fixture();
  const rejected=[{x:0.279,y:0.424,width:0.002,height:0.002},{x:0,y:0,width:1,height:1},box(-200,-200,800,500),box(-1,-100,5,130)];
  for(const bbox of rejected)assert.equal(selectHeldObject(frame,[{label:'book',score:0.99,bbox}]).status,'no-object');
  const small={label:'toothbrush',score:0.75,bbox:box(-24,-110,18,130)};
  assert.equal(selectHeldObject(frame,[small]).status,'selected');
  const big={label:'book',score:0.75,bbox:box(-55,-370,420,450)};
  assert.equal(selectHeldObject(frame,[big]).status,'selected');
  const enclosingBackground={label:'book',score:0.99,bbox:box(-200,-270,420,450)};
  assert.equal(selectHeldObject(frame,[enclosingBackground]).status,'no-object');
});

test('partial but trustworthy Left topology can locate an object that occludes several fingers',()=>{
  const {frame,box}=fixture({partial:[0,3,4,5,6,8,9,10,12]});
  const search=leftHandSearchRegion(frame);assert.equal(search.status,'ready');assert.equal(search.pointCount,9);
  const result=selectHeldObject(frame,[{label:'book',score:0.6,bbox:box(-55,-370,420,450)}]);
  assert.equal(result.status,'selected');assert.ok(result.contactGroups>=2);bounded(result.crop);
});

test('geometry stays aspect-correct across portrait and widescreen image dimensions',()=>{
  const baseline=fixture(),association=selectHeldObject(baseline.frame,[baseline.phone]).association;
  for(const dimensions of [{width:1920,height:1080},{width:900,height:1600},{width:2000,height:600}]){
    const {frame,phone}=fixture(dimensions),result=selectHeldObject(frame,[phone]);assert.equal(result.status,'selected');
    near(result.association,association);bounded(result.crop);
  }
  const {frame,phone}=fixture(),full=selectHeldObject(frame,[phone]),half=selectHeldObject(frame,[phone],{width:500,height:400});
  for(const key of ['x','y','width','height'])near(full.crop[key],half.crop[key]);
  near(leftHandSearchRegion(frame,{width:500,height:400}).palmSpanPx,45);
});

test('provider handedness is preserved regardless of screen x, array order or preview mirror',()=>{
  const {frame,phone}=fixture({leftX:0.75,rightX:0.3,labels:['Right','Left']});
  const normal=selectHeldObject(frame,[phone]),mirrored=selectHeldObject(frame,[phone],{mirror:true});
  assert.equal(normal.status,'selected');assert.ok(normal.crop.x>0.5);assert.deepEqual(mirrored.crop,normal.crop);assert.equal(normal.handedness,'Left');
});

test('known MediaPipe visibility placeholders work, while meaningful custom low visibility blocks selection',()=>{
  const {frame,phone}=fixture({placeholder:true});assert.equal(selectHeldObject(frame,[phone]).status,'selected');
  const custom=fixture();delete custom.frame.raw.rawResults;custom.frame.hands[0].points.forEach(point=>point.visibility=0);
  assert.equal(selectHeldObject(custom.frame,[custom.phone]).status,'left-hand-incomplete');
});

test('object confidence is meaningful, with a practical default threshold and no fallback on invalid detections',()=>{
  const {frame,phone}=fixture();assert.equal(selectHeldObject(frame,[{...phone,score:0.4}]).status,'selected');
  for(const score of [0.39,0,-1,NaN,Infinity,1.1])assert.equal(selectHeldObject(frame,[{...phone,score}]).status,'no-object');
  for(const bbox of [null,{x:0,y:0,width:0,height:1},{x:NaN,y:0,width:0.1,height:0.1},{x:235,y:300,width:120,height:200}]){
    assert.equal(selectHeldObject(frame,[{...phone,bbox}]).status,'no-object');
  }
  assert.equal(selectHeldObject(frame,null).status,'no-object');
});

test('source validity, coordinate registration, configuration and input immutability are explicit',()=>{
  const {frame,phone}=fixture(),before=structuredClone({frame,phone});selectHeldObject(frame,[phone]);leftHandSearchRegion(frame);
  assert.deepEqual({frame,phone},before);
  for(const override of [{synthetic:true},{stale:true},{width:0},{source:'Logitech Hands Tracker'},{coordinateSpace:'normalized-mirrored-top-left'}]){
    assert.equal(selectHeldObject({...frame,...override},[phone]).status,'invalid-frame');
  }
  assert.equal(selectHeldObject(null,[phone]).status,'invalid-frame');
  const tight=selectHeldObject(frame,[phone],{cropPadding:0,cropPaddingPalm:0});
  for(const key of ['x','y','width','height'])near(tight.crop[key],tight.object.bbox[key]);
  assert.throws(()=>selectHeldObject(frame,[phone],{objectConfidenceThreshold:-1}),RangeError);
  assert.throws(()=>leftHandSearchRegion(frame,{contactRadiusPalm:0}),RangeError);
});

const prominentBook={label:'book',score:.9,bbox:{x:.2,y:.2,width:.6,height:.6}};
const prominentDimensions={width:1000,height:800};

test('a large centered confident book produces a prominent crop without claiming a hand or depth',()=>{
  const before=structuredClone(prominentBook),result=selectProminentObject([prominentBook],prominentDimensions);
  assert.equal(result.status,'selected');assert.equal(result.method,'prominent-object');
  assert.equal(result.label,'book');assert.equal(result.score,.9);near(result.areaFraction,.36);
  assert.equal(result.handedness,undefined);assert.equal(result.handConfidence,undefined);
  for(const key of ['x','y','width','height'])near(result.object.bbox[key],prominentBook.bbox[key]);bounded(result.crop);
  near(result.crop.x,.152);near(result.crop.width,.696);
  assert.deepEqual(prominentBook,before,'selection never mutates or relabels model output');
});

test('a sole small, peripheral, cut-off or weak detection never becomes a prominent snapshot',()=>{
  const boxes=[
    {x:.45,y:.45,width:.1,height:.1},
    {x:.02,y:.1,width:.4,height:.5},
    {x:-.1,y:.2,width:.7,height:.6},
    {x:.005,y:.2,width:.6,height:.6},
    {x:.1,y:.025,width:.8,height:.95},
    {x:.415,y:.05,width:.17,height:.9},
  ];
  for(const bbox of boxes){
    const result=selectProminentObject([{...prominentBook,bbox}],prominentDimensions);
    assert.equal(result.status,'no-object');assert.equal(result.crop,null);
  }
  for(const score of [.64,0,NaN,Infinity,1.1])assert.equal(selectProminentObject([{...prominentBook,score}],prominentDimensions).status,'no-object');
  assert.equal(selectProminentObject([{...prominentBook,score:.65}],prominentDimensions).status,'selected');
});

test('people, body parts, furniture, scenery, fixtures and vehicles cannot be prominent targets',()=>{
  for(const label of ['person','hands','body','background','wall','dining_table','chair','sofa','tv','refrigerator','car','bus']){
    const result=selectProminentObject([{...prominentBook,label}],prominentDimensions);
    assert.equal(result.status,'no-object');assert.equal(result.crop,null);
  }
  const result=selectProminentObject([{...prominentBook,label:'person',score:.99},prominentBook],prominentDimensions);
  assert.equal(result.status,'selected');assert.equal(result.label,'book','a real book can remain prominent in front of a person');
});

test('prominent selection requires both area and confidence-weighted dominance over off-center rivals',()=>{
  const rival={label:'cup',score:.99,bbox:{x:.01,y:.01,width:.45,height:.45}};
  assert.equal(selectProminentObject([prominentBook,rival],prominentDimensions).status,'ambiguous-object');
  const smallWinner={label:'book',score:.65,bbox:{x:.3,y:.3,width:.4,height:.4}};
  const weightedRival={label:'bottle',score:.99,bbox:{x:.7,y:.05,width:.25,height:.3}};
  assert.equal(selectProminentObject([smallWinner,weightedRival],prominentDimensions).status,'ambiguous-object','2x area alone is insufficient');
  assert.equal(selectProminentObject([prominentBook,{...weightedRival,bbox:{x:.8,y:.05,width:.15,height:.2}}],prominentDimensions).status,'selected');
});

test('only near-identical same-class boxes deduplicate; competing labels and distinct large objects stay ambiguous',()=>{
  const duplicate={...prominentBook,score:.95,bbox:{...prominentBook.bbox,x:.2001}};
  const result=selectProminentObject([prominentBook,duplicate],prominentDimensions);
  assert.equal(result.status,'selected');assert.equal(result.candidateCount,1);assert.equal(result.score,.95);
  assert.equal(selectProminentObject([prominentBook,{...prominentBook,label:'laptop'}],prominentDimensions).status,'ambiguous-object');
  assert.equal(selectProminentObject([prominentBook,{...prominentBook,bbox:{x:.39,y:.25,width:.5,height:.5}}],prominentDimensions).status,'ambiguous-object');
});

test('prominent centering uses image aspect ratio and rejects missing image geometry',()=>{
  const landscape={...prominentBook,bbox:{x:.41,y:.25,width:.54,height:.5}};
  const portrait={...prominentBook,bbox:{x:.25,y:.41,width:.5,height:.54}};
  assert.equal(selectProminentObject([landscape],{width:1920,height:1080}).status,'no-object');
  assert.equal(selectProminentObject([portrait],{width:1080,height:1920}).status,'no-object');
  assert.equal(selectProminentObject([landscape],{width:1000,height:1000}).status,'selected');
  for(const dimensions of [{},{width:0,height:800},{width:1000,height:NaN}])assert.equal(selectProminentObject([prominentBook],dimensions).status,'invalid-frame');
  assert.equal(selectProminentObject(null,prominentDimensions).status,'no-object');
});
