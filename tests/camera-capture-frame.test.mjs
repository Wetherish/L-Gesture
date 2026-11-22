import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function captureCurrentFrame('), end = app.indexOf('function takeSnapshot(', start);
assert.ok(start >= 0 && end > start);

function harness() {
  const calls = [], camera = {videoWidth: 1280, videoHeight: 720};
  const context = Object.fromEntries(['save', 'translate', 'scale', 'drawImage', 'restore', 'getImageData'].map(method => [method, (...args) => calls.push([method, ...args])]));
  const canvas = {getContext: () => context};
  const capture = vm.runInNewContext(app.slice(start, end) + '\ncaptureCurrentFrame;', {
    state: {source: {type: 'camera'}, mirror: true}, video: camera,
    document: {createElement: () => canvas}, overlayEnabled: () => true,
    cameraOverlayFrame: () => ({id: 'developer-overlay'}), overlayOptions: () => ({mirror: true}),
    drawLandmarks: (...args) => calls.push(['landmarks', ...args]),
  });
  return {calls, camera, canvas, capture};
}

test('automatic object capture freezes raw unmirrored camera pixels even when preview and developer overlays are enabled', () => {
  const h = harness(), frame = h.capture({includeOverlays: false, mirror: false});
  assert.equal(frame, h.canvas); assert.equal(frame.width, 1280); assert.equal(frame.height, 720);
  assert.deepEqual(h.calls.map(call => call[0]), ['save', 'drawImage', 'restore', 'getImageData']);
  assert.equal(h.calls[1][1], h.camera);
});

test('manual camera snapshots preserve their existing mirrored preview and overlay defaults', () => {
  const h = harness(); h.capture();
  assert.deepEqual(h.calls.map(call => call[0]), ['save', 'translate', 'scale', 'drawImage', 'restore', 'landmarks', 'getImageData']);
  assert.deepEqual(h.calls[2], ['scale', -1, 1]);
  assert.equal(h.calls[5][3].mirror, true);
});
