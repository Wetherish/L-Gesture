import test from 'node:test';
import assert from 'node:assert/strict';
import {nextFreeSlot,projectCaptureKeys,captureErrorMessage,acquireScenePinSource} from '../dist/capture-board.js';

test('new captures append or use a later selected destination without a nine-capture limit',()=>{
  const items=Array(9).fill(null);items[0]={kind:'snapshot'};items[4]={kind:'pin'};
  assert.equal(nextFreeSlot(items,6),6);assert.equal(nextFreeSlot(items,4),5);
  assert.equal(nextFreeSlot(Array(9).fill({kind:'snapshot'}),3),9);
});
test('capture failures explain the actual browser boundary without claiming a successful capture',()=>{
  assert.match(captureErrorMessage({name:'NotAllowedError'}),/cancelled or blocked/);
  assert.match(captureErrorMessage({name:'InvalidStateError'}),/Click Pin or Snapshot/);
  assert.match(captureErrorMessage({name:'NotFoundError'}),/import an image/);
  assert.equal(captureErrorMessage(new Error('Source ended.')),'Source ended.');
  assert.equal(captureErrorMessage({name:'NotAllowedError',code:'APERTURE_POLICY_BLOCKED',message:'Open the full app.'}),'Open the full app.');
});

const hint={kind:'aux-camera',deviceId:'cpd-id',label:'CPD',width:512,height:640};
function source(overrides={}){
  const value={kind:'aux-camera',deviceId:'cpd-id',label:'CPD',stream:null,stops:0,
    isActive:()=>true,getMetadata:()=>({width:512,height:640}),capture:()=>({width:128,height:160}),stop(){this.stops++;},...overrides};
  return value;
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('scene resume calls the exact camera adapter with a copied safe hint, including native wrappers',async()=>{
  const opened=source();let provided;
  const resumed=await acquireScenePinSource({...hint,url:'http://localhost/private',stream:{}},{onResumeScenePin:(value,context)=>{
    provided=value;assert.equal(context.isCurrent(),true);return opened;
  }});
  assert.equal(resumed,opened);assert.deepEqual(provided,hint);assert.notEqual(provided,hint);assert.equal(opened.stops,0);
  const nativeDevice={backend:'avfoundation',uniqueId:'stable-native-uid'};
  const native=source({deviceId:'',label:'Native CPD',getMetadata:()=>({width:512,height:640,nativeDevice})});
  const nativeHint={...hint,deviceId:'',label:'Native CPD',nativeDevice};
  assert.equal(await acquireScenePinSource(nativeHint,{onResumeScenePin:async()=>native}),native);
  assert.equal(native.stream,null);assert.equal(native.stops,0);
});

test('cancelled scene resume settles promptly and releases a late camera lease',async()=>{
  const controller=new AbortController();let grant,receivedSignal;
  const pending=acquireScenePinSource(hint,{signal:controller.signal,onResumeScenePin:(_hint,context)=>{
    receivedSignal=context.signal;return new Promise(resolve=>{grant=resolve;});
  }});
  const rejected=assert.rejects(pending,{name:'AbortError'});controller.abort();await rejected;
  assert.equal(receivedSignal.aborted,true);
  const late=source();grant(late);await flush();assert.equal(late.stops,1);
});

test('an obsolete slot cannot accept a reconnect even if the adapter ignores cancellation',async()=>{
  let current=true,grant;
  const pending=acquireScenePinSource(hint,{isCurrent:()=>current,onResumeScenePin:()=>new Promise(resolve=>{grant=resolve;})});
  current=false;const opened=source();grant(opened);
  await assert.rejects(pending,{name:'AbortError'});assert.equal(opened.stops,1);
});

test('a changed camera, format or stopped source cannot reuse a saved normalized crop',async()=>{
  for(const opened of [source({deviceId:'different-id'}),source({getMetadata:()=>({width:640,height:480})}),source({isActive:()=>false}),source({kind:'pin'})]){
    await assert.rejects(acquireScenePinSource(hint,{onResumeScenePin:async()=>opened}),/original|format|stopped|live capture/);
    assert.equal(opened.stops,1);
  }
  const nativeDevice={backend:'avfoundation',uniqueId:'expected-native-uid'};
  const wrongNative=source({deviceId:'',label:'CPD',getMetadata:()=>({width:512,height:640,nativeDevice:{...nativeDevice,uniqueId:'other-native-uid'}})});
  await assert.rejects(acquireScenePinSource({...hint,deviceId:'',nativeDevice},{onResumeScenePin:async()=>wrongNative}),/original scene camera/);
  assert.equal(wrongNative.stops,1);
});

test('legacy native label-only hints remain readable but cannot invoke a resume adapter',async()=>{
  let calls=0;
  await assert.rejects(acquireScenePinSource({...hint,deviceId:''},{onResumeScenePin:()=>{calls++;return source({deviceId:''});}}),/no verified device identity.*new explicit scene crop/);
  assert.equal(calls,0,'an old label must not start or adopt any native camera');
});

test('native resume requires exact backend and UID, independent of matching or renamed labels',async()=>{
  const nativeDevice={backend:'avfoundation',uniqueId:'camera-uid-A'},saved={...hint,deviceId:'',nativeDevice};
  for(const actual of [undefined,{backend:'dshow',uniqueId:'camera-uid-A'},{backend:'avfoundation',uniqueId:'camera-uid-B'}]){
    const opened=source({deviceId:'',label:saved.label,getMetadata:()=>({width:512,height:640,...(actual?{nativeDevice:actual}:{})})});
    await assert.rejects(acquireScenePinSource(saved,{onResumeScenePin:async()=>opened}),/original scene camera/);
    assert.equal(opened.stops,1);
  }
  const matching=source({deviceId:'',label:'Renamed by OS',getMetadata:()=>({width:512,height:640,nativeDevice})});
  const resumed=await acquireScenePinSource(saved,{onResumeScenePin:value=>{
    // A callback receives a detached identity, never the validation reference.
    value.nativeDevice.uniqueId='mutated-callback-copy';return matching;
  }});
  assert.equal(resumed,matching);assert.equal(matching.stops,0);assert.equal(saved.nativeDevice.uniqueId,'camera-uid-A');
});

test('perspective resume validates original geometry and detaches transform data before the adapter can mutate it',async()=>{
  const transform={type:'perspective',quad:[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}]};
  const opened=source();let wrapped;
  const resumed=await acquireScenePinSource({...hint,transform},{onResumeScenePin:value=>{
    value.transform.quad[0].x=.4;return opened;
  },createPerspectiveSource:(actual,correction)=>{assert.equal(actual,opened);wrapped=correction;return {corrected:true,source:actual};}});
  assert.equal(resumed.corrected,true);assert.deepEqual(wrapped,transform);assert.equal(opened.stops,0);
  assert.equal(transform.quad[0].x,.2);
  const changed=source({getMetadata:()=>({width:640,height:480})});let wraps=0;
  await assert.rejects(acquireScenePinSource({...hint,transform},{onResumeScenePin:()=>changed,createPerspectiveSource(){wraps++;}}),/format changed/);
  assert.equal(wraps,0);assert.equal(changed.stops,1);
});


test('physical keys project the first nine occupied captures and empty keys append beyond holes',()=>{
  const items=new Map(Array.from({length:12},(_,index)=>[index,{index}]));
  assert.deepEqual(projectCaptureKeys(items),[0,1,2,3,4,5,6,7,8]);
  items.delete(0);assert.deepEqual(projectCaptureKeys(items),[1,2,3,4,5,6,7,8,9]);
  items.set(0,{index:0});assert.deepEqual(projectCaptureKeys(items),[0,1,2,3,4,5,6,7,8]);
  const legacy=new Map([[2,{index:2}],[8,{index:8}]]);
  assert.deepEqual(projectCaptureKeys(legacy),[2,8,9,10,11,12,13,14,15]);
  assert.equal(nextFreeSlot(legacy,0),9);
  assert.equal(nextFreeSlot(new Map([[1000000000,{index:1000000000}]])),1000000001);
});
