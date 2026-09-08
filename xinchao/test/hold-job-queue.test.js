import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimNextHoldJob,
  completeHoldJob,
  enqueueHoldJob,
  failHoldJob,
  holdJobView,
  newHoldJobQueue,
  normalizeHoldJobQueue,
  retryHoldJob,
} from '../src/hold-job-queue.js';

const at = (minutes) => new Date(Date.parse('2026-08-27T00:00:00.000Z') + minutes * 60_000);

test('hold jobs are durably queued, idempotent, and hide the original payload in status views', () => {
  const queue = newHoldJobQueue();
  const input = {
    content: '要逐字保留的内容',
    title: '一个标题',
    quotes: [{ text: '不要丢掉这句', speaker: '他' }],
    future_field: { enabled: true },
  };

  const first = enqueueHoldJob(queue, input, 'mcp:session:1', at(0));
  const duplicate = enqueueHoldJob(queue, input, 'mcp:session:1', at(1));
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.id, first.job.id);

  const view = holdJobView(first.job);
  assert.equal(view.status, 'queued');
  assert.equal('payload' in view, false);
  assert.equal(queue.jobs[0].payload.future_field.enabled, true);

  const claimed = claimNextHoldJob(queue, at(1));
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.payload.content, input.content);

  const completed = completeHoldJob(queue, claimed.id, {
    ombreBucketId: 'bucket-123',
    responseText: '新建→bucket-123 恋爱',
  }, at(2));
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.ombreBucketId, 'bucket-123');
  assert.equal(holdJobView(completed).result.responseText, '新建→bucket-123 恋爱');
  assert.equal('payload' in holdJobView(completed), false);
});

test('failed jobs back off, manual retry is explicit, and stale workers are recovered', () => {
  const queue = newHoldJobQueue();
  enqueueHoldJob(queue, { content: '需要重试的内容' }, 'retry-key', at(0));
  const claimed = claimNextHoldJob(queue, at(0));
  const failed = failHoldJob(queue, claimed.id, new Error('OB 暂时不可用'), at(0));
  assert.equal(failed.status, 'retry');
  assert.equal(failed.lastError, 'OB 暂时不可用');
  assert.equal(claimNextHoldJob(queue, at(0)), null);

  const queued = retryHoldJob(queue, claimed.id, at(1));
  assert.equal(queued.status, 'queued');
  assert.equal(queued.manualRetries, 1);
  assert.equal(claimNextHoldJob(queue, at(1)).status, 'running');

  const staleQueue = newHoldJobQueue();
  enqueueHoldJob(staleQueue, { content: '进程中断的内容' }, 'stale-key', at(0));
  const staleClaim = claimNextHoldJob(staleQueue, at(0));
  staleClaim.startedAt = at(0).toISOString();
  staleQueue.jobs[0].status = 'running';
  staleQueue.jobs[0].startedAt = at(0).toISOString();
  normalizeHoldJobQueue(staleQueue, at(11));
  assert.equal(staleQueue.jobs[0].status, 'retry');
  assert.equal(staleQueue.jobs[0].lastError, 'hold_worker_lease_expired');
});
