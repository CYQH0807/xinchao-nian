import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HoldMediaStore, stageHoldMediaArgs } from '../src/hold-media-store.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** Create an isolated hold-media store for one test case. */
async function createStore(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'xinchao-hold-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new HoldMediaStore(join(directory, 'hold-media'), options);
  await store.init();
  return store;
}

test('stages image bytes outside the JSON queue and materializes them for Ombre', async (t) => {
  const store = await createStore(t);
  const staged = await store.stage(PNG, { filename: '猫.png', mediaType: 'image/png' });

  assert.match(staged.media_ref, /^hold-media:[0-9a-f]{32}$/u);
  assert.equal(staged.filename, '猫.png');
  assert.equal(staged.type, 'image/png');
  assert.equal(staged.size, PNG.length);
  assert.deepEqual(await readFile(store.pathFor(staged.media_ref)), PNG);

  const materialized = await store.materialize({ content: '带图的记忆', media: [staged] });
  assert.equal(materialized.media[0].media_ref, undefined);
  assert.equal(materialized.media[0].data_base64, PNG.toString('base64'));

  await store.release([staged]);
  await assert.rejects(store.assertAvailable(staged), /hold_media_reference_missing/);
});

test('converts inline Base64 compatibility input to a short staging reference', async (t) => {
  const store = await createStore(t);
  const prepared = await stageHoldMediaArgs(store, {
    content: '兼容直传',
    media: [{
      data_base64: PNG.toString('base64'),
      filename: 'inline.png',
      type: 'image/png',
      note: '保留说明',
    }],
  });

  assert.equal(prepared.stagedRefs.length, 1);
  assert.match(prepared.payload.media[0].media_ref, /^hold-media:/u);
  assert.equal('data_base64' in prepared.payload.media[0], false);
  assert.equal(
    (await store.materialize(prepared.payload)).media[0].data_base64,
    PNG.toString('base64'),
  );
  await store.release(prepared.payload.media);
});

test('rejects unsupported, oversized, malformed, and path-based media', async (t) => {
  const store = await createStore(t);
  const limited = await createStore(t, { maxBytes: PNG.length - 1 });

  await assert.rejects(
    limited.stage(PNG, { mediaType: 'image/png' }),
    /hold_media_too_large/,
  );
  await assert.rejects(
    store.stage(Buffer.from('not an image'), { mediaType: 'image/png' }),
    /hold_media_invalid_image/,
  );
  await assert.rejects(
    store.stage(PNG, { mediaType: 'image/svg+xml' }),
    /hold_media_type_unsupported/,
  );
  await assert.rejects(
    stageHoldMediaArgs(store, { media: [{ path: '/tmp/local-only.png' }] }),
    /hold_media_path_unsupported/,
  );
});
