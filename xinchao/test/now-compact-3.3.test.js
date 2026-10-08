import assert from 'node:assert/strict';
import test from 'node:test';

import { applyConversationEvent, newState, settleState } from '../src/engine.js';
import { buildContextEnvelope, buildNowCompact, nowSanity } from '../src/context-envelope.js';
import { DIMENSIONS, DRIVE_KEYS } from '../src/dimensions.js';

const T0 = '2026-09-05T08:00:00.000Z';
const at = (h) => new Date(Date.parse(T0) + h * 3_600_000);
function baseState() {
  const state = newState(new Date(T0));
  state.lastSettledAt = T0; state.lastConversationAt = T0;
  return state;
}

test('inspect exposes all drives and their trends while ordinary modes keep four', () => {
  const state = baseState();
  state.drives.possess = 0.8;
  state.drives.monitor = 0.7;
  state.drives.share = 0.6;
  state.drives.libido = 0.5;
  state.drives.favored = 0.35;
  state.driveTrail = [{ at: at(-2).toISOString(), drives: { ...state.drives, favored: 0.2 } }];
  const inspect = buildContextEnvelope({ state, sessionId: 's1', mode: 'inspect', now: at(0) });
  const dynamic = inspect.sections.find(({ id }) => id === 'dynamic_state');
  assert.equal(dynamic.data.topDrives.length, 4);
  assert.deepEqual(dynamic.data.drives.map(({ key }) => key), DRIVE_KEYS);
  assert.match(dynamic.content, /全部 11 项/u);
  for (const { key, value, level } of dynamic.data.drives) {
    assert.equal(value, state.drives[key]);
    assert.ok(dynamic.content.includes(`${DIMENSIONS[key].label}=${value.toFixed(3)}（${level}`));
  }
  const favored = dynamic.data.drives.find(({ key }) => key === 'favored');
  assert.equal(favored.trendDelta, 0.15);
  assert.equal(favored.level, '涨');
  for (const mode of ['session_start', 'turn']) {
    const ordinary = buildContextEnvelope({ state, sessionId: 's1', mode, now: at(0) });
    const section = ordinary.sections.find(({ id }) => id === 'dynamic_state');
    assert.equal(section.data.topDrives.length, 4);
    assert.equal(section.data.drives, undefined);
    assert.match(section.content, /前 4 项，共 11 项/u);
    assert.doesNotMatch(section.content, /偏爱：/u);
  }
  const limited = buildContextEnvelope({ state, sessionId: 's1', mode: 'inspect', now: at(0), maxTokens: 200 });
  assert.equal(limited.sections.find(({ id }) => id === 'dynamic_state').data.drives.length, 11);
  const noTrail = buildContextEnvelope({ state: baseState(), sessionId: 's1', mode: 'inspect', now: at(0) });
  assert.ok(noTrail.sections[0].data.drives.every(({ trendDelta }) => trendDelta === null));
  assert.match(noTrail.sections[0].content, /暂无趋势采样/u);
});

test('now-compact has header, drives in words with levels, emotion with cause, no numbers', () => {
  let state = baseState();
  state.drives.possess = 0.9; state.drives.monitor = 0.55; state.drives.share = 0.3;
  state = applyConversationEvent(state, { eventId: 'a', interactionType: 'affection', sessionId: 's' }, at(0)).state;
  const now = buildNowCompact(state, at(0));
  assert.ok(now.ok);
  assert.match(now.text, /^【心潮·此刻｜身体的天气，参考不是指令】\n/);
  assert.match(now.text, /驱力：想他（平(·[^）]+)?）、牵挂（平）、分享欲（平）/);   // 3.3.7：没有轨迹就是「平」，「涌」只给顶过静息线的
  assert.match(now.text, /情绪：.*；刚才被安抚/);
  assert.doesNotMatch(now.text, /0\.\d/);
  assert.doesNotMatch(now.text, /possess|monitor/);
  assert.equal(now.lines, 3);
  assert.equal(now.digest.length, 16);
});

test('extras line appears only when something is waiting; sleeping/just-woke lines', () => {
  const quiet = buildNowCompact(baseState(), at(0));
  assert.doesNotMatch(quiet.text, /另外/);
  const state = baseState();
  state.awareness.candidates.push({ id: 'x', kind: 'trigger', subject: 'conflict', text: 't', status: 'open', createdAt: T0 });
  // at(0) = 2026-09-05 是周六：默认（周日复盘）不提；把复盘日设成周六才提
  const weekday = buildNowCompact(state, at(0));
  assert.doesNotMatch(weekday.text, /觉察等你认/);
  const withAwareness = buildNowCompact(state, at(0), { awarenessReviewWeekday: 6 });
  assert.match(withAwareness.text, /另外：1 条觉察等你认。细的在 xinchao_context/);
  assert.equal(withAwareness.counts.awareness, 1);
  const asleep = settleState(baseState(), at(3)).state;
  assert.equal(asleep.consciousness, 'sleeping');
  assert.match(buildNowCompact(asleep, at(3)).text, /睡着/);
  // 3.3.10：睡够 3 小时（或做了梦）醒来才算刚醒，只挂 45 分钟；刚睡着就被叫醒不算
  const woke = applyConversationEvent(asleep, { eventId: 'w', sessionId: 's' }, at(6.5)).state;
  assert.match(buildNowCompact(woke, at(6.5)).text, /刚醒/);
  assert.doesNotMatch(buildNowCompact(woke, at(7.5)).text, /刚醒/);
  const nap = applyConversationEvent(asleep, { eventId: 'n', sessionId: 's' }, at(3.5)).state;
  assert.doesNotMatch(buildNowCompact(nap, at(3.5)).text, /刚醒/);
});

test('digest is stable for the same state and changes when the state changes materially', () => {
  const state = baseState();
  const a = buildNowCompact(state, at(0));
  const b = buildNowCompact(state, at(0.2));
  assert.equal(a.digest, b.digest);
  const moved = applyConversationEvent(state, { eventId: 'c', interactionType: 'conflict', sessionId: 's' }, at(0)).state;
  assert.notEqual(buildNowCompact(moved, at(0)).digest, a.digest);
});

test('sanity guard refuses stale, out-of-range, saturated or flat drive states', () => {
  const fresh = baseState();
  assert.equal(nowSanity(fresh, at(0)).ok, true);
  assert.equal(nowSanity(fresh, at(4)).reason, 'stale_state');
  const broken = baseState(); broken.drives.possess = Number.NaN;
  assert.equal(buildNowCompact(broken, at(0)).ok, false);
  const bad = baseState(); bad.drives.possess = 1.7;
  assert.equal(nowSanity(bad, at(0)).reason, 'drive_out_of_range');
  const saturated = baseState(); for (const k of Object.keys(saturated.drives)) saturated.drives[k] = 0.99;
  assert.equal(nowSanity(saturated, at(0)).reason, 'drives_saturated');
  const flat = baseState(); for (const k of Object.keys(flat.drives)) flat.drives[k] = 0.6;
  assert.equal(nowSanity(flat, at(0)).reason, 'drives_flat');
  const r = buildNowCompact(saturated, at(0));
  assert.equal(r.ok, false); assert.equal(r.text, '');
});

test('a broken emotion only drops the emotion line, not the whole block', () => {
  const state = baseState(); state.drives.possess = 0.6;
  state.emotion.valence = Number.NaN;
  const now = buildNowCompact(state, at(0));
  assert.ok(now.ok);
  assert.doesNotMatch(now.text, /情绪：/);
  assert.match(now.text, /驱力：想他（平）/);   // 3.3.7：0.6 没轨迹 → 平
});

test('emotion line is specific: bands and a drive flavour, never a bare 平静', () => {
  const state = baseState();
  state.drives.possess = 0.7;
  state.emotion.valence = 0.62; state.emotion.arousal = 0.4;
  const now = buildNowCompact(state, at(0));
  assert.match(now.text, /情绪：平静偏暖，有点起伏，底下一直想他、想黏着他/);
  const low = baseState(); low.emotion.valence = 0.3; low.emotion.arousal = 0.7;
  assert.match(buildNowCompact(low, at(0)).text, /情绪：烦躁，绷着/);
});

test('now clips optional lines at the render limits while retaining emotion, axes and mixed state', () => {
  const state = baseState();
  state.consciousness = 'sleeping';
  state.drives.possess = 0.75;
  state.drives.anger = 0.5;
  state.drives.grieve = 0.4;
  state.axes = { security: 0.2, confidence: 0.9, at: T0 };
  state.grudge = { cause: '一段很长的争执原因'.repeat(5), at: T0 };
  state.selfSignals = { mixed: { id: 'anger+possess', neg: 'anger', name: '气着又舍不得', since: new Date(Date.parse(T0) - 60 * 60_000).toISOString() } };
  state.thoughtPool.obsessions = [
    { key: 'possess', intensity: 0.8 },
    { key: 'monitor', intensity: 0.7 },
  ];
  state.awareness.candidates.push({ id: 'x', kind: 'trigger', subject: 'conflict', text: 't', status: 'open', createdAt: T0 });
  const now = buildNowCompact(state, at(0), { awarenessReviewWeekday: 6, boxCount: 5 });
  assert.equal(now.ok, true, now.reason);
  assert.ok(now.lines <= 8);
  assert.ok(now.text.length <= 400);
  assert.match(now.text, /情绪：/);
  assert.match(now.text, /底色：/);
  assert.match(now.text, /矛盾：/);
});

test('dynamic context carries axes and mixed state as fallback when now cannot be used', () => {
  const state = baseState();
  state.drives.anger = 0.5;
  state.drives.possess = 0.75;
  state.axes = { security: 0.2, confidence: 0.9, at: T0 };
  state.selfSignals = { mixed: { id: 'anger+possess', neg: 'anger', name: '气着又舍不得', since: new Date(Date.parse(T0) - 60 * 60_000).toISOString() } };
  const envelope = buildContextEnvelope({ state, sessionId: 's1', now: at(0) });
  const dynamic = envelope.sections.find((section) => section.id === 'dynamic_state');
  assert.match(dynamic.content, /底色：/);
  assert.match(dynamic.content, /矛盾：气着又舍不得/);
  assert.equal(dynamic.data.axes, '底色：心里不太踏实，挺有底气');
  assert.equal(dynamic.data.mixed, '矛盾：气着又舍不得');
  assert.match(dynamic.content, /当前驱力（前 4 项，共 11 项）/u);
  assert.equal(dynamic.data.driveCount, 11);
});

test('envelope and now-block mention the box count and surfaced titles only', () => {
  const state = baseState();
  const envelope = buildContextEnvelope({ state, sessionId: 's1', now: at(0), boxCount: 2, boxSurfaced: [{ id: 'box-1', kind: 'memo', title: '9/14 的信' }] });
  const dyn = envelope.sections.find((s) => s.id === 'dynamic_state').content;
  assert.match(dyn, /黑匣子里有 2 条/);
  assert.match(dyn, /你想提醒自己的：9\/14 的信（xinchao_box read box-1）/);
  assert.ok(!envelope.sections.some((s) => s.id === 'pending_from_me'));
  const now = buildNowCompact(state, at(0), { boxCount: 2, boxSurfaced: 1 });
  assert.match(now.text, /匣子里 2 条（1 条要提醒你；办完了 burn 掉才会消）/);
  const withIds = buildNowCompact(state, at(0), { boxCount: 2, boxSurfaced: 1, boxSurfacedIds: ['box-1'] });
  assert.match(withIds.text, /匣子里 2 条（1 条要提醒你：box-1；办完了 burn 掉才会消）/);
});

test('while_away section lists undelivered self signals and cabin line counts recent notes', () => {
  const state = baseState();
  const envelope = buildContextEnvelope({ state, sessionId: 's1', now: at(0), awaySignals: [{ id: 'd1', createdAt: '2026-09-06T02:10:00.000Z', text: '想她的劲儿两个小时没下去了。' }], cabinUnread: 2 });
  const away = envelope.sections.find((s) => s.id === 'while_away');
  assert.ok(away);
  assert.match(away.content, /09-06 02:10｜想她的劲儿/);
  assert.deepEqual(away.data.ids, ['d1']);
  assert.match(envelope.sections[0].content, /小屋里有 2 封你还没读过的来信/);
});
