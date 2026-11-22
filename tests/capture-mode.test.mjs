import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaptureMode,swapCaptureSlots} from '../dist/capture-mode.js';

test('right cycles Pick, Remove, Reorder and wraps; left follows the reverse order',()=>{
  const forward=createCaptureMode(), backward=createCaptureMode();
  const next=()=>forward.navigate({direction:'next',pressed:true}).mode;
  const previous=()=>backward.navigate({direction:'previous',pressed:true}).mode;
  assert.equal(forward.getState().mode,'normal','Pick retains its internal normal identifier');
  assert.deepEqual(Array.from({length:6},next),['remove','reorder','normal','remove','reorder','normal']);
  assert.deepEqual(Array.from({length:6},previous),['reorder','remove','normal','reorder','remove','normal']);
});
test('navigation releases and unknown directions preserve the current mode and unfinished reorder pair',()=>{
  const changes=[],control=createCaptureMode({onChange:state=>changes.push(state)});
  control.setMode('reorder');control.press(4);
  const published=changes.length;
  for(const event of [{direction:'next',pressed:false},{direction:'previous',pressed:false},{direction:'unknown',pressed:true}]){
    assert.deepEqual(control.navigate(event),{mode:'reorder',firstKey:4});
  }
  assert.equal(changes.length,published,'Ignored navigation does not redraw or clear the pending pair');
});
test('rapid mixed navigation never performs capture actions and always clears an unfinished reorder pair',()=>{
  const actions=[],changes=[];
  const control=createCaptureMode({hasCapture:index=>index===2,onSelect:index=>actions.push(['pick',index]),onRemove:index=>actions.push(['remove',index]),onSwap:(first,second)=>actions.push(['swap',first,second]),onChange:state=>changes.push(state)});
  const next={normal:'remove',remove:'reorder',reorder:'normal'};
  const previous={normal:'reorder',reorder:'remove',remove:'normal'};
  let expected='normal';
  for(let i=0;i<1200;i++){
    if(expected==='reorder'){
      control.press(2);
      assert.equal(control.getState().firstKey,2);
    }
    const direction=i%7<4?'next':'previous',published=changes.length;
    expected=(direction==='next'?next:previous)[expected];
    assert.deepEqual(control.navigate({direction,pressed:true}),{mode:expected,firstKey:null});
    assert.equal(changes.length,published+1,'Each press publishes exactly one new mode');
    assert.deepEqual(control.navigate({direction,pressed:false}),{mode:expected,firstKey:null});
    assert.equal(changes.length,published+1,'Release never advances the mode again');
  }
  assert.deepEqual(actions,[],'Changing mode must never pick, remove or swap a capture');
});
test('normal presses only inspect; remove presses remove occupied keys without acting on empty keys',()=>{
  const events=[];
  const control=createCaptureMode({hasCapture:i=>i===2,onSelect:i=>events.push(['select',i]),onRemove:i=>events.push(['remove',i])});
  control.press(2);control.setMode('remove');control.press(1);control.press(2);
  assert.deepEqual(events,[['select',2],['remove',2]]);
});
test('reorder chooses an occupied first key, then swaps with an occupied or empty destination',()=>{
  const swaps=[];
  const control=createCaptureMode({hasCapture:i=>i===0||i===3,onSwap:(a,b)=>swaps.push([a,b])});
  control.setMode('reorder');control.press(2);
  assert.equal(control.getState().firstKey,null);
  control.press(0);assert.equal(control.getState().firstKey,0);
  control.press(3);control.press(0);control.press(8);
  assert.deepEqual(swaps,[[0,3],[0,8]]);
  assert.deepEqual(control.getState(),{mode:'reorder',firstKey:null});
});
test('same key cancels a pair; changing mode or returning to Pick clears pending selections',()=>{
  const control=createCaptureMode();
  control.setMode('reorder');control.press(4);control.press(4);
  assert.equal(control.getState().firstKey,null);
  control.press(1);control.setMode('remove');control.setMode('reorder');
  assert.equal(control.getState().firstKey,null);
  control.press(3);control.setMode('normal');
  assert.deepEqual(control.getState(),{mode:'normal',firstKey:null});
});
test('a first capture removed while selected cannot be swapped by a stale pair',()=>{
  const occupied=new Set([0,3]),swaps=[];
  const control=createCaptureMode({hasCapture:i=>occupied.has(i),onSwap:(a,b)=>swaps.push([a,b])});
  control.setMode('reorder');control.press(0);occupied.delete(0);control.press(3);
  assert.equal(control.getState().firstKey,3);assert.deepEqual(swaps,[]);
});
test('swapping live pins preserves source identity and invalidates old saves at both locations',()=>{
  const source={capture(){},stop(){}},pin={index:0,kind:'pin',source,timer:73,saveVersion:4,sentAt:50},snapshot={index:3,kind:'snapshot',saveVersion:7,sentAt:20};
  const slots=Array(9).fill(null);slots[0]=pin;slots[3]=snapshot;
  assert.equal(swapCaptureSlots(slots,0,3),true);
  assert.equal(slots[3],pin);assert.equal(pin.source,source);assert.equal(pin.timer,73);assert.equal(pin.index,3);assert.equal(pin.saveVersion,5);assert.equal(pin.sentAt,null);
  assert.equal(slots[0],snapshot);assert.equal(snapshot.index,0);assert.equal(snapshot.saveVersion,8);
  swapCaptureSlots(slots,0,3);assert.equal(slots[0],pin);assert.equal(slots[3],snapshot);
});
test('moving a capture into an empty key leaves exactly one instance and invalid keys cannot mutate the board',()=>{
  const pin={index:2,saveVersion:0},slots=Array(9).fill(null);slots[2]=pin;
  swapCaptureSlots(slots,2,8);assert.equal(slots[2],null);assert.equal(slots[8],pin);assert.equal(pin.index,8);assert.equal(slots.filter(Boolean).length,1);
  assert.throws(()=>swapCaptureSlots(slots,-1,8),RangeError);assert.equal(slots[8],pin);
});


test('overflow captures participate in Pick, Remove and Reorder while live timers keep their item identity',()=>{
  const pin={index:8,source:{capture(){}},timer:42,saveVersion:0},photo={index:13,kind:'snapshot',saveVersion:0};
  const items=new Map([[8,pin],[13,photo]]),actions=[];
  const control=createCaptureMode({hasCapture:index=>items.has(index),onSelect:index=>actions.push(['pick',index]),onRemove:index=>actions.push(['remove',index]),onSwap:(a,b)=>swapCaptureSlots(items,a,b)});
  control.press(13);control.setMode('remove');control.press(13);
  assert.deepEqual(actions,[['pick',13],['remove',13]]);
  control.setMode('reorder');control.press(8);control.press(13);
  assert.equal(items.get(13),pin);assert.equal(pin.index,13);assert.equal(pin.timer,42);assert.equal(items.get(8),photo);
  swapCaptureSlots(items,8,13);assert.equal(items.get(8),pin);assert.equal(items.size,2);
});
