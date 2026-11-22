import test from 'node:test';
import assert from 'node:assert/strict';
import {setupBrowserPhoto} from '../dist/browser-photo.js';

class Element extends EventTarget {
  constructor(tag, doc) {super(); this.tagName=tag;this.ownerDocument=doc;this.children=[];this.style={};this.dataset={};this.attributes={};this.textContent='';this.open=false;this.hidden=false;this.disabled=false;this.checked=false;}
  append(...items) {for(const item of items){this.children.push(item);item.parent=this;}}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this);}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  getContext(){return {drawImage:(...args)=>this.ownerDocument.draws.push(args),getImageData:()=>({data:new Uint8ClampedArray(4)})};}
}
class Track extends EventTarget {
  constructor(id='a', caps={}) {super();this.kind='video';this.readyState='live';this.id='track-'+id;this.label='Camera '+id;this.caps=caps;this.stopCalls=0;}
  getSettings(){return {deviceId:this.id,width:640,height:480};}
  getCapabilities(){return this.caps;}
  stop(){this.stopCalls++;this.readyState='ended';this.dispatchEvent(new Event('ended'));}
}
const find = (element, predicate) => predicate(element) ? element : element.children.map(child=>find(child,predicate)).find(Boolean);
const deferred = () => {let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};};
const flush = async () => {await new Promise(resolve=>setTimeout(resolve,0));};

function fixture(options={}) {
  let selected = options.track || new Track();
  const calls={construct:[],caps:0,settings:0,photos:[],decode:0,saves:[],errors:[],logs:[],bitmaps:[]};
  const photoCaps=options.caps || {imageWidth:{min:640,max:4096,step:1},imageHeight:{min:480,max:3072,step:1},fillLightMode:['off'],redEyeReduction:'never'};
  const doc={draws:[],createElement(tag){return new Element(tag,this);}};
  class Capture {
    constructor(track){calls.construct.push(track);if(options.constructorError)throw options.constructorError;}
    getPhotoCapabilities(){calls.caps++;return options.readCaps?options.readCaps():Promise.resolve(photoCaps);}
    getPhotoSettings(){calls.settings++;return options.readSettings?options.readSettings():Promise.resolve({imageWidth:1920,imageHeight:1080,fillLightMode:'off'});}
    takePhoto(settings){calls.photos.push(settings);return options.takePhoto?options.takePhoto(settings):Promise.resolve(new Blob(['camera-image'],{type:'image/jpeg'}));}
  }
  doc.defaultView={ImageCapture:options.unsupported?undefined:Capture,navigator:{mediaDevices:{getSupportedConstraints:()=>options.supportedConstraints || {}}},
    createImageBitmap:async blob=>{
      calls.decode++;
      if(options.decode)return options.decode(blob);
      const bitmap={width:options.width || 1920,height:options.height || 1080,closed:0,close(){this.closed++;}};
      calls.bitmaps.push(bitmap);return bitmap;
    }};
  const host=new Element('div',doc);
  const controller=setupBrowserPhoto({host,getTrack:()=>selected,
    onSnapshot:async(canvas,metadata)=>{calls.saves.push({canvas,metadata});if(options.save)return options.save(canvas,metadata);},
    onRequestPTZ:options.requestPTZ, log:(...args)=>calls.logs.push(args),notice:(...args)=>calls.errors.push(args),
    timeouts:{read:100,capture:100,decode:100,save:100,ptz:100,...options.timeouts}});
  const details=find(host,node=>node.dataset.component==='browser-photo');
  return {controller,host,doc,calls,details,track:selected,
    button:action=>find(host,node=>node.dataset.action===action),
    async open(){details.open=true;return controller.refresh();},
    select(track){selected=track;},
    async idle(){for(let i=0;i<100 && controller.getState().busy;i++)await flush();assert.equal(controller.getState().busy,false,'operation should settle');}
  };
}

test('closed Camera extras performs no photo queries or captures; opening reads actual capabilities and settings',async()=>{
  const f=fixture();
  assert.equal(f.details.open,false);
  await f.controller.refresh();
  assert.equal(f.calls.construct.length,0);
  assert.equal(f.calls.caps,0);assert.equal(f.calls.photos.length,0);
  await f.open();
  assert.equal(f.calls.caps,1);assert.equal(f.calls.settings,1);assert.equal(f.calls.photos.length,0);
  assert.equal(f.controller.getState().capabilities.imageWidth.max,4096);
  assert.deepEqual(f.controller.getState().settings,{imageWidth:1920,imageHeight:1080,fillLightMode:'off'});
  assert.equal(f.button('maximum').parent.hidden,false);
  f.controller.destroy();assert.equal(f.track.stopCalls,0);
});

test('still capture proves decoded dimensions, preserves source identity, and applies no mirror or landmark overlay',async()=>{
  const f=fixture({width:4032,height:3024});await f.open();
  f.button('maximum').checked=true;f.button('capture').click();await f.idle();
  assert.deepEqual(f.calls.photos,[{imageWidth:4096,imageHeight:3072}]);
  assert.equal(f.calls.saves.length,1);
  const {canvas,metadata}=f.calls.saves[0];
  assert.equal(canvas.width,4032);assert.equal(canvas.height,3024);
  assert.equal(metadata.width,4032);assert.equal(metadata.height,3024);
  assert.equal(metadata.name,'Camera a');assert.equal(metadata.sourceId,'track-a');
  assert.equal(metadata.mirrored,false);assert.equal(metadata.landmarkOverlay,false);
  assert.equal(metadata.mimeType,'image/jpeg');assert.ok(metadata.bytes>0);
  assert.equal(f.doc.draws.length,1);assert.deepEqual(f.doc.draws[0].slice(1),[0,0]);
  assert.equal(f.calls.bitmaps[0].closed,1);
  assert.equal(f.controller.getState().lastCapture.width,4032);
  f.controller.destroy();
});

test('ImageCapture absence is a normal fallback and does not disable a supported PTZ permission action',async()=>{
  let requested=0;
  const f=fixture({unsupported:true,supportedConstraints:{pan:true},requestPTZ:()=>{requested++;return true;}});
  const state=await f.open();assert.equal(state.busy,false);
  assert.equal(f.controller.getState().status,'unsupported');
  assert.equal(f.button('capture').disabled,true);
  assert.equal(f.calls.photos.length,0);assert.equal(f.calls.errors.length,0);
  assert.equal(f.button('ptz').hidden,false);
  f.button('ptz').click();assert.equal(requested,1,'permission callback must run synchronously in the click handler');
  await f.idle();f.controller.destroy();
});

test('PTZ action is hidden without supported constraints or when current track already reports usable ranges',async()=>{
  for(const options of [{supportedConstraints:{}},{supportedConstraints:{pan:true,zoom:true},track:new Track('a',{pan:{min:-30,max:30},zoom:{min:1,max:4}})}]){
    const f=fixture({...options,requestPTZ:()=>assert.fail('unneeded permission prompt')});
    assert.equal(f.button('ptz').hidden,true);f.controller.destroy();
  }
});

test('partial capability failure keeps the returned settings and allows an explicit default photo attempt',async()=>{
  const f=fixture({readCaps:()=>Promise.reject(new Error('Photo capabilities not exposed'))});await f.open();
  assert.equal(f.controller.getState().capabilities,null);
  assert.equal(f.controller.getState().settings.imageWidth,1920);
  assert.match(f.controller.getState().queryErrors.capabilities,/not exposed/);
  assert.equal(f.button('maximum').parent.hidden,true);
  f.button('capture').click();await f.idle();
  assert.deepEqual(f.calls.photos,[{}]);assert.equal(f.calls.saves.length,1);
  f.controller.destroy();
});

test('source switch while takePhoto is pending suppresses delivery even without a refresh call',async()=>{
  const pending=deferred(),f=fixture({takePhoto:()=>pending.promise});await f.open();
  f.button('capture').click();assert.equal(f.controller.getState().busy,true);
  f.select(new Track('b'));pending.resolve(new Blob(['image'],{type:'image/jpeg'}));await f.idle();
  assert.equal(f.calls.decode,0);assert.equal(f.calls.saves.length,0);assert.equal(f.calls.errors.length,0);
  assert.equal(f.controller.getState().track.trackId,'track-b');f.controller.destroy();
});

test('stop during decoding settles promptly and closes a bitmap that arrives late',async()=>{
  const pending=deferred(),f=fixture({decode:()=>pending.promise});await f.open();
  f.button('capture').click();await flush();assert.equal(f.calls.decode,1);
  f.controller.stop();assert.equal(f.controller.getState().busy,false);
  const bitmap={width:1280,height:720,closed:0,close(){this.closed++;}};
  pending.resolve(bitmap);await flush();
  assert.equal(bitmap.closed,1);assert.equal(f.calls.saves.length,0);assert.equal(f.calls.errors.length,0);
  assert.equal(f.track.stopCalls,0);f.controller.destroy();
});

test('capture timeout ignores late blobs and another click cannot start a concurrent photo',async()=>{
  const pending=deferred(),f=fixture({takePhoto:()=>pending.promise,timeouts:{capture:10}});await f.open();
  f.button('capture').click();f.button('capture').click();
  assert.equal(f.calls.photos.length,1);await f.idle();
  assert.match(f.controller.getState().lastError,/timed out/);assert.equal(f.calls.errors.length,1);
  pending.resolve(new Blob(['late']));await flush();
  assert.equal(f.calls.decode,0);assert.equal(f.calls.saves.length,0);f.controller.destroy();
});

test('oversized blobs and decoded dimensions fail before handing a photo to the board',async()=>{
  const oversized=fixture({takePhoto:()=>Promise.resolve({size:33*1024*1024,type:'image/jpeg'})});await oversized.open();
  oversized.button('capture').click();await oversized.idle();
  assert.equal(oversized.calls.decode,0);assert.equal(oversized.calls.saves.length,0);
  assert.match(oversized.controller.getState().lastError,/32 MB/);oversized.controller.destroy();
  const dimensions=fixture({width:20000,height:20000});await dimensions.open();
  dimensions.button('capture').click();await dimensions.idle();
  assert.equal(dimensions.calls.saves.length,0);assert.equal(dimensions.calls.bitmaps[0].closed,1);
  assert.match(dimensions.controller.getState().lastError,/48 megapixels/);dimensions.controller.destroy();
});

test('ending the active track cancels photo work without stopping a replacement or emitting a false saved event',async()=>{
  const pending=deferred(),f=fixture({takePhoto:()=>pending.promise});await f.open();
  f.button('capture').click();f.track.stop();
  pending.resolve(new Blob(['late']));await flush();
  assert.equal(f.controller.getState().status,'stopped');assert.equal(f.calls.saves.length,0);
  assert.equal(f.calls.logs.some(([message])=>message==='Camera still photo saved'),false);
  assert.equal(f.track.stopCalls,1);f.controller.destroy();
});

test('an obsolete capability query cannot overwrite the replacement camera results',async()=>{
  const pending=deferred();let reads=0;
  const f=fixture({readCaps:()=>++reads===1?pending.promise:Promise.resolve({imageWidth:{min:1,max:800},imageHeight:{min:1,max:600}})});
  f.details.open=true;const old=f.controller.refresh();
  f.select(new Track('b'));await f.controller.refresh();
  pending.resolve({imageWidth:{min:1,max:9999}});await old;
  assert.equal(f.controller.getState().capabilities.imageWidth.max,800);
  assert.equal(f.controller.getState().track.trackId,'track-b');f.controller.destroy();
});

test('async snapshot integration receives cancellation state; canceled saves are not reported as completed',async()=>{
  const pending=deferred();let received;
  const f=fixture({save:async(_canvas,metadata)=>{received=metadata;assert.equal(metadata.isCurrent(),true);await pending.promise;}});await f.open();
  f.button('capture').click();await flush();
  assert.ok(received);f.controller.stop();
  assert.equal(received.signal.aborted,true);assert.equal(received.isCurrent(),false);
  pending.resolve();await flush();
  assert.equal(f.controller.getState().lastCapture,null);
  assert.equal(f.calls.logs.some(([message])=>message==='Camera still photo saved'),false);f.controller.destroy();
});

test('PTZ reacquisition can synchronously stop the panel and reject later without an unhandled rejection',async()=>{
  const pending=deferred();let f;
  f=fixture({supportedConstraints:{zoom:true},requestPTZ:()=>{f.controller.stop();return pending.promise;}});
  f.button('ptz').click();pending.reject(new Error('Permission denied'));await flush();
  assert.equal(f.controller.getState().busy,false);assert.equal(f.calls.errors.length,0);f.controller.destroy();
});

test('destroy removes controls and ignores late capability responses',async()=>{
  const pending=deferred(),f=fixture({readCaps:()=>pending.promise});
  f.details.open=true;const reading=f.controller.refresh();f.controller.destroy();
  pending.resolve({imageWidth:{max:99}});await reading;
  assert.equal(f.host.children.length,0);assert.equal(f.controller.getState().status,'destroyed');
  assert.equal(f.controller.getState().capabilities,null);assert.equal(f.track.stopCalls,0);
});

test('a rejected board delivery never produces a successful capture status',async()=>{
  const f=fixture({save:()=>null});await f.open();f.button('capture').click();await f.idle();
  assert.equal(f.controller.getState().lastCapture,null);
  assert.match(f.controller.getState().lastError,/not added/);
  assert.equal(f.calls.logs.some(([message])=>message==='Camera still photo saved'),false);
  assert.equal(f.calls.bitmaps[0].closed,1);f.controller.destroy();
});
