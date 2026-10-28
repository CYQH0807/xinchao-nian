import test from 'node:test';
import assert from 'node:assert/strict';
import { applySatisfaction, newState } from '../src/engine.js';

const T = new Date('2026-10-26T06:00:00Z');

test('/v1/satisfy：只走乘法满足 + 饱足平台；不算她来了；同一个 eventId 不重复', () => {
  const s0 = newState(T);
  s0.drives.libido = 0.8;
  s0.drives.possess = 0.7;
  const before = s0.lastConversationAt;
  const { state, applied } = applySatisfaction(s0, ['libido', 'nope'], T, { eventId: 'e1' });
  assert.deepEqual(applied, ['libido']);
  assert.ok(state.drives.libido < 0.8 * 0.5);
  assert.equal(state.drives.possess, 0.7);                 // 想她不动
  assert.ok(state.satisfactionPlateaus.libido);
  assert.equal(state.lastConversationAt, before);          // 不算她来过
  const again = applySatisfaction(state, ['libido'], T, { eventId: 'e1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.state.drives.libido, state.drives.libido);
});


test('satisfaction applies repeated keys once and keeps pending elapsed time, sleep and emotion', () => {
  const s0 = newState(T);
  s0.consciousness = 'sleeping';
  s0.drives.libido = 0.8;
  const emotion = structuredClone(s0.emotion);
  const before = { lastSettledAt: s0.lastSettledAt, lastConversationAt: s0.lastConversationAt, sleepStartedAt: s0.sleepStartedAt };
  const later = new Date(T.getTime() + 2 * 3_600_000);
  const single = applySatisfaction(s0, ['libido'], later, { eventId: 'single' });
  const repeated = applySatisfaction(s0, ['libido', 'libido'], later, { eventId: 'repeated' });
  assert.deepEqual(repeated.applied, ['libido']);
  assert.deepEqual(repeated.state.drives, single.state.drives);
  assert.equal(repeated.state.consciousness, 'sleeping');
  assert.deepEqual(repeated.state.emotion, emotion);
  assert.equal(repeated.state.lastSettledAt, before.lastSettledAt);
  assert.equal(repeated.state.lastConversationAt, before.lastConversationAt);
  assert.equal(repeated.state.sleepStartedAt, before.sleepStartedAt);
  const retry = applySatisfaction(repeated.state, ['libido'], later, { eventId: 'repeated' });
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.state.drives, repeated.state.drives);
});

test('an invalid drive cannot reserve an idempotency key before a valid retry', () => {
  const s0 = newState(T);
  const invalid = applySatisfaction(s0, ['invalid'], T, { eventId: 'same-event' });
  assert.deepEqual(invalid.applied, []);
  const corrected = applySatisfaction(invalid.state, ['curiosity'], T, { eventId: 'same-event' });
  assert.deepEqual(corrected.applied, ['curiosity']);
});
