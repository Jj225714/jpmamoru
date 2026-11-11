import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskLimits, taskView } from './task-contract.mjs';
import { FalJobService, JsonJobStore } from './job-service.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
async function setup(provider, options = {}) {
  const path = join(await mkdtemp(join(tmpdir(), 'task-contract-')), 'jobs.json');
  return new FalJobService({ store: new JsonJobStore(path), provider, pollDelayMs: 1, ...options });
}
const input = (key = 'one') => ({ model: 'esrgan', idempotencyKey: key, credential: 'key', payload: {} });
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); }
  throw new Error('condition timeout');
}

test('limits default to 2, model cap is independent, invalid configuration fails', () => {
  const limits = new TaskLimits(2, { a: 1 }); limits.acquire('1', 'a');
  assert.throws(() => limits.acquire('2', 'a'), { status: 429 });
  limits.acquire('2', 'b'); assert.throws(() => limits.acquire('3', 'c'), { status: 429 });
  limits.release('1'); assert.equal(limits.acquire('3', 'a'), true);
  assert.throws(() => new TaskLimits(0)); assert.throws(() => new TaskLimits(2, { a: 3 }));
});
test('progress is honest and terminal elapsed time is frozen', () => {
  assert.equal(taskView({ status: 'running', createdAt: 10 }, 20).progress.percent, null);
  const result = taskView({ status: 'uncertain', createdAt: 10, finishedAt: 30 }, 999);
  assert.equal(result.elapsed_ms, 20); assert.equal(result.actions.retry.allowed, false);
  assert.equal(result.actions.cancel.allowed, false);
});
test('Fal cancellation before submit ID is disallowed; failure does not claim canceled', async () => {
  const submitted = deferred(), status = deferred();
  const service = await setup({ submit: () => submitted.promise, status: () => status.promise, cancel: async () => { throw new Error('network'); }, result: async () => ({ images: [] }) });
  const job = await service.create(input());
  await assert.rejects(service.cancel(job.job_id, 'key'), { status: 409 });
  submitted.resolve({ request_id: 'provider-id' });
  await until(() => !!service.store.jobs.get(job.job_id).providerJobId);
  await assert.rejects(service.cancel(job.job_id, 'other'), { status: 404 });
  const canceled = await service.cancel(job.job_id, 'key'); assert.notEqual(canceled.status, 'canceled');
  assert.equal(canceled.error.code, 'cancel_unconfirmed');
  status.resolve({ status: 'COMPLETED' }); await service.waitForIdle();
  assert.equal((await service.get(job.job_id, 'key')).status, 'succeeded');
});
test('Fal acknowledged cancel remains pending until provider confirms', async () => {
  const status = deferred();
  const service = await setup({ submit: async () => ({ request_id: 'provider-id' }), status: () => status.promise, cancel: async () => ({}) });
  const job = await service.create(input()); await until(() => !!service.store.jobs.get(job.job_id).providerJobId);
  const pending = await service.cancel(job.job_id, 'key'); assert.notEqual(pending.status, 'canceled');
  assert.equal(pending.progress.stage, 'cancel_requested');
  status.resolve({ status: 'CANCELLED' }); await service.waitForIdle();
  const done = await service.get(job.job_id, 'key'); assert.equal(done.status, 'canceled'); assert.ok(done.finished_at);
});
test('Fal completion recovery retries only reads and concurrent resume has one worker', async () => {
  let submits = 0, results = 0;
  const read = deferred();
  const service = await setup({ submit: async () => { submits++; return { request_id: 'provider-id' }; }, status: async () => ({ status: 'COMPLETED' }), result: async () => { if (++results === 1) throw Object.assign(new Error('temporary'), { status: 503 }); return read.promise; } });
  const job = await service.create(input()); await service.waitForIdle();
  const recoverable = await service.get(job.job_id, 'key', { resume: false });
  assert.equal(recoverable.status, 'recoverable'); assert.equal(recoverable.actions.retry.mode, 'resume_query');
  await assert.rejects(service.resume(job.job_id, 'other'), { status: 404 });
  const resumes = [service.resume(job.job_id, 'key'), service.resume(job.job_id, 'key')];
  await until(() => results === 2); read.resolve({ images: [] }); await Promise.all(resumes); await service.waitForIdle();
  assert.equal(submits, 1); assert.equal(results, 2);
  assert.equal((await service.get(job.job_id, 'key')).status, 'succeeded');
});
test('Fal admission rejects before submit and uncertain cannot retry', async () => {
  const submitted = deferred(); let calls = 0;
  const service = await setup({ submit: async () => { calls++; await submitted.promise; throw new Error('disconnect'); } }, { maxActive: 1 });
  const job = await service.create(input());
  await assert.rejects(service.create(input('two')), { status: 429 });
  submitted.resolve(); await service.waitForIdle();
  assert.equal(calls, 1); assert.equal((await service.get(job.job_id, 'key')).status, 'uncertain');
  await assert.rejects(service.resume(job.job_id, 'key'), { status: 409 });
  assert.equal((await service.create(input())).job_id, job.job_id); assert.equal(calls, 1);
});
