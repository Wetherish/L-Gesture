/**
 * Offline audit of the pinned SDK's behavior when analytics network access is
 * rejected. This executes the unmodified vendor logger in an isolated VM with
 * a rejecting fetch stub; it never opens a network connection or runs a model.
 *
 * Run: node scripts/audit-mediapipe-privacy.mjs
 *
 * Private names are deliberately tied to the pinned, hashed runtime. A vendor
 * upgrade requires a fresh source audit, not just updating this fixture.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {installObjectNetworkPolicy} from '../dist/object-detector-worker.js';

const vendor = new URL('../dist/vendor/mediapipe/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', vendor), 'utf8'));
assert.equal(manifest.runtime.version, '1.2.3', 'Re-audit privacy behavior for a new SDK version');
const code = readFileSync(new URL('vision_bundle.mjs', vendor), 'utf8');
const entry = manifest.files.find(file => file.path === 'vision_bundle.mjs');
assert.equal(createHash('sha256').update(code).digest('hex'), entry.sha256);

// Expose the exact vendor logger only inside the VM; the on-disk module remains
// byte-identical to the upstream package. Remove the ESM export for VM parsing.
const exportClause = /export\{[^}]*\};\s*\/\/# sourceMappingURL=[^\n]*\s*$/;
assert.match(code, exportClause, 'Vendor module structure changed; re-audit required');
const instrumented = code.replace(exportClause, '') + ';self.audit={Logger:xh,Event:_h};';
const consoleCalls = [];
const fetchAttempts = [];
const intervals = new Map();
const unhandled = [];
let intervalId = 0;
const sandbox = {
  self: {}, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, AbortController,
  performance, atob, btoa, setTimeout, clearTimeout,
  console: Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map(level =>
    [level, (...args) => consoleCalls.push({level, args: args.map(String)})])),
  setInterval: (callback, ms) => {
    const id = ++intervalId;
    intervals.set(id, {callback, ms});
    return id;
  },
  clearInterval: id => intervals.delete(id),
  location: {href:'https://roofcat-audit.example/object-detector-worker.js'},
  fetch: async (url, options) => {
    fetchAttempts.push({url: String(url), method: options?.method});
    throw new TypeError('External network disabled by the audit');
  },
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const recordUnhandled = reason => unhandled.push(reason);
process.on('unhandledRejection', recordUnhandled);
try {
  vm.runInNewContext(instrumented, sandbox, {timeout: 3000});
  const {Logger, Event} = sandbox.self.audit;
  const logger = new Logger('offline-audit-placeholder');
  assert.equal(intervals.size, 1);
  assert.equal([...intervals.values()][0].ms, 60_000);
  logger.i.push(new Event());
  logger.flush();
  await settle();
  assert.deepEqual(fetchAttempts, [{url: 'https://odml.pa.googleapis.com/v1/log', method: 'POST'}]);
  assert.equal(logger.error?.message, 'Logging failed with HTTP error: 0');
  assert.equal(logger.i.length, 0);
  assert.equal(intervals.size, 0);
  for (let n = 0; n < 20; n++) logger.flush();
  logger.close();
  await settle();
  await settle();
  assert.equal(fetchAttempts.length, 1, 'Logger must stop retrying after a blocked request');
  assert.equal(consoleCalls.length, 0, 'Blocked analytics must remain silent');
  assert.equal(unhandled.length, 0, 'Blocked analytics must not create an unhandled rejection');
  assert.equal(intervals.size, 0);
  // Exercise the real new worker policy with the exact pinned vendor logger.
  // The stub above must not be reached at all by this second analytics logger.
  const restorePolicy=installObjectNetworkPolicy(sandbox,'https://roofcat-audit.example');
  const protectedLogger=new Logger('object-worker-audit-placeholder');
  protectedLogger.i.push(new Event());protectedLogger.flush();await settle();await settle();
  assert.equal(fetchAttempts.length,1,'Object worker must block analytics before reaching fetch');
  assert.equal(protectedLogger.error?.message,'Logging failed with HTTP error: 0');
  assert.equal(intervals.size,0);protectedLogger.close();restorePolicy();
  assert.equal(unhandled.length,0);assert.equal(consoleCalls.length,0);
  console.log('MediaPipe privacy audit passed: both logger failure handling and object-worker network policy are silent, nonfatal, and stop analytics retries. No network used.');
} finally {
  process.removeListener('unhandledRejection', recordUnhandled);
}
