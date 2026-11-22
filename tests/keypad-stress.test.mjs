import test from 'node:test';
import assert from 'node:assert/strict';
import {runKeypadStress} from '../dist/keypad-stress.js';

function harness() {
  const state = {mode: 'reorder', selected: 4, connected: true, error: null, acceptedFrames: 20, busyRetries: 7};
  const captures = Object.freeze(Array.from({length: 9}, (_, index) => Object.freeze({index, title: `Capture ${index}`, kind: index % 2 ? 'pin' : 'snapshot'})));
  const events = [], progress = [];
  let time = 0, flushes = 0;
  const options = {
    initialSelection: 4,
    getState: () => ({...state}),
    setPick: () => {state.mode = 'normal'; events.push(['mode', 'normal']);},
    navigate: direction => {
      const next = {normal: 'remove', remove: 'reorder', reorder: 'normal'};
      const previous = {normal: 'reorder', reorder: 'remove', remove: 'normal'};
      state.mode = (direction === 'next' ? next : previous)[state.mode];
      events.push(['navigate', direction, state.mode]);
    },
    select: index => {
      assert.equal(state.mode, 'normal', 'No key press is allowed in Remove or Reorder');
      state.selected = index;
      events.push(['select', index]);
    },
    flush: async () => {
      flushes++;
      state.acceptedFrames++;
      events.push(['flush', state.mode, state.selected]);
      return {status: 'sent', deviceAccepted: true};
    },
    sleep: async milliseconds => {time += milliseconds;},
    now: () => time,
    onProgress: value => progress.push(value)
  };
  return {state, captures, events, progress, options, get flushes() {return flushes;}};
}

test('1,200 paced requests cycle both ways, make only safe Pick selections, and report counter deltas', async () => {
  const h = harness(), before = JSON.stringify(h.captures);
  let sleeps = 0;
  const result = await runKeypadStress({...h.options, sleep: async ms => {
    await h.options.sleep(ms);
    sleeps++;
    if (sleeps % 8 === 0) h.state.acceptedFrames++;
    if (sleeps % 11 === 0) h.state.busyRetries++;
  }});
  assert.equal(result.status, 'passed');
  assert.equal(result.completed, 1200);
  assert.equal(result.steps, 1200);
  assert.equal(result.elapsedMs, 1199 * 25);
  assert.equal(result.confirmedFrames, h.state.acceptedFrames - 20);
  assert.equal(result.confirmedDuringLoad, result.confirmedFrames - 1, 'The restoration frame is excluded from load confirmations');
  assert.equal(result.busyRetries, h.state.busyRetries - 7);
  assert(result.confirmedFrames > 0);
  assert.equal(h.events.filter(event => event[0] === 'navigate').length, 900);
  assert.equal(h.events.filter(event => event[0] === 'select').length, 301, '300 test selections plus the final restoration');
  assert.deepEqual(new Set(h.events.filter(event => event[0] === 'navigate').map(event => event[1])), new Set(['next', 'previous']));
  assert.deepEqual(h.events.at(-1), ['flush', 'normal', 4]);
  assert.equal(h.flushes, 1);
  assert.equal(JSON.stringify(h.captures), before, 'No capture or capture order changes');
  assert.equal(h.progress.at(-1).status, 'passed');
});

test('a zero-delay burst restores the starting selection and needs a fresh device confirmation', async () => {
  const h = harness();
  let loadConfirmed = false;
  const result = await runKeypadStress({...h.options, steps: 240, intervalMs: 0, sleep: async () => {
    if (!loadConfirmed) {h.state.acceptedFrames++; loadConfirmed = true;}
  }});
  assert.equal(result.status, 'passed');
  assert.equal(result.completed, 240);
  assert.equal(result.elapsedMs, 0);
  assert.equal(result.confirmedFrames, 2);
  assert.equal(result.confirmedDuringLoad, 1);
  assert.equal(result.busyRetries, 0, 'Historical busy retries are excluded');
  assert.equal(h.state.mode, 'normal');
  assert.equal(h.state.selected, 4);
});

test('a multi-step run cannot pass when only its final restoration frame was accepted', async () => {
  const h = harness();
  const result = await runKeypadStress({...h.options, steps: 40, intervalMs: 0});
  assert.equal(result.status, 'failed');
  assert.equal(result.completed, 40);
  assert.equal(result.confirmedFrames, 1);
  assert.equal(result.confirmedDuringLoad, 0);
  assert.match(result.error, /Only the final restoration frame/);
  assert.deepEqual(h.events.at(-1), ['flush', 'normal', 4]);
});

test('cancellation interrupts an unresolved sleep, restores Pick, flushes, and remains stopped', {timeout: 1000}, async () => {
  const h = harness(), controller = new AbortController();
  let beganSleeping;
  const sleeping = new Promise(resolve => {beganSleeping = resolve;});
  const running = runKeypadStress({...h.options, signal: controller.signal, sleep: () => {
    beganSleeping();
    return new Promise(() => {});
  }});
  await sleeping;
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'stopped');
  assert.equal(result.completed, 1);
  assert.equal(result.confirmedFrames, 1);
  assert.deepEqual(h.events.at(-1), ['flush', 'normal', 4]);
  assert.equal(h.events.filter(event => event[0] === 'navigate').length, 0);
});

test('cancellation during final confirmation never becomes a passed result or aborts the write', async () => {
  const h = harness(), controller = new AbortController();
  let confirm, beganFlush;
  const flushing = new Promise(resolve => {beganFlush = resolve;});
  const pending = new Promise(resolve => {confirm = resolve;});
  const running = runKeypadStress({...h.options, steps: 1, signal: controller.signal, flush: () => {beganFlush(); return pending;}});
  await flushing;
  controller.abort();
  h.state.acceptedFrames++;
  confirm({status: 'sent', deviceAccepted: true});
  const result = await running;
  assert.equal(result.status, 'stopped');
  assert.equal(result.confirmedFrames, 1);
  assert.equal(h.state.mode, 'normal');
  assert.equal(h.state.selected, 4);
});

test('a transport error or disconnect fails the run even if final restoration later succeeds', async () => {
  for (const failure of ['error', 'disconnect']) {
    const h = harness();
    let sleeps = 0;
    const result = await runKeypadStress({...h.options, steps: 30, sleep: async ms => {
      await h.options.sleep(ms);
      if (++sleeps === 3) {
        if (failure === 'error') h.state.error = 'USB report failed';
        else h.state.connected = false;
      }
    }, flush: async () => {
      h.state.error = null; h.state.connected = true;
      return h.options.flush();
    }});
    assert.equal(result.status, 'failed');
    assert.equal(result.completed, 3);
    assert.match(result.error, failure === 'error' ? /USB report failed/ : /disconnected/);
    assert.deepEqual(h.events.at(-1), ['flush', 'normal', 4]);
    assert.equal(result.confirmedFrames, 1, 'A later accepted frame cannot erase an earlier transport failure');
  }
});

test('pass requires an accepted final board and a new confirmation beyond the starting counter', async () => {
  for (const invalid of ['unaccepted', 'superseded', 'no-new-confirmation']) {
    const h = harness();
    const result = await runKeypadStress({...h.options, steps: 1, flush: async () => {
      if (invalid !== 'no-new-confirmation') h.state.acceptedFrames++;
      return {status: invalid === 'superseded' ? 'superseded' : 'sent', deviceAccepted: invalid !== 'unaccepted'};
    }});
    assert.equal(result.status, 'failed', invalid);
    assert.match(result.error, /not accepted|No new keypad frame/);
    assert.equal(h.state.mode, 'normal');
    assert.equal(h.state.selected, 4);
  }
});

test('a stalled final flush is bounded and never turns an unconfirmed run into a pass', {timeout: 1000}, async () => {
  const h = harness();
  let lateResolve;
  const pending = new Promise(resolve => {lateResolve = resolve;});
  const result = await runKeypadStress({...h.options, steps: 1, flushTimeoutMs: 15, flush: () => pending});
  assert.equal(result.status, 'failed');
  assert.match(result.error, /not confirmed.*timeout/);
  assert.equal(h.state.mode, 'normal');
  assert.equal(h.state.selected, 4);
  lateResolve({status: 'sent', deviceAccepted: true});
  await Promise.resolve();
  assert.equal(result.status, 'failed', 'A late completion cannot rewrite an already returned test result');
});

test('a cancelled run with no transport failure remains stopped when final flushing times out', {timeout: 1000}, async () => {
  const h = harness(), controller = new AbortController();
  controller.abort();
  const result = await runKeypadStress({...h.options, signal: controller.signal, flushTimeoutMs: 15, flush: () => new Promise(() => {})});
  assert.equal(result.status, 'stopped');
  assert.equal(result.completed, 0);
  assert.match(result.error, /not confirmed.*timeout/);
  assert.equal(h.state.mode, 'normal');
  assert.equal(h.state.selected, 4);
  assert.equal(h.events.filter(event => event[0] === 'navigate').length, 0);
});

test('cancelling during an unresponsive final flush stays stopped after the bounded wait', {timeout: 1000}, async () => {
  const h = harness(), controller = new AbortController();
  const result = await runKeypadStress({...h.options, steps: 1, signal: controller.signal, flushTimeoutMs: 15, flush: () => {
    controller.abort();
    return new Promise(() => {});
  }});
  assert.equal(result.status, 'stopped');
  assert.match(result.error, /timeout/);
  assert.equal(h.state.mode, 'normal');
  assert.equal(h.state.selected, 4);
});

test('an incorrectly wired Pick callback cannot cause a Remove or Reorder key action', async () => {
  const h = harness();
  h.state.mode = 'remove';
  const result = await runKeypadStress({...h.options, setPick: () => {}, steps: 12});
  assert.equal(result.status, 'failed');
  assert.equal(result.completed, 0);
  assert.equal(h.events.filter(event => event[0] === 'select').length, 0);
  assert.equal(h.events.filter(event => event[0] === 'navigate').length, 0);
  assert.match(result.error, /Could not enter Pick/);
});
