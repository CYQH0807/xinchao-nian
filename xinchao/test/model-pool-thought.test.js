import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { ModelClient } from '../src/model-client.js';
import { applySurfacedThought, newState } from '../src/engine.js';
import { buildContextEnvelope } from '../src/context-envelope.js';
import { tickThoughtPool } from '../src/thought-pool.js';
import { detectSelfSignals } from '../src/self-signals.js';

const now = new Date('2026-10-08T12:00:00.000Z');
const input = { state: newState(now), topDrives: [{ key: 'monitor', label: '牵挂', value: .6 }],
  material: '[bucket_id:4f4a37e2fe6b] [domain:内心]\n窗边留着一杯温水。' };

async function fixture(t, { content = JSON.stringify({ message: '又想起窗边那杯温水。' }), status = 200 } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const client = new ModelClient({ enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'fixture-key', name: 'MiniMax-M3', timeoutMs: 1000, maxInputChars: 10000,
    maxOutputTokens: 650, agentName: '汐', notificationRecipient: '他' });
  return { client, requests };
}

test('pool thought uses the internal prompt and survives into context and the existing self-signal path', async (t) => {
  const { client, requests } = await fixture(t);
  const result = await client.generatePoolThought(input);
  assert.equal(result.source, 'model');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'MiniMax-M3');
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.match(requests[0].messages[0].content, /内部念头/u);
  assert.doesNotMatch(requests[0].messages[0].content, /适合手机通知/u);
  assert.match(requests[0].messages[1].content, /窗边留着一杯温水/u);
  const refs = { ombreBucketId: '4f4a37e2fe6b', sourceOmbreBucketIds: ['4f4a37e2fe6b'] };
  let state = applySurfacedThought(input.state, 'monitor', result.message, now, .45, refs).state;
  assert.equal(state.thoughtPool.flash[0].text, result.message);
  assert.deepEqual(state.thoughtPool.flash[0].sourceOmbreBucketIds, refs.sourceOmbreBucketIds);
  const dynamic = buildContextEnvelope({ state, now, mode: 'turn' }).sections.find(({ id }) => id === 'dynamic_state');
  assert.equal(dynamic.data.thoughts.flash[0].text, result.message);
  assert.ok(dynamic.content.includes(result.message));
  assert.match(dynamic.content, /非事实记录/u);
  state = applySurfacedThought(state, 'monitor', result.message, now, .45, refs).state;
  for (let i = 0; i < 3; i++) tickThoughtPool(state.thoughtPool);
  assert.equal(state.thoughtPool.obsessions[0].text, result.message);
  const signals = detectSelfSignals(state, now, { timeZone: 'UTC' }).signals;
  assert.ok(signals.some(({ kind, text }) => kind === 'obsession' && text.includes(result.message)));
});

test('disabled, unconfigured and empty pool generation retain the excerpt without a model request', async (t) => {
  const { client, requests } = await fixture(t);
  client.config.enabled = false;
  assert.deepEqual(await client.generatePoolThought(input), { message: '窗边留着一杯温水。', source: 'memory' });
  client.config.enabled = true;
  client.config.apiKey = '';
  assert.equal((await client.generatePoolThought(input)).source, 'memory');
  client.config.apiKey = 'fixture-key';
  assert.deepEqual(await client.generatePoolThought({ ...input, material: '' }), { message: '', source: 'memory' });
  assert.equal(requests.length, 0);
});

for (const options of [{ status: 503 }, { content: 'invalid JSON' }, { content: '{"message":""}' }]) {
  test(`failed or empty pool generation falls back to the real excerpt: ${JSON.stringify(options)}`, async (t) => {
    const { client } = await fixture(t, options);
    const result = await client.generatePoolThought(input);
    assert.equal(result.source, 'memory');
    assert.equal(result.message, '窗边留着一杯温水。');
    if (options.status || options.content === 'invalid JSON') assert.ok(result.error);
  });
}
