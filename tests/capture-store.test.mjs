import test from 'node:test';
import assert from 'node:assert/strict';
import {CAPTURE_SLOTS, DEFAULT_PIN_FPS, normalizeFps, fitContain, normalizeCaptureSourceHint, normalizeCaptureDocumentKind, validateCaptureRecord, createCaptureStore, drawKeyImage, drawKeyModeOverlay} from '../dist/capture-store.js';

const record = overrides => ({index: 0, kind: 'pin', title: 'Window', fps: 2,
  region: {x: 0.1, y: 0.2, width: 0.5, height: 0.6}, createdAt: 1700000000000,
  updatedAt: '2024-01-01T00:00:00.000Z', image: new Blob(['frame bytes'], {type: 'image/png'}), sourceLabel: 'Camera', ...overrides});

test('FPS defaults to 10 and bounds finite requests without changing explicit rates', () => {
  assert.equal(DEFAULT_PIN_FPS, 10);
  for (const value of [undefined, null, '', ' ', false, {}, NaN, Infinity, 'bad']) assert.equal(normalizeFps(value), 10);
  assert.equal(normalizeFps(0), 0.2);
  assert.equal(normalizeFps(-5), 0.2);
  assert.equal(normalizeFps(100), 10);
  assert.equal(normalizeFps('2.5'), 2.5);
});

test('saved pins keep every explicitly selected rate when the new-pin default changes', () => {
  for (const fps of [0.2, 0.5, 1, 2.5, 5, 10]) {
    assert.equal(validateCaptureRecord(record({fps})).fps, fps);
    assert.equal(validateCaptureRecord(record({fps: String(fps)})).fps, fps);
  }
  assert.equal(validateCaptureRecord(record({fps: undefined})).fps, 10);
});

test('Contain math preserves both portrait and landscape content without clipping', () => {
  assert.deepEqual(fitContain(1920, 1080, 108, 80), {x: 0, y: 9.625, width: 108, height: 60.75});
  assert.deepEqual(fitContain(512, 640, 108, 80), {x: 22, y: 0, width: 64, height: 80});
  assert.deepEqual(fitContain(50, 50, 100, 100), {x: 0, y: 0, width: 100, height: 100});
  for (const value of [0, -1, NaN, Infinity, '640']) assert.throws(() => fitContain(value, 480, 118, 118), /positive, finite/);
});

test('Capture validation rejects unsafe indexes, invalid FPS, crops and absent real image', () => {
  assert.equal(CAPTURE_SLOTS, 9);
  for (const index of [-1, Number.MAX_SAFE_INTEGER+1, 1.5, '0', NaN]) assert.throws(() => validateCaptureRecord(record({index})), /index/);
  for (const fps of [Infinity, NaN, false, {}, '']) assert.throws(() => validateCaptureRecord(record({fps})), /FPS/);
  for (const region of [null, {x: -0.1, y: 0, width: 1, height: 1}, {x: 0.5, y: 0, width: 0.6, height: 1}, {x: 0, y: 0, width: 0, height: 1}, {x: 0, y: 0, width: 1, height: NaN}]) {
    assert.throws(() => validateCaptureRecord(record({region})), /region/);
  }
  assert.throws(() => validateCaptureRecord(record({image: null})), /Blob/);
  assert.throws(() => validateCaptureRecord(record({image: new Blob(['not an image'], {type: 'text/html'})})), /image MIME/);
});

test('Capture validation copies data and excludes live playback state', () => {
  const original = record({fps: 100, stream: {private: true}, timer: 10, paused: false});
  const safe = validateCaptureRecord(original);
  assert.equal(safe.fps, 10);
  assert.equal(safe.createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(safe.image, original.image);
  assert.equal(safe.stream, undefined);
  assert.equal(safe.timer, undefined);
  assert.equal(safe.paused, undefined);
  safe.region.x = 0;
  assert.equal(original.region.x, 0.1);
});

test('document scan preferences persist only for explicitly classified paper or notebooks',()=>{
  for(const documentKind of ['paper','notebook']){
    assert.equal(normalizeCaptureDocumentKind(documentKind),documentKind);
    for(const kind of ['pin','snapshot'])for(const scanEnhanced of [true,false]){
      const original=record({kind,documentKind,scanEnhanced,rawFrame:{private:true},frame:{private:true},filterOptions:{unknown:true}});
      const safe=validateCaptureRecord(original);
      assert.equal(safe.documentKind,documentKind);assert.equal(safe.scanEnhanced,scanEnhanced);
      assert.equal(safe.image,original.image,'the one original image blob is preserved');
      assert.equal(safe.rawFrame,undefined);assert.equal(safe.frame,undefined);assert.equal(safe.filterOptions,undefined);
    }
    assert.equal(validateCaptureRecord(record({documentKind})).scanEnhanced,true);
    for(const scanEnhanced of [null,0,1,'false',{},[]])assert.throws(()=>validateCaptureRecord(record({documentKind,scanEnhanced})),/boolean/);
  }
  for(const documentKind of [undefined,null,'none','Notebook','phone',{},['paper']]){
    assert.equal(normalizeCaptureDocumentKind(documentKind),null);
    const safe=validateCaptureRecord(record({documentKind,scanEnhanced:true}));
    assert.equal(safe.documentKind,undefined);assert.equal(safe.scanEnhanced,undefined);
  }
  const legacy=validateCaptureRecord(record({title:'Notebook'}));
  assert.equal(legacy.documentKind,undefined,'a title alone cannot enable document processing');
});

test('the actual store round trip retains the original document image and reversible preference',async t=>{
  const factory=fakeIndexedDB();replaceIndexedDB(t,factory);
  const store=createCaptureStore();t.after(()=>store.close());
  for(const [index,scanEnhanced] of [true,false].entries())
    await store.save(record({index,kind:index?'snapshot':'pin',documentKind:'notebook',scanEnhanced}));
  const loaded=await store.load();assert.equal(loaded.length,2);
  assert.deepEqual(loaded.map(item=>[item.documentKind,item.scanEnhanced]),[['notebook',true],['notebook',false]]);
  assert.equal(await loaded[0].image.text(),'frame bytes');assert.equal(await loaded[1].image.text(),'frame bytes');
});

test('Scene resume hints whitelist only bounded device identity and real dimensions', () => {
  const hint = {kind: 'aux-camera', deviceId: 'exact-browser-id', label: 'LVNext CPD Camera', width: 512, height: 640,
    url: 'http://localhost/private?token=secret', credentials: {password: 'secret'}, stream: {getTracks() {}}, timer: 5};
  const safe = validateCaptureRecord(record({sourceHint: hint}));
  assert.deepEqual(safe.sourceHint, {kind: 'aux-camera', deviceId: 'exact-browser-id', label: 'LVNext CPD Camera', width: 512, height: 640});
  assert.notEqual(safe.sourceHint, hint); safe.sourceHint.label = 'Changed'; assert.equal(hint.label, 'LVNext CPD Camera');
  assert.equal(validateCaptureRecord(record()).sourceHint, undefined, 'older records remain compatible');
  assert.equal(validateCaptureRecord(record({kind: 'snapshot', sourceHint: hint})).sourceHint, undefined);
  assert.deepEqual(normalizeCaptureSourceHint({kind: 'aux-camera', deviceId: '', label: 'Observed native camera', width: 512, height: 640}),
    {kind: 'aux-camera', deviceId: '', label: 'Observed native camera', width: 512, height: 640});
});

test('fixed perspective geometry persists separately from a rectified crop for main and scene pins',()=>{
  const transform={type:'perspective',quad:[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}]};
  const sourceHint={kind:'aux-camera',deviceId:'cpd',label:'CPD',width:512,height:640};
  const safe=validateCaptureRecord(record({transform:{...transform,apiKey:'excluded'},sourceHint}));
  assert.deepEqual(safe.transform,transform);assert.deepEqual(safe.sourceHint.transform,transform);
  assert.deepEqual(safe.region,record().region,'region remains relative to the rectified image');
  assert.notEqual(safe.transform.quad,transform.quad);assert.notEqual(safe.transform.quad,safe.sourceHint.transform.quad);
  const main=validateCaptureRecord(record({transform}));assert.deepEqual(main.transform,transform);assert.equal(main.sourceHint,undefined);
  assert.equal(validateCaptureRecord(record()).transform,undefined,'old records keep their original source crop');
  assert.equal(validateCaptureRecord(record({kind:'snapshot',transform})).transform,undefined,'snapshots already contain their frozen pixels');
  assert.deepEqual(validateCaptureRecord(record({sourceHint:{...sourceHint,transform}})).transform,transform);
  assert.throws(()=>validateCaptureRecord(record({transform:{...transform,quad:transform.quad.toReversed()}})),/Perspective/);
  assert.throws(()=>validateCaptureRecord(record({transform,sourceHint:{...sourceHint,transform:{...transform,quad:[{x:.21,y:.1},...transform.quad.slice(1)]}}})),/does not match/);
});

test('upright geometry survives the actual store round trip with an independent resume transform and upright crop',async t=>{
  const quad=[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}];
  const transforms=[{type:'perspective',quad:[quad[2],quad[3],quad[0],quad[1]]},
    {type:'perspective',quad,rotationDegrees:180},{type:'perspective',quad,rotationDegrees:-8.25}];
  const factory=fakeIndexedDB();replaceIndexedDB(t,factory);
  const store=createCaptureStore();t.after(()=>store.close());
  for(const [index,transform] of transforms.entries())await store.save(record({index,
    transform:{...transform,privateMetadata:'discard'},
    sourceHint:{kind:'aux-camera',deviceId:'exact-scene',label:'Scene',width:640,height:400}}));
  const loaded=await store.load();assert.equal(loaded.length,3);
  for(const [index,item] of loaded.entries()){
    assert.equal(item.paused,true);assert.deepEqual(item.transform,transforms[index]);
    assert.deepEqual(item.sourceHint.transform,transforms[index]);assert.deepEqual(item.region,record().region);
    assert.equal(item.sourceHint.width,640);assert.equal(item.sourceHint.height,400);
    assert.notEqual(item.transform.quad,item.sourceHint.transform.quad);
    item.transform.quad[0].x=0;assert.notEqual(item.sourceHint.transform.quad[0].x,0);
    assert.deepEqual(factory.rows.get(index).transform,transforms[index],'reading geometry is detached from returned state');
  }
});

test('stored reading angles are bounded and cannot disagree with the exact-camera resume hint',()=>{
  const transform={type:'perspective',quad:[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}],rotationDegrees:180};
  const sourceHint={kind:'aux-camera',deviceId:'cpd',label:'CPD',width:512,height:640};
  for(const rotationDegrees of [null,NaN,Infinity,'180',181,-181]){
    const invalid={...transform,rotationDegrees};
    assert.throws(()=>validateCaptureRecord(record({transform:invalid})),/reading rotation/);
    assert.throws(()=>validateCaptureRecord(record({sourceHint:{...sourceHint,transform:invalid}})),/reading rotation/);
  }
  assert.throws(()=>validateCaptureRecord(record({transform,sourceHint:{...sourceHint,transform:{...transform,rotationDegrees:13.5}}})),/does not match/);
});

test('Invalid optional scene hints cannot smuggle arbitrary identities or dimensions into storage', () => {
  const hint = {kind: 'aux-camera', deviceId: 'camera-id', label: 'Camera', width: 640, height: 480};
  for (const change of [{kind: 'screen'}, {deviceId: {}}, {deviceId: 'x'.repeat(513)}, {label: 'x'.repeat(301)},
    {deviceId: '', label: ''}, {width: 0}, {width: Infinity}, {height: NaN}, {height: '480'}, {height: 32769}]) {
    assert.throws(() => validateCaptureRecord(record({sourceHint: {...hint, ...change}})), /hint|camera|Camera/);
  }
});

test('Native device identity is exact, detached and strictly whitelisted without dropping legacy hints', () => {
  const nativeDevice={backend:'avfoundation',uniqueId:'stable-UID-001',index:0,url:'http://localhost/private',credentials:'secret'};
  const sourceHint={kind:'aux-camera',deviceId:'',label:'Duplicate camera label',width:512,height:640,nativeDevice};
  const safe=validateCaptureRecord(record({sourceHint}));
  assert.deepEqual(safe.sourceHint.nativeDevice,{backend:'avfoundation',uniqueId:'stable-UID-001'});
  assert.notEqual(safe.sourceHint.nativeDevice,nativeDevice);
  safe.sourceHint.nativeDevice.uniqueId='changed';assert.equal(nativeDevice.uniqueId,'stable-UID-001');
  const legacy=validateCaptureRecord(record({sourceHint:{...sourceHint,nativeDevice:undefined}}));
  assert.equal(legacy.sourceHint.deviceId,'');assert.equal(legacy.sourceHint.label,sourceHint.label);assert.equal(legacy.sourceHint.nativeDevice,undefined);
  for(const invalid of [{},[],{backend:'AVFoundation',uniqueId:'a'},{backend:'x'.repeat(33),uniqueId:'a'},
    {backend:'bad backend',uniqueId:'a'},{backend:'avfoundation',uniqueId:''},{backend:'avfoundation',uniqueId:' '},
    {backend:'avfoundation',uniqueId:'x'.repeat(513)},{backend:'avfoundation',uniqueId:'a\nb'},
    {backend:'avfoundation',uniqueId:123}])assert.throws(()=>validateCaptureRecord(record({sourceHint:{...sourceHint,nativeDevice:invalid}})),/native camera/);
});

function replaceIndexedDB(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {value, configurable: true, writable: true});
  t.after(() => previous ? Object.defineProperty(globalThis, 'indexedDB', previous) : delete globalThis.indexedDB);
}
function fakeIndexedDB(initial = []) {
  const rows = new Map(initial.map(value => [value.index, value]));
  let closeCount = 0;
  const db = {close() {closeCount++;}, objectStoreNames: {contains: () => true},
    transaction() {
      const tx = {};
      const request = operation => {
        const result = {};
        queueMicrotask(() => {
          result.result = operation();
          result.onsuccess?.();
          queueMicrotask(() => tx.oncomplete?.());
        });
        return result;
      };
      tx.objectStore = () => ({getAll: () => request(() => [...rows.values()]),
        put: value => request(() => rows.set(value.index, value)),
        delete: index => request(() => rows.delete(index)), clear: () => request(() => rows.clear())});
      return tx;
    }};
  return {rows, db, get closeCount() {return closeCount;},
    open() {const request = {}; queueMicrotask(() => {request.result = db; request.onsuccess?.();}); return request;}};
}

test('Saved slots restore paused; replacement, remove and clear operate on exact indexes', async t => {
  const factory = fakeIndexedDB(); replaceIndexedDB(t, factory);
  const store = createCaptureStore(); t.after(() => store.close());
  await store.save(record({index: 8, paused: false, stream: {}}));
  await store.save(record({index: 1, kind: 'snapshot'}));
  await store.save(record({index: 8, title: 'Updated pin'}));
  const restored = await store.load();
  assert.deepEqual(restored.map(row => row.index), [1, 8]);
  assert(restored.every(row => row.paused === true));
  assert.equal(restored[1].title, 'Updated pin');
  assert.equal(factory.rows.get(8).stream, undefined);
  assert.equal(factory.rows.get(8).paused, undefined);
  await store.remove(1);
  assert.deepEqual((await store.load()).map(row => row.index), [8]);
  await store.clear();
  assert.deepEqual(await store.load(), []);
});

test('Scene reconnect identity survives a paused restore and atomic slot movement without live handles', async t => {
  const factory = fakeIndexedDB(); replaceIndexedDB(t, factory);
  const store = createCaptureStore(); t.after(() => store.close());
  const sourceHint = {kind: 'aux-camera', deviceId: 'cpd-id', label: 'CPD', width: 512, height: 640};
  await store.save(record({index: 5, sourceHint, paused: false, source: {stop() {}}, stream: {}}));
  const [restored] = await store.load();
  assert.equal(restored.paused, true); assert.deepEqual(restored.sourceHint, sourceHint);
  assert.equal(restored.source, undefined); assert.equal(restored.stream, undefined);
  await store.updateSlots([{...restored, index: 2}], [5]);
  const [moved] = await store.load(); assert.equal(moved.index, 2); assert.deepEqual(moved.sourceHint, sourceHint);
  assert.deepEqual(moved.region, restored.region); assert.equal(moved.fps, restored.fps);
});

test('Storage absence and blocked opening reject rather than inventing captures', async t => {
  replaceIndexedDB(t, undefined);
  await assert.rejects(createCaptureStore().load(), /does not provide IndexedDB/);
  let pending, closed = 0;
  globalThis.indexedDB = {open() {pending = {}; queueMicrotask(() => pending.onblocked?.()); return pending;}};
  const store = createCaptureStore();
  await assert.rejects(store.load(), /Another Roofcat tab/);
  pending.result = {close() {closed++;}};
  pending.onsuccess();
  assert.equal(closed, 1, 'A late database connection after rejection must be closed');
  store.close();
});

test('Closing a pending connection immediately rejects and closes any late success', async t => {
  let pending, closed = 0;
  replaceIndexedDB(t, {open() {pending = {}; return pending;}});
  const store = createCaptureStore();
  const loading = store.load();
  store.close();
  await assert.rejects(loading, /closed while opening/);
  pending.result = {close() {closed++;}};
  pending.onsuccess();
  assert.equal(closed, 1);
  await assert.rejects(store.load(), /closed/);
});

test('Blocked browser storage and corrupt saved records have actionable errors', async t => {
  replaceIndexedDB(t, {open() {
    const request = {};
    queueMicrotask(() => {request.error = new DOMException('Denied', 'SecurityError'); request.onerror?.();});
    return request;
  }});
  await assert.rejects(createCaptureStore().load(), /blocked local capture storage/);
  globalThis.indexedDB = fakeIndexedDB([record({index: -1})]);
  const store = createCaptureStore();
  await assert.rejects(store.load(), /saved capture is invalid/);
  store.close();
});

/** A staged transaction fixture: requests change a private map until commit. */
function atomicIndexedDB(initial, {failPut = 0, throwPut = 0} = {}) {
  const factory = fakeIndexedDB(initial);
  const stats = {opens: 0, transactions: 0, commits: 0, aborts: 0, requests: 0};
  const open = factory.open;
  factory.open = () => {stats.opens++; return open();};
  factory.db.transaction = () => {
    stats.transactions++;
    const staged = new Map(factory.rows);
    let active = true, pending = 0, puts = 0;
    const tx = {
      abort() {
        if (!active) throw new DOMException('Transaction inactive.', 'InvalidStateError');
        active = false;
        stats.aborts++;
        queueMicrotask(() => tx.onabort?.());
      }
    };
    const enqueue = (operation, fails = false) => {
      if (!active) throw new DOMException('Transaction inactive.', 'TransactionInactiveError');
      const request = {};
      pending++;
      stats.requests++;
      queueMicrotask(() => {
        if (!active) return;
        if (fails) {
          request.error = new DOMException('No room for the second image.', 'QuotaExceededError');
          request.onerror?.({target: request});
          tx.error = request.error;
          tx.onerror?.({target: request});
          tx.abort();
          return;
        }
        request.result = operation();
        request.onsuccess?.();
        if (--pending === 0) queueMicrotask(() => {
          if (!active || pending) return;
          active = false;
          factory.rows.clear();
          for (const [index, value] of staged) factory.rows.set(index, value);
          stats.commits++;
          tx.oncomplete?.();
        });
      });
      return request;
    };
    tx.objectStore = () => ({
      put(value) {
        puts++;
        if (puts === throwPut) throw new DOMException('The image could not be cloned.', 'DataCloneError');
        return enqueue(() => staged.set(value.index, value), puts === failPut);
      },
      delete: index => enqueue(() => staged.delete(index)),
      getAll: () => enqueue(() => [...staged.values()])
    });
    return tx;
  };
  return {...factory, stats};
}

test('A two-slot swap commits both captures together and leaves other slots intact', async t => {
  const first = record({index: 0, title: 'First'}), second = record({index: 4, kind: 'snapshot', title: 'Second'});
  const untouched = record({index: 8, title: 'Untouched'});
  const factory = atomicIndexedDB([first, second, untouched]); replaceIndexedDB(t, factory);
  const store = createCaptureStore(); t.after(() => store.close());
  const changes = [{...first, index: 4}, {...second, index: 0}];
  const writing = store.updateSlots(changes, [0, 4]);
  changes[0].title = 'Mutation after validation';
  await writing;
  assert.equal(factory.stats.transactions, 1);
  assert.equal(factory.stats.commits, 1);
  assert.equal(factory.rows.get(0).title, 'Second');
  assert.equal(factory.rows.get(0).image, second.image);
  assert.equal(factory.rows.get(4).title, 'First');
  assert.equal(factory.rows.get(4).image, first.image);
  assert.equal(factory.rows.get(8), untouched);
});

test('Batch records override removals and the last duplicate index wins', async t => {
  const factory = atomicIndexedDB([record({index: 0}), record({index: 8})]); replaceIndexedDB(t, factory);
  const store = createCaptureStore(); t.after(() => store.close());
  await store.updateSlots([record({index: 3, title: 'Earlier'}), record({index: 3, title: 'Final'})], [0, 3, 3]);
  assert.deepEqual([...factory.rows.keys()].sort(), [3, 8]);
  assert.equal(factory.rows.get(3).title, 'Final');
  assert.equal(factory.stats.transactions, 1);
  assert.equal(factory.stats.commits, 1);
});

test('Invalid batch input is rejected before storage opens or any write is queued', async t => {
  const original = record({index: 0});
  const factory = atomicIndexedDB([original]); replaceIndexedDB(t, factory);
  const store = createCaptureStore(); t.after(() => store.close());
  await assert.rejects(store.updateSlots([record({index: 1}), record({index: Number.MAX_SAFE_INTEGER+1})], [0]), /index/);
  await assert.rejects(store.updateSlots([record({index: 1})], [0, -1]), /index/);
  await assert.rejects(store.updateSlots([record({index: 1}), null], [0]), /record object/);
  await assert.rejects(store.updateSlots('not an array'), /arrays/);
  await store.updateSlots([]);
  assert.equal(factory.stats.opens, 0);
  assert.equal(factory.stats.transactions, 0);
  assert.equal(factory.stats.requests, 0);
  assert.deepEqual([...factory.rows], [[0, original]]);
});

test('An asynchronous second-write failure rolls back the whole slot swap', async t => {
  const first = record({index: 0, title: 'First'}), second = record({index: 4, title: 'Second'});
  const factory = atomicIndexedDB([first, second], {failPut: 2}); replaceIndexedDB(t, factory);
  const store = createCaptureStore(); t.after(() => store.close());
  await assert.rejects(store.updateSlots([{...first, index: 4}, {...second, index: 0}], [0, 4]), /storage is full/);
  assert.equal(factory.stats.aborts, 1);
  assert.equal(factory.stats.commits, 0);
  assert.deepEqual([...factory.rows], [[0, first], [4, second]]);
});

test('A synchronous enqueue failure aborts earlier queued removals and writes', async t => {
  const first = record({index: 0, title: 'First'}), second = record({index: 4, title: 'Second'});
  const factory = atomicIndexedDB([first, second], {throwPut: 2}); replaceIndexedDB(t, factory);
  const store = createCaptureStore(); t.after(() => store.close());
  await assert.rejects(store.updateSlots([{...first, index: 4}, {...second, index: 0}], [0, 4]), /Could not update local captures/);
  assert.equal(factory.stats.aborts, 1);
  assert.equal(factory.stats.commits, 0);
  assert.deepEqual([...factory.rows], [[0, first], [4, second]]);
});

test('Key images preserve the complete portrait frame and reserve a readable footer', () => {
  const calls = [], text = [];
  const context = {fillRect(...args) {calls.push(['fillRect', ...args]);}, drawImage(...args) {calls.push(['drawImage', ...args]);},
    fillText(...args) {text.push(args);}, measureText(value) {return {width: value.length * 6};}};
  const canvas = {getContext() {return context;}};
  const frame = {width: 512, height: 640};
  assert.equal(drawKeyImage(canvas, {kind: 'pin', title: 'Desk detail', index: 2, frame, paused: true}), canvas);
  assert.equal(canvas.width, 118);
  assert.equal(canvas.height, 118);
  assert.deepEqual(calls.find(call => call[0] === 'drawImage'), ['drawImage', frame, 27, 5, 64, 80]);
  assert.equal(text[0][0], 'Desk detail', 'The capture title has no generated key number');
  assert(text.some(call => call[0] === 'PAUSED'));
  assert(text.every(call => call[1] >= 0 && call[1] <= 118 && call[2] >= 0 && call[2] <= 118));
  assert.equal(context.fillStyle, '#b8f6ce');
  drawKeyImage(canvas, {kind: 'snapshot', title: 'Still', index: 0, frame});
  assert.equal(text.at(-2)[0], 'Still', 'Snapshot titles also omit the slot number');
  assert.equal(context.fillStyle, '#ffd0d9');
});

function artworkCanvas() {
  const calls = [], stack = [];
  let width = 118, height = 118, path = [];
  const properties = ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'font', 'textAlign', 'textBaseline', 'globalAlpha', 'globalCompositeOperation'];
  const ctx = {
    fillStyle: '#123c25', globalAlpha: 0.75, globalCompositeOperation: 'source-over',
    save() {stack.push(Object.fromEntries(properties.map(property => [property, this[property]])));},
    restore() {Object.assign(this, stack.pop());},
    fillRect(...args) {calls.push({type: 'fillRect', args, colour: this.fillStyle});},
    drawImage(...args) {calls.push({type: 'drawImage', args});},
    clearRect(...args) {calls.push({type: 'clearRect', args});},
    fillText(...args) {calls.push({type: 'fillText', args, colour: this.fillStyle});},
    measureText(text) {return {width: text.length * 6};},
    beginPath() {path = [];},
    moveTo(x, y) {path.push(['move', x, y]);},
    lineTo(x, y) {path.push(['line', x, y]);},
    stroke() {calls.push({type: 'stroke', path: path.map(point => [...point]), colour: this.strokeStyle, width: this.lineWidth});}
  };
  const canvas = {getContext() {return ctx;}};
  Object.defineProperties(canvas, {
    width: {get: () => width, set: value => {width = value; calls.push({type: 'resize'});}},
    height: {get: () => height, set: value => {height = value; calls.push({type: 'resize'});}}
  });
  return {canvas, ctx, calls};
}

test('Unselected normal key mode is a pixel-preserving no-op without acquiring a context', () => {
  const canvas = {width: 118, height: 118, getContext() {assert.fail('Normal mode must not touch the canvas');}};
  assert.equal(drawKeyModeOverlay(canvas), canvas);
  assert.equal(drawKeyModeOverlay(canvas, {mode: 'normal', selectedForReorder: true}), canvas);
  assert.equal(canvas.width, 118);
  assert.equal(canvas.height, 118);
});

test('Normal selection adds only an inset ring and preserves the capture, type colours and context state', () => {
  for (const kind of ['pin', 'snapshot', null]) {
    const {canvas, ctx, calls} = artworkCanvas();
    const frame = {width: 640, height: 480};
    const baseColour = kind === 'pin' ? '#123c25' : kind === 'snapshot' ? '#4d1921' : '#202823';
    if (kind) drawKeyImage(canvas, {kind, index: 3, title: 'Desk view', frame});
    else {ctx.fillStyle = baseColour; ctx.fillRect(0, 0, 118, 118);}
    const originalFill = ctx.fillStyle, before = calls.length;
    assert.equal(drawKeyModeOverlay(canvas, {selected: true, occupied: !!kind}), canvas);
    const overlay = calls.slice(before);
    assert.equal(overlay.length, 4, 'The selection adds only four edge strips');
    for (const call of overlay) {
      assert.equal(call.type, 'fillRect', 'Selection must not add a caption, badge, reset or replacement image');
      assert.equal(call.colour, '#65dce6');
      const [x, y, width, height] = call.args;
      assert(x >= 2 && y >= 2 && x + width <= 116 && y + height <= 116, 'The outer type colour stays visible');
      assert.equal(x < 113 && x + width > 5 && y < 85 && y + height > 5, false, 'The complete captured image stays untouched');
    }
    assert.equal(calls.find(call => call.type === 'fillRect').colour, baseColour);
    assert.equal(ctx.fillStyle, originalFill);
    assert.equal(ctx.globalAlpha, 0.75, 'Selection restores the caller’s alpha');
    assert.equal(ctx.globalCompositeOperation, 'source-over');
  }
});

test('Redrawing a normal key removes its previous selection ring without changing the captured frame', () => {
  const {canvas, calls} = artworkCanvas();
  const frame = {width: 640, height: 480};
  // Resolve pixels touched by the rectangular artwork and source image. Text is
  // intentionally sampled around, so the test does not depend on a font rasterizer.
  const pixelAt = (x, y) => {
    let pixel = null;
    for (const call of calls) {
      if (call.type === 'resize') {pixel = null; continue;}
      if (!['fillRect', 'drawImage'].includes(call.type)) continue;
      const [left, top, width, height] = call.type === 'drawImage' ? call.args.slice(1) : call.args;
      if (x >= left && y >= top && x < left + width && y < top + height) pixel = call.type === 'drawImage' ? call.args[0] : call.colour;
    }
    return pixel;
  };
  const base = {kind: 'pin', index: 1, title: 'Live view', frame};
  drawKeyImage(canvas, base);
  drawKeyModeOverlay(canvas, {mode: 'normal', selected: true});
  assert.equal(pixelAt(2, 59), '#65dce6');
  assert.equal(pixelAt(0, 59), '#123c25');
  assert.equal(pixelAt(59, 40), frame);
  drawKeyImage(canvas, base);
  drawKeyModeOverlay(canvas, {mode: 'normal', selected: false});
  assert.equal(pixelAt(2, 59), '#123c25', 'Moving selection away clears the old LCD ring');
  assert.equal(pixelAt(59, 40), frame, 'The original image remains in its fitted position');
});

test('Remove and Reorder artwork ignore normal selection, retaining their own mode cues', () => {
  for (const options of [{mode: 'remove'}, {mode: 'remove', occupied: false}, {mode: 'reorder'}, {mode: 'reorder', selectedForReorder: true}]) {
    const ordinary = artworkCanvas(), normalSelected = artworkCanvas();
    drawKeyModeOverlay(ordinary.canvas, options);
    drawKeyModeOverlay(normalSelected.canvas, {...options, selected: true});
    assert.deepEqual(normalSelected.calls, ordinary.calls);
  }
});

test('Remove overlay marks the edge and corner while preserving actual pin/snapshot artwork', () => {
  for (const kind of ['pin', 'snapshot']) {
    const {canvas, ctx, calls} = artworkCanvas();
    const frame = {width: 1920, height: 1080};
    drawKeyImage(canvas, {kind, index: 1, title: 'Actual capture', frame});
    const originalCount = calls.length, originalFill = ctx.fillStyle;
    assert.equal(calls.find(call => call.type === 'fillRect').colour, kind === 'pin' ? '#123c25' : '#4d1921');
    assert.equal(drawKeyModeOverlay(canvas, {mode: 'remove'}), canvas);
    const overlay = calls.slice(originalCount);
    assert(overlay.some(call => call.type === 'fillText' && call.args[0] === 'REMOVE'));
    assert.equal(overlay.find(call => call.type === 'fillRect').colour, '#ff9a55');
    assert.deepEqual(overlay.find(call => call.type === 'stroke').path, [
      ['move', 98, 10], ['line', 108, 21], ['move', 108, 10], ['line', 98, 21]
    ]);
    assert.equal(calls.filter(call => call.type === 'drawImage').length, 1);
    assert(!overlay.some(call => ['resize', 'drawImage', 'clearRect'].includes(call.type)));
    assert.equal(ctx.fillStyle, originalFill, 'The overlay restores the caller’s context state');
    assert.equal(ctx.globalAlpha, 0.75);
  }
});

test('Reorder and its selected source have distinct colours, swap arrows and a double frame', () => {
  const ordinary = artworkCanvas(), selected = artworkCanvas();
  drawKeyModeOverlay(ordinary.canvas, {mode: 'reorder'});
  drawKeyModeOverlay(selected.canvas, {mode: 'reorder', selectedForReorder: true});
  assert.equal(ordinary.calls.find(call => call.type === 'fillRect').colour, '#6d9fff');
  assert.equal(selected.calls.find(call => call.type === 'fillRect').colour, '#62fff1');
  assert.equal(ordinary.calls.find(call => call.type === 'fillText').args[0], 'REORDER');
  assert.equal(selected.calls.find(call => call.type === 'fillText').args[0], 'PICK NEXT');
  const arrows = ordinary.calls.find(call => call.type === 'stroke').path;
  assert(arrows.some(point => point[0] === 'line' && point[1] === 109 && point[2] === 11));
  assert(arrows.some(point => point[0] === 'line' && point[1] === 97 && point[2] === 20));
  assert.equal(selected.calls.filter(call => call.type === 'fillRect').length,
    ordinary.calls.filter(call => call.type === 'fillRect').length + 4, 'Selected source adds a second frame');
});

test('Empty Remove slots are muted and empty Reorder slots cannot appear selected', () => {
  const inactive = artworkCanvas(), empty = artworkCanvas(), invalidSelection = artworkCanvas();
  drawKeyModeOverlay(inactive.canvas, {mode: 'remove', occupied: false});
  assert.equal(inactive.calls.find(call => call.type === 'fillRect').colour, '#56615d');
  assert.equal(inactive.calls.find(call => call.type === 'fillText').args[0], 'EMPTY');
  drawKeyModeOverlay(empty.canvas, {mode: 'reorder', occupied: false});
  drawKeyModeOverlay(invalidSelection.canvas, {mode: 'reorder', occupied: false, selectedForReorder: true});
  assert.deepEqual(invalidSelection.calls, empty.calls);
});

test('Every mode leaves the central captured image unpainted and draws within the LCD bounds', () => {
  const centre = {left: 29, top: 30, right: 89, bottom: 80};
  for (const options of [{mode: 'remove'}, {mode: 'remove', occupied: false}, {mode: 'reorder'}, {mode: 'reorder', selectedForReorder: true}]) {
    const {canvas, calls} = artworkCanvas();
    drawKeyModeOverlay(canvas, options);
    for (const call of calls.filter(call => call.type === 'fillRect')) {
      const [x, y, width, height] = call.args;
      assert(x >= 0 && y >= 0 && x + width <= 118 && y + height <= 118);
      const overlapsCentre = x < centre.right && x + width > centre.left && y < centre.bottom && y + height > centre.top;
      assert.equal(overlapsCentre, false, `A ${options.mode} overlay must not cover the capture centre`);
    }
    for (const point of calls.find(call => call.type === 'stroke').path) {
      assert(point[1] >= 92 && point[1] <= 114 && point[2] >= 4 && point[2] <= 27, 'Mode icon stays inside the corner badge');
    }
    assert(!calls.some(call => ['resize', 'clearRect', 'drawImage'].includes(call.type)));
  }
});


test('capture persistence and reload retain the tenth and later captures without changing legacy indexes',async t=>{
  const factory=fakeIndexedDB();replaceIndexedDB(t,factory);
  const first=createCaptureStore();
  for(let index=0;index<14;index++)await first.save(record({index,title:`Capture ${index+1}`}));
  first.close();
  const restored=createCaptureStore();t.after(()=>restored.close());
  assert.deepEqual((await restored.load()).map(item=>item.index),Array.from({length:14},(_,i)=>i));
  const retained=factory.rows.get(9).image;
  await restored.remove(0);
  assert.equal((await restored.load()).length,13);
  assert.equal(factory.rows.get(9).image,retained,'deletion does not rewrite unaffected image blobs');
  await restored.save(record({index:0}));
  await restored.updateSlots([record({index:8,title:'Was capture 14'}),record({index:13,title:'Was capture 9'})],[8,13]);
  const reloaded=await restored.load();
  assert.equal(reloaded.length,14);assert.equal(reloaded[8].title,'Was capture 14');assert.equal(reloaded[13].title,'Was capture 9');
});
