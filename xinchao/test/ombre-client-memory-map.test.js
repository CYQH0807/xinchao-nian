import assert from 'node:assert/strict';
import test from 'node:test';

import {
  materialWithRefs,
  OmbreClient,
  parseMemoryMapText,
  parseMemoryPreviewText,
  parseSurfacedBucketIds,
} from '../src/ombre-client.js';

test('breath metadata exposes source bucket ids without guessing from body text', () => {
  const text = `
[bucket_id:74a5375d099c] [domain:恋爱,记忆]\n正文里偶然有 deadbeef1234 不应该被当成桶。
---
[语义关联] [bucket_id:16ef1d2b1fd9] [domain:内心]\n另一条。
---
[bucket_id:74a5375d099c]\n重复表头不重复计数。`;
  assert.deepEqual(parseSurfacedBucketIds(text), ['74a5375d099c', '16ef1d2b1fd9']);
  assert.deepEqual(materialWithRefs(text).bucketIds, ['74a5375d099c', '16ef1d2b1fd9']);
  assert.deepEqual(materialWithRefs(text).domains, ['恋爱', '记忆', '内心']);
});

test('pulse text becomes a metadata-only memory map', () => {
  const result = parseMemoryMapText(`
固化桶：1
动态桶：2
归档桶：3
总占用：2.5 MB
📌 [a35f6a3aeb35] 《以前我们只有文字》 主题:恋爱,成长 情感:V0.9/A0.7 重要:10 权重:80 标签:共同记忆,承诺,成长
[c3b4466ae887] 《你呼吸就可以想起来了》 主题:恋爱 情感:V0.8/A0.4 重要:8 权重:45 标签:共同记忆,承诺,成长
[d4c5577bf998] 《一段完全不同的生活记忆》 主题:生活 情感:V0.5/A0.2 重要:4 权重:12 标签:吃饭,天气,通勤
[e5d6688ca009] 《另一段独立的工作记录》 主题:工作 情感:V0.4/A0.5 重要:3 权重:9 标签:项目,会议,进度
`);

  assert.equal(result.available, true);
  assert.equal(result.total, 4);
  assert.equal(result.stats.pinned, 1);
  assert.equal(result.stars[0].pinned, true);
  assert.equal(result.stars[0].driveSnapshot, null);
  assert.equal(result.stars[0].historical, true);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].kind, 'tag-derived');
  assert.equal('content' in result.stars[0], false);
});

test('structured 3.0 map preserves optional emotional stamp fields', () => {
  const result = parseMemoryMapText(JSON.stringify({
    schemaVersion: 3,
    stars: [{
      id: 'future-bucket',
      title: '带情感戳的瞬间',
      domain: ['恋爱'],
      importance: 9,
      valence: .72,
      arousal: .84,
      drive_snapshot: { possess: .8 },
      drive_affinity: { possess: .9 },
      created_at: '2026-08-09T10:00:00.000Z',
    }],
    edges: [],
  }));

  assert.equal(result.available, true);
  assert.equal(result.stars[0].historical, false);
  assert.deepEqual(result.stars[0].driveSnapshot, { possess: .8 });
  assert.deepEqual(result.stars[0].driveAffinity, { possess: .9 });
  assert.equal(result.capabilities.driveSnapshots, true);
  assert.equal(result.capabilities.driveAffinity, true);
  assert.equal(result.capabilities.timestamps, true);
});

test('bucket preview preserves original lines but never returns more than seven', () => {
  const source = Array.from({ length: 10 }, (_, index) => `原文第 ${index + 1} 行`).join('\n');
  const result = parseMemoryPreviewText(JSON.stringify({ ok: true, id: 'bucket-1', preview: source, truncated: true }), 'bucket-1');
  assert.equal(result.available, true);
  assert.equal(result.lineCount, 7);
  assert.equal(result.preview.split('\n').at(-1), '原文第 7 行');
  assert.equal(result.truncated, true);
});

test('bucket preview refuses a mismatched bucket id', () => {
  const result = parseMemoryPreviewText(JSON.stringify({ ok: true, id: 'other', preview: '不该返回' }), 'wanted');
  assert.equal(result.available, false);
  assert.equal(result.reason, 'id_mismatch');
  assert.equal(result.preview, '');
});

test('client accepts stateless Ombre MCP initialization', async (t) => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    methods.push(payload.method);
    const body = payload.method === 'tools/list'
      ? JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [] } })
      : '';
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => body,
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new OmbreClient({ url: 'http://ombre.test/mcp' });
  assert.deepEqual(await client.listTools(), []);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('write adapters send only the Ombre v3.6.3 arguments', async () => {
  const client = new OmbreClient({ writeEnabled: true });
  const calls = [];
  client.call = async (name, args) => {
    calls.push([name, args]);
    if (name === 'grow') {
      return { result: { content: [{ type: 'text', text: '已整理 → growbucket123' }] } };
    }
    if (name === 'hold') {
      return { result: { content: [{ type: 'text', text: '已沉淀 abcdef123456' }] } };
    }
    return { result: { content: [{ type: 'text', text: 'ok' }] } };
  };

  assert.equal(await client.storeHeldOutput({ content: '一段待留下的整理内容' }), 'growbucket123');
  assert.equal(await client.storeDream({ dream: '梦', residue: '余韵', awareness: '醒后' }), 'abcdef123456');
  assert.deepEqual(calls[0], ['grow', { content: '一段待留下的整理内容' }]);
  assert.deepEqual(calls[1][0], 'hold');
  assert.deepEqual(calls[1][1], {
    content: '梦境：梦\n梦境余韵：余韵\n醒后意识：醒后\n说明：这是睡眠结算产生的梦境，不是现实事件；调用外部记忆服务不等于醒来。',
    tags: 'dream',
    importance: 7,
  });
  assert.deepEqual(calls[2], ['trace', { bucket_id: 'abcdef123456', dont_surface: 1 }]);
});

test('background hold adapter returns the bucket id from the Ombre acknowledgement', async () => {
  const client = new OmbreClient({ writeEnabled: true, holdTimeoutMs: 120000 });
  const calls = [];
  client.call = async (name, args, timeoutMs) => {
    calls.push([name, args, timeoutMs]);
    return { result: { content: [{ type: 'text', text: '新建→holdbucket123 恋爱' }] } };
  };

  assert.deepEqual(await client.hold({ content: '后台保存' }), {
    ombreBucketId: 'holdbucket123',
    responseText: '新建→holdbucket123 恋爱',
  });
  assert.deepEqual(calls, [['hold', { content: '后台保存' }, 120000]]);
});
