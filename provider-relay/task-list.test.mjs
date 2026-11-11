import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonJobStore, FalJobService, createFalJobHandler } from './job-service.mjs';
import { GptJobs, createGptJobHandler } from './gpt-jobs.mjs';
import { createProviderHandler } from './server.mjs';

const hash = key => createHash('sha256').update(key).digest('hex');
const path = async () => join(await mkdtemp(join(tmpdir(), 'task-list-')), 'state.json');

for (const kind of ['GPT', 'Fal']) test(`${kind} actual HTTP list isolates owners, paginates without results and survives restart`, async t => {
  const file = await path();
  const service = kind === 'GPT' ? new GptJobs({ path: file }) : new FalJobService({ store: new JsonJobStore(file), provider: {} });
  await service.store.load();
  const stamp = Date.now();
  for (let i = 0; i < 5; i++) service.store.jobs.set(String(i), { id: String(i), owner: hash(i === 4 ? 'other' : 'member'), model: 'esrgan', status: 'succeeded', createdAt: stamp, finishedAt: stamp, result: { private_image: 'DO_NOT_LEAK' }, error: { code: 'test_error', message: 'SECRET_UPSTREAM_BODY' } });
  await service.store.flush();
  let handler;
  const server = http.createServer((req, res) => handler(req, res, () => res.writeHead(404).end()));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createProviderHandler({ origin, ...(kind === 'GPT' ? { gptJobHandler: createGptJobHandler({ allowLegacyBearer: true, service, origin }) } : { jobHandler: createFalJobHandler({ allowLegacyBearer: true, service, origin }) }) });
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const endpoint = kind === 'GPT' ? '/api/providers/gpt/jobs' : '/api/providers/fal/jobs/esrgan';
  const get = async (query = '', key = 'member') => fetch(origin + endpoint + query, { headers: { Origin: origin, ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
  assert.equal((await get('', '')).status, 401);
  const page1 = await (await get('?limit=2')).json();
  assert.deepEqual(page1.items.map(j => j.job_id), ['3', '2']);
  assert.equal(page1.items[0].result_job_id, '3'); assert.ok(page1.items[0].expires_at);
  assert.ok(!JSON.stringify(page1).includes('DO_NOT_LEAK')); assert.ok(!JSON.stringify(page1).includes('SECRET_UPSTREAM_BODY'));
  assert.equal('result' in page1.items[0], false); assert.equal('owner' in page1.items[0], false);
  // Delete the cursor anchor and insert a newer record: keyset paging still proceeds.
  service.store.jobs.delete('2'); service.store.jobs.set('new', { id: 'new', createdAt: stamp + 1, owner: hash('member'), status: 'queued', model: 'esrgan' });
  const page2 = await (await get('?limit=2&cursor=' + page1.next_cursor)).json();
  assert.deepEqual(page2.items.map(j => j.job_id), ['1', '0']); assert.equal(page2.next_cursor, null);
  assert.deepEqual((await (await get('', 'other')).json()).items.map(j => j.job_id), ['4']);
  assert.equal((await get('?cursor=bad')).status, 400); assert.equal((await get('?limit=51')).status, 400);
  assert.equal((await get('?limit=1&limit=2')).status, 400); assert.equal((await get('?owner=other')).status, 400);
  await service.store.flush();
  const restored = kind === 'GPT' ? new GptJobs({ path: file }) : new FalJobService({ store: new JsonJobStore(file), provider: {} });
  const listed = await restored.list('member', '', kind === 'Fal' ? 'esrgan' : undefined);
  assert.equal(listed.items.find(j => j.job_id === 'new').status, 'uncertain');
  assert.ok(!listed.items.some(j => j.job_id === '4'));
});

test('expired confirmed terminal jobs reclaim 1000 slots; active/uncertain/recoverable never expire', async () => {
  let now = 100;
  const store = new JsonJobStore(await path(), { now: () => now, retentionMs: 50 }); await store.load();
  for (let i = 0; i < 1000; i++) store.jobs.set(String(i), { id: String(i), status: ['succeeded', 'failed', 'canceled'][i % 3], finishedAt: 100 });
  for (const status of ['queued', 'running', 'uncertain', 'recoverable']) store.jobs.set(status, { id: status, status, finishedAt: 0 });
  await store.flush(); now = 149; assert.equal(await store.cleanup(), 0);
  now = 150; await Promise.all([store.cleanup(), store.cleanup()]);
  assert.deepEqual([...store.jobs.keys()], ['queued', 'running', 'uncertain', 'recoverable']);
  assert.equal(JSON.parse(await readFile(store.path)).length, 4);
});

test('retention preserves idempotency and conflict; expiry removes result and dedup together', async () => {
  let now = 100, submits = 0;
  const store = new JsonJobStore(await path(), { now: () => now, retentionMs: 50 });
  const service = new FalJobService({ store, now: () => now, provider: { submit: async () => { submits++; return { request_id: 'upstream' }; }, status: async () => ({ status: 'COMPLETED' }), result: async () => ({ images: [] }) } });
  const request = { model: 'esrgan', credential: 'member', idempotencyKey: 'one', payload: {} };
  const first = await service.create(request); await service.waitForIdle();
  now = 149; assert.equal((await service.create(request)).job_id, first.job_id);
  await assert.rejects(service.create({ ...request, payload: { changed: true } }), { status: 409 }); assert.equal(submits, 1);
  now = 150; await assert.rejects(service.get(first.job_id, 'member'), { status: 404 });
  const second = await service.create(request); await service.waitForIdle();
  assert.notEqual(second.job_id, first.job_id); assert.equal(submits, 2);
  const restarted = new FalJobService({ store: new JsonJobStore(store.path, { now: () => now, retentionMs: 50 }), provider: {} });
  assert.equal((await restarted.create(request)).job_id, second.job_id);
});

test('cleanup failure restores records and fails closed', async () => {
  const store = new JsonJobStore(await path(), { now: () => 100, retentionMs: 50 }); await store.load();
  store.jobs.set('old', { id: 'old', status: 'succeeded', finishedAt: 1 });
  store.flush = async () => { throw new Error('disk full'); };
  await assert.rejects(store.cleanup(), /disk full/); assert.ok(store.jobs.has('old'));
});
