import test from 'node:test';
import assert from 'node:assert/strict';
import {setupCaptureBoard} from '../dist/capture-board.js';
import {validateCaptureRecord} from '../dist/capture-store.js';
import {createCaptureGallery} from '../dist/capture-gallery.js';

/** Minimal DOM/media boundaries; every capture mutation uses the real board. */
function harness(t,{deferEncoding=false}={}) {
  const savedGlobals=new Map(),rows=new Map(),writes=[],uploads=[],encoders=[],boards=[],imageUrls=new Map();
  let ids=new Map(),callbacks,doc;
  function install(name,value){savedGlobals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});}
  class Element {
    constructor(tag='div'){
      this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes=new Map();this.listeners=new Map();
      this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.innerHTML='';this.style={};this.width=640;this.height=400;this.isConnected=true;
      const classes=new Set();this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle(name,force){const on=force??!classes.has(name);if(on)classes.add(name);else classes.delete(name);return on;}};
      const context={measureText:text=>({width:text.length*6}),drawImage:source=>{this.frameTag=source.frameTag;},fillText:text=>{this.caption=text;}};
      this.context=new Proxy(context,{get:(target,key)=>key in target?target[key]:()=>{}});
    }
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    addEventListener(name,callback){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(callback);}
    removeEventListener(name,callback){this.listeners.get(name)?.delete(callback);}
    dispatch(name,event={}){for(const callback of this.listeners.get(name)||[])callback({target:this,preventDefault(){},...event});}
    click(){if(!this.disabled)this.dispatch('click');}
    append(...nodes){for(const node of nodes){node.remove?.();this.children.push(node);node.parentNode=this;}}
    insertBefore(node,before){node.remove?.();const index=this.children.indexOf(before);this.children.splice(index<0?this.children.length:index,0,node);node.parentNode=this;}
    remove(){if(this.parentNode){const siblings=this.parentNode.children,index=siblings.indexOf(this);if(index>=0)siblings.splice(index,1);}this.parentNode=null;}
    getContext(){return this.context;}
    getClientRects(){return this.hidden?[]:[{}];}
    toBlob(callback,type='image/png'){
      const tag=this.frameTag||'test-frame',width=this.width,height=this.height;
      const finish=()=>{const blob=new Blob([tag],{type});blob.frameWidth=width;blob.frameHeight=height;callback(blob);};
      if(deferEncoding)encoders.push(finish);else queueMicrotask(finish);
    }
    focus(){doc.activeElement=this;}
    blur(){doc.activeElement=null;this.dispatch('change');}
    scrollIntoView(){}
    showModal(){this.open=true;}
    close(){this.open=false;}
  }
  const element=id=>{if(!ids.has(id)){const node=new Element();node.id=id;if(id==='defaultPinFps')node.value='10';ids.set(id,node);}return ids.get(id);};
  doc={body:new Element('body'),activeElement:null,getElementById:element,createElement:tag=>new Element(tag),querySelector:selector=>element(selector)};
  const window={addEventListener(){},removeEventListener(){}};window.top=window.self=window;
  install('document',doc);install('window',window);install('isSecureContext',true);
  install('navigator',{mediaDevices:{getDisplayMedia(){},getUserMedia(){}}});
  install('URL',class extends URL {
    static createObjectURL(blob){const id=`blob:roofcat-test/${imageUrls.size}`;imageUrls.set(id,blob);return id;}
    static revokeObjectURL(id){imageUrls.delete(id);}
  });
  install('Image',class {naturalWidth=640;naturalHeight=400;set src(value){
    this.url=value;const blob=imageUrls.get(value);this.naturalWidth=blob?.frameWidth||640;this.naturalHeight=blob?.frameHeight||400;
    Promise.resolve(blob?.text()).then(tag=>{this.frameTag=tag;this.onload?.();});
  }});
  install('IntersectionObserver',undefined);
  const hardware={supported:true,connected:true,status:'connected',pendingKeys:[],deviceName:'Test keypad'};
  const createStore=()=>({
    async load(){return [...rows.values()].sort((a,b)=>a.index-b.index).map(value=>({...value,paused:true}));},
    async save(record){const safe=validateCaptureRecord(record);writes.push(['save',safe.index]);rows.set(safe.index,safe);},
    async remove(index){writes.push(['remove',index]);rows.delete(index);},
    async updateSlots(records,indices){const safe=records.map(validateCaptureRecord);writes.push(['swap',...indices]);for(const index of indices)rows.delete(index);for(const record of safe)rows.set(record.index,record);},
    close(){},
  });
  function start(options={}){
    const board=setupCaptureBoard({createStore,createScreen:()=>({destroy(){},choose:()=>Promise.resolve(null)}),createKeypad:options=>{
      callbacks=options;return {getState:()=>hardware,detect:async()=>hardware,destroy:async()=>{},
        async setKeyImages(frames){assert.equal(frames.length,9,'USB receives exactly nine physical tiles');uploads.push(frames.slice());return {status:'sent',deviceAccepted:true,sentAt:Date.now()};},
        async setKeyImage(index){assert(index>=0&&index<9,'overflow must never be sent as a physical address');return {status:'sent'};},
      };
    },...options});boards.push(board);return board;
  }
  t.after(()=>{for(const board of boards)board.destroy();for(const [name,descriptor] of savedGlobals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  return {start,rows,writes,uploads,element,Element,
    frame(name='frame'){const canvas=new Element('canvas');canvas.frameTag=name;return canvas;},
    hardwarePress(index){callbacks.onKey({index,pressed:true});},
    navigate(direction='next'){callbacks.onNavigation({direction,pressed:true});},
    releaseEncodings(){while(encoders.length)encoders.shift()();},
    pendingEncodings:()=>encoders.length,
    resetDom(){ids=new Map();doc.activeElement=null;doc.body=new Element('body');},body:()=>doc.body,
    physicalIndices(){return element('keypadGrid').children.map(wrapper=>Number(wrapper.children[0].dataset.captureIndex));},
  };
}

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function addPhotos(board,h,count){return Array.from({length:count},(_,index)=>board.addSnapshot(h.frame(`frame-${index}`),{title:`Photo ${index+1}`,present:false,quiet:true}));}
function lease(h,name){return {kind:'aux-camera',label:name,deviceId:'shared-scene',stops:0,isActive:()=>true,
  resumeHint:{kind:'aux-camera',deviceId:'shared-scene',label:'Scene',width:640,height:400},
  capture:()=>h.frame(name),stop(){this.stops++;}};}

test('the real board accepts, persists, reloads and displays twelve captures while USB stays at nine',async t=>{
  const h=harness(t),board=h.start();await board.ready;
  const photos=addPhotos(board,h,12);assert(photos.every(Boolean));await board.flushPersistence();await tick();
  assert.equal(board.getState().captures.length,12);assert.equal(h.rows.size,12);
  assert.equal(h.element('screenSnapshotButton').disabled,false);assert.equal(h.element('pinRegionButton').disabled,false);
  assert.deepEqual(h.physicalIndices(),[0,1,2,3,4,5,6,7,8]);
  assert.deepEqual(board.getGalleryState().captures.map(item=>item.keyIndex),[0,1,2,3,4,5,6,7,8,null,null,null]);
  assert.equal(board.getGalleryState().captures,board.getGalleryState().captures,'animation reads reuse ordering instead of rebuilding every frame');
  board.pressSlot(11);assert.equal(board.getSelection().index,11);assert.equal(board.getSelection().keyIndex,null);
  assert.equal(h.element('captureFocusLabel').textContent,'CAPTURE 12');
  assert.equal(h.element('#boardView .cb-dock').children.at(-1).children.length,3);
  board.destroy();h.resetDom();const restored=h.start();await restored.ready;
  assert.deepEqual(restored.getState().captures.map(item=>item.title),Array.from({length:12},(_,i)=>`Photo ${i+1}`));
  assert.equal(restored.getGalleryState().captures.length,12);assert.deepEqual(h.physicalIndices(),[0,1,2,3,4,5,6,7,8]);
});

test('direct deletion promotes the tenth capture onto key nine; Undo restores order without rewriting other blobs',async t=>{
  const h=harness(t),board=h.start();await board.ready;addPhotos(board,h,10);await board.flushPersistence();
  const image=h.rows.get(9).image,writeCount=h.writes.length;
  assert.equal(board.removeCapture(0),true);await board.flushPersistence();
  assert.deepEqual(h.physicalIndices(),[1,2,3,4,5,6,7,8,9]);assert.equal(h.rows.get(9).image,image);
  assert.deepEqual(h.writes.slice(writeCount),[['remove',0]],'only the removed record is written');
  board.pressSlot(9);assert.equal(h.element('keypadGrid').children[8].children[0].classList.contains('is-selected'),true);
  h.hardwarePress(8);assert.equal(board.getSelection().index,9,'physical key nine addresses the promoted capture');
  assert.equal(board.getGalleryState().canUndo,true);h.element('undoCaptureAction').click();await board.flushPersistence();
  assert.deepEqual(h.physicalIndices(),[0,1,2,3,4,5,6,7,8]);assert.equal(h.rows.size,10);assert.equal(board.getGalleryState().canUndo,false);
  const trash=h.element('keypadGrid').children[0].children[1];assert.match(trash.innerHTML,/#i-trash/);trash.click();await board.flushPersistence();assert.equal(h.rows.has(0),false);
});

test('reordering across the ninth-key boundary keeps the same live pin, source and timer, including Undo',async t=>{
  const h=harness(t),board=h.start();await board.ready;addPhotos(board,h,8);
  const source=lease(h,'pin'),pin=board.addPin(source,{fps:.2,present:false,quiet:true,title:'Live pin'}),timer=pin.timer;
  addPhotos(board,h,3);await board.flushPersistence();
  h.navigate();h.navigate();board.pressSlot(8);board.pressSlot(11);await board.flushPersistence();
  assert.equal(pin.index,11);assert.equal(pin.source,source);assert.equal(pin.timer,timer);assert.equal(source.stops,0);
  assert.equal(board.getGalleryState().captures.find(item=>item.index===11).keyIndex,null);
  assert.equal(h.rows.get(11).kind,'pin');assert.equal(h.rows.get(8).kind,'snapshot');
  h.element('undoCaptureAction').click();await board.flushPersistence();
  assert.equal(pin.index,8);assert.equal(pin.timer,timer);assert.equal(source.stops,0);assert.equal(h.rows.get(8).kind,'pin');
});

test('removing one of twelve shared-camera pins releases only its own lease and Undo stays paused',async t=>{
  const h=harness(t),board=h.start();await board.ready;
  const sources=Array.from({length:12},(_,i)=>lease(h,`pin-${i}`));
  sources.forEach(source=>assert(board.addPin(source,{fps:.2,present:false,quiet:true})));await board.flushPersistence();
  board.removeCapture(3);await board.flushPersistence();
  assert.deepEqual(sources.map(source=>source.stops),[0,0,0,1,0,0,0,0,0,0,0,0]);
  h.element('undoCaptureAction').click();await board.flushPersistence();
  assert.equal(board.getState().captures.find(item=>item.index===3).paused,true);
  assert.deepEqual(sources.map(source=>source.stops),[0,0,0,1,0,0,0,0,0,0,0,0]);
});

test('late image encodings cannot resurrect a deleted capture, including after an overflow reorder',async t=>{
  const h=harness(t,{deferEncoding:true}),board=h.start();await board.ready;addPhotos(board,h,10);
  h.navigate();h.navigate();board.pressSlot(0);board.pressSlot(9);board.removeCapture(9);
  h.releaseEncodings();await board.flushPersistence();
  assert.equal(h.rows.has(9),false);assert.equal(h.rows.size,9);assert.equal(h.rows.get(0).title,'Photo 10');
  assert.equal([...h.rows.values()].some(item=>item.title==='Photo 1'),false);
  h.element('undoCaptureAction').click();h.releaseEncodings();await board.flushPersistence();
  assert.equal(h.rows.get(9).title,'Photo 1');assert.equal(h.rows.size,10);
});

test('shared gallery keeps direct trash and settings available for overflow without claiming a tenth hardware key',t=>{
  const h=harness(t),container=new h.Element(),events=[];
  const gallery=createCaptureGallery({container,onDelete:index=>events.push(['delete',index]),onConfigure:index=>events.push(['configure',index]),onPress:index=>events.push(['press',index])});
  t.after(()=>gallery.destroy());
  gallery.render({mode:'normal',selected:9,firstReorderKey:null,disabled:false,captures:[{index:9,keyIndex:null,kind:'pin',title:'Notebook',frame:h.frame(),updatedAt:'now'}]});
  const children=container.children[0].children;
  const preview=children.find(element=>element.className==='call-capture-tile');
  const trash=children.find(element=>element.className==='call-capture-delete');
  const settings=children.find(element=>element.className==='call-capture-settings');
  assert.match(trash.innerHTML,/#i-trash/);assert.match(trash.getAttribute('aria-label'),/capture 10/);assert.doesNotMatch(trash.getAttribute('aria-label'),/key 10/);
  trash.click();settings.click();preview.click();assert.deepEqual(events,[['delete',9],['configure',9],['press',9]]);
});

test('document gallery wands update through board revisions and target the correct capture without presenting or deleting',async t=>{
  const h=harness(t),events=[],presented=[],board=h.start({enhanceFrame:scanRenderer(h),onPick:value=>presented.push(value)});await board.ready;
  board.addSnapshot(h.frame('paper'),{documentKind:'paper',scanEnhanced:false,title:'Paper',present:false,quiet:true});
  addPhotos(board,h,8);
  board.addSnapshot(h.frame('notebook'),{documentKind:'notebook',title:'Notebook',present:false,quiet:true});
  const container=new h.Element(),gallery=createCaptureGallery({container,
    onToggleEnhancement:index=>{events.push(['toggle',index]);board.toggleScanEnhancement(index);},
    onPress:index=>{events.push(['present',index]);board.pressSlot(index);},
    onDelete:index=>{events.push(['delete',index]);board.removeCapture(index);}});
  t.after(()=>gallery.destroy());
  const render=()=>gallery.render(board.getGalleryState());
  const wand=index=>container.children.find(card=>Number(card.dataset.captureIndex)===index).children.find(element=>element.className==='call-capture-enhance');
  render();assert.equal(container.children.length,10);
  assert.equal(wand(0).hidden,false);assert.equal(wand(0).getAttribute('aria-pressed'),'false');assert.match(wand(0).getAttribute('aria-label'),/Apply scan filter.*key 1/);
  assert.equal(wand(1).hidden,true,'an ordinary capture does not offer scan processing');
  assert.equal(wand(9).hidden,false);assert.equal(wand(9).getAttribute('aria-pressed'),'true');assert.match(wand(9).getAttribute('aria-label'),/Remove scan filter.*capture 10/);
  const before=board.getGalleryState(),selected=board.getSelection().index;
  wand(9).click();const after=board.getGalleryState();assert.equal(before.captures,after.captures,'the capture list stays cached');assert(after.revision>before.revision);
  render();assert.equal(wand(9).getAttribute('aria-pressed'),'false');assert.equal(wand(9).classList.contains('is-active'),false);
  const preview=container.children[9].children.find(element=>element.className==='call-capture-tile').children[0];
  assert.equal(preview.frameTag,'notebook');
  wand(0).click();render();assert.equal(wand(0).getAttribute('aria-pressed'),'true');assert.equal(wand(0).classList.contains('is-active'),true);
  assert.deepEqual(events,[['toggle',9],['toggle',0]]);assert.deepEqual(presented,[]);assert.equal(board.getSelection().index,selected);assert.equal(board.getState().captures.length,10);
  // The independently rendered overflow gallery forwards the same stable index.
  const overflow=h.element('#boardView .cb-dock').children.at(-1);
  const overflowWand=overflow.children[0].children.find(element=>element.className==='call-capture-enhance');
  assert.equal(overflowWand.getAttribute('aria-pressed'),'false');overflowWand.click();
  assert.equal(board.getGalleryState().captures[9].scanEnhanced,true);assert.equal(overflowWand.getAttribute('aria-pressed'),'true');
  assert.deepEqual(presented,[]);assert.equal(board.getState().captures.length,10);
  gallery.render({...board.getGalleryState(),disabled:true});const count=events.length;wand(0).click();assert.equal(events.length,count);
  await board.flushPersistence();
});

const perspective={type:'perspective',quad:[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}]};
const find=(element,predicate)=>predicate(element)?element:element.children.map(child=>find(child,predicate)).find(Boolean);

for(const {name,transform,initialSize,croppedSize} of [
  {name:'planar surface',transform:perspective,initialSize:[384,320],croppedSize:[230,160]},
  {name:'upside-down page',transform:{type:'perspective',quad:[perspective.quad[2],perspective.quad[3],perspective.quad[0],perspective.quad[1]]},initialSize:[384,320],croppedSize:[230,160]},
  {name:'slightly rotated crop',transform:{...perspective,rotationDegrees:-8.25},initialSize:[426,372],croppedSize:[256,186]},
])test(`the ${name} keeps its fixed correction through Crop, storage, reload and exact-camera resume`,async t=>{
  const h=harness(t),region={x:.1,y:.2,width:.6,height:.5};let editorSource,providedHint;
  const board=h.start({createScreen:()=>({destroy(){},choose:async()=>null,
    async editRegion(options){editorSource=options.source;return {region};}})});await board.ready;
  const original=lease(h,'actual-camera-pixels'),pin=board.addPin(original,{transform,
    region:{x:.15,y:.05,width:.7,height:.9},fps:.2,present:false,quiet:true});
  assert.ok(pin);assert.notEqual(pin.source,original);assert.deepEqual(pin.transform,transform);
  assert.deepEqual(pin.region,{x:0,y:0,width:1,height:1},'the original model box is not applied twice after correction');
  assert.deepEqual([pin.frame.width,pin.frame.height],initialSize);assert.equal(pin.frame.frameTag,'actual-camera-pixels');
  await board.flushPersistence();assert.deepEqual(h.rows.get(0).transform,transform);assert.deepEqual(h.rows.get(0).sourceHint.transform,transform);
  assert.equal(board.configureCapture(0),true);
  find(h.body(),element=>element.tagName==='BUTTON'&&element.textContent==='Crop').click();await tick();await board.flushPersistence();
  assert.equal(editorSource,pin.source);assert.deepEqual(pin.region,region);assert.deepEqual([pin.frame.width,pin.frame.height],croppedSize);
  find(h.body(),element=>element.tagName==='BUTTON'&&element.textContent==='Done').click();await board.flushPersistence();
  const saved=h.rows.get(0);assert.deepEqual(saved.region,region);assert.deepEqual(saved.transform,transform);
  assert.equal(saved.sourceHint.width,640);assert.equal(saved.sourceHint.height,400,'resume identity retains the original camera format');
  board.destroy();assert.equal(original.stops,1);h.resetDom();
  const reopened=lease(h,'new-real-camera-pixels');
  const restored=h.start({onResumeScenePin:async hint=>{providedHint=hint;return reopened;}});await restored.ready;
  assert.equal(restored.getState().captures[0].paused,true);h.element('resharePin').click();await tick();await tick();await restored.flushPersistence();
  assert.deepEqual(providedHint.transform,transform);assert.equal(restored.getState().captures[0].paused,false);
  const capture=restored.getGalleryState().captures[0];assert.deepEqual([capture.frame.width,capture.frame.height],croppedSize);
  assert.equal(capture.frame.frameTag,'new-real-camera-pixels');assert.deepEqual(h.rows.get(0).region,region);assert.deepEqual(h.rows.get(0).transform,transform);
  restored.removeCapture(0);assert.equal(reopened.stops,1);assert.equal(original.stops,1);
});

test('multiple corrected pins keep independent leases and main-camera transforms persist without a false scene resume identity',async t=>{
  const h=harness(t),board=h.start();await board.ready;
  const a=lease(h,'scene-A'),b=lease(h,'scene-B');
  const first=board.addPin(a,{transform:perspective,fps:.2,present:false,quiet:true});
  const second=board.addPin(b,{transform:perspective,fps:.2,present:false,quiet:true});
  assert.ok(first&&second);assert.notEqual(first.source,second.source);
  board.removeCapture(first.index);assert.equal(a.stops,1);assert.equal(b.stops,0);assert.equal(second.source.isActive(),true);
  const main={...lease(h,'main'),kind:'camera',resumeHint:undefined,deviceId:undefined};
  const mainPin=board.addPin(main,{transform:perspective,fps:.2,present:false,quiet:true});await board.flushPersistence();
  assert.deepEqual(h.rows.get(mainPin.index).transform,perspective);assert.equal(h.rows.get(mainPin.index).sourceHint,undefined);
  board.stopPrimaryPins();assert.equal(main.stops,1);assert.equal(b.stops,0);
  board.stopAuxiliaryPins();assert.equal(b.stops,1);assert.equal(a.stops,1);
});

function scanRenderer(h,calls=[]){
  return frame=>{
    calls.push(frame.frameTag);
    assert.doesNotMatch(frame.frameTag||'',/^scan\(/,'a scan is always derived from original pixels');
    const enhanced=h.frame(`scan(${frame.frameTag})`);enhanced.width=frame.width;enhanced.height=frame.height;return enhanced;
  };
}

test('document snapshots keep original pixels through repeated wand toggles, storage and reload',async t=>{
  const h=harness(t),calls=[],enhanceFrame=scanRenderer(h,calls),board=h.start({enhanceFrame});await board.ready;
  const source=h.frame('original-paper'),photo=board.addSnapshot(source,{documentKind:'paper',present:false,quiet:true});
  assert.notEqual(photo.rawFrame,source);assert.equal(photo.rawFrame.frameTag,'original-paper');
  assert.equal(photo.scanEnhanced,true);assert.equal(photo.frame.frameTag,'scan(original-paper)');
  assert.equal(board.getGalleryState().captures[0].documentKind,'paper');
  assert.equal(board.getGalleryState().captures[0].scanEnhanced,true);
  assert.equal(h.element('captureFocusCanvas').frameTag,'scan(original-paper)');
  assert.equal(h.element('keypadGrid').children[0].children[0].children[0].frameTag,'scan(original-paper)');
  const wand=h.element('keypadGrid').children[0].children[3];
  assert.equal(wand.hidden,false);assert.match(wand.innerHTML,/#i-wand/);assert.equal(wand.getAttribute('aria-pressed'),'true');
  await board.flushPersistence();
  assert.equal(h.rows.get(0).image.type,'image/png');assert.equal(await h.rows.get(0).image.text(),'original-paper');
  assert.equal(h.rows.get(0).scanEnhanced,true);
  wand.click();assert.equal(wand.getAttribute('aria-pressed'),'false');assert.equal(photo.frame,photo.rawFrame);
  assert.equal(h.element('captureFocusCanvas').frameTag,'original-paper');
  assert.equal(h.element('keypadGrid').children[0].children[0].children[0].frameTag,'original-paper');
  await board.flushPersistence();assert.equal(h.rows.get(0).scanEnhanced,false);
  assert.equal(board.toggleScanEnhancement(0),true);await board.flushPersistence();
  assert.deepEqual(calls,['original-paper','original-paper']);
  board.destroy();h.resetDom();const restored=h.start({enhanceFrame});await restored.ready;
  const restoredPhoto=restored.getGalleryState().captures[0];
  assert.equal(restoredPhoto.scanEnhanced,true);assert.equal(restoredPhoto.frame.frameTag,'scan(original-paper)');
  assert.equal(restored.toggleScanEnhancement(0),true);assert.equal(restoredPhoto.frame.frameTag,'original-paper');
  await restored.flushPersistence();assert.equal(h.rows.get(0).scanEnhanced,false);assert.equal(await h.rows.get(0).image.text(),'original-paper');
  assert.equal(source.frameTag,'original-paper','the caller-owned frame is never modified');
});

test('ordinary captures never receive automatic scan filtering or a working wand',async t=>{
  const h=harness(t);let calls=0;const board=h.start({enhanceFrame:()=>{calls++;throw new Error('not expected');}});await board.ready;
  for(const documentKind of [undefined,null,'none','phone','Notebook',{kind:'paper'}]){
    const photo=board.addSnapshot(h.frame('unaltered'),{documentKind,scanEnhanced:true,title:'Notebook',present:false,quiet:true});
    assert.equal(photo.documentKind,null);assert.equal(photo.scanEnhanced,false);assert.equal(photo.frame,photo.rawFrame);
    assert.equal(board.toggleScanEnhancement(photo.index),false);
    assert.equal(h.element('keypadGrid').children[photo.index].children[3].hidden,true);
  }
  await board.flushPersistence();assert.equal(calls,0);
  for(const row of h.rows.values()){assert.equal(row.documentKind,undefined);assert.equal(row.scanEnhanced,undefined);}
});

test('a live corrected document is filtered after geometry, updates from raw frames and toggles without opening a source',async t=>{
  const h=harness(t),calls=[],board=h.start({enhanceFrame:scanRenderer(h,calls)});await board.ready;
  let captured=0;const source=lease(h,'scene');source.capture=()=>h.frame(`scene-${++captured}`);
  const pin=board.addPin(source,{documentKind:'notebook',transform:perspective,fps:.2,present:false,quiet:true});
  assert.deepEqual([pin.frame.width,pin.frame.height],[384,320]);assert.equal(pin.frame.frameTag,'scan(scene-1)');
  const timer=pin.timer,leaseReference=pin.source;
  board.toggleScanEnhancement(0);board.toggleScanEnhancement(0);
  assert.equal(captured,1);assert.equal(pin.timer,timer);assert.equal(pin.source,leaseReference);assert.equal(source.stops,0);
  h.element('pausePin').click();assert.equal(pin.paused,true);
  h.element('pausePin').click();assert.equal(pin.paused,false);assert.equal(captured,2);
  assert.equal(pin.rawFrame.frameTag,'scene-2');assert.equal(pin.frame.frameTag,'scan(scene-2)');
  h.element('snapshotPin').click();const snapshot=board.getGalleryState().captures[1];
  assert.equal(snapshot.documentKind,'notebook');assert.equal(snapshot.scanEnhanced,true);assert.equal(snapshot.frame.frameTag,'scan(scene-2)');
  board.toggleScanEnhancement(1);assert.equal(snapshot.frame.frameTag,'scene-2');assert.equal(pin.scanEnhanced,true);
  await board.flushPersistence();assert.equal(await h.rows.get(1).image.text(),'scene-2');assert.equal(h.rows.get(1).scanEnhanced,false);
  assert.deepEqual(calls,['scene-1','scene-1','scene-2','scene-2']);
});

test('static document crop edits use original pixels before reapplying one scan filter',async t=>{
  const h=harness(t),calls=[];let editorFrame;
  const board=h.start({enhanceFrame:scanRenderer(h,calls),createScreen:()=>({destroy(){},choose:async()=>null,
    async editRegion(options){editorFrame=options.frame;const frame=h.frame(`${options.frame.frameTag}/crop`);frame.width=320;frame.height=200;return {region:{x:.1,y:.2,width:.5,height:.5},frame};}})});await board.ready;
  const photo=board.addSnapshot(h.frame('sheet'),{documentKind:'paper',present:false,quiet:true});
  assert.equal(board.configureCapture(0),true);find(h.body(),element=>element.tagName==='BUTTON'&&element.textContent==='Crop').click();await tick();
  assert.equal(editorFrame.frameTag,'sheet');assert.equal(photo.rawFrame.frameTag,'sheet/crop');assert.equal(photo.frame.frameTag,'scan(sheet/crop)');
  assert.deepEqual([photo.frame.width,photo.frame.height],[320,200]);assert.deepEqual(calls,['sheet','sheet/crop']);
  find(h.body(),element=>element.tagName==='BUTTON'&&element.textContent==='Done').click();await board.flushPersistence();
  board.toggleScanEnhancement(0);assert.equal(photo.frame.frameTag,'sheet/crop');await board.flushPersistence();
  assert.equal(await h.rows.get(0).image.text(),'sheet/crop');assert.equal(h.rows.get(0).scanEnhanced,false);
});

test('document preference survives paused-camera reload and exact-source resume without extra filtering when off',async t=>{
  const h=harness(t),calls=[],enhanceFrame=scanRenderer(h,calls),board=h.start({enhanceFrame});await board.ready;
  const source=lease(h,'old-camera');board.addPin(source,{documentKind:'notebook',scanEnhanced:false,transform:perspective,fps:.2,present:false,quiet:true});
  await board.flushPersistence();assert.deepEqual(calls,[]);board.destroy();h.resetDom();
  const reopened=lease(h,'reconnected-camera'),restored=h.start({enhanceFrame,onResumeScenePin:async()=>reopened});await restored.ready;
  const savedPreview=restored.getGalleryState().captures[0];assert.equal(savedPreview.scanEnhanced,false);assert.equal(savedPreview.paused,true);
  assert.equal(savedPreview.frame.frameTag,'old-camera');h.element('resharePin').click();await tick();await tick();await restored.flushPersistence();
  const resumed=restored.getGalleryState().captures[0];assert.equal(resumed.documentKind,'notebook');assert.equal(resumed.scanEnhanced,false);
  assert.equal(resumed.frame.frameTag,'reconnected-camera');assert.equal(resumed.paused,false);assert.deepEqual(calls,[]);
  restored.toggleScanEnhancement(0);assert.equal(resumed.frame.frameTag,'scan(reconnected-camera)');assert.deepEqual(calls,['reconnected-camera']);
});

test('scan preference and raw pixels survive out-of-order encodings, reorder, deletion and Undo',async t=>{
  const h=harness(t,{deferEncoding:true}),board=h.start({enhanceFrame:scanRenderer(h)});await board.ready;
  board.addSnapshot(h.frame('page-A'),{documentKind:'paper',present:false,quiet:true});
  board.addSnapshot(h.frame('page-B'),{documentKind:'notebook',present:false,quiet:true});
  board.toggleScanEnhancement(0);h.navigate();h.navigate();board.pressSlot(0);board.pressSlot(1);
  assert.equal(board.getGalleryState().captures[1].scanEnhanced,false);board.removeCapture(1);
  h.releaseEncodings();await board.flushPersistence();assert.equal(h.rows.size,1);assert.equal(await h.rows.get(0).image.text(),'page-B');
  h.element('undoCaptureAction').click();h.releaseEncodings();await board.flushPersistence();
  assert.equal(h.rows.get(1).scanEnhanced,false);assert.equal(h.rows.get(1).documentKind,'paper');assert.equal(await h.rows.get(1).image.text(),'page-A');
  assert.equal(board.getGalleryState().captures[1].frame.frameTag,'page-A');
});

test('rapid wand changes share an in-flight raw encoding while only the latest preference reaches storage',async t=>{
  const h=harness(t,{deferEncoding:true}),board=h.start({enhanceFrame:scanRenderer(h)});await board.ready;
  board.addSnapshot(h.frame('one-original'),{documentKind:'paper',present:false,quiet:true});
  assert.equal(h.pendingEncodings(),1);
  for(let change=0;change<21;change++)assert.equal(board.toggleScanEnhancement(0),true);
  assert.equal(h.pendingEncodings(),1,'rapid preferences must not allocate a full PNG conversion each');
  h.releaseEncodings();await board.flushPersistence();
  assert.equal(h.writes.length,1);assert.equal(h.rows.get(0).scanEnhanced,false);assert.equal(await h.rows.get(0).image.text(),'one-original');
  board.toggleScanEnhancement(0);assert.equal(h.pendingEncodings(),1,'finished conversions are not retained as a second compressed image in memory');
  h.releaseEncodings();await board.flushPersistence();assert.equal(h.rows.get(0).scanEnhanced,true);
});

test('filter errors keep the current real frame and healthy camera live, persist an honest off state, and allow retry',async t=>{
  const h=harness(t),reports=[];let fail=false;
  const render=scanRenderer(h),board=h.start({enhanceFrame:frame=>{if(fail)throw new Error('pixel read failed');return render(frame);},toast:(...message)=>reports.push(message)});await board.ready;
  let captured=0;const source=lease(h,'camera');source.capture=()=>h.frame(`camera-${++captured}`);
  const pin=board.addPin(source,{documentKind:'paper',fps:.2,present:false,quiet:true});
  fail=true;h.element('pausePin').click();h.element('pausePin').click();await board.flushPersistence();
  assert.equal(pin.paused,false);assert.equal(source.stops,0);assert.equal(pin.scanEnhanced,false);assert.equal(pin.frame,pin.rawFrame);
  assert.equal(pin.frame.frameTag,'camera-2');assert.equal(h.rows.get(0).scanEnhanced,false);assert.equal(await h.rows.get(0).image.text(),'camera-2');
  assert.equal(reports.filter(([message])=>message.includes('Scan filter unavailable')).length,1);
  assert.equal(board.toggleScanEnhancement(0),false);assert.equal(pin.scanEnhanced,false);assert.equal(pin.frame.frameTag,'camera-2');
  fail=false;assert.equal(board.toggleScanEnhancement(0),true);assert.equal(pin.frame.frameTag,'scan(camera-2)');assert.equal(captured,2);
  await board.flushPersistence();assert.equal(h.rows.get(0).scanEnhanced,true);
});
