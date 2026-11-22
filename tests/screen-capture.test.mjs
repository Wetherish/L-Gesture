import test from 'node:test';
import assert from 'node:assert/strict';
import {createScreenCapture, normalizeRegion, regionFromPoints, regionToPixels, humanScreenLabel} from '../dist/screen-capture.js';

function mockGlobal(t, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {configurable: true, value});
  t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
}
function stream() {
  const tracks = [new EventTarget(), new EventTarget()];
  tracks.forEach(track => {track.readyState='live';track.stopped=0;track.stop=()=>{track.stopped++;track.readyState='ended';};});
  return {getTracks:()=>tracks,getVideoTracks:()=>[tracks[0]],tracks};
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('Useful screen labels preserve human titles and remove control characters', () => {
  assert.equal(humanScreenLabel({label:'Chrome — Design review',getSettings:()=>({displaySurface:'browser'})}),'Chrome — Design review');
  assert.equal(humanScreenLabel({label:'  Slides\nDeck\u0000\u202E — demo  '}),'Slides Deck — demo');
  assert.equal(humanScreenLabel({label:'Desktop 1'}),'Desktop 1');
});

test('Opaque capture labels use readable display-surface names', () => {
  const labels=['web-contents-media-stream://F8840A9A27','screen:0:0','window:123456:0','123456','F8840A9A27A34B58A01234567890ABCD','{F8840A9A-27A3-4B58-A012-34567890ABCD}'];
  for(const label of labels) {
    assert.equal(humanScreenLabel({label,getSettings:()=>({displaySurface:'browser'})}),'Browser tab',label);
    assert.equal(humanScreenLabel({label,getSettings:()=>({displaySurface:'window'})}),'Shared window',label);
    assert.equal(humanScreenLabel({label,getSettings:()=>({displaySurface:'monitor'})}),'Shared screen',label);
  }
});

test('Missing or inaccessible surface settings have a readable fallback', () => {
  assert.equal(humanScreenLabel(), 'Screen capture');
  assert.equal(humanScreenLabel({label:'0',getSettings(){throw new Error('ended');}}), 'Screen capture');
  assert.equal(humanScreenLabel({label:'',getSettings:()=>({displaySurface:'unknown'})}), 'Screen capture');
});

test('Screen labels are capped at 300 characters without splitting emoji pairs', () => {
  assert.equal(humanScreenLabel({label:'Title '.repeat(80)}).length,300);
  const label=humanScreenLabel({label:'A'.repeat(299)+'🎥'});
  assert.equal(label,'A'.repeat(299));
});

test('Region normalization clips and handles reverse selections', () => {
  assert.deepEqual(normalizeRegion(),{x:0,y:0,width:1,height:1});
  assert.deepEqual(normalizeRegion({x:0.75,y:0.75,width:-0.5,height:-0.5}),{x:0.25,y:0.25,width:0.5,height:0.5});
  assert.deepEqual(normalizeRegion({x:-0.5,y:-0.5,width:2,height:2}),{x:0,y:0,width:1,height:1});
  assert.throws(()=>normalizeRegion({x:2,y:0,width:1,height:1}),/visible width/);
  assert.throws(()=>normalizeRegion({x:NaN,y:0,width:1,height:1}),/finite/);
});

test('Drag points give the same rectangle in either direction', () => {
  const start={x:0.25,y:0.25},end={x:0.75,y:0.75};
  assert.deepEqual(regionFromPoints(start,end),regionFromPoints(end,start));
  assert.deepEqual(regionFromPoints(start,end),{x:0.25,y:0.25,width:0.5,height:0.5});
  assert.throws(()=>regionFromPoints(start,start),/visible width/);
});

test('Crop geometry respects source coordinates, max dimensions and aspect ratio', () => {
  assert.deepEqual(regionToPixels({x:.25,y:.25,width:.5,height:.5},1920,1080),{sx:480,sy:270,sw:960,sh:540,width:960,height:540});
  const full=regionToPixels(undefined,3840,2160);
  assert.deepEqual(full,{sx:0,sy:0,sw:3840,sh:2160,width:1600,height:900});
  const portrait=regionToPixels(undefined,1080,1920);
  assert.equal(portrait.height,1200);assert.equal(portrait.width,675);
});

test('Tiny edge crops remain within the source and never allocate a zero-size canvas', () => {
  const crop=regionToPixels({x:.99999,y:.99999,width:.00001,height:.00001},100,100);
  assert.deepEqual(crop,{sx:99,sy:99,sw:1,sh:1,width:1,height:1});
  assert.throws(()=>regionToPixels(undefined,0,1080),/positive/);
  assert.throws(()=>regionToPixels(undefined,1920,1080,{maxWidth:Infinity}),/positive/);
});

test('Picker is invoked synchronously; destroy resolves null and cleans late grants', async t => {
  let grant;let called=false;let constraints;
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(value){called=true;constraints=value;return new Promise(resolve=>{grant=resolve;});}}});
  const chooser=createScreenCapture();const result=chooser.choose({kind:'pin',fps:2});
  assert.equal(called,true);assert.equal(constraints.audio,false);assert.deepEqual(constraints.video.frameRate,{ideal:2});assert.equal(constraints.video.displaySurface,'browser');
  chooser.destroy();assert.equal(await result,null);
  const s=stream();grant(s);await flush();
  assert.deepEqual(s.tracks.map(track=>track.stopped),[1,1]);
});

test('new screen pins request 10 fps while explicit rates and the supported range are preserved', async t => {
  let constraints;
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(value){constraints=value;throw new DOMException('Picker cancelled.','NotAllowedError');}}});
  const chooser=createScreenCapture();
  for(const [options,expected]of [[undefined,10],[{fps:NaN},10],[{fps:1},1],[{fps:2.5},2.5],[{fps:'5'},5],[{fps:100},10],[{fps:0},0.2]]){
    constraints=null;
    const result=chooser.choose(options);
    assert.deepEqual(constraints.video.frameRate,{ideal:expected});
    assert.equal(constraints.audio,false);
    await assert.rejects(result,{name:'NotAllowedError'});
  }
  chooser.destroy();
});

test('Embedded screen policy denial is actionable and never opens the native picker', async t => {
  let calls=0;
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(){calls++;return new Promise(()=>{});}}});
  mockGlobal(t,'document',{permissionsPolicy:{features:()=>['display-capture'],allowsFeature:()=>false}});
  mockGlobal(t,'window',{top:{},self:{}});
  const chooser=createScreenCapture();
  await assert.rejects(chooser.choose(),error=>error.code==='APERTURE_POLICY_BLOCKED'&&error.feature==='display-capture'&&/embedded preview/.test(error.message)&&/own browser tab/.test(error.message));
  assert.equal(calls,0);chooser.destroy();
});

test('Unknown display policy preserves synchronous picker invocation', async t => {
  let calls=0,grant;
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(){calls++;return new Promise(resolve=>{grant=resolve;});}}});
  mockGlobal(t,'document',{featurePolicy:{features:()=>['camera'],allowsFeature:()=>false}});
  const chooser=createScreenCapture(),pending=chooser.choose();assert.equal(calls,1);
  chooser.destroy();assert.equal(await pending,null);const s=stream();grant(s);await flush();assert.equal(s.tracks[0].stopped,1);
});

test('Picker error handling preserves explicit policy errors and markers', async t => {
  const blocked=Object.assign(new Error('Screen sharing is blocked by the embedding page.'),{name:'NotAllowedError',code:'APERTURE_POLICY_BLOCKED'});
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia:()=>Promise.reject(blocked)}});
  const chooser=createScreenCapture();await assert.rejects(chooser.choose(),error=>error===blocked);chooser.destroy();
});

test('A new chooser request cancels the old one and cannot inherit its late stream', async t => {
  const requests=[];
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(){return new Promise((resolve,reject)=>requests.push({resolve,reject}));}}});
  const chooser=createScreenCapture();const first=chooser.choose();const second=chooser.choose({kind:'snapshot'});
  assert.equal(await first,null);assert.equal(requests.length,2);
  const old=stream();requests[0].resolve(old);await flush();assert.equal(old.tracks[0].stopped,1);
  const denied=assert.rejects(second,error=>error.name==='NotAllowedError'&&/Screen capture/.test(error.message));
  requests[1].reject(new DOMException('Permission denied','NotAllowedError'));await denied;chooser.destroy();
});

test('Native picker errors propagate instead of pretending capture succeeded', async t => {
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(){throw new DOMException('Gesture required','InvalidStateError');}}});
  const chooser=createScreenCapture();await assert.rejects(chooser.choose(),{name:'InvalidStateError'});chooser.destroy();
});

test('Unsupported or destroyed capture controls do not request permission', async t => {
  mockGlobal(t,'navigator',{mediaDevices:{}});
  const chooser=createScreenCapture();await assert.rejects(chooser.choose(),{name:'NotSupportedError'});
  chooser.destroy();await assert.rejects(chooser.choose(),{name:'InvalidStateError'});
});

test('Stopping sharing before first decoded frame releases the entire source', async t => {
  const s=stream();
  class Video extends EventTarget {
    style={};readyState=0;videoWidth=0;videoHeight=0;removed=false;
    setAttribute(){} play(){return new Promise(()=>{});} pause(){} remove(){this.removed=true;}
  }
  const video=new Video();
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia:()=>Promise.resolve(s)}});
  mockGlobal(t,'document',{createElement:tag=>{assert.equal(tag,'video');return video;},body:{append(){}}});
  const chooser=createScreenCapture();const result=chooser.choose();
  await flush();const failure=assert.rejects(result,error=>error.name==='NotReadableError'&&/stopped/.test(error.message));
  s.tracks[0].dispatchEvent(new Event('ended'));await failure;
  assert.deepEqual(s.tracks.map(track=>track.stopped),[1,1]);assert.equal(video.srcObject,null);assert.equal(video.removed,true);
  chooser.destroy();
});

function mockDom(t) {
  const doc = {};
  class Element extends EventTarget {
    constructor(tag) {super();this.tagName=tag.toUpperCase();this.style={};this.dataset={};this.children=[];this.className='';this.classList={add(){},remove(){}};this.clientWidth=800;this.clientHeight=450;this.isConnected=true;this.width=300;this.height=150;this.draws=[];this._value='';}
    set value(value){this._value=String(value);} get value(){return this._value;}
    setAttribute(){} removeAttribute(){} append(...items){for(const item of items){item.parent=this;this.children.push(item);}}
    remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    focus(){doc.activeElement=this;}getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:this.clientHeight};}
    getContext(){return {drawImage:(...args)=>this.draws.push(args)};}
    showModal(){this.open=true;}close(){this.open=false;this.dispatchEvent(new Event('close'));}
    closest(){return null;}
  }
  class Video extends Element {
    constructor(){super('video');this.readyState=2;this.videoWidth=1920;this.videoHeight=1080;this.currentTime=0;}
    play(){return Promise.resolve();}pause(){this.paused=true;}
  }
  Object.assign(doc,{head:new Element('head'),body:new Element('body'),activeElement:new Element('button'),querySelector:()=>null,createElement:tag=>tag==='video'?new Video():new Element(tag)});
  mockGlobal(t,'document',doc);mockGlobal(t,'window',new EventTarget());
  const find=(root,predicate)=>predicate(root)?root:root.children.map(child=>find(child,predicate)).find(Boolean);
  return {doc,find};
}

test('Confirmation transfers ownership; snapshot capture uses the frozen preview', async t => {
  const {doc,find}=mockDom(t),s=stream();s.tracks[0].label='Shared test window';
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia:()=>Promise.resolve(s)}});
  const chooser=createScreenCapture(),pending=chooser.choose({kind:'snapshot'});await flush();
  const dialog=find(doc.body,item=>item.tagName==='DIALOG');assert.ok(dialog?.open);
  find(dialog,item=>item.textContent==='Capture snapshot').dispatchEvent(new Event('click'));
  const {source,region}=await pending;
  assert.deepEqual(region,{x:0,y:0,width:1,height:1});assert.equal(source.label,'Shared test window');
  assert.equal(s.tracks[0].stopped,0);chooser.destroy();assert.equal(s.tracks[0].stopped,0);
  source.video.currentTime=8;
  const image=source.capture(region);assert.equal(image.draws[0][0].tagName,'CANVAS');
  assert.equal(image.width,1600);assert.equal(image.height,900);
  source.stop();assert.deepEqual(s.tracks.map(track=>track.stopped),[1,1]);
  assert.throws(()=>source.capture(region),{name:'InvalidStateError'});
});

test('Pins immediately transfer the whole source without a region dialog, then follow fresh frames', async t => {
  const {doc,find}=mockDom(t),s=stream();
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia:()=>Promise.resolve(s)}});
  const chooser=createScreenCapture(),pending=chooser.choose({kind:'pin'});await flush();
  const {source,region}=await pending;
  assert.equal(find(doc.body,item=>item.tagName==='DIALOG'),undefined);
  assert.deepEqual(region,{x:0,y:0,width:1,height:1});
  assert.equal(s.tracks[0].stopped,0);
  assert.equal(source.capture(region).draws[0][0].tagName,'CANVAS');
  source.video.currentTime=1;
  assert.equal(source.capture(region).draws[0][0],source.video);
  assert.equal(source.capture(region).draws[0][0],source.video);
  source.stop();chooser.destroy();
});

test('Escape cancels the crop dialog, releases tracks and resolves null', async t => {
  const {doc,find}=mockDom(t),s=stream();
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia:()=>Promise.resolve(s)}});
  const chooser=createScreenCapture(),pending=chooser.choose({kind:'snapshot'});await flush();
  const dialog=find(doc.body,item=>item.tagName==='DIALOG');
  dialog.dispatchEvent(new Event('cancel',{cancelable:true}));
  assert.equal(await pending,null);assert.deepEqual(s.tracks.map(track=>track.stopped),[1,1]);
  assert.equal(dialog.isConnected,false);chooser.destroy();
});

test('focus preference is set before the picker and finalized before video playback',async t=>{
  const {doc}=mockDom(t),s=stream(),events=[];s.tracks[0].getSettings=()=>({displaySurface:'browser'});
  class Controller{setFocusBehavior(value){events.push(value);}}
  mockGlobal(t,'CaptureController',Controller);
  const create=doc.createElement;doc.createElement=tag=>{const el=create(tag);if(tag==='video'){const play=el.play.bind(el);el.play=()=>{events.push('play');return play();};}return el;};
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(options){events.push('picker');assert.ok(options.controller instanceof Controller);return Promise.resolve(s);}}});
  const chooser=createScreenCapture(),pending=chooser.choose({kind:'pin'});
  assert.deepEqual(events,['no-focus-change','picker']);
  const result=await pending;
  assert.deepEqual(events,['no-focus-change','picker','no-focus-change','play']);
  result.source.stop();chooser.destroy();
});

test('a browser removing the older focus enum falls back synchronously without reopening the picker',async t=>{
  mockDom(t);const s=stream(),focusCalls=[];let pickerCalls=0;s.tracks[0].getSettings=()=>({displaySurface:'window'});
  class Controller{setFocusBehavior(value){focusCalls.push(value);if(value==='no-focus-change')throw new TypeError('Unsupported enum');}}
  mockGlobal(t,'CaptureController',Controller);
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(options){pickerCalls++;assert.ok(options.controller instanceof Controller);assert.deepEqual(focusCalls,['no-focus-change','focus-capturing-application']);return Promise.resolve(s);}}});
  const chooser=createScreenCapture(),result=await chooser.choose();
  assert.equal(pickerCalls,1);assert.deepEqual(focusCalls,['no-focus-change','focus-capturing-application','focus-capturing-application']);
  result.source.stop();chooser.destroy();
});

test('an unavailable focus controller is omitted and does not block capture',async t=>{
  mockDom(t);const s=stream();let pickerCalls=0;
  class Controller{setFocusBehavior(){throw new DOMException('Unavailable','NotSupportedError');}}
  mockGlobal(t,'CaptureController',Controller);
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(options){pickerCalls++;assert.equal('controller' in options,false);return Promise.resolve(s);}}});
  const chooser=createScreenCapture(),result=await chooser.choose();assert.equal(pickerCalls,1);result.source.stop();chooser.destroy();
});

test('monitor captures keep the pre-picker hint without an invalid post-resolution focus call',async t=>{
  mockDom(t);const s=stream(),focusCalls=[];s.tracks[0].getSettings=()=>({displaySurface:'monitor'});
  class Controller{setFocusBehavior(value){focusCalls.push(value);}}
  mockGlobal(t,'CaptureController',Controller);mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia:()=>Promise.resolve(s)}});
  const chooser=createScreenCapture(),result=await chooser.choose();assert.deepEqual(focusCalls,['no-focus-change']);result.source.stop();chooser.destroy();
});

test('a browser declining the final focus hint does not retry the picker or discard the pin',async t=>{
  mockDom(t);const s=stream();let focusCalls=0,pickerCalls=0;s.tracks[0].getSettings=()=>({displaySurface:'browser'});
  class Controller{setFocusBehavior(){if(++focusCalls>1)throw new DOMException('Focus already finalized','InvalidStateError');}}
  mockGlobal(t,'CaptureController',Controller);mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(){pickerCalls++;return Promise.resolve(s);}}});
  const chooser=createScreenCapture(),result=await chooser.choose();assert.equal(pickerCalls,1);assert.equal(s.tracks[0].stopped,0);assert.ok(result.source);result.source.stop();chooser.destroy();
});

test('focus diagnostics distinguish API support, accepted hint and observed page focus',async t=>{
  const {doc}=mockDom(t),s=stream(),records=[];s.tracks[0].getSettings=()=>({displaySurface:'browser'});doc.hasFocus=()=>false;doc.visibilityState='hidden';
  class Controller{setFocusBehavior(){}}
  mockGlobal(t,'CaptureController',Controller);mockGlobal(t,'navigator',{userAgent:'Test Chromium',mediaDevices:{getDisplayMedia:()=>Promise.resolve(s)}});
  const chooser=createScreenCapture({log:(message,detail)=>records.push({message,detail})}),result=await chooser.choose();
  const focus=records.filter(record=>record.message==='Screen capture focus').map(record=>record.detail);
  assert.deepEqual(focus.map(record=>record.stage),['support','preference-set','hint-accepted','first-frame']);
  assert.ok(focus.every(record=>record.requestId===focus[0].requestId));
  assert.equal(focus[0].available,true);assert.equal(focus[0].method,true);assert.equal(focus[2].surface,'browser');
  assert.equal(focus.at(-1).focused,false);assert.equal(focus.at(-1).visibility,'hidden');
  result.source.stop();chooser.destroy();
});

test('a live pin crop reuses its full source and initial region without a new browser request',async t=>{
  const {doc,find}=mockDom(t),s=stream();let calls=0;
  mockGlobal(t,'navigator',{mediaDevices:{getDisplayMedia(){calls++;return Promise.resolve(s);}}});
  const chooser=createScreenCapture(),{source}=await chooser.choose(),region={x:.25,y:.25,width:.5,height:.5};
  const pending=chooser.editRegion({source,kind:'pin',region});
  const dialog=find(doc.body,item=>item.tagName==='DIALOG');assert.ok(dialog?.open);
  find(dialog,item=>item.textContent==='Apply crop').dispatchEvent(new Event('click'));
  const result=await pending;assert.equal(calls,1);assert.deepEqual(result.region,region);assert.equal(result.frame.width,960);assert.equal(result.frame.height,540);
  assert.equal(s.tracks[0].stopped,0);assert.equal(source.capture().width,1600);source.stop();chooser.destroy();
});

test('saved-image cropping changes only the returned image and never mutates the original canvas',async t=>{
  const {doc,find}=mockDom(t),frame=doc.createElement('canvas');frame.width=800;frame.height=400;
  const chooser=createScreenCapture(),pending=chooser.editRegion({frame,kind:'snapshot',region:{x:.25,y:0,width:.5,height:1}});
  const dialog=find(doc.body,item=>item.tagName==='DIALOG');find(dialog,item=>item.textContent==='Apply crop').dispatchEvent(new Event('click'));
  const result=await pending;assert.equal(result.frame.width,400);assert.equal(result.frame.height,400);assert.equal(frame.width,800);assert.equal(frame.height,400);
  assert.notStrictEqual(result.frame,frame);chooser.destroy();
});

test('canceling or destroying a borrowed-source crop keeps its stream and original frame intact',async t=>{
  const {doc,find}=mockDom(t),frame=doc.createElement('canvas'),s=stream();frame.width=800;frame.height=400;let stops=0;
  const source={stream:s,label:'Existing pin',capture:()=>frame,stop(){stops++;}};
  const chooser=createScreenCapture(),first=chooser.editRegion({source,kind:'pin'});
  find(doc.body,item=>item.tagName==='DIALOG').dispatchEvent(new Event('cancel',{cancelable:true}));assert.equal(await first,null);
  const second=chooser.editRegion({source,kind:'pin'});chooser.destroy();assert.equal(await second,null);
  assert.equal(stops,0);assert.equal(s.tracks[0].stopped,0);assert.equal(frame.width,800);assert.equal(frame.height,400);
});

test('a source ending during crop rejects cleanly without taking ownership of its tracks',async t=>{
  const {doc,find}=mockDom(t),frame=doc.createElement('canvas'),s=stream();let stops=0;
  const source={stream:s,capture:()=>frame,stop(){stops++;}},chooser=createScreenCapture(),pending=chooser.editRegion({source,kind:'pin'});
  const dialog=find(doc.body,item=>item.tagName==='DIALOG'),failure=assert.rejects(pending,{name:'NotReadableError'});
  s.tracks[0].readyState='ended';s.tracks[0].dispatchEvent(new Event('ended'));await failure;
  assert.equal(dialog.isConnected,false);assert.equal(stops,0);assert.equal(s.tracks[1].stopped,0);chooser.destroy();
});
