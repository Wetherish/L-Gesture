import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {isCapturePending,captureOutcomeFeedback,gestureIndicatorState} from '../dist/capture-gesture-feedback.js';
import {DEFAULT_PIN_HOLD_MS} from '../dist/pin-gesture.js';

const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const start=app.indexOf('function updateCaptureGesture(){'),end=app.indexOf('function showCallHelp(',start);
assert.ok(start>=0&&end>start,'exercise the actual application gesture feedback routing');
const updateSource=app.slice(start,end)+'\nupdateCaptureGesture;';

function feedbackHarness({phase='latched',actionState='pinned',busy=false}={}){
  const source={sourceId:'rgb',label:'RGB',isActive:()=>true},frame={source:'Browser inference'};
  const pin={kind:'pin',phase,holding:true,progress:phase==='latched'?1:.4,triggered:false};
  const state={view:'call',probing:false,telemetry:new Map(),captureGesture:{kind:'pin',phase:'latched',holding:true,
    actionState,message:`Result: ${actionState}`,completed:2,pinched:false}};
  const calls={cleared:0,pinInputs:[]};
  const context={state,performance:{now:()=>1000},trackingSource:()=>source,objectCaptureSource:()=>source,gazeCaptureSource:()=>source,
    cameraRoleContextKey:()=> 'roles',cameraActionKey:()=> 'roles',browserTracking:{getState:()=>({status:'running'})},
    document:{hidden:false,querySelector:()=>null},captureBoard:{isBusy:()=>false},sourceOverlayFrames:()=>[],
    selectGestureInput:()=>({frame,sourceId:source.sourceId}),gestureActionSource:'roles',objectWarmSource:'roles',gestureResultTimer:1,
    gestureDetector:{update:()=>({phase:'idle',completed:0,pinched:false,triggered:false})},
    pinGestureDetector:{update:(_frame,options)=>{calls.pinInputs.push(options);return pin;}},
    scenePins:{isBusy:()=>busy},objectCapture:{isBusy:()=>false},
    clearGestureFeedback(){calls.cleared++;state.captureGesture={...state.captureGesture,actionState:'idle',message:''};},
    dismissCaptureGesture(){assert.fail('a stable visible source must not dismiss the capture');},
  };
  return {state,pin,calls,update:vm.runInNewContext(updateSource,context)};
}

test('holding the fired pin pose cannot erase success or failure feedback on the next UI frame',()=>{
  for(const actionState of ['pinned','saved','not-found','error']){
    const h=feedbackHarness({actionState});h.update();h.update();
    assert.equal(h.calls.cleared,0,actionState);assert.equal(h.state.captureGesture.actionState,actionState);
    assert.equal(h.state.captureGesture.message,`Result: ${actionState}`);
  }
});

test('a fresh 1.5-second hold can replace old capture feedback with its own progress',()=>{
  const h=feedbackHarness({phase:'holding',actionState:'error'});h.update();
  assert.equal(h.calls.cleared,1);assert.equal(h.state.captureGesture.actionState,'idle');
  assert.equal(h.state.captureGesture.kind,'pin');assert.equal(h.state.captureGesture.phase,'holding');
  assert.equal(h.state.captureGesture.progress,.4);assert.equal(h.state.captureGesture.message,'');
});

test('busy pin work keeps its action state while the detector continues observing a possible release',()=>{
  const h=feedbackHarness({phase:'latched',actionState:'detecting',busy:true});h.update();
  assert.equal(h.calls.cleared,0);assert.equal(h.state.captureGesture.actionState,'detecting');
  assert.equal(h.calls.pinInputs.length,1);assert.equal(h.calls.pinInputs[0].active,false);
});

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function transactionHarness(){
  const source={sourceId:'rgb',label:'RGB',isActive:()=>true},calls={captures:[],renders:0,timers:new Map()},jobs=[];
  let result={phase:'ready',completed:0,pinched:false,triggered:false},timerId=0;
  const state={view:'call',probing:false,telemetry:new Map(),captureGesture:{kind:'snapshot',actionState:'idle',completed:0}};
  const context={state,isCapturePending,captureOutcomeFeedback,gestureActionId:0,gestureActionSource:null,objectWarmSource:'roles',gestureResultTimer:null,
    performance:{now:()=>1000},trackingSource:()=>source,objectCaptureSource:()=>source,gazeCaptureSource:()=>source,
    cameraRoleContextKey:()=> 'roles',cameraActionKey:()=> 'roles',browserTracking:{getState:()=>({status:'running'})},
    document:{hidden:false,querySelector:()=>null},captureBoard:{isBusy:()=>false},sourceOverlayFrames:()=>[],
    selectGestureInput:()=>({frame:{},sourceId:source.sourceId}),
    gestureDetector:{update:()=>result,getState:()=>({...result,triggered:false}),reset(){result={phase:'waiting',completed:0,pinched:false,triggered:false};}},
    pinGestureDetector:{update:()=>({phase:'idle',holding:false,triggered:false}),getState:()=>({phase:'idle',holding:false}),reset(){}},
    scenePins:{isBusy:()=>false,cancel(){context.objectCaptureChanged({actionState:'idle',message:''});}},
    objectCapture:{isBusy:()=>false,capture(options){calls.captures.push(options);const job=deferred();jobs.push(job);return job.promise;}},
    openAIScene:{cancel(){}},callWorkspace:{render(){calls.renders++;}},log(){},showView(){},toast(message){calls.toast=message;},
    clearTimeout(id){calls.timers.delete(id);},setTimeout(fn,ms){calls.timers.set(++timerId,{fn,ms});return timerId;}};
  const a=app.indexOf('function clearGestureFeedback(){'),b=app.indexOf('function showCallHelp(',a);
  const manual=app.slice(app.indexOf('function manualScenePin(){'),app.indexOf('async function resumeScenePin('));
  const api=vm.runInNewContext(manual+app.slice(a,b)+'\n({manualScenePin,updateCaptureGesture,objectCaptureChanged,dismissCaptureGesture,finishGestureAction,clearGestureFeedback});',context);
  return {state,calls,jobs,context,api,setResult:value=>{result=value;},trigger(){result={phase:'cooldown',completed:2,pinched:false,triggered:true};api.updateCaptureGesture();result={...result,triggered:false};}};
}

test('two filled dots require an accepted snapshot action, never a held second pinch or a pin result',()=>{
  for(const completed of [0,1,2]){
    const pending=gestureIndicatorState({kind:'snapshot',actionState:'idle',completed,pinched:true});
    assert.ok(pending.completed<2);assert.equal(pending.pending,true);assert.equal(pending.acknowledged,false);
  }
  assert.deepEqual(gestureIndicatorState({kind:'snapshot',completed:2,acknowledged:true,actionState:'detecting'}),
    {completed:2,pending:false,acknowledged:true});
  assert.equal(gestureIndicatorState({kind:'pin',completed:2,acknowledged:true,actionState:'pinned'}).acknowledged,false);
});

test('every accepted double pinch starts one capture and settles even without a pipeline callback',async()=>{
  for(const [outcome,expected] of [[{status:'saved'},'saved'],[{status:'not-found'},'not-found'],[{status:'busy'},'error'],
    [{status:'cancelled'},'cancelled'],[{status:'error',message:'Camera stopped.'},'error'],[{},'error']]){
    const h=transactionHarness();h.trigger();
    assert.equal(h.calls.captures.length,1);assert.equal(h.state.captureGesture.actionState,'detecting');
    assert.equal(gestureIndicatorState(h.state.captureGesture).completed,2);
    h.jobs[0].resolve(outcome);await flush();
    assert.equal(h.state.captureGesture.actionState,expected);assert.ok(h.state.captureGesture.message);
    assert.equal(gestureIndicatorState(h.state.captureGesture).completed,2,'acknowledgement remains attached to the result');
    assert.equal(h.calls.timers.size,1);
  }
});

test('rejected capture promises show terminal feedback and retain the accepted two-pinch acknowledgement',async()=>{
  const h=transactionHarness();h.trigger();h.jobs[0].reject(new Error('Worker failed.'));await flush();
  assert.equal(h.state.captureGesture.actionState,'error');assert.equal(h.state.captureGesture.message,'Worker failed.');
  assert.equal(h.state.captureGesture.acknowledged,true);
});

test('pipeline idle while capturing becomes visible cancellation and cannot erase a saved result',async()=>{
  const h=transactionHarness();h.trigger();h.api.objectCaptureChanged({actionState:'idle',message:''});
  assert.equal(h.state.captureGesture.actionState,'cancelled');assert.ok(h.state.captureGesture.message);
  h.jobs[0].resolve({status:'cancelled'});await flush();assert.equal(h.state.captureGesture.actionState,'cancelled');
  h.api.objectCaptureChanged({actionState:'saved',message:'Saved Notebook from your left hand.'});
  h.api.objectCaptureChanged({actionState:'idle',message:''});assert.equal(h.state.captureGesture.actionState,'saved');
  assert.equal(h.state.captureGesture.message,'Saved Notebook from your left hand.');
});

test('dismissal reports an interrupted action and late completion cannot overwrite the next gesture',async()=>{
  const h=transactionHarness();h.trigger();h.api.dismissCaptureGesture({message:'Camera changed. Try again.'});
  assert.equal(h.state.captureGesture.actionState,'cancelled');assert.equal(h.state.captureGesture.message,'Camera changed. Try again.');
  h.trigger();assert.equal(h.state.captureGesture.actionState,'detecting');
  h.jobs[0].resolve({status:'error',message:'Obsolete failure'});await flush();
  assert.equal(h.state.captureGesture.actionState,'detecting');
  h.jobs[1].resolve({status:'saved',method:'left-hand-region'});await flush();
  assert.equal(h.state.captureGesture.actionState,'saved');assert.match(h.state.captureGesture.message,/above your left hand/);
});

test('a specific pipeline result is retained when the capture promise resolves',async()=>{
  const h=transactionHarness();h.trigger();h.api.objectCaptureChanged({actionState:'not-found',message:'Show the base of your left index finger.'});
  const timer=[...h.calls.timers.keys()][0];h.jobs[0].resolve({status:'not-found'});await flush();
  assert.equal(h.state.captureGesture.message,'Show the base of your left index finger.');assert.equal([...h.calls.timers.keys()][0],timer);
});

test('repeated camera lifecycle resets retain a terminal result until explicitly dismissed',()=>{
  const h=transactionHarness();h.trigger();h.api.dismissCaptureGesture({message:'Camera changed. Try again.'});
  const timer=[...h.calls.timers.keys()][0];h.api.dismissCaptureGesture();h.api.dismissCaptureGesture();
  assert.equal(h.state.captureGesture.actionState,'cancelled');assert.equal(h.state.captureGesture.message,'Camera changed. Try again.');
  assert.equal([...h.calls.timers.keys()][0],timer);
  h.api.dismissCaptureGesture({clearResult:true});assert.equal(h.state.captureGesture.actionState,'idle');
  assert.equal(gestureIndicatorState(h.state.captureGesture).completed,0);
});

test('manual pin progress cannot falsely acknowledge a double pinch',()=>{
  const h=transactionHarness();h.state.captureGesture={kind:'pin',actionState:'idle',completed:0};
  h.api.objectCaptureChanged({actionState:'detecting',message:'Finding a region.'});
  assert.equal(h.state.captureGesture.completed,0);assert.equal(gestureIndicatorState(h.state.captureGesture).acknowledged,false);
});

test('manual pin request cannot hide an accepted gesture while its capture is busy',()=>{
  for(const pipeline of ['objectCapture','scenePins']){
    const h=transactionHarness();h.trigger();const previous=h.state.captureGesture;
    h.context[pipeline].isBusy=()=>true;h.api.manualScenePin();
    assert.strictEqual(h.state.captureGesture,previous);assert.match(h.calls.toast,/still running/);
    assert.equal(h.state.captureGesture.actionState,'detecting');assert.equal(h.state.captureGesture.acknowledged,true);
  }
});

async function callHudHarness(){
  const call=await readFile(new URL('../dist/call-workspace.js',import.meta.url),'utf8'),elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{hidden:false,textContent:'',style:{},attributes:{},classes:new Set(),
      setAttribute(name,value){this.attributes[name]=value;},querySelector(){return {setAttribute(){}};},
      classList:{toggle(name,value){const classes=elements.get(id).classes;value?classes.add(name):classes.delete(name);}}});
    return elements.get(id);
  };
  const begin=call.indexOf('  function renderGesture('),end=call.indexOf('  function renderCaptureLayout(',begin);
  const render=vm.runInNewContext(call.slice(begin,end)+'\nrenderGesture;',{
    active:true,gestureSignature:null,$:element,text:(node,value)=>{node.textContent=value;},onGestureDismiss(){},gestureIndicatorState,DEFAULT_PIN_HOLD_MS
  });
  return {render,element};
}

test('actual call HUD keeps two accepted dots beside progress and the terminal result',async()=>{
  const {render,element}=await callHudHarness();
  render({kind:'snapshot',phase:'second-closed',completed:1,pinched:true,actionState:'idle'});
  assert.equal(element('callGesture').attributes['data-completed'],'1');assert.equal(element('callGestureProgress').hidden,false);
  assert.equal(element('callGestureResult').hidden,true);assert.match(element('callGestureStatus').textContent,/Release to take/);
  for(const [actionState,label] of [['detecting','Finding object…'],['saved','Snapshot saved'],['not-found','No object found'],['error','Capture failed'],['cancelled','Capture cancelled']]){
    render({kind:'snapshot',completed:2,pinched:false,acknowledged:true,actionState});
    assert.equal(element('callGesture').attributes['data-completed'],'2');assert.equal(element('callGesture').hidden,false);
    assert.equal(element('callGestureProgress').hidden,false);assert.equal(element('callGestureResult').hidden,false);
    assert.equal(element('callGestureLabel').textContent,label);assert.equal(element('callGestureSpinner').hidden,actionState!=='detecting');
  }
  render({kind:'snapshot',completed:0,pinched:false,actionState:'idle'});assert.equal(element('callGesture').hidden,true);
});

test('actual hold HUD and accessible timing follow the shared 1.5-second default without completing early',async()=>{
  const {render,element}=await callHudHarness();
  for(const heldMs of [0,750,1499,1500]){
    render({kind:'pin',phase:heldMs===1500?'latched':'holding',holding:true,progress:heldMs/DEFAULT_PIN_HOLD_MS,actionState:'idle'});
    const ring=element('callPinHold');
    assert.equal(ring.hidden,false);assert.equal(Number(ring.attributes['aria-valuemax']),1.5);
    assert.equal(Number(ring.attributes['aria-valuenow']),heldMs/1000);
    if(heldMs===0)assert.match(element('callGestureStatus').textContent,/1\.5 seconds remaining/);
    if(heldMs===750)assert.match(ring.style.backgroundImage,/180deg/);
    if(heldMs===1499){
      assert.ok(Number(ring.attributes['aria-valuenow'])<Number(ring.attributes['aria-valuemax']));
      assert.match(element('callGestureStatus').textContent,/0\.1 seconds remaining/);
    }
    if(heldMs===1500)assert.match(element('callGestureStatus').textContent,/Lower your fingers/);
  }
});
