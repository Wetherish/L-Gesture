import test from 'node:test';
import assert from 'node:assert/strict';
import {setupScenePinUI} from '../dist/scene-pin-ui.js';

// The same small EventTarget/tree pattern used by screen-capture and photo
// tests. The real dialog, listeners, sample collection and timers run unchanged.
class Element extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName=tag.toUpperCase(); this.ownerDocument=document;
    this.children=[]; this.attributes={}; this.dataset={}; this.style={};
    this.className=''; this.textContent=''; this.hidden=false; this.disabled=false;
    this.classList={add:name=>{this.className+=' '+name;}};
    if(this.tagName==='DIALOG'){
      this.showModal=()=>{this.open=true;};
      this.close=()=>{this.open=false;this.dispatchEvent(new Event('close'));};
    }
  }
  append(...nodes) {for (const node of nodes) {node.remove(); node.parentNode=this; this.children.push(node);}}
  replaceChildren(...nodes) {for (const node of [...this.children]) node.remove(); this.append(...nodes);}
  remove() {if (this.parentNode) {this.parentNode.children=this.parentNode.children.filter(node=>node!==this); this.parentNode=null;}}
  setAttribute(key,value) {this.attributes[key]=String(value);}
  removeAttribute(key) {delete this.attributes[key];}
  get isConnected() {return this===this.ownerDocument.body || !!this.parentNode?.isConnected;}
  focus() {this.ownerDocument.activeElement=this;}
  click() {if (!this.disabled) this.dispatchEvent(new Event('click'));}
  getContext() {return this.ownerDocument.context;}
}
const find=(root,predicate)=>predicate(root)?root:root.children.map(node=>find(node,predicate)).find(Boolean);
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

function fixture(t, overrides = {}) {
  let clock=1000, timerId=0, selectedGaze={sourceId:'rgb-camera',generation:4,kind:'main'};
  const timers=new Map(), original=new Map(), changes=[], frames=[], events={closed:0,pinned:0};
  const replace=(name,value)=>{
    original.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,value});
  };
  const schedule=(callback,delay=0,repeat=false)=>{
    const id=++timerId;timers.set(id,{callback,at:clock+delay,interval:repeat?delay:null});return id;
  };
  const document={visibilityState:'visible',context:{drawImage(){},save(){},restore(){},beginPath(){},arc(){},stroke(){},moveTo(){},lineTo(){},fill(){}}};
  document.createElement=tag=>new Element(tag,document);
  document.createElementNS=(_,tag)=>document.createElement(tag);
  document.body=document.createElement('body'); document.activeElement=document.body;
  replace('document',document); replace('performance',{now:()=>clock});
  replace('setTimeout',(callback,delay)=>schedule(callback,delay));
  replace('setInterval',(callback,delay)=>schedule(callback,delay,true));
  replace('clearTimeout',id=>timers.delete(id)); replace('clearInterval',id=>timers.delete(id));
  const scene={sourceId:'cpd-camera',generation:9,width:512,height:640,kind:'scene',label:'Scene camera',
    isActive:()=>true,capture(){const frame=document.createElement('canvas');frame.width=512;frame.height=640;frames.push(frame);return frame;}};
  const controller=setupScenePinUI({
    getSource:()=>scene,getGazeSource:()=>selectedGaze,
    getChoices:()=>[{value:'scene',label:'Scene camera'}],getSelected:()=> 'scene',
    onChoose(){},onRefresh(){},getCalibration:()=>null,
    getSignal:()=>({type:'scene-gaze-feature',live:true,sourceId:selectedGaze.sourceId,generation:selectedGaze.generation,
      method:'logitech-screen-geometric',inputSignature:'screen:1920x1080:camera:1280x720',
      timestampMs:Math.floor(clock/50)*50,observedAtMs:Math.floor(clock/50)*50,feature:{x:.15,y:.15}}),
    onCalibration:value=>changes.push(value),onPin:()=>events.pinned++,onClose:()=>events.closed++, ...overrides,
  });
  t.after(()=>{
    controller.destroy(); timers.clear();
    for(const [name,descriptor] of original) {
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  });
  async function advance(milliseconds) {
    const until=clock+milliseconds;let count=0;
    await flush();
    while(true) {
      const next=[...timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next||next[1].at>until)break;
      assert.ok(++count<1000,'dialog timers must remain bounded');
      const [id,timer]=next;clock=timer.at;
      if(timer.interval===null)timers.delete(id);else timer.at+=timer.interval;
      timer.callback();await flush();
    }
    clock=until;await flush();
  }
  const byClass=name=>find(document.body,node=>node.className.split(' ').includes(name));
  const button=label=>find(document.body,node=>node.tagName==='BUTTON'&&node.attributes['aria-label']===label);
  async function begin() {
    assert.equal(controller.open(),true);button('Calibrate gaze').click();await advance(0);
    assert.equal(byClass('scene-pin-status').textContent,'Point 1 of 5');
    assert.equal(byClass('scene-pin-steps').hidden,false);
    assert.deepEqual(changes,[null],'starting clears the old fit but saves no new one');
  }
  return {controller,scene,changes,events,frames,timers,advance,begin,button,byClass,
    setGaze:change=>{selectedGaze={...selectedGaze,...change};}};
}

for (const [name,change] of [['camera identity',{sourceId:'other-rgb-camera'}],['camera session',{generation:5}]]) {
  test(`changing only the gaze ${name} after the first target invalidates the actual dialog calibration`,async t=>{
    const h=fixture(t), originalScene={...h.scene};await h.begin();
    h.button('Record this calibration point').click();await h.advance(450);
    assert.equal(h.byClass('scene-pin-status').textContent,'Point 2 of 5');
    assert.equal(h.byClass('scene-pin-steps').children[0].dataset.state,'done','a real first target was recorded');
    h.setGaze(change);await h.advance(200);
    assert.deepEqual(h.scene,originalScene,'the crop source and session remain unchanged');
    assert.equal(h.byClass('scene-pin-steps').hidden,true,'the active calibration is discarded between targets');
    assert.ok(h.button('Retry calibration'),'the old session cannot continue recording');
    assert.match(h.byClass('scene-pin-status').textContent,/Camera changed/);
    assert.equal(h.button('Record this calibration point').hidden,true);
    await h.advance(1000);
    assert.deepEqual(h.changes,[null],'the invalidated session never saves an accepted calibration');
    assert.equal(h.events.pinned,0);
  });
}

test('closing the calibration dialog during sampling cancels timers and prevents later callbacks',async t=>{
  const h=fixture(t);await h.begin();
  h.button('Record this calibration point').click();await h.advance(100);
  assert.equal(h.byClass('scene-pin-progress').hidden,false,'sampling is actually running');
  const detachedStatus=h.byClass('scene-pin-status');
  h.button('Close scene camera settings').click();
  assert.equal(h.controller.isOpen(),false);assert.equal(h.events.closed,1);
  const statusAtClose=detachedStatus.textContent,frameCount=h.frames.length;
  await h.advance(1000);
  assert.equal(h.timers.size,0,'no sample or preview work survives closing');
  assert.deepEqual(h.changes,[null]);assert.equal(h.events.pinned,0);assert.equal(h.events.closed,1);
  assert.equal(detachedStatus.textContent,statusAtClose,'a late sample cannot update the closed dialog');
  assert.equal(h.frames.length,frameCount);assert.ok(h.frames.every(frame=>frame.width===1&&frame.height===1),'borrowed preview frames are released');
});

function modelOptions() {
  return [{value:'auto',label:'Automatic',available:true},{value:'browser',label:'Browser · MagicTouch v2',available:true},
    {value:'sam2.1-large',label:'GPU · SAM 2.1 Large',available:false,reason:'Install this model.'}];
}

test('eye model controls do not probe on opening and choosing a model preserves calibration state', async t => {
  let selection='auto',checks=0; const choices=[];
  const h=fixture(t,{getGazeModelState:()=>({selection,local:{checked:false,status:'unchecked'},model:{name:'MagicTouch v2'}}),
    getGazeModelOptions:modelOptions,onCheckGPU:()=>checks++,onGazeModelChange:value=>{selection=value;choices.push(value);}});
  h.controller.open();await h.advance(200);
  const select=h.byClass('scene-pin-models').children[0].children[0].children.find(node=>node.tagName==='SELECT');
  assert.equal(select.value,'auto');assert.equal(checks,0);assert.equal(select.children.length,3);
  assert.match(select.children.at(-1).textContent,/needs setup/);
  select.value='sam2.1-large';select.dispatchEvent(new Event('change'));await h.advance(0);
  assert.deepEqual(choices,['sam2.1-large']);assert.deepEqual(h.changes,[],'model changes never reset the camera gaze calibration');
  assert.equal(select.value,'sam2.1-large');assert.equal(checks,0);
  h.button('Check local GPU').click();await h.advance(0);assert.equal(checks,1);
});

test('model selection and GPU checks stay disabled while recording gaze calibration', async t => {
  let modelChanges=0,checks=0;
  const h=fixture(t,{getGazeModelState:()=>({selection:'auto',local:{status:'unchecked'}}),getGazeModelOptions:modelOptions,
    onGazeModelChange:()=>modelChanges++,onCheckGPU:()=>checks++});
  await h.begin();
  const select=h.byClass('scene-pin-models').children[0].children[0].children.find(node=>node.tagName==='SELECT');
  assert.equal(select.disabled,true);assert.equal(h.button('Check local GPU').disabled,true);
  select.dispatchEvent(new Event('change'));h.button('Check local GPU').click();await h.advance(0);
  assert.equal(modelChanges,0);assert.equal(checks,0);assert.deepEqual(h.changes,[null]);
});

test('closing the eye dialog aborts an in-progress GPU check and rejects its late UI update', async t => {
  let complete,requestContext,accepted=0; const wait=new Promise(resolve=>{complete=resolve;});
  const h=fixture(t,{getGazeModelState:()=>({selection:'auto',local:{status:'unchecked'}}),getGazeModelOptions:modelOptions,
    onGazeModelChange(){},onCheckGPU:async context=>{requestContext=context;await wait;if(context.isCurrent())accepted++;}});
  h.controller.open();h.button('Check local GPU').click();await h.advance(0);
  assert.ok(requestContext);const statusNode=h.byClass('scene-pin-model-status');
  h.button('Close scene camera settings').click();assert.equal(requestContext.signal.aborted,true);
  const previous=statusNode.textContent;complete();await h.advance(300);
  assert.equal(accepted,0);assert.equal(statusNode.textContent,previous);assert.equal(h.controller.isOpen(),false);
});

test('an unavailable explicit model shows a model error instead of a calibration error', async t => {
  const h=fixture(t,{getGazeModelState:()=>({selection:'sam2.1-large',local:{status:'unavailable',checked:true,message:'Start the local GPU service.'}}),
    getGazeModelOptions:modelOptions,onGazeModelChange:()=>{throw new Error('SAM 2.1 Large is not installed.');},onCheckGPU(){}});
  h.controller.open();const select=h.byClass('scene-pin-models').children[0].children[0].children.find(node=>node.tagName==='SELECT');
  select.value='sam2.1-large';select.dispatchEvent(new Event('change'));await h.advance(0);
  assert.equal(h.byClass('scene-pin-status').textContent,'Gaze model unavailable');
  assert.match(h.byClass('scene-pin-status').title,/not installed/);assert.deepEqual(h.changes,[]);
});

test('automatic gaze aim is the default and switching modes does not discard a saved fit', async t => {
  let mode='auto';const modes=[];
  const h=fixture(t,{getGazeMode:()=>mode,onGazeModeChange:value=>{modes.push(value);mode=value;}});
  h.controller.open();await h.advance(0);
  const select=h.byClass('scene-pin-aim').children.find(node=>node.tagName==='SELECT');
  assert.equal(select.value,'auto');assert.match(select.children[0].textContent,/seated estimate/);
  select.value='calibrated';select.dispatchEvent(new Event('change'));await h.advance(0);
  assert.deepEqual(modes,['calibrated']);assert.deepEqual(h.changes,[]);
  assert.equal(select.value,'calibrated');assert.equal(h.byClass('scene-pin-status').textContent,'Eyes ready · calibrate gaze');
  h.button('Calibrate gaze').click();await h.advance(0);assert.equal(select.disabled,true);
  select.value='auto';select.dispatchEvent(new Event('change'));await h.advance(0);assert.deepEqual(modes,['calibrated']);
});

test('eye-menu OpenAI key requires an explicit click, clears the field, and can be forgotten', async t => {
  const changes=[];let configured=false,model='gpt-6.2-sol';
  const h=fixture(t,{getOpenAIState:()=>({configured,model,status:configured?'ready':'unconfigured'}),
    getOpenAIOptions:()=>[{value:'gpt-6.2-sol',label:'GPT-6.2 Sol'},{value:'gpt-6.2-astra',label:'GPT-6.2 Astra'}],
    onOpenAIChange:value=>{changes.push(value);if(value.key!==undefined)configured=!!value.key;if(value.model)model=value.model;}});
  h.controller.open();await h.advance(0);
  const key=h.byClass('scene-pin-key'),use=h.button('Use OpenAI key'),forget=h.button('Forget OpenAI key');
  assert.equal(key.type,'password');assert.equal(key.autocomplete,'off');assert.equal(use.disabled,true);
  key.value='sk-test-key-used-only-in-this-test';key.dispatchEvent(new Event('input'));await h.advance(0);
  assert.equal(changes.length,0);assert.equal(use.disabled,false);
  use.click();await h.advance(0);
  assert.equal(changes[0].key,'sk-test-key-used-only-in-this-test');assert.equal(key.value,'');
  assert.equal(forget.hidden,false);assert.deepEqual(h.changes,[],'API settings do not change calibration');
  const section=h.byClass('scene-pin-openai');
  const select=section.children[0].children.find(node=>node.tagName==='SELECT');
  select.value='gpt-6.2-astra';select.dispatchEvent(new Event('change'));await h.advance(0);
  assert.deepEqual(changes[1],{model:'gpt-6.2-astra'});
  forget.click();await h.advance(0);assert.deepEqual(changes[2],{key:''});assert.equal(forget.hidden,true);
  key.value='sk-unsaved-key-used-only-in-this-test';h.button('Close scene camera settings').click();
  assert.equal(key.value,'','closing clears an unsaved credential from the detached input');assert.equal(changes.length,3);
});
