import { createHash, randomUUID } from 'node:crypto';
import { StateStore } from './state-store.js';

export const HOLD_JOB_STATUSES = Object.freeze(['queued', 'running', 'retry', 'succeeded', 'failed']);

const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);
const MAX_JOBS = 500;
const MAX_ATTEMPTS = 8;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WORKER_LEASE_MS = 10 * 60 * 1000;
const RETRY_BASE_MS = 2 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ERROR_LENGTH = 1000;
const MAX_RESPONSE_LENGTH = 2000;

/** 创建一个空的持久化 hold 任务队列。 */
export function newHoldJobQueue() {
  return { schemaVersion: 1, revision: 0, jobs: [] };
}

function iso(value = new Date()) {
  return new Date(value).toISOString();
}

function parseTime(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : null;
}

function timestamp(value, fallback = null) {
  const time = parseTime(value);
  return time == null ? fallback : new Date(time).toISOString();
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'hold_job_failed');
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH) || 'hold_job_failed';
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  return {
    ombreBucketId: String(result.ombreBucketId ?? '').trim() || null,
    responseText: String(result.responseText ?? '').trim().slice(0, MAX_RESPONSE_LENGTH) || null,
  };
}

function normalizeJob(input, now = new Date()) {
  const createdAt = timestamp(input?.createdAt, iso(now));
  const status = HOLD_JOB_STATUSES.includes(input?.status) ? input.status : 'queued';
  return {
    id: String(input?.id ?? `hold_${randomUUID()}`).trim() || `hold_${randomUUID()}`,
    requestKeyHash: String(input?.requestKeyHash ?? '').trim(),
    payloadDigest: String(input?.payloadDigest ?? '').trim(),
    payload: input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? clone(input.payload)
      : {},
    status,
    attempts: Math.max(0, Number(input?.attempts) || 0),
    manualRetries: Math.max(0, Number(input?.manualRetries) || 0),
    createdAt,
    updatedAt: timestamp(input?.updatedAt, createdAt),
    startedAt: timestamp(input?.startedAt),
    finishedAt: timestamp(input?.finishedAt),
    nextAttemptAt: timestamp(input?.nextAttemptAt),
    lastError: input?.lastError ? compactError(input.lastError) : null,
    result: normalizeResult(input?.result),
  };
}

function pruneQueue(queue, now = new Date()) {
  const cutoff = now.getTime() - JOB_RETENTION_MS;
  queue.jobs = queue.jobs.filter((job) => {
    if (!TERMINAL_STATUSES.has(job.status)) return true;
    const finishedAt = parseTime(job.finishedAt);
    return finishedAt == null || finishedAt >= cutoff;
  });
  if (queue.jobs.length <= MAX_JOBS) return;

  const removable = queue.jobs
    .filter((job) => TERMINAL_STATUSES.has(job.status))
    .sort((left, right) => (parseTime(left.finishedAt) ?? 0) - (parseTime(right.finishedAt) ?? 0));
  const remove = new Set(removable.slice(0, queue.jobs.length - MAX_JOBS).map((job) => job.id));
  queue.jobs = queue.jobs.filter((job) => !remove.has(job.id));
}

/** 校验并深拷贝 Ombre hold 参数，确保任务落盘后仍可原样重放。 */
export function normalizeHoldPayload(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('hold 参数必须是对象');
  }
  let payload;
  try {
    payload = structuredClone(input);
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error('hold_payload_too_large');
    }
  } catch (error) {
    if (error.message === 'hold_payload_too_large') throw error;
    throw new Error('hold 参数无法持久化');
  }
  payload.content = String(payload.content ?? '');
  if (!payload.content.trim()) throw new Error('content 是必填项');
  return payload;
}

/** 规范化队列文件并恢复已经失去 worker 租约的任务。 */
export function normalizeHoldJobQueue(input, now = new Date()) {
  const queue = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : newHoldJobQueue();
  queue.schemaVersion = Math.max(1, Number(queue.schemaVersion) || 0);
  queue.revision = Math.max(0, Number(queue.revision) || 0);
  const seenIds = new Set();
  queue.jobs = (Array.isArray(queue.jobs) ? queue.jobs : [])
    .map((job) => normalizeJob(job, now))
    .filter((job) => {
      if (seenIds.has(job.id)) return false;
      seenIds.add(job.id);
      return true;
    });

  const nowMs = now.getTime();
  for (const job of queue.jobs) {
    const startedAt = parseTime(job.startedAt);
    if (job.status === 'running' && startedAt != null && nowMs - startedAt > WORKER_LEASE_MS) {
      job.status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
      job.updatedAt = iso(now);
      job.finishedAt = job.status === 'failed' ? iso(now) : null;
      job.nextAttemptAt = job.status === 'retry' ? iso(now) : null;
      job.lastError = 'hold_worker_lease_expired';
    }
  }
  pruneQueue(queue, now);
  return queue;
}

/** 将新的 hold 任务写入队列，并用请求指纹实现安全去重。 */
export function enqueueHoldJob(queue, input, requestKey = '', now = new Date()) {
  normalizeHoldJobQueue(queue, now);
  const payload = normalizeHoldPayload(input);
  const payloadDigest = digest(JSON.stringify(payload));
  const requestKeyHash = requestKey ? digest(requestKey) : '';
  if (requestKeyHash) {
    const existing = queue.jobs.find((job) => job.requestKeyHash === requestKeyHash);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) throw new Error('hold 请求标识已被不同内容占用');
      return { job: clone(existing), duplicate: true };
    }
  }

  const createdAt = iso(now);
  const job = {
    id: `hold_${randomUUID()}`,
    requestKeyHash,
    payloadDigest,
    payload,
    status: 'queued',
    attempts: 0,
    manualRetries: 0,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: createdAt,
    lastError: null,
    result: null,
  };
  queue.jobs.unshift(job);
  queue.revision += 1;
  pruneQueue(queue, now);
  return { job: clone(job), duplicate: false };
}

/** 原子领取下一条到期任务，并增加一次执行尝试。 */
export function claimNextHoldJob(queue, now = new Date()) {
  normalizeHoldJobQueue(queue, now);
  const nowMs = now.getTime();
  const job = queue.jobs
    .filter((item) => (item.status === 'queued' || item.status === 'retry')
      && (parseTime(item.nextAttemptAt) ?? 0) <= nowMs
      && item.attempts < MAX_ATTEMPTS)
    .sort((left, right) => parseTime(left.createdAt) - parseTime(right.createdAt))[0];
  if (!job) return null;
  job.status = 'running';
  job.attempts += 1;
  job.startedAt = iso(now);
  job.updatedAt = iso(now);
  job.finishedAt = null;
  job.nextAttemptAt = null;
  queue.revision += 1;
  return clone(job);
}

/** 记录 Ombre 成功结果，并把任务转为可查询的完成态。 */
export function completeHoldJob(queue, id, result = {}, now = new Date()) {
  normalizeHoldJobQueue(queue, now);
  const job = queue.jobs.find((item) => item.id === id);
  if (!job) throw new Error('hold_job_not_found');
  job.status = 'succeeded';
  job.updatedAt = iso(now);
  job.finishedAt = iso(now);
  job.nextAttemptAt = null;
  job.lastError = null;
  job.result = normalizeResult(result);
  queue.revision += 1;
  pruneQueue(queue, now);
  return clone(job);
}

/** 记录一次失败并按指数退避安排重试，超过上限后进入失败终态。 */
export function failHoldJob(queue, id, error, now = new Date()) {
  normalizeHoldJobQueue(queue, now);
  const job = queue.jobs.find((item) => item.id === id);
  if (!job) throw new Error('hold_job_not_found');
  const message = compactError(error);
  const exhausted = job.attempts >= MAX_ATTEMPTS;
  job.status = exhausted ? 'failed' : 'retry';
  job.updatedAt = iso(now);
  job.finishedAt = exhausted ? iso(now) : null;
  job.nextAttemptAt = exhausted
    ? null
    : iso(new Date(now.getTime() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, job.attempts - 1)))));
  job.lastError = message;
  queue.revision += 1;
  pruneQueue(queue, now);
  return clone(job);
}

/** 手动把失败或重试中的任务重新排队，不重复已经成功的任务。 */
export function retryHoldJob(queue, id, now = new Date()) {
  normalizeHoldJobQueue(queue, now);
  const job = queue.jobs.find((item) => item.id === id);
  if (!job) throw new Error('hold_job_not_found');
  if (job.status === 'succeeded') throw new Error('hold_job_already_succeeded');
  if (job.status === 'running') throw new Error('hold_job_in_progress');
  job.status = 'queued';
  job.manualRetries += 1;
  job.updatedAt = iso(now);
  job.finishedAt = null;
  job.nextAttemptAt = iso(now);
  queue.revision += 1;
  return clone(job);
}

/** 返回不含原始正文的安全任务视图，供 MCP 状态工具使用。 */
export function holdJobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    manualRetries: job.manualRetries,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    nextAttemptAt: job.nextAttemptAt,
    lastError: job.lastError,
    result: normalizeResult(job.result),
  };
}

/** 对持久化队列提供原子入队、领取、完成、失败和查询操作。 */
export class HoldJobStore {
  constructor(path) {
    this.store = new StateStore(path, newHoldJobQueue);
  }

  /** 初始化队列文件并回收失去租约的任务。 */
  async init(now = new Date()) {
    await this.store.update((queue) => normalizeHoldJobQueue(queue, now));
  }

  /** 持久化一条 hold 任务，并返回脱敏后的任务视图。 */
  async enqueue(payload, requestKey = '', now = new Date()) {
    let output;
    await this.store.update((queue) => {
      output = enqueueHoldJob(queue, payload, requestKey, now);
      return queue;
    });
    return { job: holdJobView(output.job), duplicate: output.duplicate };
  }

  /** 原子领取一条到期任务，并保留完整 payload 供 worker 执行。 */
  async claimNext(now = new Date()) {
    let job;
    await this.store.update((queue) => {
      job = claimNextHoldJob(queue, now);
      return queue;
    });
    return job;
  }

  /** 持久化 Ombre 成功结果。 */
  async complete(id, result = {}, now = new Date()) {
    let job;
    await this.store.update((queue) => {
      job = completeHoldJob(queue, id, result, now);
      return queue;
    });
    return holdJobView(job);
  }

  /** 持久化失败并安排退避重试。 */
  async fail(id, error, now = new Date()) {
    let job;
    await this.store.update((queue) => {
      job = failHoldJob(queue, id, error, now);
      return queue;
    });
    return holdJobView(job);
  }

  /** 手动重新排队一条失败任务。 */
  async retry(id, now = new Date()) {
    let job;
    await this.store.update((queue) => {
      job = retryHoldJob(queue, id, now);
      return queue;
    });
    return holdJobView(job);
  }

  /** 查询一条不含原始正文的任务状态。 */
  async get(id) {
    const queue = normalizeHoldJobQueue(await this.store.read());
    return holdJobView(queue.jobs.find((job) => job.id === id));
  }
}
