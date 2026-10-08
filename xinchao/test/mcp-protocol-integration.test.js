import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpMessage, OB_PROXY_TOOLS } from '../src/mcp-protocol.js';
import { gateMcpSelfReport } from '../src/interaction-policy.js';
import { SYSTEM_VERSION } from '../src/version.js';
import { computePersonalityStats, normalizePersonalityCore } from '../src/personality-store.js';

const request = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

test('personality MCP reports no assessment and still exposes independent anchors', async () => {
  const core = normalizePersonalityCore({ schemaVersion: 1, anchors: [{ key: 'boundary', label: '底线' }] });
  const result = await handleMcpMessage(request('tools/call', {
    name: 'xinchao_personality_stats', arguments: { include_reasons: false },
  }), { personalityStats: async () => ({ stats: computePersonalityStats(core), core }) });
  const payload = result.body.result;
  assert.equal(payload.isError, false);
  assert.match(payload.content[0].text, /尚无可用.*自评/u);
  assert.doesNotMatch(payload.content[0].text, /均值|schemaVersion70|anchors70/u);
  assert.equal(payload.structuredContent.available, false);
  assert.equal(payload.structuredContent.dimensionCount, 0);
  assert.deepEqual(payload.structuredContent.dimensions, []);
  assert.equal(payload.structuredContent.anchors[0].label, '底线');
});

test('MCP handshake reports the shared runtime version', async () => {
  const result = await handleMcpMessage(request('initialize', {
    protocolVersion: '2025-06-18',
  }), {});
  assert.equal(result.status, 200);
  assert.equal(result.body.result.serverInfo.version, SYSTEM_VERSION);
});

test('MCP self-report gate requires exchange evidence for relationship types', () => {
  const relational = { interactionType: 'affection' };
  assert.equal(gateMcpSelfReport(relational), 'affection');
  assert.equal(relational.interactionType, '');

  const selfAction = { interactionType: 'reflection' };
  assert.equal(gateMcpSelfReport(selfAction), null);
  assert.equal(selfAction.interactionType, 'reflection');

  const evidenced = { interactionType: 'affection', exchange: '对方：我抱了你。' };
  assert.equal(gateMcpSelfReport(evidenced), null);
  assert.equal(evidenced.interactionType, 'affection');

  const disabled = { interactionType: 'affection' };
  assert.equal(gateMcpSelfReport(disabled, false), null);
  assert.equal(disabled.interactionType, 'affection');
});

test('gated MCP event response explains the missing exchange evidence', async () => {
  const result = await handleMcpMessage(request('tools/call', {
    name: 'xinchao_event',
    arguments: { event_id: 'event-gate-0001', interaction_type: 'affection', session_id: 's1' },
  }), {
    event: async () => ({
      sessionId: 's1', revision: 2,
      interaction: { type: 'affection', applied: false, reasonCode: 'needs_her' },
    }),
    nowLine: async () => '',
  });
  assert.match(result.body.result.content[0].text, /exchange/);
  assert.equal(result.body.result.structuredContent.interaction.reasonCode, 'needs_her');
});

test('tools/list keeps Xinchao, board and curated OB tools together', async () => {
  const liveObTools = OB_PROXY_TOOLS
    .filter((name) => name !== 'You' && name !== 'Them')
    .map((name) => ({
      name,
      description: `live schema for ${name}`,
      inputSchema: { type: 'object', properties: { live: { type: 'boolean' } } },
      ...(name === 'trace' ? { annotations: { destructiveHint: true } } : {}),
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
  assert.ok(names.includes('xinchao_hold_status'));
  assert.ok(names.includes('xinchao_hold_retry'));
  assert.ok(names.includes('xinchao_box'));
  assert.equal(names.includes('xinchao_pending_create'), false);
  assert.equal(names.includes('xinchao_pending_consumed'), false);
  assert.ok(names.includes('xinchao_personality_reflect'));
  assert.equal(names.includes('xinchao_pending_hold'), false);
  assert.equal(names.includes('xinchao_pending_drop'), false);
  assert.ok(names.includes('board_post'));
  assert.ok(names.includes('board_read'));
  assert.ok(names.includes('breath'));
  for (const name of liveObTools.map((tool) => tool.name)) {
    assert.ok(names.includes(name), `missing OB tool ${name}`);
  }
  const breath = result.body.result.tools.find((tool) => tool.name === 'breath');
  assert.equal(breath.title, '浮现记忆');
  assert.match(breath.description, /长期记忆自然浮现/);
  assert.equal(breath.inputSchema.properties.live.type, 'boolean');
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

test('hidden tools disappear from tools/list', async () => {
  const result = await handleMcpMessage(request('tools/list'), { toolsHide: new Set(['xinchao_pending_create']) });
  const names = result.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('xinchao_box'));
  assert.ok(!names.includes('xinchao_pending_create'));
});

test('xinchao_* tool replies carry a trailing now-line; xinchao_context does not', async () => {
  const handlers = {
    nowLine: async () => '此刻：想他（涌）；情绪 安心',
    handoffNote: async () => ({ revision: 3, duplicate: false }),
    context: async () => ({ delivered: true, additionalContext: 'ctx', sections: [] }),
  };
  const note = await handleMcpMessage(request('tools/call', { name: 'xinchao_handoff_note', arguments: { event_id: 'evt-000001', note: 'x', session_id: 's' } }), handlers);
  assert.match(note.body.result.content[0].text, /此刻：想他（涌）/);
  const ctx = await handleMcpMessage(request('tools/call', { name: 'xinchao_context', arguments: { session_id: 's' } }), handlers);
  assert.doesNotMatch(ctx.body.result.content[0].text, /此刻：/);
});
