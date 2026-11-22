import test from 'node:test';
import assert from 'node:assert/strict';
import {setupGazeDebugUI,clipGazeDebugRegion} from '../dist/gaze-debug-ui.js';

class Element {
  constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.attributes=new Map();this.dataset={};this.style={};this.className='';this.textContent='';this.hidden=false;}
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const child of [...this.children])child.remove();this.append(...nodes);}
  remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;}}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  getContext(){return this.context;}
}
const find=(root,predicate)=>predicate(root)?root:root.children.map(child=>find(child,predicate)).find(Boolean);
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} should equal ${expected}`);
const image=(width=1200,height=800)=>({width,height,closed:0,close(){this.closed++;}});

function fixture({enabled=true,enhanceFrame}={}){
  const canvases=[];
  const doc={createElement(tag){
    const element=new Element(tag,this);
    if(tag==='canvas'){
      const operations=[],context={operations,globalAlpha:1,drawImage(...args){operations.push({name:'drawImage',args,alpha:this.globalAlpha});}};
      for(const name of ['clearRect','save','restore','beginPath','rect','clip','arc','moveTo','lineTo','closePath','setTransform','stroke','strokeRect','setLineDash'])context[name]=(...args)=>operations.push({name,args});
      element.context=context;canvases.push(element);
    }
    return element;
  }};
  const host=doc.createElement('div'),ui=setupGazeDebugUI({host,...(enhanceFrame?{enhanceFrame}:{})});
  ui.setSourceKey('current-camera');ui.setEnabled(enabled);
  const byClass=name=>find(host,node=>node.className.split(' ').includes(name));
  const card=step=>find(host,node=>node.dataset.step===step);
  const canvas=step=>find(card(step),node=>node.tagName==='CANVAS');
  return {ui,host,canvases,byClass,card,canvas,
    update:(stage,extra={})=>ui.update({attemptId:1,sourceKey:'current-camera',stage,...extra}),
  };
}

test('debug is disabled by default and only copies the current frozen attempt when explicitly enabled',()=>{
  const h=fixture({enabled:false}),frame=image(3840,2160);
  assert.equal(h.ui.getState().enabled,false);assert.equal(h.byClass('gaze-debug').hidden,true);
  assert.equal(h.update('capture',{frame}),false);assert.equal(h.canvases.length,4);
  h.ui.setEnabled(true);
  assert.equal(h.update('capture',{frame,sourceSize:{width:3840,height:2160},gaze:{x:.6,y:.5}}),true);
  assert.deepEqual(h.ui.getState().previewSize,{width:480,height:270});
  assert.equal(h.canvas('source').hidden,false);assert.equal(h.canvas('roi').hidden,true);
  assert.equal(h.canvas('model').hidden,true);assert.equal(h.canvas('result').hidden,true);
  assert.equal(h.byClass('gaze-debug').attributes.get('aria-busy'),'true');
  assert.equal(find(h.host,node=>node.tagName==='SUMMARY').attributes.get('aria-label'),'About gaze crop debugging');
  assert.equal(h.ui.getState().confidence,null);assert.deepEqual(h.ui.getState().models,[]);
  const privateCopy=h.canvases.find(canvas=>canvas.context.operations.some(op=>op.name==='drawImage'&&op.args[0]===frame));
  assert.ok(privateCopy);assert.equal(privateCopy.width,480);
  frame.width=frame.height=1;
  h.update('roi',{roi:{x:.1,y:.1,width:.8,height:.8}});
  assert.deepEqual(h.ui.getState().previewSize,{width:480,height:270},'the caller can release its pixels immediately');
  assert.equal(frame.closed,0,'borrowed images are never closed by the panel');
  h.ui.destroy();assert.equal(h.host.children.length,0);
  assert.ok(h.canvases.every(canvas=>canvas.width===1&&canvas.height===1));
});

test('seated aiming is labeled approximate and amber through final selection, with assumptions inside help',()=>{
  const h=fixture(),assumptions=['Upright in front of the eye camera.','Camera geometry is not measured.'];
  const uncertainty={kind:'qualitative-search-prior',level:'broad',radiusX:.3,radiusY:.35,space:'scene-normalized',measured:false};
  h.update('capture',{frame:image()});
  h.update('roi',{frame:image(600,600),frameRegion:{x:.1,y:.1,width:.8,height:.8},roi:{x:.1,y:.1,width:.8,height:.8},gaze:{x:.5,y:.5},
    calibrated:false,mappingMethod:'seated-estimate-v1',gazeQuality:{kind:'seated-assumption',confidence:null},assumptions,uncertainty});
  assert.equal(h.byClass('gaze-debug-latest').textContent,'≈ Seated estimate');
  assert.equal(h.byClass('gaze-debug').dataset.mapping,'approximate');assert.equal(h.canvas('source').context.strokeStyle,'#f2bf66');
  assert.ok(find(h.card('source'),node=>node.textContent==='Frozen image · seated estimate'));
  assert.ok(find(h.byClass('gaze-debug-metadata'),node=>node.textContent===assumptions.join(' ')));
  assert.ok(find(h.byClass('gaze-debug-metadata'),node=>node.textContent==='Broad search prior; not a measured error bound'));
  h.update('model',{operation:'segment',model:{id:'real-model',name:'Point segmenter'},confidence:null});
  h.update('result',{crop:{x:.3,y:.3,width:.3,height:.4}});
  const state=h.ui.getState();assert.equal(state.calibrated,false);assert.equal(state.mappingMethod,'seated-estimate-v1');
  assert.equal(state.gazeQuality.confidence,null);assert.equal(state.confidence,null);assert.deepEqual(state.assumptions,assumptions);
  assert.deepEqual(state.uncertainty,uncertainty);assert.equal(h.byClass('gaze-debug-latest').textContent,'≈ Seated estimate');
  assert.doesNotMatch(h.byClass('gaze-debug-detail').textContent,/%/);
  state.assumptions[0]='Modified';state.uncertainty.radiusX=1;state.gazeQuality.kind='Modified';
  assert.deepEqual(h.ui.getState().assumptions,assumptions);assert.deepEqual(h.ui.getState().uncertainty,uncertainty);
  assert.equal(h.ui.getState().gazeQuality.kind,'seated-assumption');h.ui.destroy();
});

test('calibrated and unknown mapping labels are not inferred from a gaze coordinate alone',()=>{
  const h=fixture();h.update('capture',{frame:image(),gaze:{x:.5,y:.5}});
  assert.equal(h.byClass('gaze-debug-latest').textContent,'Latest attempt');assert.equal(h.ui.getState().calibrated,null);
  assert.equal(h.canvas('source').context.strokeStyle,'#d0d7e0');
  h.update('roi',{calibrated:true,mappingMethod:'scene-calibration-v1',roi:{x:.1,y:.1,width:.8,height:.8}});
  assert.equal(h.byClass('gaze-debug-latest').textContent,'Calibrated');assert.equal(h.byClass('gaze-debug').dataset.mapping,'calibrated');
  assert.equal(h.canvas('source').context.strokeStyle,'#dcff96');
  h.update('capture',{attemptId:2,frame:image()});
  assert.equal(h.ui.getState().calibrated,null);assert.equal(h.ui.getState().mappingMethod,'');
  assert.deepEqual(h.ui.getState().assumptions,[]);assert.equal(h.ui.getState().uncertainty,null);h.ui.destroy();
});

test('an object-only scene fallback clears earlier gaze claims and uses a neutral scene-object label',()=>{
  const h=fixture();h.update('capture',{frame:image()});
  h.update('roi',{calibrated:false,mappingMethod:'seated-estimate-v1',gaze:{x:.5,y:.5},roi:{x:.1,y:.1,width:.8,height:.8},
    assumptions:['Assumed camera placement.'],gazeQuality:{kind:'seated-assumption',confidence:null}});
  h.update('model',{operation:'detect',calibrated:null,mappingMethod:'scene-object-model',gaze:null,roi:null,
    gazeQuality:null,assumptions:[],uncertainty:null,boxes:[{bbox:{x:.2,y:.2,width:.4,height:.5},label:'Notebook',score:null}]});
  assert.equal(h.byClass('gaze-debug-latest').textContent,'Scene object');assert.equal(h.ui.getState().gaze,null);
  assert.equal(h.ui.getState().calibrated,null);assert.equal(h.ui.getState().gazeQuality,null);assert.deepEqual(h.ui.getState().assumptions,[]);
  assert.equal(h.ui.getState().confidence,null);assert.equal(h.byClass('gaze-debug').dataset.mapping,'unknown');h.ui.destroy();
});

test('final perspective preview uses the original frozen pixels and the same fixed transform as the live pin',()=>{
  const h=fixture(),original=image(512,640),processed=image(400,400),transform={type:'perspective',quad:[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}]};
  h.update('capture',{frame:original,sourceSize:{width:512,height:640}});
  const originalCopy=h.canvases.find(canvas=>canvas.context.operations.some(op=>op.name==='drawImage'&&op.args[0]===original));
  h.update('model',{frame:processed,frameRegion:{x:.1,y:.1,width:.8,height:.8},operation:'detect'});
  h.update('result',{crop:{x:.1,y:.05,width:.8,height:.9},transform,calibrated:null,mappingMethod:'scene-object-model'});
  const canvas=h.canvas('result');assert.equal(canvas.hidden,false);assert.equal(canvas.width,230);assert.equal(canvas.height,384);
  const draws=canvas.context.operations.filter(op=>op.name==='drawImage');assert.equal(draws.length,2);
  assert.ok(draws.every(op=>op.args[0]===originalCopy),'straightening never samples contrast-processed model pixels');
  assert.ok(find(h.card('result'),node=>node.textContent==='Straightened crop · frozen preview'));
  assert.deepEqual(h.ui.getState().transform,transform);const state=h.ui.getState();state.transform.quad[0].x=.4;
  assert.equal(h.ui.getState().transform.quad[0].x,.2);h.ui.setEnabled(false);assert.equal(h.ui.getState().transform,null);h.ui.destroy();
});

test('upright debug results retain reading order and use an owner-document canvas for arbitrary rotations',()=>{
  const quad=[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}];
  for(const [transform,orientation] of [
    [{type:'perspective',quad:[quad[2],quad[3],quad[0],quad[1]]},{status:'text-upright',method:'page-corners',clockwiseDegrees:180}],
    [{type:'perspective',quad,rotationDegrees:-8.25},{status:'text-upright',method:'rotation',clockwiseDegrees:-8.25}],
  ]){
    const h=fixture(),original=image(512,640),processed=image(400,400);
    h.update('capture',{frame:original,sourceSize:{width:512,height:640}});
    const originalCopy=h.canvases.find(canvas=>canvas.context.operations.some(op=>op.name==='drawImage'&&op.args[0]===original));
    h.update('model',{frame:processed,operation:'detect',orientation:{...orientation,rawResponse:'discard'}});
    h.update('result',{crop:{x:.1,y:.05,width:.8,height:.9},transform:{...transform,privateMetadata:'discard'}});
    const output=h.canvas('result');assert.equal(output.hidden,false);
    const draws=output.context.operations.filter(op=>op.name==='drawImage');
    if(transform.rotationDegrees){
      assert.equal(draws.length,1);const intermediate=draws[0].args[0];
      assert.ok(h.canvases.includes(intermediate),'rotation allocates through the panel owner document');
      assert.ok(intermediate.context.operations.filter(op=>op.name==='drawImage').every(op=>op.args[0]===originalCopy));
      assert.equal(intermediate.width,1);assert.equal(intermediate.height,1,'temporary rotation pixels are released');
      assert.ok(output.width>230&&output.height>384,'rotation retains the complete crop in expanded bounds');
    }else{
      assert.equal(draws.length,2);assert.ok(draws.every(op=>op.args[0]===originalCopy));
      assert.ok(output.context.operations.some(op=>op.name==='setTransform'&&op.args[0]<0&&op.args[3]<0),'page order turns both axes without a mirror');
    }
    assert.ok(find(h.card('result'),node=>node.textContent==='Upright crop · frozen preview'));
    assert.ok(find(h.byClass('gaze-debug-metadata'),node=>node.textContent===`Upright · ${orientation.clockwiseDegrees}° clockwise correction · ${orientation.method}`));
    const state=h.ui.getState();assert.deepEqual(state.transform,transform);assert.deepEqual(state.orientation,orientation);
    state.orientation.clockwiseDegrees=0;state.transform.quad[0].x=0;
    assert.deepEqual(h.ui.getState().orientation,orientation);assert.deepEqual(h.ui.getState().transform,transform);
    h.ui.setEnabled(false);assert.equal(h.ui.getState().orientation,null);assert.equal(h.ui.getState().transform,null);
    h.ui.destroy();assert.ok(h.canvases.every(canvas=>canvas.width===1&&canvas.height===1));
  }
});

test('unknown and invalid orientation metadata never label a debug preview upright',()=>{
  for(const orientation of [{status:'unknown',method:'unknown',clockwiseDegrees:null},
    {status:'unknown',method:'rotation',clockwiseDegrees:180}]){
    const h=fixture();h.update('capture',{frame:image()});
    h.update('result',{crop:{x:.2,y:.2,width:.4,height:.5},orientation});
    assert.equal(h.canvas('result').hidden,false);
    assert.ok(find(h.card('result'),node=>node.textContent==='Selected crop · frozen preview'));
    if(orientation.method==='unknown'){
      assert.deepEqual(h.ui.getState().orientation,orientation);
      assert.ok(find(h.byClass('gaze-debug-metadata'),node=>node.textContent==='Unknown; no reading rotation'));
    }else{
      assert.equal(h.ui.getState().orientation,null);
      assert.equal(find(h.byClass('gaze-debug-metadata'),node=>node.textContent==='Text orientation'),undefined);
    }
    h.ui.destroy();
  }
});

test('invalid perspective output cannot masquerade as an ordinary selected-crop preview',()=>{
  for(const transform of [{type:'perspective',quad:[]},
    {type:'perspective',quad:[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}],rotationDegrees:181}]){
    const h=fixture();h.update('capture',{frame:image()});
    h.update('result',{crop:{x:.2,y:.2,width:.4,height:.5},transform});
    assert.equal(h.canvas('result').hidden,true);assert.equal(h.ui.getState().transform,null);
    assert.ok(find(h.card('result'),node=>node.textContent==='Perspective preview unavailable'));h.ui.destroy();
  }
});

test('ROI previews, gaze, mask and boxes share original-frame geometry and the final crop is a real subset',()=>{
  const h=fixture(),frame=image(),roi={x:.2,y:.1,width:.5,height:.7};
  h.update('capture',{frame,gaze:{x:.4,y:.5},sourceSize:{width:1200,height:800}});
  const roiFrame=image(600,560);h.update('roi',{roi,frame:roiFrame,frameRegion:roi});
  const mask=image(100,140);
  assert.equal(h.update('model',{operation:'segment',mask:{image:mask,bounds:roi},boxes:[{bbox:{x:.1,y:.1,width:.4,height:.5},label:'book',score:.9}],model:{name:'Actual model',id:'test-model',delegate:'CPU'},confidence:null}),true);
  const modelCanvas=h.canvas('model');assert.equal(modelCanvas.hidden,false);
  const gaze=modelCanvas.context.operations.filter(op=>op.name==='arc').at(-1);
  near(gaze.args[0],192);near(gaze.args[1],256);
  const box=modelCanvas.context.operations.filter(op=>op.name==='strokeRect').at(-1);
  [0,0,288,320].forEach((value,index)=>near(box.args[index],value));
  const maskDraw=modelCanvas.context.operations.findLast(op=>op.name==='drawImage'&&op.alpha===.55);
  assert.ok(maskDraw);assert.notEqual(maskDraw.args[0],mask,'render uses the private mask copy');
  [0,0,100,140,0,0,480,448].forEach((value,index)=>near(maskDraw.args[index+1],value));
  const crop={x:.22,y:.25,width:.3,height:.4};h.update('result',{crop,message:'Pinned book'});
  assert.equal(h.canvas('result').hidden,false);for(const key of ['x','y','width','height'])near(h.ui.getState().crop[key],crop[key]);
  const finalDraw=h.canvas('result').context.operations.filter(op=>op.name==='drawImage').at(-1);
  near(finalDraw.args[1],(.22-.2)/.5*480);near(finalDraw.args[2],(.25-.1)/.7*448);
  near(finalDraw.args[3],.3/.5*480);near(finalDraw.args[4],.4/.7*448);
  assert.equal(h.byClass('gaze-debug-status').textContent,'Pinned book');
  assert.equal(h.byClass('gaze-debug').attributes.get('aria-busy'),'false');
  assert.equal(h.update('model',{message:'late model'}),false,'late stages cannot overwrite a completed attempt');
  assert.equal(mask.closed,0);assert.equal(roiFrame.closed,0);h.ui.destroy();
});

test('clipping preserves mask registration and does not clamp an invalid gaze into the image',()=>{
  const h=fixture();h.update('capture',{frame:image(1000,1000),gaze:{x:1.2,y:.5}});
  h.update('roi',{roi:{x:-.2,y:.2,width:.5,height:.6}});
  const mask=image(200,200);h.update('model',{frameRegion:{x:0,y:.2,width:.3,height:.6},mask:{image:mask,bounds:{x:-.1,y:.2,width:.5,height:.6}},boxes:[{bbox:{x:2,y:0,width:.1,height:.1}},{bbox:{x:NaN,y:0,width:.1,height:.1}}]});
  assert.equal(h.ui.getState().gaze,null);assert.deepEqual(h.ui.getState().boxes,[]);
  assert.deepEqual(h.ui.getState().roi,{x:0,y:.2,width:.3,height:.6000000000000001});
  const operation=h.canvas('model').context.operations.findLast(op=>op.name==='drawImage'&&op.alpha===.55);
  near(operation.args[1],40);near(operation.args[3],120);near(operation.args[5],0);near(operation.args[7],240);
  assert.equal(clipGazeDebugRegion({x:2,y:0,width:.1,height:.1}),null);
  assert.equal(clipGazeDebugRegion({x:0,y:0,width:-1,height:1}),null);
  h.ui.destroy();
});

test('new attempts, source changes, cancellation and Developer disable erase pixels and reject late events',()=>{
  const h=fixture(),frame=image();h.update('capture',{frame});
  const firstCopy=h.canvases.at(-1);h.update('capture',{attemptId:2,frame:image()});
  assert.equal(firstCopy.width,1);assert.equal(h.update('error',{message:'old failure'}),false);
  assert.equal(h.ui.getState().attemptId,2);
  h.ui.setSourceKey('replacement-camera');
  assert.equal(h.ui.getState().stage,'idle');assert.ok(h.canvases.every(canvas=>canvas.width===1&&canvas.height===1));
  assert.equal(h.update('model',{attemptId:2}),false);
  assert.equal(h.update('model',{attemptId:3,sourceKey:'replacement-camera'}),false,'stages cannot start an unbound attempt');
  h.update('capture',{attemptId:3,sourceKey:'replacement-camera',frame:image()});
  h.ui.clear();assert.equal(h.update('model',{attemptId:3,sourceKey:'replacement-camera'}),false);
  assert.equal(h.update('capture',{attemptId:3,sourceKey:'replacement-camera',frame:image()}),false,'cleared attempt IDs cannot revive old pixels');
  h.ui.setEnabled(false);
  assert.equal(h.update('capture',{attemptId:4,sourceKey:'replacement-camera',frame:image()}),false);
  h.ui.setEnabled(true);assert.equal(h.ui.getState().stage,'idle');
  h.update('capture',{attemptId:5,sourceKey:'replacement-camera',frame:image()});
  assert.equal(h.update('cancelled',{attemptId:5,sourceKey:'replacement-camera'}),true);
  assert.equal(h.ui.getState().stage,'idle');assert.equal(h.update('result',{attemptId:5,sourceKey:'replacement-camera',crop:{x:0,y:0,width:1,height:1}}),false);
  h.ui.destroy();assert.equal(h.update('capture',{attemptId:6,sourceKey:'replacement-camera',frame:image()}),false);
});

test('actual model metadata remains truthful through pending, unscored and failed stages',()=>{
  const h=fixture();h.update('capture',{frame:image()});
  h.update('model',{operation:'detect',model:{id:'detector',name:'Object detector',delegate:'GPU'},confidence:.82,scoreKind:'Detection score'});
  assert.match(h.byClass('gaze-debug-detail').textContent,/Detection score 82%/);
  h.update('model',{operation:'segment',model:{id:'segmenter',name:'Point segmenter',delegate:'CPU'},mask:{image:image(80,80),bounds:{x:.1,y:.1,width:.8,height:.8}}});
  assert.equal(h.ui.getState().confidence,null);assert.doesNotMatch(h.byClass('gaze-debug-detail').textContent,/%/);
  assert.match(h.byClass('gaze-debug-detail').textContent,/Point segmenter/);
  h.update('model',{operation:'detect',model:{id:'detector',name:'Object detector',delegate:'GPU'},confidence:2});
  assert.equal(h.ui.getState().confidence,null);assert.match(h.byClass('gaze-debug-detail').textContent,/Object detector/);
  h.update('error',{message:'No unambiguous object was found.'});
  assert.equal(h.canvas('source').hidden,false);assert.equal(h.canvas('result').hidden,true);
  assert.equal(h.byClass('gaze-debug-status').textContent,'No unambiguous object was found.');
  const summary=h.ui.getState();summary.models[0].name='Changed';assert.notEqual(h.ui.getState().models[0].name,'Changed');
  h.ui.destroy();
});

test('model details use the reported runtime delegate and retain it through an unscored final event',()=>{
  const h=fixture(),model={id:'magic-touch-v2-int8',name:'MagicTouch v2'};
  h.update('capture',{frame:image()});h.update('model',{model});
  assert.equal(h.ui.getState().models[0].delegate,'','no delegate is inferred before a result');
  h.update('model',{model:{...model,delegate:'GPU'},delegate:'CPU'});
  assert.equal(h.ui.getState().models[0].delegate,'CPU','actual result overrides earlier model metadata');
  h.update('model',{delegate:'GPU'});
  assert.equal(h.ui.getState().models[0].delegate,'GPU','a delegate-only event updates the current model');
  h.update('model',{model:{id:'other-model',name:'Other model'}});
  assert.equal(h.ui.getState().models.at(-1).delegate,'','a different model cannot inherit a delegate');
  h.update('model',{model,delegate:'CPU'});h.update('model',{model,delegate:42});
  assert.equal(h.ui.getState().models.at(-1).delegate,'CPU','invalid optional metadata cannot erase a real result');
  h.update('result',{model,crop:{x:.2,y:.2,width:.3,height:.4}});
  assert.equal(h.ui.getState().models.at(-1).delegate,'CPU');
  assert.ok(find(h.host,node=>node.tagName==='DD'&&node.textContent==='Other model; MagicTouch v2 · CPU'),
    'the actual delegate appears in the accessible help metadata');
  h.ui.destroy();
});

test('SAM mask IoU and binary pixels are displayed separately from object confidence and survive final metadata',()=>{
  const h=fixture(),qualityScore=.3001441955566406,model={id:'sam2.1-tiny',name:'SAM 2.1 Tiny'};
  h.update('capture',{frame:image()});
  h.update('model',{operation:'segment',model,delegate:'CUDA',qualityScore,qualityScoreKind:'predicted-mask-iou',
    mask:{image:image(80,80),bounds:{x:.1,y:.1,width:.8,height:.8},semantics:'binary'}});
  assert.equal(h.ui.getState().confidence,null);assert.equal(h.ui.getState().qualityScore,qualityScore);
  assert.equal(h.ui.getState().qualityScoreKind,'predicted-mask-iou');assert.equal(h.ui.getState().maskSemantics,'binary');
  assert.match(h.byClass('gaze-debug-detail').textContent,/Mask IoU 0\.300/);
  assert.doesNotMatch(h.byClass('gaze-debug-detail').textContent,/%/);
  assert.ok(find(h.host,node=>node.tagName==='DT'&&node.textContent==='Predicted mask IoU'));
  assert.ok(find(h.host,node=>node.tagName==='DD'&&node.textContent==='0.300'));
  assert.ok(find(h.host,node=>node.tagName==='DD'&&node.textContent==='Binary foreground'));
  assert.ok(find(h.card('model'),node=>node.textContent==='Binary foreground mask'));
  h.update('result',{model,crop:{x:.2,y:.2,width:.3,height:.4}});
  assert.equal(h.ui.getState().qualityScore,qualityScore);assert.equal(h.ui.getState().models[0].delegate,'CUDA');
  h.ui.setEnabled(false);assert.equal(h.ui.getState().qualityScore,null);assert.equal(h.ui.getState().maskSemantics,'');h.ui.destroy();
});

test('only finite explicitly typed mask scores are displayed, and later detector output clears prior mask metadata',()=>{
  const h=fixture();h.update('capture',{frame:image()});
  for(const value of [{qualityScore:NaN,qualityScoreKind:'predicted-mask-iou'},
    {qualityScore:.9,qualityScoreKind:'object-confidence'},{qualityScore:.9}]){
    h.update('model',value);assert.equal(h.ui.getState().qualityScore,null);
    assert.doesNotMatch(h.byClass('gaze-debug-detail').textContent,/Mask IoU/);
  }
  h.update('model',{qualityScore:1.12,qualityScoreKind:'predicted-mask-iou',mask:{image:image(80,80),semantics:'binary'}});
  assert.equal(h.ui.getState().qualityScore,1.12,'preserve an actual model estimate instead of clamping it into confidence');
  assert.match(h.byClass('gaze-debug-detail').textContent,/Mask IoU 1\.120/);
  h.update('model',{operation:'detect',confidence:.82,scoreKind:'Detection score',mask:null});
  assert.equal(h.ui.getState().qualityScore,null);assert.equal(h.ui.getState().qualityScoreKind,'');assert.equal(h.ui.getState().maskSemantics,'');
  assert.match(h.byClass('gaze-debug-detail').textContent,/Detection score 82%/);
  assert.doesNotMatch(h.byClass('gaze-debug-detail').textContent,/Mask IoU/);h.ui.destroy();
});

test('a processed model input and full-frame mask rescue cannot alter original or final preview pixels',()=>{
  const h=fixture(),original=image(),rawRoi=image(600,560),processed=image(600,560),roi={x:.2,y:.1,width:.5,height:.7};
  h.update('capture',{frame:original});h.update('roi',{roi,frame:rawRoi,frameRegion:roi});
  h.update('model',{frame:processed,frameRegion:roi,mask:{image:image(80,80),bounds:roi}});
  const processedCopy=h.canvases.find(canvas=>canvas.context.operations.some(op=>op.name==='drawImage'&&op.args[0]===processed));
  assert.ok(processedCopy);
  assert.equal(h.canvas('source').context.operations.some(op=>op.name==='drawImage'&&op.args[0]===processedCopy),false);
  const full={x:0,y:0,width:1,height:1};h.update('model',{frame:image(),frameRegion:full,mask:{image:image(120,80),bounds:full}});
  assert.equal(h.canvas('model').width,480);assert.equal(h.canvas('model').height,320,'full-frame rescue is displayed outside the old ROI');
  h.update('result',{crop:{x:.22,y:.25,width:.3,height:.4}});
  assert.equal(h.canvas('result').context.operations.some(op=>op.name==='drawImage'&&op.args[0]===processedCopy),false);
  const rawCopy=h.canvases.find(canvas=>canvas.context.operations.some(op=>op.name==='drawImage'&&op.args[0]===rawRoi));
  assert.equal(h.canvas('result').context.operations.filter(op=>op.name==='drawImage').at(-1).args[0],rawCopy);
  h.ui.destroy();
});

test('boxes-only completion preserves the full-frame model input after ROI rescue',()=>{
  const h=fixture(),roi={x:.2,y:.1,width:.5,height:.7},full={x:0,y:0,width:1,height:1};
  h.update('capture',{frame:image(),sourceSize:{width:1200,height:800}});
  h.update('roi',{roi,frame:image(600,560),frameRegion:roi});
  h.update('model',{operation:'detect',frame:image(),frameRegion:full,mask:null,boxes:[]});
  h.update('model',{operation:'detect',boxes:[{bbox:{x:.05,y:.2,width:.15,height:.2},label:'book',score:.8}]});
  const canvas=h.canvas('model');assert.equal(canvas.hidden,false);
  assert.equal(canvas.width,480);assert.equal(canvas.height,320);
  const box=canvas.context.operations.filter(op=>op.name==='strokeRect').at(-1);
  [24,64,72,64].forEach((value,index)=>near(box.args[index],value));
  h.update('result',{crop:{x:.05,y:.2,width:.15,height:.2}});
  assert.equal(h.canvas('model').height,320,'result retains the model input view');
  h.ui.destroy();
});

test('repeated previews retain only bounded thumbnails and sanitize malformed optional input',()=>{
  const h=fixture();
  for(let attemptId=1;attemptId<=12;attemptId++){
    h.update('capture',{attemptId,frame:image(6000,4000),gaze:{x:.5,y:.5}});
    h.update('roi',{attemptId,roi:{x:.1,y:.1,width:.8,height:.8},frame:image(4000,3000),frameRegion:{x:.1,y:.1,width:.8,height:.8}});
    h.update('model',{attemptId,mask:{image:image(4000,3000)},boxes:Array.from({length:100},()=>({bbox:{x:.2,y:.2,width:.1,height:.1},score:NaN,label:'\u0000book'}))});
    h.update('result',{attemptId,crop:{x:.2,y:.2,width:.2,height:.2}});
    const retained=h.canvases.filter(canvas=>canvas.width>1||canvas.height>1);
    assert.ok(retained.length<=8);assert.ok(retained.every(canvas=>canvas.width<=480&&canvas.height<=480));
    assert.equal(h.ui.getState().boxes.length,32);assert.equal(h.ui.getState().boxes[0].label,'book');assert.equal(h.ui.getState().boxes[0].score,null);
  }
  h.ui.destroy();assert.ok(h.canvases.every(canvas=>canvas.width===1&&canvas.height===1));
});

test('four accepted page corners draw the actual polygon and four vertex markers in model-image coordinates',()=>{
  const h=fixture(),quad=[{x:.75,y:.8},{x:.2,y:.75},{x:.25,y:.2},{x:.7,y:.25}];
  h.update('capture',{frame:image(1200,800)});
  h.update('model',{operation:'detect',frame:image(1200,800),frameRegion:{x:0,y:0,width:1,height:1},
    boxes:[{bbox:{x:.2,y:.2,width:.55,height:.6},label:'Notebook'}],quad,
    documentKind:'notebook',cornerRefinement:{method:'edge-refined',verifiedEdges:4,rawResponse:'discard'}});
  const canvas=h.canvas('model'),operations=canvas.context.operations;
  assert.equal(canvas.hidden,false);assert.equal(canvas.width,480);assert.equal(canvas.height,320);
  const moves=operations.filter(op=>op.name==='moveTo'),lines=operations.filter(op=>op.name==='lineTo'),markers=operations.filter(op=>op.name==='arc');
  assert.equal(moves.length,1);assert.equal(lines.length,3);assert.equal(markers.length,4);
  assert.ok(operations.some(op=>op.name==='closePath'));assert.equal(canvas.context.strokeStyle,'#d8c0ff');
  for(let index=0;index<4;index++){
    const path=index?lines[index-1]:moves[0];
    near(path.args[0],quad[index].x*480);near(path.args[1],quad[index].y*320);
    near(markers[index].args[0],path.args[0]);near(markers[index].args[1],path.args[1]);
  }
  assert.ok(find(h.card('model'),node=>node.textContent==='Four corners · image edges verified'));
  assert.deepEqual(h.ui.getState().cornerQuad,quad);
  const copy=h.ui.getState();copy.cornerQuad[0].x=0;copy.cornerRefinement.verifiedEdges=0;quad[0].x=.1;
  assert.equal(h.ui.getState().cornerQuad[0].x,.75);assert.equal(h.ui.getState().cornerRefinement.verifiedEdges,4);
  assert.deepEqual(h.ui.getState().cornerRefinement,{method:'edge-refined',verifiedEdges:4});h.ui.destroy();
});

test('illustration-upright scan preview enhances rectified frozen camera pixels and releases its temporary filter canvas',()=>{
  const enhanced=[],calls=[];
  const h=fixture({enhanceFrame(frame,{createCanvas}){
    calls.push({frame,width:frame.width,height:frame.height,draws:frame.context.operations.filter(op=>op.name==='drawImage').slice()});
    const output=createCanvas();output.width=frame.width;output.height=frame.height;
    output.getContext('2d').drawImage(frame,0,0);enhanced.push(output);return output;
  }});
  const original=image(512,640),processed=image(400,400);
  const quad=[{x:.8,y:.9},{x:.2,y:.9},{x:.2,y:.1},{x:.8,y:.1}],transform={type:'perspective',quad};
  const orientation={status:'illustration-upright',method:'page-corners',clockwiseDegrees:180};
  h.update('capture',{frame:original,sourceSize:{width:512,height:640}});
  const originalCopy=h.canvases.find(canvas=>canvas.context.operations.some(op=>op.name==='drawImage'&&op.args[0]===original));
  h.update('model',{frame:processed,operation:'detect',documentKind:'paper',orientation:{...orientation,privateText:'discard'},
    quad,cornerRefinement:{method:'model-corners',verifiedEdges:2,privateImage:'discard'}});
  assert.equal(calls.length,0,'filtering waits for a selected crop');
  h.update('result',{crop:{x:.1,y:.05,width:.8,height:.9},transform,scanEnhanced:true});
  const output=h.canvas('result');assert.equal(output.hidden,false);assert.equal(calls.length,1);
  assert.equal(calls[0].frame,output);assert.equal(calls[0].width,230);assert.equal(calls[0].height,384);
  assert.equal(calls[0].draws.length,2);assert.ok(calls[0].draws.every(op=>op.args[0]===originalCopy));
  assert.equal(output.context.operations.filter(op=>op.name==='drawImage').at(-1).args[0],enhanced[0]);
  assert.equal(enhanced[0].width,1);assert.equal(enhanced[0].height,1,'the enhancement buffer is released after compositing');
  assert.ok(find(h.card('result'),node=>node.textContent==='Upright crop · scan filter'));
  assert.ok(find(h.byClass('gaze-debug-metadata'),node=>node.textContent==='Illustration'));
  assert.ok(find(h.byClass('gaze-debug-metadata'),node=>node.textContent==='On · original pixels retained'));
  assert.deepEqual(h.ui.getState().orientation,orientation);assert.equal(h.ui.getState().documentKind,'paper');
  assert.deepEqual(h.ui.getState().cornerRefinement,{method:'model-corners',verifiedEdges:2});
  assert.equal(h.ui.getState().scanEnhanced,true);h.ui.destroy();
});

test('debug scan enhancement requires an explicit paper or notebook classification and exact true preference',()=>{
  for(const [documentKind,scanEnhanced,expected] of [['paper',true,true],['notebook',true,true],['paper',false,false],
    ['paper','true',false],['book',true,false],['phone',true,false],[undefined,true,false],[{kind:'paper'},true,false]]){
    let calls=0;const h=fixture({enhanceFrame(frame,{createCanvas}){calls++;const output=createCanvas();output.width=frame.width;output.height=frame.height;return output;}});
    h.update('capture',{frame:image()});
    h.update('result',{crop:{x:.2,y:.2,width:.4,height:.5},documentKind,scanEnhanced,
      cornerRefinement:{method:'edge-refined',verifiedEdges:3,rawResponse:'discard'}});
    const state=h.ui.getState();assert.equal(calls,expected?1:0);assert.equal(state.scanEnhanced,expected);
    assert.equal(state.documentKind,['paper','notebook'].includes(documentKind)?documentKind:null);
    assert.equal(state.cornerRefinement,null);assert.equal(h.canvas('result').hidden,false);h.ui.destroy();
  }
});

test('a failed scan preview keeps its real rectified image visible and labels the unavailable filter honestly',()=>{
  let calls=0;const h=fixture({enhanceFrame(){calls++;throw new Error('Readback unavailable');}});
  const original=image(512,640),transform={type:'perspective',quad:[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}]};
  h.update('capture',{frame:original,sourceSize:{width:512,height:640}});
  const originalCopy=h.canvases.find(canvas=>canvas.context.operations.some(op=>op.name==='drawImage'&&op.args[0]===original));
  h.update('result',{crop:{x:.1,y:.05,width:.8,height:.9},transform,documentKind:'notebook',scanEnhanced:true});
  assert.equal(calls,1);const output=h.canvas('result');assert.equal(output.hidden,false);
  const draws=output.context.operations.filter(op=>op.name==='drawImage');assert.equal(draws.length,2);
  assert.ok(draws.every(op=>op.args[0]===originalCopy));
  assert.ok(find(h.card('result'),node=>node.textContent==='Straightened crop · frozen preview · filter preview unavailable'));
  assert.equal(find(h.card('result'),node=>node.textContent==='Straightened crop · scan filter'),undefined);
  assert.equal(h.ui.getState().stage,'result');h.ui.destroy();
});
