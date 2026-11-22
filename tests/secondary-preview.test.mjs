import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {setupSecondaryPreview,createNativeCameraMonitor} from '../dist/secondary-preview.js';
import {createCameraFeedPool,classifyCameraDevice} from '../dist/camera-feed-pool.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const selectionHelpers=app.slice(app.indexOf('function primaryCameraDeviceId(){'),app.indexOf('async function openCamera('));

class Element extends EventTarget {
  constructor(tag='div'){super();this.tag=tag;this.hidden=true;this.children=[];this.attributes={};this.value='';this.textContent='';this.srcObject=null;this.videoWidth=512;this.videoHeight=640;this.readyState=2;this.style={};}
  set innerHTML(value){this.nodes=new Map([...value.matchAll(/<([a-z]+)[^>]*id="([^"]+)"/g)].map(([,tag,id])=>[id,new Element(tag)]));this.stage=new Element();}
  querySelector(selector){return selector==='.secondary-stage'?this.stage:this.nodes?.get(selector.slice(1))||null;}
  append(value){this.children.push(value);}
  insertBefore(value){this.append(value);}
  replaceChildren(...values){this.children=values;this.value=values[0]?.value||'';}
  add(value){this.children.push(value);}
  get selectedOptions(){return this.children.filter(value=>value.value===this.value);}
  setAttribute(name,value){this.attributes[name]=value;}
  removeAttribute(name){delete this.attributes[name];if(name==='src'){this.naturalWidth=0;this.naturalHeight=0;}}
  play(){return Promise.resolve();} pause(){} load(){} remove(){this.removed=true;}
  getContext(){return {drawImage(){},getImageData(){return {};}};}
}
class Track extends EventTarget {
  constructor(id){super();this.id=id;this.readyState='live';this.stops=0;this.label=id==='rgb'?'RGB camera':'Scene CPD';this.endedListeners=new Set();}
  addEventListener(type,listener,options){if(type==='ended')this.endedListeners.add(listener);super.addEventListener(type,listener,options);}
  removeEventListener(type,listener,options){if(type==='ended')this.endedListeners.delete(listener);super.removeEventListener(type,listener,options);}
  getSettings(){return {deviceId:this.id,width:512,height:640,frameRate:30};}
  getConstraints(){return {};}
  getCapabilities(){return {};}
  stop(){this.stops++;this.readyState='ended';}
  end(){this.readyState='ended';this.dispatchEvent(new Event('ended'));}
}
const makeStream=id=>{const track=new Track(id);return {track,getTracks:()=>[track],getVideoTracks:()=>[track]};};
function harness(t,{getMedia}={}){
  const host=new Element(),calls=[],streams=[],events=[],notices=[];
  const cameras=[{kind:'videoinput',deviceId:'cpd',label:'LVNext CPD'},{kind:'videoinput',deviceId:'rgb',label:'RGB Camera'},{kind:'videoinput',deviceId:'wide',label:'Wide Camera'}];
  const globals={document:{getElementById:id=>id==='liveView'?host:null,createElement:tag=>new Element(tag)},navigator:{mediaDevices:{getSupportedConstraints:()=>({})}},Option:class{constructor(text,value){this.textContent=text;this.value=value;}},location:{href:'https://example.test/'}};
  for(const [key,value]of Object.entries(globals)){const original=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>original?Object.defineProperty(globalThis,key,original):delete globalThis[key]);}
  let primary='';
  const pool=createCameraFeedPool({getPrimaryDeviceId:()=>primary,makeVideo:()=>new Element('video'),attachVideo(){},waitFrame:async()=>{},
    getMedia:constraints=>{calls.push(constraints);if(getMedia)return getMedia(constraints);const stream=makeStream(constraints.video.deviceId.exact);streams.push(stream);return Promise.resolve(stream);}});
  const secondary=setupSecondaryPreview({cameraPool:pool,getCameraDevices:()=>cameras,getPrimaryDeviceId:()=>primary,onStateChange:value=>events.push(value),notice:message=>notices.push(message)});
  t.after(()=>{secondary.destroy();pool.destroy();});
  return {secondary,pool,cameras,calls,streams,events,notices,section:host.children[0],setPrimary:value=>primary=value};
}

test('scene-first opening leaves default RGB selection distinct and exposes the same raw scene element',async t=>{
  const h=harness(t);assert.equal(await h.secondary.open('cpd'),true);
  const state={cameras:h.cameras,source:null,request:null,deviceId:'cpd'};
  const select=vm.runInNewContext(selectionHelpers+'\n({primaryCameraDeviceId,resolvePrimaryCameraDevice});',{state,cameraPool:h.pool,secondaryController:h.secondary,classifyCameraDevice});
  assert.equal(select.primaryCameraDeviceId(),'');assert.equal(select.resolvePrimaryCameraDevice(),'rgb');
  const tracking=h.secondary.getTrackingSource(),target=h.secondary.getOverlayTarget();
  assert.strictEqual(tracking.element,target.element);assert.strictEqual(target.canvas,h.section.querySelector('#secondaryOverlay'));
  assert.strictEqual(target.stage,h.section.querySelector('.secondary-stage'));assert.equal(tracking.mirror,false);
  assert.equal(tracking.width,512);assert.equal(tracking.height,640);assert.match(tracking.sourceId,/^scene:\d+:browser:cpd$/);
  assert.equal(h.calls.length,1);assert.ok(h.events.some(event=>event.connecting&&!event.connected));assert.equal(h.events.at(-1).connecting,false);
  state.request={};state.deviceId='rgb';h.setPrimary(select.primaryCameraDeviceId());h.secondary.refresh();
  assert.equal(h.secondary.getState().connected,true);assert.equal(h.streams[0].track.stops,0);
  h.setPrimary('cpd');h.secondary.refresh();assert.equal(h.secondary.getState().connected,false);assert.equal(h.streams[0].track.stops,1);
});

test('pending auxiliary IDs are excluded from default main selection and no camera is guessed when every device is occupied',()=>{
  const state={cameras:[{deviceId:'cpd',label:'Scene CPD'},{deviceId:'wide',label:'Wide'}],deviceId:'cpd',request:null,source:null};
  const feeds=[{deviceId:'cpd'}];const secondary={deviceId:'wide',connecting:true,connected:false};
  const select=vm.runInNewContext(selectionHelpers+'\n({resolvePrimaryCameraDevice,primaryCameraDeviceId});',{state,cameraPool:{getState:()=>({feeds})},secondaryController:{getState:()=>secondary},classifyCameraDevice});
  assert.throws(()=>select.resolvePrimaryCameraDevice(),/already used by the scene/);
  assert.equal(select.resolvePrimaryCameraDevice('cpd'),'cpd'); // Explicit transfer is handled by openCamera.
  state.source={type:'camera',id:'rgb'};state.deviceId='cpd';assert.equal(select.primaryCameraDeviceId(),'rgb');
});

test('rapid source replacement releases a late grant and cannot stop the newer scene reader',async t=>{
  const pending=new Map();const h=harness(t,{getMedia:constraints=>{const grant=deferred();pending.set(constraints.video.deviceId.exact,grant);return grant.promise;}});
  const first=h.secondary.open('cpd'),second=h.secondary.open('wide');
  assert.equal(await first,false);const current=makeStream('wide');pending.get('wide').resolve(current);assert.equal(await second,true);
  const obsolete=makeStream('cpd');pending.get('cpd').resolve(obsolete);await flush();
  assert.equal(obsolete.track.stops,1);assert.equal(current.track.stops,0);assert.equal(h.secondary.getState().deviceId,'wide');
  assert.equal(h.secondary.getState().connecting,false);assert.equal(h.pool.getState().feeds.length,1);
});

test('cancelling a pending scene releases its eventual grant and leaves no tracked consumers',async t=>{
  const grant=deferred(),abort=new AbortController();const h=harness(t,{getMedia:()=>grant.promise});
  const opening=h.secondary.open('cpd',{signal:abort.signal});abort.abort();assert.equal(await opening,false);
  const late=makeStream('cpd');grant.resolve(late);await flush();
  assert.equal(late.track.stops,1);assert.equal(h.secondary.getState().connecting,false);assert.equal(h.secondary.getTrackingSource(),null);assert.deepEqual(h.pool.getState().feeds,[]);
});

test('a primary claim during pending scene startup discards only the auxiliary grant',async t=>{
  const grant=deferred();const h=harness(t,{getMedia:()=>grant.promise});const primary=makeStream('cpd');
  const opening=h.secondary.open('cpd');h.setPrimary('cpd');h.secondary.refresh();
  assert.equal(await opening,false);const obsolete=makeStream('cpd');grant.resolve(obsolete);await flush();
  assert.equal(obsolete.track.stops,1);assert.equal(primary.track.stops,0);assert.equal(h.secondary.getState().connected,false);
});

test('stopping the preview releases only its lease and removes its ended listener while a pin stays live',async t=>{
  const h=harness(t);await h.secondary.open('cpd');const source=h.secondary.getCaptureSource(),pin=await source.retain();
  const track=h.streams[0].track;assert.equal(track.endedListeners.size,2);
  h.secondary.stop();assert.equal(track.stops,0);assert.equal(track.endedListeners.size,1);assert.equal(pin.isActive(),true);assert.equal(source.isActive(),false);
  pin.stop();assert.equal(track.stops,1);assert.equal(track.endedListeners.size,0);
});

test('track removal clears tracking identity and allows a new scene generation',async t=>{
  const h=harness(t);await h.secondary.open('cpd');const first=h.secondary.getTrackingSource();h.streams[0].track.end();
  assert.equal(h.secondary.getTrackingSource(),null);assert.equal(h.secondary.getState().connected,false);
  assert.equal(await h.secondary.open('cpd'),true);assert.notEqual(h.secondary.getTrackingSource().sourceId,first.sourceId);
});

function monitorHarness(results){
  let now=0,nextId=0;const timers=new Map(),calls=[],ended=[];
  const setTimer=(callback,delay)=>{const id=++nextId;timers.set(id,{callback,at:now+delay});return id;};
  const monitor=createNativeCameraMonitor('http://127.0.0.1:8765/api/camera/status?index=1&backend=avfoundation&device_uid=cpd-uid',{
    now:()=>now,setTimer,clearTimer:id=>timers.delete(id),onEnded:error=>ended.push(error.message),
    fetchStatus:async(url,options)=>{calls.push({url:new URL(url),options});const value=results.shift();if(value instanceof Error)throw value;return {ok:true,json:async()=>value};}
  });
  return {monitor,calls,ended,timers,advance:async ms=>{now+=ms;const due=[...timers].filter(([,item])=>item.at<=now);for(const[id,item]of due){if(timers.delete(id))await item.callback();}},setNow:value=>now=value};
}
const status=(extra={})=>({active:true,matches:true,job_id:'a'.repeat(32),frame_sequence:1,frame_age_ms:0,timeout_ms:7000,...extra});

test('native progress binds the exact reader job and every subsequent poll preserves device identity',async()=>{
  const h=monitorHarness([status(),status({frame_sequence:31,frame_age_ms:20})]);await h.monitor.start();await h.advance(1000);
  assert.equal(h.calls[0].url.searchParams.has('job_id'),false);assert.equal(h.calls[1].url.searchParams.get('job_id'),'a'.repeat(32));
  assert.equal(h.calls[1].url.searchParams.get('device_uid'),'cpd-uid');assert.equal(h.calls[1].url.searchParams.get('backend'),'avfoundation');
  assert.equal(h.calls[1].url.pathname,'/api/camera/status');assert.equal(h.calls[1].options.cache,'no-store');assert.equal(h.calls[1].options.credentials,'omit');
  assert.equal(h.monitor.getState().verified,true);assert.equal(h.monitor.getState().frameSequence,31);assert.equal(h.monitor.isActive(),true);
  h.monitor.stop();assert.equal(h.timers.size,0);
});

test('repeated status cannot refresh a frozen encoded frame even if reported age is zero',async()=>{
  const h=monitorHarness([status(),status()]);await h.monitor.start();await h.advance(7100);
  assert.equal(h.monitor.isActive(),false);assert.equal(h.ended.length,1);assert.match(h.ended[0],/stopped delivering/);assert.equal(h.timers.size,0);
});

test('a replaced or ended native job is rejected even when another reader at that index is active',async()=>{
  for(const replacement of [status({matches:false,match_error:'job_replaced',job_id:'b'.repeat(32)}),status({job_id:'b'.repeat(32)}),{active:false,matches:false}]){
    const h=monitorHarness([status(),replacement]);await h.monitor.start();await h.advance(1000);
    assert.equal(h.monitor.isActive(),false);assert.equal(h.ended.length,1);assert.equal(h.timers.size,0);
  }
});

test('legacy active/status remains usable without claiming verified frame progress',async()=>{
  const h=monitorHarness([{active:true,settings:{width:512,height:640}},{active:true,settings:{}},{active:false}]);await h.monitor.start();
  assert.equal(h.monitor.getState().verified,false);assert.equal(h.monitor.getState().mode,'status-only');await h.advance(1000);assert.equal(h.monitor.isActive(),true);
  assert.equal(h.calls[1].url.searchParams.has('job_id'),false);await h.advance(1000);assert.equal(h.monitor.isActive(),false);assert.equal(h.ended.length,1);
});

test('one failed status request can recover; repeated failures close only the monitor',async()=>{
  const h=monitorHarness([status(),new Error('network'),status({frame_sequence:65}),new Error('network'),new Error('network')]);await h.monitor.start();
  await h.advance(1000);assert.equal(h.monitor.isActive(),true);await h.advance(1000);assert.equal(h.monitor.getState().frameSequence,65);
  await h.advance(1000);assert.equal(h.ended.length,0);await h.advance(1000);assert.equal(h.ended.length,1);assert.equal(h.monitor.isActive(),false);
});

test('initial malformed native progress never becomes live and old job sequence cannot restart silently',async()=>{
  for(const value of [status({job_id:null}),status({frame_age_ms:null}),status({frame_sequence:0}),status({matches:false})]){
    const h=monitorHarness([value]);await assert.rejects(h.monitor.start());assert.equal(h.monitor.isActive(),false);assert.equal(h.timers.size,0);
  }
  const h=monitorHarness([status({frame_sequence:10}),status({frame_sequence:2})]);await h.monitor.start();await h.advance(1000);
  assert.equal(h.ended.length,1);assert.match(h.ended[0],/sequence restarted/);
});

test('stopping a monitor cancels pending status and a late response cannot resume polling or notify',async()=>{
  const pending=deferred();let requestSignal;const timers=new Map();let nextId=0;const ended=[];
  const monitor=createNativeCameraMonitor('http://127.0.0.1:8765/api/camera/status?index=1',{
    fetchStatus:async(_,options)=>{requestSignal=options.signal;return pending.promise;},
    setTimer:callback=>{timers.set(++nextId,callback);return nextId;},clearTimer:id=>timers.delete(id),onEnded:error=>ended.push(error)
  });
  const opening=monitor.start();monitor.stop();assert.equal(requestSignal.aborted,true);
  pending.resolve({ok:true,json:async()=>status()});await assert.rejects(opening,{name:'AbortError'});
  assert.equal(monitor.isActive(),false);assert.equal(timers.size,0);assert.equal(ended.length,0);
});
