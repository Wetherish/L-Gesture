import test from 'node:test';
import assert from 'node:assert/strict';
import {featurePolicyAllows,inspectBrowserCapabilities,appLaunchUrl,appShareUrl} from '../dist/browser-capabilities.js';

const navigator = {hid:{getDevices(){},requestDevice(){}},mediaDevices:{getUserMedia(){},getDisplayMedia(){}}};
const top = {}; top.self = top; top.top = top;
const framed = {self:{},top:{}};
const policy = allowed => ({featurePolicy:{features:()=>['hid','camera','microphone','display-capture'],allowsFeature:feature=>allowed.includes(feature)}});
test('top-level HTTPS exposes capability availability without requesting any device',()=>{
  const report = inspectBrowserCapabilities({document:policy(['hid','camera','microphone','display-capture']),navigator,window:top,secureContext:true});
  assert.equal(report.embedded,false);
  for (const feature of Object.values(report.features)) assert.equal(feature.status,'ready');
});
test('iframe policy denial is detected even when WebHID exists',()=>{
  const report = inspectBrowserCapabilities({document:policy(['camera']),navigator,window:framed,secureContext:true});
  assert.equal(report.features.hid.available,true);
  assert.equal(report.features.hid.policyAllowed,false);
  assert.equal(report.features.hid.status,'policy-blocked');
  assert.match(report.features.hid.message,/embedded preview/);
  assert.equal(report.features.screen.status,'policy-blocked');
  assert.equal(report.features.camera.status,'ready');
});
test('top-level denial identifies the host instead of promising that another tab will fix it',()=>{
  const report = inspectBrowserCapabilities({document:policy([]),navigator,window:top,secureContext:true});
  assert.match(report.features.hid.message,/host must allow hid/);
  assert.doesNotMatch(report.features.hid.message,/Open the full app/);
});
test('missing or unknown policy introspection remains unknown, not a denial',()=>{
  assert.equal(featurePolicyAllows('hid',{}),null);
  assert.equal(featurePolicyAllows('hid',{permissionsPolicy:{features:()=>['camera'],allowsFeature:()=>false}}),null);
  assert.equal(featurePolicyAllows('hid',{featurePolicy:{allowsFeature(){throw new Error('unsupported')}}}),null);
  const report = inspectBrowserCapabilities({document:{},navigator,window:top,secureContext:true});
  assert.equal(report.features.hid.status,'ready');
});
test('insecure and browser-unsupported features have separate recovery instructions',()=>{
  const insecure = inspectBrowserCapabilities({document:{},navigator,window:top,secureContext:false});
  assert.equal(insecure.features.hid.status,'insecure');
  const partial = inspectBrowserCapabilities({document:{},navigator:{mediaDevices:navigator.mediaDevices},window:top,secureContext:true});
  assert.equal(partial.features.hid.status,'unsupported');
  assert.equal(partial.features.screen.status,'ready');
});
test('share URL excludes credentials, queries and fragments but preserves a portable install path',()=>{
  assert.equal(appLaunchUrl('https://u:p@app.example/studio/?token=secret#capture'), 'https://app.example/studio/');
  assert.equal(appLaunchUrl('http://localhost:8080/'), 'http://localhost:8080/');
  assert.equal(appLaunchUrl('file:///local/index.html'), 'https://aperture-camera-lab.batikanor.chatgpt.site/');
  assert.equal(appShareUrl('http://127.0.0.1:8080/?token=private'), 'https://aperture-camera-lab.batikanor.chatgpt.site/');
  assert.equal(appShareUrl('https://app.example/studio/?token=private'), 'https://app.example/studio/');
});
