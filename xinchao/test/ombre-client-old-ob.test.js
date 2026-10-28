import assert from 'node:assert/strict';
import test from 'node:test';
import { OmbreClient, OmbreToolError } from '../src/ombre-client.js';

const rawMemory = [
  '[bucket_id:skip-one] [domain:生活] [tags:午后]',
  '这一条已经浮现过。',
  '---',
  '[bucket_id:keep-two] [domain:关系] [tags:窗边]',
  '窗边有一句值得记住的话。',
].join('\n');

function fakeOb({ advancedError, breathError, dreamError } = {}) {
  const calls = [];
  const client = new OmbreClient({ url: 'http://ob.test/mcp', breathMaxResults: 3 });
  client.stateless = true;
  client.post = async ({ params }) => {
    calls.push({ name: params.name, args: params.arguments });
    if (params.name === 'breath_advanced' && advancedError) return advancedError;
    if (params.name === 'breath' && breathError) return breathError;
    if (params.name === 'dream' && dreamError) return dreamError;
    return { result: { content: [{ type: 'text', text: rawMemory }] } };
  };
  return { client, calls };
}

const missingTool = { result: { isError: true, content: [{ type: 'text', text: 'Unknown tool: breath_advanced' }] } };

test('old OB falls back for daytime and thought materials without treating the error as a memory', async () => {
  const { client, calls } = fakeOb({ advancedError: missingTool });
  const daytime = await client.daytimeMaterialWithRefs([], { valence: 0.4, arousal: 0.6 }, new Date('2026-10-20T08:00:00Z'), ['skip-one']);
  assert.deepEqual(calls.map((call) => call.name), ['breath_advanced', 'breath']);
  assert.deepEqual(calls[1].args, { valence: 0.4, arousal: 0.6, max_results: 6, max_tokens: 20000 });
  assert.deepEqual(daytime.bucketIds, ['keep-two']);
  assert.deepEqual(daytime.domains, ['关系']);
  assert.doesNotMatch(daytime.text, /Unknown tool|已经浮现过/);

  calls.length = 0;
  const thought = await client.thoughtMaterialWithRefs([], null, new Date(), ['skip-one']);
  assert.deepEqual(calls.map((call) => call.name), ['breath']);
  assert.deepEqual(thought.bucketIds, ['keep-two']);
});

test('old OB cannot provide a dated far-memory and never substitutes a recent one', async () => {
  const { client, calls } = fakeOb({ advancedError: missingTool });
  const result = await client.farMaterial(new Date('2026-10-20T08:00:00Z'));
  assert.deepEqual(result, { text: '', bucketIds: [], domains: [] });
  assert.deepEqual(calls.map((call) => call.name), ['breath_advanced']);
  assert.equal(calls[0].args.date_to, '2026-09-20');
});

test('advanced OB retains date, emotion, bucket ID and exclusion behavior', async () => {
  const { client, calls } = fakeOb();
  const result = await client.daytimeMaterialWithRefs([], { valence: 0.4, arousal: 0.6 }, new Date('2026-10-20T08:00:00Z'), ['skip-one']);
  assert.deepEqual(calls.map((call) => call.name), ['breath_advanced']);
  assert.equal(calls[0].args.date_from, '2026-10-06');
  assert.equal(calls[0].args.valence, 0.4);
  assert.deepEqual(result.bucketIds, ['keep-two']);
  assert.deepEqual(result.domains, ['关系']);
});

test('tool and JSON-RPC errors in memory reads propagate instead of becoming material', async () => {
  for (const response of [
    { result: { isError: true, content: [{ type: 'text', text: 'database is locked' }] } },
    { isError: true, content: [{ type: 'text', text: 'database is locked' }] },
    { error: { code: -32603, message: 'database is locked' } },
  ]) {
    const { client, calls } = fakeOb({ advancedError: response, breathError: response, dreamError: response });
    for (const read of [
      () => client.recentMaterialWithRefs(),
      () => client.daytimeMaterialWithRefs(),
      () => client.thoughtMaterialWithRefs(),
      () => client.farMaterial(),
      () => client.recentContinuityMaterial(),
      () => client.digestMaterial(),
    ]) {
      await assert.rejects(read, (error) => error instanceof OmbreToolError && !error.unknownTool);
    }
    assert.equal(calls.filter(({ name }) => name === 'breath_advanced').length, 3);
  }
});

test('JSON-RPC unknown-tool response takes the same bounded legacy fallback', async () => {
  const { client, calls } = fakeOb({ advancedError: { error: { code: -32601, message: 'Unknown tool: breath_advanced' } } });
  const result = await client.thoughtMaterialWithRefs();
  assert.deepEqual(calls.map((call) => call.name), ['breath_advanced', 'breath']);
  assert.deepEqual(result.bucketIds, ['skip-one', 'keep-two']);
});

test('failed fallback is not returned as a memory', async () => {
  const { client } = fakeOb({ advancedError: missingTool, breathError: { result: { isError: true, content: [{ type: 'text', text: 'read failed' }] } } });
  await assert.rejects(() => client.daytimeMaterialWithRefs(), (error) => error instanceof OmbreToolError && error.tool === 'breath');
});

test('an unrelated unknown-tool failure does not disable the advanced tool', async () => {
  const { client, calls } = fakeOb({ advancedError: { result: { isError: true, content: [{ type: 'text', text: 'Unknown tool: internal_index' }] } } });
  await assert.rejects(() => client.daytimeMaterialWithRefs(), (error) => error instanceof OmbreToolError && !error.unknownTool);
  assert.deepEqual(calls.map(({ name }) => name), ['breath_advanced']);
  assert.notEqual(client.noAdvanced, true);
});
