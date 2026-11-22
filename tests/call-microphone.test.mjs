import test from 'node:test';
import assert from 'node:assert/strict';
import {createCallMicrophone} from '../dist/call-microphone.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
class Track extends EventTarget {
  constructor(id='mic-a'){super();this.id=id;this.kind='audio';this.label='Microphone '+id;this.readyState='live';this.enabled=true;this.muted=false;this.stops=0;}
  getSettings(){return {deviceId:this.id,channelCount:2,sampleRate:48000,echoCancellation:false};}
  stop(){this.stops++;this.readyState='ended';}
  unplug(){this.readyState='ended';this.dispatchEvent(new Event('ended'));}
  interrupt(muted){this.muted=muted;this.dispatchEvent(new Event(muted?'mute':'unmute'));}
}
function stream(id='mic-a') {const track=new Track(id);return {track,getTracks:()=>[track],getAudioTracks:()=>[track]};}
class Context extends EventTarget {
  constructor(events,options={}){super();this.events=events;this.options=options;this.state='suspended';this.resumeCalls=0;this.closeCalls=0;this.connections=[];this.disconnections=0;}
  get destination(){assert.fail('The microphone must never be routed to audible output');}
  resume(){this.resumeCalls++;this.events.push('resume');if(this.options.resume)return this.options.resume(this);this.state='running';this.dispatchEvent(new Event('statechange'));return Promise.resolve();}
  close(){this.closeCalls++;this.state='closed';this.dispatchEvent(new Event('statechange'));return this.options.close?this.options.close():Promise.resolve();}
  createAnalyser(){const context=this;return {fftSize:256,getFloatTimeDomainData:data=>data.fill(0.25),disconnect(){context.disconnections++;}};}
  createMediaStreamSource(input){this.input=input;this.events.push('wire');return {connect:node=>this.connections.push(node),disconnect:()=>this.disconnections++};}
}
function fixture(options={}){
  const states=[],streams=[],errors=[],requests=[],contexts=[],events=[];
  const gesture={active:options.gesture!==false};
  const getUserMedia=(constraints,control)=>{events.push('getUserMedia');const pending=deferred();requests.push({constraints,control,...pending});return options.getUserMedia?options.getUserMedia(constraints,control,pending):pending.promise;};
  const controller=createCallMicrophone({
    getUserMedia, timeoutMs:options.timeoutMs || 1000,isUserGesture:()=>gesture.active,
    getAudioContext:()=>{events.push('context');if(options.noContext)return null;if(options.contextError)throw options.contextError;const context=new Context(events,options.context||{});contexts.push(context);return context;},
    onState:value=>{states.push(value);options.onState?.(value);},
    onStream:(value,state)=>{streams.push({stream:value,state});options.onStream?.(value,state);},
    onError:(error,state)=>{errors.push({error,state});options.onError?.(error,state);},
  });
  return {controller,states,streams,errors,requests,contexts,events,gesture};
}

test('creation, mute intent and disconnect do not request permission or open an AudioContext',()=>{
  const f=fixture();assert.equal(f.controller.getState().status,'off');
  f.controller.setMuted(true);assert.equal(f.controller.getState().targetMuted,true);
  assert.equal(f.controller.getState().status,'off');assert.equal(f.controller.getLevel(),0);
  f.controller.toggleMuted();f.controller.disconnect();f.controller.destroy();
  assert.equal(f.requests.length,0);assert.equal(f.contexts.length,0);
});

test('connect requests only the chosen microphone, resumes the meter synchronously and shares the original stream',async()=>{
  const f=fixture(),input=stream();const pending=f.controller.connect('mic-a');
  assert.deepEqual(f.events,['context','resume','getUserMedia']);
  assert.equal(f.controller.getState().status,'connecting');
  assert.deepEqual(f.requests[0].constraints,{video:false,audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:2},sampleRate:{ideal:48000},deviceId:{exact:'mic-a'}}});
  f.gesture.active=false;f.requests[0].resolve(input);assert.equal(await pending,true);
  assert.strictEqual(f.controller.getStream(),input);assert.strictEqual(f.streams[0].stream,input);
  assert.strictEqual(f.contexts[0].input,input);assert.equal(f.contexts[0].resumeCalls,1);
  assert.equal(f.contexts[0].connections.length,1);assert.equal(f.controller.getLevel(),0.25);
  assert.equal(f.controller.getState().label,'Microphone mic-a');assert.equal(f.controller.getState().status,'live');
  f.controller.destroy();assert.equal(input.track.stops,1);assert.equal(f.contexts[0].closeCalls,1);
});

test('mute keeps the same recording track, produces an immediate zero meter, and never reacquires the device',async()=>{
  const f=fixture(),input=stream(),pending=f.controller.connect();f.requests[0].resolve(input);await pending;
  const recordingTrack=f.controller.getStream().getAudioTracks()[0];
  f.controller.setMuted(true);
  assert.equal(recordingTrack.enabled,false);assert.equal(input.track.stops,0);
  assert.equal(f.controller.getState().status,'muted');assert.equal(f.controller.getLevel(),0);
  f.controller.toggleMuted();assert.equal(recordingTrack.enabled,true);assert.equal(f.controller.getLevel(),0.25);
  assert.strictEqual(f.controller.getStream(),input);assert.equal(f.requests.length,1);assert.equal(f.streams.length,1);
  f.controller.destroy();
});

test('mute chosen while permission is pending applies before the granted stream is published',async()=>{
  let enabledAtDelivery;
  const f=fixture({onStream:value=>{if(value)enabledAtDelivery=value.track.enabled;}}),input=stream();
  const pending=f.controller.connect();f.controller.setMuted(true);
  assert.equal(f.controller.getState().status,'connecting');assert.equal(f.controller.getState().targetMuted,true);
  f.requests[0].resolve(input);assert.equal(await pending,true);
  assert.equal(enabledAtDelivery,false);assert.equal(f.controller.getState().status,'muted');assert.equal(f.controller.getLevel(),0);
  f.controller.destroy();
});

test('double-connect coalesces the same permission request and an existing same-device connection',async()=>{
  const f=fixture(),input=stream();const first=f.controller.connect('mic-a'),second=f.controller.connect('mic-a');
  assert.strictEqual(first,second);assert.equal(f.requests.length,1);assert.equal(f.contexts.length,1);
  f.requests[0].resolve(input);assert.equal(await first,true);
  f.controller.setMuted(true);assert.equal(await f.controller.connect('mic-a'),true);
  assert.equal(f.requests.length,1);assert.equal(input.track.enabled,false);f.controller.destroy();
});

test('cancel settles a pending connection promptly and stops a permission grant that arrives later',async()=>{
  const f=fixture();const pending=f.controller.connect();f.controller.disconnect();
  assert.equal(await pending,false);assert.equal(f.controller.getState().status,'off');
  const late=stream();f.requests[0].resolve(late);await flush();
  assert.equal(late.track.stops,1);assert.equal(f.controller.getStream(),null);assert.equal(f.streams.length,0);
  assert.equal(f.errors.length,0);assert.equal(f.contexts[0].closeCalls,1);f.controller.destroy();
});

test('device switching releases the old microphone, preserves mute, and publishes only the replacement',async()=>{
  const f=fixture(),a=stream('a'),b=stream('b');const first=f.controller.connect('a');f.requests[0].resolve(a);await first;
  f.controller.setMuted(true);const second=f.controller.connect('b');
  assert.equal(a.track.stops,1);assert.equal(f.controller.getStream(),null);assert.equal(f.streams.at(-1).stream,null);
  f.requests[1].resolve(b);assert.equal(await second,true);assert.equal(b.track.enabled,false);
  assert.equal(f.controller.getState().deviceId,'b');assert.equal(f.controller.getState().status,'muted');
  assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.contexts[1].closeCalls,0);f.controller.destroy();
});

test('rapid switches settle every promise and discard all out-of-order grants except the latest',async()=>{
  const f=fixture({noContext:true}),promises=[],inputs=[];
  for(let i=0;i<100;i++){promises.push(f.controller.connect('mic-'+i));inputs.push(stream('mic-'+i));}
  for(let i=99;i>=0;i--)f.requests[i].resolve(inputs[i]);
  const results=await Promise.all(promises);await flush();
  assert.equal(results.filter(Boolean).length,1);assert.equal(results[99],true);
  assert.equal(f.streams.filter(item=>item.stream).length,1);assert.strictEqual(f.controller.getStream(),inputs[99]);
  assert.ok(inputs.slice(0,99).every(input=>input.track.stops===1));assert.equal(inputs[99].track.stops,0);
  f.controller.destroy();
});

test('permission rejection has useful error state and closes the unused meter',async()=>{
  const f=fixture();const pending=f.controller.connect();f.requests[0].reject(new DOMException('Denied','NotAllowedError'));
  assert.equal(await pending,false);assert.equal(f.controller.getState().status,'error');
  assert.match(f.controller.getState().permissionError,/Allow this site/);assert.equal(f.controller.getStream(),null);
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].error.name,'NotAllowedError');
  assert.equal(f.contexts[0].closeCalls,1);f.controller.destroy();
});

test('timed-out permission requests settle and late inputs are stopped',async()=>{
  const f=fixture({timeoutMs:10});assert.equal(await f.controller.connect(),false);
  assert.equal(f.controller.getState().error.name,'TimeoutError');assert.equal(f.errors.length,1);
  const late=stream();f.requests[0].resolve(late);await flush();
  assert.equal(late.track.stops,1);assert.equal(f.controller.getStream(),null);f.controller.destroy();
});

test('unplugging the input releases it and reports a reconnectable error without requesting another microphone',async()=>{
  const f=fixture(),input=stream(),pending=f.controller.connect();f.requests[0].resolve(input);await pending;
  input.track.unplug();assert.equal(f.controller.getState().status,'error');assert.equal(f.controller.getStream(),null);
  assert.equal(f.controller.getLevel(),0);assert.equal(f.controller.getState().permissionError,null);
  assert.equal(f.requests.length,1);assert.equal(f.streams.at(-1).stream,null);assert.equal(f.contexts[0].closeCalls,1);
  f.controller.destroy();
});

test('temporary source mute is distinct from user mute and cannot leave a stale nonzero meter',async()=>{
  const f=fixture(),input=stream(),pending=f.controller.connect();f.requests[0].resolve(input);await pending;
  input.track.interrupt(true);assert.equal(f.controller.getState().interrupted,true);assert.equal(f.controller.getState().targetMuted,false);assert.equal(f.controller.getLevel(),0);
  input.track.interrupt(false);assert.equal(f.controller.getState().interrupted,false);assert.equal(f.controller.getLevel(),0.25);
  f.controller.setMuted(true);input.track.interrupt(false);assert.equal(f.controller.getLevel(),0);f.controller.destroy();
});

test('AudioContext is never resumed from an asynchronous permission result, and a later explicit unmute can enable its meter',async()=>{
  const f=fixture({gesture:false}),input=stream(),pending=f.controller.connect();
  assert.equal(f.contexts.length,0);f.requests[0].resolve(input);await pending;
  assert.equal(f.contexts.length,0);assert.equal(f.controller.getState().status,'live');assert.equal(f.controller.getLevel(),0);
  f.gesture.active=true;f.controller.setMuted(false);
  assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].resumeCalls,1);assert.equal(f.controller.getLevel(),0.25);
  f.controller.destroy();
});

test('Web Audio absence or failure does not turn a working microphone into a connection failure',async()=>{
  for(const options of [{noContext:true},{contextError:new Error('No analyser context')}]){
    const f=fixture(options),input=stream(),pending=f.controller.connect();f.requests[0].resolve(input);assert.equal(await pending,true);
    assert.equal(f.controller.getState().status,'live');assert.equal(f.controller.getState().meterAvailable,false);
    assert.equal(f.controller.getLevel(),0);assert.equal(f.errors.length,0);f.controller.destroy();
  }
});

test('a pending or rejected AudioContext resume cannot delay microphone connection or leak after disconnect',async()=>{
  const resume=deferred(),f=fixture({context:{resume:()=>resume.promise}}),input=stream(),pending=f.controller.connect();
  f.requests[0].resolve(input);assert.equal(await pending,true);assert.equal(f.controller.getLevel(),0);
  f.controller.disconnect();resume.reject(new Error('Audio context closed'));await flush();
  assert.equal(f.controller.getState().status,'off');assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.errors.length,0);f.controller.destroy();
});

test('reentrant cancellation in onState cannot open a permission request after being canceled',async()=>{
  let f;f=fixture({onState:state=>{if(state.status==='connecting')f.controller.disconnect();}});
  assert.equal(await f.controller.connect(),false);assert.equal(f.requests.length,0);assert.equal(f.contexts.length,0);
  assert.equal(f.controller.getState().status,'off');f.controller.destroy();
});

test('onStream can synchronously switch inputs without an old completion overriding the new state',async()=>{
  let f,replacement;
  f=fixture({onStream:value=>{if(value?.track.id==='a')replacement=f.controller.connect('b');}});
  const first=f.controller.connect('a'),a=stream('a');f.requests[0].resolve(a);assert.equal(await first,false);
  const b=stream('b');f.requests[1].resolve(b);assert.equal(await replacement,true);
  assert.strictEqual(f.controller.getStream(),b);assert.equal(a.track.stops,1);assert.equal(f.controller.getState().deviceId,'b');
  f.controller.destroy();
});

test('destroy cancels pending permission, prevents reconnect and ignores late errors',async()=>{
  const f=fixture(),pending=f.controller.connect();f.controller.destroy();assert.equal(await pending,false);
  assert.equal(await f.controller.connect('b'),false);f.requests[0].reject(new Error('late permission error'));await flush();
  assert.equal(f.requests.length,1);assert.equal(f.controller.getState().destroyed,true);assert.equal(f.errors.length,0);
  assert.equal(f.contexts[0].closeCalls,1);
});
