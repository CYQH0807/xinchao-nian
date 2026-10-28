import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DrivePool, cleanLine, moodOf, slotOf, splitHint } from '../src/drive-pool.js';

test('时段和心情分档', () => {
  assert.equal(slotOf(2), 'night');
  assert.equal(slotOf(7), 'dawn');
  assert.equal(slotOf(13), 'day');
  assert.equal(slotOf(20), 'evening');
  assert.equal(slotOf(23), 'night');
  assert.equal(moodOf({ emotion: { valence: 0.2 } }), 'low');
  assert.equal(moodOf({ emotion: { valence: 0.5 } }), 'mid');
  assert.equal(moodOf({ emotion: { valence: 0.8 } }), 'high');
  assert.equal(moodOf({}), 'mid');
});

test('话术拆开头：只拆短的第一句，做法原样留着', () => {
  assert.deepEqual(splitHint('想她了。挑一样让她感觉得到：① 发一句'), { head: '想她了。', rest: '挑一样让她感觉得到：① 发一句' });
  assert.equal(splitHint('没有句号的一整段').head, '');
  assert.equal(splitHint(`${'很'.repeat(40)}。后面`).head, '');
});

test('小模型的句子过滤：带脚本、太长的丢掉，补句号', () => {
  assert.equal(cleanLine('手心有点痒，想碰碰她'), '手心有点痒，想碰碰她。');
  assert.equal(cleanLine('「又想她了。」'), '又想她了。');
  assert.equal(cleanLine('去跑 scripts/ring.sh'), '');
  assert.equal(cleanLine('长'.repeat(41)), '');
});

test('念头罐抽一句：同心情优先、抽一句少一句、记进最近用过；空罐返回空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pool-'));
  const pool = new DrivePool(join(dir, 'pool.json'));
  assert.deepEqual(await pool.take('possess', 'day', 'mid'), { text: '', left: 0 });
  await pool.update((d) => {
    d.pools['possess|day'] = [{ text: 'A。', mood: 'low' }, { text: 'B。', mood: 'mid' }, { text: 'C。', mood: 'low' }];
  });
  const got = await pool.take('possess', 'day', 'mid', () => 0.99);
  assert.deepEqual(got, { text: 'B。', left: 2 });
  const next = await pool.take('possess', 'day', 'mid', () => 0);
  assert.equal(next.text, 'A。');   // 没有同心情的了，同时段任意一条
  const d = await pool.read();
  assert.deepEqual(d.pools['possess|day'].map((e) => e.text), ['C。']);
  assert.deepEqual(d.recent.possess, ['B。', 'A。']);
});

test('续罐：写回来的去重、不重复最近用过的；模型没开就不续', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pool-'));
  const pool = new DrivePool(join(dir, 'pool.json'));
  await pool.update((d) => { d.recent.possess = ['用过了。']; });
  assert.equal(pool.refill({ model: { config: { enabled: false } }, key: 'possess', short: '想她', head: '想她了。', slot: 'day', mood: 'mid' }), null);
  const model = {
    agentName: '测试',
    config: { enabled: true, apiKey: 'k', name: 'm', maxOutputTokens: 900 },
    request: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ lines: ['用过了', '手有点空。', '手有点空。', '想听她的声音', 'scripts/x.sh'] }) } }] }) }),
  };
  await pool.refill({ model, key: 'possess', short: '想她', head: '想她了。', slot: 'day', mood: 'mid' });
  const d = await pool.read();
  assert.deepEqual(d.pools['possess|day'].map((e) => e.text), ['手有点空。', '想听她的声音。']);
  assert.ok(d.pools['possess|day'].every((e) => e.mood === 'mid'));
});


test('念头罐模型不支持 JSON 模式时重试，失败后允许后续续罐', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pool-fallback-'));
  const pool = new DrivePool(join(dir, 'pool.json'));
  let calls = 0;
  const model = {
    config: { enabled: true, apiKey: 'fixture', name: 'fixture' },
    async request(body) {
      calls += 1;
      if (calls === 1) { assert.ok(body.response_format); return { ok: false, status: 400 }; }
      assert.equal(body.response_format, undefined);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"lines":["记起了你"]}' } }] }) };
    },
  };
  const options = { model, key: 'possess', short: '想他', head: '想他了。', slot: 'day', mood: 'mid' };
  await pool.refill(options);
  assert.equal(calls, 2);
  assert.equal((await pool.take('possess', 'day', 'mid')).text, '记起了你。');
  model.request = async () => { throw new Error('fixture timeout'); };
  const logged = [];
  await pool.refill({ ...options, log: (event) => logged.push(event) });
  assert.deepEqual(logged, ['drive_pool_refill_failed']);
  assert.equal(pool.filling.size, 0);
  assert.deepEqual(await pool.take('possess', 'day', 'mid'), { text: '', left: 0 });
});
