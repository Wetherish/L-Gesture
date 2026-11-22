import test from 'node:test';
import assert from 'node:assert/strict';
import {createPinchHistory,fingertipPlotAxes,projectFingertip,setupHandGraphs} from '../dist/hand-graphs.js';

const pinch=(px=120,cm=3)=>({status:'ok',distancePx:px,distanceWorldCm:cm,distanceNormalized:0.1});

test('history deduplicates repeated frames without turning frozen data into a live series',()=>{
  const history=createPinchHistory();
  assert.equal(history.push(0,pinch(),{sourceId:'camera-a',frameKey:10}),true);
  assert.equal(history.push(3000,pinch(400),{sourceId:'camera-a',frameKey:10}),false);
  assert.deepEqual(history.values(3000),[{time:0,px:120,cm:3,normalized:0.1}]);
  history.push(3100,pinch(130),{sourceId:'camera-a',frameKey:11});
  assert.deepEqual(history.values().map(sample=>sample.px),[120,null,130]);
});

test('uncertain, ambiguous and explicitly missing right hands create gaps rather than zeroes',()=>{
  const history=createPinchHistory();
  history.push(0,pinch(),{frameKey:1});
  history.push(10,{...pinch(),status:'low-confidence'},{frameKey:2});
  history.push(20,{...pinch(),status:'ambiguous'},{frameKey:3});
  history.push(100,pinch(140),{frameKey:4});
  history.missing(110);history.missing(120);
  assert.deepEqual(history.values().map(sample=>sample.px),[120,null,140,null]);
  assert.ok(history.values().filter(sample=>sample.px===null).every(sample=>sample.cm===null&&sample.normalized===null));
});

test('a missing world estimate is preserved through throttling while valid pixel data continues',()=>{
  const history=createPinchHistory();
  history.push(0,pinch(),{frameKey:1});
  history.push(5,pinch(125,null),{frameKey:2});
  history.push(10,pinch(130,4),{frameKey:3});
  assert.deepEqual(history.values().map(sample=>sample.cm),[3,null,4]);
  assert.deepEqual(history.values().map(sample=>sample.px),[120,125,130]);
});

test('source changes, reset and a backwards host clock cannot join unrelated timelines',()=>{
  const history=createPinchHistory();
  history.push(1000,pinch(),{sourceId:'a',frameKey:1});
  history.push(2000,pinch(300),{sourceId:'b',frameKey:1});
  assert.equal(history.sourceId,'b');assert.deepEqual(history.values().map(sample=>sample.px),[300]);
  history.push(50,pinch(30),{sourceId:'b',frameKey:2});
  assert.deepEqual(history.values().map(sample=>sample.px),[30]);
  history.clear();assert.equal(history.size,0);assert.equal(history.sourceId,null);
});

test('history stays bounded under a long fast stream and expires after its rolling window',()=>{
  const history=createPinchHistory({maxSamples:320});
  for(let frame=0;frame<30_000;frame++)history.push(frame*10,pinch(frame%300,frame%2?null:4),{frameKey:frame});
  const values=history.values(299_990);
  assert.ok(values.length<=320);assert.ok(values.filter(sample=>sample.time<279_990).length<=1);
  assert.ok(values.every(sample=>Number.isFinite(sample.time)));
  assert.equal(history.values(320_001).length,0);
});

test('ordinary measurements are sampled at no more than 15 fps',()=>{
  const history=createPinchHistory();
  for(let frame=0;frame<1000;frame++)history.push(frame,pinch(frame),{frameKey:frame});
  assert.ok(history.size<=15);
});

test('mirroring changes only screen placement and preserves out-of-frame source coordinates',()=>{
  const point={x:0.2,y:0.7,z:-0.12},rect={x:10,y:20,width:400,height:200};
  assert.deepEqual(projectFingertip(point,rect),{x:90,y:160});
  assert.deepEqual(projectFingertip(point,rect,true),{x:330,y:160});
  assert.deepEqual(point,{x:0.2,y:0.7,z:-0.12});
  assert.deepEqual(projectFingertip({x:1.1,y:-0.1},rect),{x:450.00000000000006,y:0});
  assert.equal(projectFingertip({x:null,y:0.2},rect),null);
});

test('portrait sources fill a wide compact scatter plot and tick density follows available space',()=>{
  const wide=fingertipPlotAxes(640,145,{sourceWidth:640,sourceHeight:960});
  assert.ok(wide.rect.width>570);assert.equal(wide.rect.height,96);
  assert.deepEqual(wide.xTicks.map(tick=>tick.label),['0','160','320','480','640']);
  assert.deepEqual(wide.yTicks.map(tick=>tick.label),['0','480','960']);
  const narrow=fingertipPlotAxes(220,145,{sourceWidth:640,sourceHeight:960});
  assert.ok(narrow.xTicks.length<wide.xTicks.length);
  const mirrored=fingertipPlotAxes(640,145,{sourceWidth:640,sourceHeight:960,mirror:true});
  assert.deepEqual(mirrored.rect,wide.rect);
  assert.deepEqual(mirrored.xTicks.map(tick=>tick.label),['640','480','320','160','0']);
  assert.deepEqual(mirrored.yTicks,wide.yTicks);
});

// A minimal event/DOM fixture exercises the controller's clocks, current
// readings and cleanup without introducing a browser test dependency.
class Element extends EventTarget {
  constructor(tag,doc){super();this.tagName=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.attributes=new Map();this.textContent='';this.className='';this.style={setProperty(){}};this.classList={toggle(){}};}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
  insertBefore(node,before){node.remove();node.parentNode=this;const index=before?this.children.indexOf(before):-1;if(index<0)this.children.push(node);else this.children.splice(index,0,node);}
  remove(){if(this.parentNode){const siblings=this.parentNode.children;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}}
  getBoundingClientRect(){return this.ownerDocument.bounds;}
  getContext(){this.ownerDocument.canvasReads++;return this.ownerDocument.canvasContext;}
}
function fixture({width=440,height=240,canvasContext=null}={}){
  const env=new EventTarget(),doc=new EventTarget(),pending=new Map();let now=0,id=0;
  env.devicePixelRatio=1;
  env.setTimeout=(callback,delay=0)=>{const key=++id;pending.set(key,{callback,at:now+delay});return key;};
  env.clearTimeout=key=>pending.delete(key);
  env.requestAnimationFrame=callback=>env.setTimeout(callback,1);env.cancelAnimationFrame=env.clearTimeout;
  Object.assign(doc,{defaultView:env,hidden:false,canvasReads:0,bounds:{left:0,top:0,width,height},canvasContext,createElement:tag=>new Element(tag,doc)});
  const host=new Element('div',doc),controller=setupHandGraphs({host,clock:()=>now});
  const all=(root=host)=>root.children.flatMap(child=>[child,...all(child)]);
  return {controller,doc,host,pending,all,
    find:className=>all().find(node=>node.className.split(' ').includes(className)),
    advance(milliseconds){const target=now+milliseconds;let count=0;while(true){const next=[...pending.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>target)break;assert.ok(count++<20_000,'draw loop must remain bounded');pending.delete(next[0]);now=next[1].at;next[1].callback(now);}now=target;},
  };
}
function frame(timestampMs,sides=['Left','Right']){
  return {timestampMs,width:1280,height:720,hands:sides.map(handedness=>({handedness,confidence:0.95,
    points:Array.from({length:21},(_,index)=>({index,x:0.1+index*0.02,y:0.2+index*0.01,z:-index*0.001}))}))};
}

test('the controller renders ten real fingertip selectors and accurate source coordinates',()=>{
  const f=fixture();f.controller.update(frame(1),{sourceId:'a'});assert.equal(f.controller.getState().points,0);
  f.controller.setEnabled(true);f.controller.update(frame(1),{sourceId:'a',mirror:true});f.advance(5);
  assert.equal(f.controller.getState().points,10);
  assert.equal(f.all().filter(node=>node.className==='hg-finger').length,10);
  assert.equal(f.find('hg-selected-name').textContent,'Right · Index');
  assert.deepEqual(f.all(f.find('hg-coordinates')).filter(node=>node.tagName==='dd').map(node=>node.textContent),['332.8','201.6','0.260 / 0.280','-0.008']);
  const thumb=f.all().find(node=>node.attributes.get('aria-label')==='Left thumb fingertip');
  thumb.dispatchEvent(new Event('focus'));f.advance(100);
  assert.equal(f.find('hg-selected-name').textContent,'Left · Thumb');
  f.controller.destroy();assert.equal(f.host.children.length,0);assert.equal(f.pending.size,0);
});

test('portrait plot pointer selection follows the full-width mirrored projection without changing source values',()=>{
  const ctx=Object.fromEntries(['setTransform','clearRect','beginPath','moveTo','lineTo','stroke','fill','fillText','save','restore','rect','clip','arc'].map(name=>[name,()=>{}]));
  ctx.measureText=label=>({width:String(label).length*6.7});
  const f=fixture({width:640,height:145,canvasContext:ctx}),input=frame(1,['Left']);input.width=640;input.height=960;
  input.hands[0].points[20].x=0.82;
  f.controller.setEnabled(true);f.controller.update(input,{sourceId:'portrait'});f.advance(5);
  const canvas=f.find('hg-position'),pinky=input.hands[0].points[20];
  function select(mirror){
    const {rect}=fingertipPlotAxes(640,145,{sourceWidth:640,sourceHeight:960,mirror});
    const point=projectFingertip(pinky,rect,mirror),event=new Event('click');
    Object.assign(event,{clientX:point.x,clientY:point.y});canvas.dispatchEvent(event);f.advance(100);
    assert.equal(f.find('hg-selected-name').textContent,'Left · Pinky');
    assert.deepEqual(f.all(f.find('hg-coordinates')).filter(node=>node.tagName==='dd').map(node=>node.textContent),['524.8','384.0','0.820 / 0.400','-0.020']);
  }
  select(false);
  const thumb=f.all().find(node=>node.attributes.get('aria-label')==='Left thumb fingertip');thumb.dispatchEvent(new Event('focus'));
  input.timestampMs=2;f.controller.update(input,{sourceId:'portrait',mirror:true});f.advance(100);select(true);
  f.controller.destroy();
});

test('frozen frames expire despite repeated update calls and resume only with fresh data',()=>{
  const f=fixture();f.controller.setEnabled(true);f.controller.update(frame(1),{sourceId:'a'});f.advance(1000);
  f.controller.update(frame(1),{sourceId:'a'});f.advance(1300);
  assert.equal(f.controller.getState().lastFreshAt,0);assert.equal(f.controller.getState().points,0);
  assert.equal(f.find('hg-distance').textContent,'—');
  f.controller.update(frame(2),{sourceId:'a'});f.advance(100);assert.equal(f.controller.getState().points,10);
  f.controller.update(null,{sourceId:'a',active:false});f.advance(100);assert.equal(f.controller.getState().points,0);
  assert.ok(f.controller.getState().historySamples>=3);
  f.controller.update(frame(3,['Left']),{sourceId:'b'});f.advance(100);
  assert.equal(f.controller.getState().sourceId,'b');assert.equal(f.controller.getState().historySamples,1);
  assert.equal(f.find('hg-pinch-state').textContent,'Waiting for right hand');assert.equal(f.find('hg-distance').textContent,'—');
  f.controller.destroy();
});

test('hidden and disabled graphs stop drawing; returning clears stale readings',()=>{
  const f=fixture();f.controller.setEnabled(true);f.controller.update(frame(1),{sourceId:'a'});f.advance(100);
  const reads=f.doc.canvasReads;f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));f.advance(3000);
  assert.equal(f.doc.canvasReads,reads);assert.equal(f.pending.size,0);
  f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));f.advance(100);
  assert.equal(f.controller.getState().points,0);assert.ok(f.doc.canvasReads>reads);
  f.controller.setEnabled(false);assert.equal(f.controller.getState().historySamples,0);assert.equal(f.pending.size,0);
  f.controller.destroy();
});
