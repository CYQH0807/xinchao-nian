import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpMessage, OB_PROXY_TOOLS } from '../src/mcp-protocol.js';
import { SYSTEM_VERSION } from '../src/version.js';

const request = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

test('MCP handshake reports the shared runtime version', async () => {
  const result = await handleMcpMessage(request('initialize', {
    protocolVersion: '2025-06-18',
  }), {});
  assert.equal(result.status, 200);
  assert.equal(result.body.result.serverInfo.version, SYSTEM_VERSION);
});

test('tools/list keeps Xinchao, board and curated OB tools together', async () => {
  const liveObTools = OB_PROXY_TOOLS
    .filter((name) => name !== 'You' && name !== 'Them')
    .map((name) => ({
      name,
      description: `live schema for ${name}`,
      inputSchema: { type: 'object', properties: { live: { type: 'boolean' } } },
    }));
  const result = await handleMcpMessage(request('tools/list'), {
    boardEnabled: true,
    listObTools: async () => [
      ...liveObTools,
      { name: 'purge', description: 'must stay hidden', inputSchema: { type: 'object' } },
    ],
  });
  const names = result.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('xinchao_context'));
  assert.ok(names.includes('xinchao_pending_create'));
  assert.ok(names.includes('xinchao_pending_consumed'));
  assert.ok(names.includes('xinchao_hold_status'));
  assert.ok(names.includes('xinchao_hold_retry'));
  assert.ok(names.includes('xinchao_personality_reflect'));
  assert.equal(names.includes('xinchao_pending_hold'), false);
  assert.equal(names.includes('xinchao_pending_drop'), false);
  assert.ok(names.includes('board_post'));
  assert.ok(names.includes('board_read'));
  assert.ok(names.includes('breath'));
  for (const name of liveObTools.map((tool) => tool.name)) {
    assert.ok(names.includes(name), `missing OB tool ${name}`);
  }
  const breathSearch = result.body.result.tools.find((tool) => tool.name === 'breath_search');
  assert.equal(breathSearch.description, 'live schema for breath_search');
  assert.equal(breathSearch.title, '检索记忆');
  const trace = result.body.result.tools.find((tool) => tool.name === 'trace');
  assert.equal(trace.annotations.destructiveHint, true);
  assert.equal(names.includes('purge'), false);
});

test('hold returns an accepted job and status tools expose the durable result', async () => {
  const calls = [];
  const handlers = {
    defaultSessionId: 'mcp-test-session',
    callOb: async (name, args, context) => {
      calls.push({ name, args, context });
      return { accepted: true, job_id: 'hold_job_1', status: 'queued', duplicate: false };
    },
    holdJobStatus: async ({ jobId }) => ({
      id: jobId,
      status: 'succeeded',
      attempts: 1,
      manualRetries: 0,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
      startedAt: '2026-08-27T00:00:01.000Z',
      finishedAt: '2026-08-27T00:01:00.000Z',
      nextAttemptAt: null,
      lastError: null,
      result: { ombreBucketId: 'bucket-1', responseText: '新建→bucket-1' },
    }),
    holdJobRetry: async ({ jobId }) => ({ id: jobId, status: 'queued', attempts: 1 }),
  };

  const accepted = await handleMcpMessage(request('tools/call', {
    name: 'hold', arguments: { content: '异步落盘的内容' },
  }), handlers);
  assert.equal(accepted.body.result.isError, false);
  assert.equal(accepted.body.result.structuredContent.job_id, 'hold_job_1');
  assert.equal(calls[0].context.requestId, 1);
  assert.equal(calls[0].context.sessionId, 'mcp-test-session');

  const status = await handleMcpMessage(request('tools/call', {
    name: 'xinchao_hold_status', arguments: { job_id: 'hold_job_1' },
  }), handlers);
  assert.equal(status.body.result.structuredContent.result.ombreBucketId, 'bucket-1');
  assert.match(status.body.result.content[0].text, /status=succeeded/);

  const retry = await handleMcpMessage(request('tools/call', {
    name: 'xinchao_hold_retry', arguments: { job_id: 'hold_job_1' },
  }), handlers);
  assert.equal(retry.body.result.structuredContent.status, 'queued');
});

test('AI can submit one complete monthly personality reflection through MCP', async () => {
  let received;
  const dimensions = [
    'joy', 'sorrow', 'anger', 'fear', 'disgust', 'surprise', 'love',
    'shame', 'trust', 'desire', 'calm', 'cognition', 'conflict', 'expression',
  ].map((key) => ({ key, score: 70, reason: `AI 回顾 ${key}` }));
  const result = await handleMcpMessage(request('tools/call', {
    name: 'xinchao_personality_reflect',
    arguments: { month: '2026-08', dimensions },
  }), {
    personalityReflect: async (input) => {
      received = input;
      return { month: input.month, duplicate: false };
    },
  });
  assert.equal(result.body.result.isError, false);
  assert.equal(received.month, '2026-08');
  assert.equal(received.dimensions.length, 14);
});

test('AI may create and acknowledge pending output but cannot choose user disposition', async () => {
  let created;
  let consumed;
  const handlers = {
    pendingCreate: async (input) => {
      created = input;
      return { item: { id: 'pending_1', ...input }, duplicate: false, revision: 2 };
    },
    pendingConsumed: async (input) => {
      consumed = input;
      return { consumed: input.ids, revision: 3 };
    },
  };
  const createResult = await handleMcpMessage(request('tools/call', {
    name: 'xinchao_pending_create',
    arguments: { kind: 'share', content: '下午翻到一件想等她回来说的事。', source_ombre_bucket_ids: ['bucket_a'] },
  }), handlers);
  assert.equal(createResult.body.result.isError, false);
  assert.deepEqual(created.sourceOmbreBucketIds, ['bucket_a']);

  const consumedResult = await handleMcpMessage(request('tools/call', {
    name: 'xinchao_pending_consumed', arguments: { ids: ['pending_1'] },
  }), handlers);
  assert.equal(consumedResult.body.result.isError, false);
  assert.deepEqual(consumed.ids, ['pending_1']);
});

test('OB failure does not remove Xinchao or board tools', async () => {
  const result = await handleMcpMessage(request('tools/list'), {
    boardEnabled: true,
    listObTools: async () => { throw new Error('offline'); },
  });
  const names = result.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('xinchao_event'));
  assert.ok(names.includes('board_post'));
  assert.ok(names.includes('board_read'));
});
