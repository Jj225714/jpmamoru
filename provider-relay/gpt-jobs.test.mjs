import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createProviderHandler } from './server.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GptJobs, createGptJobHandler, validateGptInput } from './gpt-jobs.mjs';

const storePath = async () => join(await mkdtemp(join(tmpdir(), 'gpt-jobs-')), 'jobs.json');
const valid = { operation: 'generations', body: { model: 'gpt-image-2', prompt: 'test', n: 1 } };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=';
const success = res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png }] })); };
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function harness(t, upstream, options = {}) {
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    upstream(req, res, seen.length);
  });
  const baseUrl = await listen(mock);
  const path = await storePath();
  const service = new GptJobs({ path, baseUrl: baseUrl + '/v1', retryDelayMs: 5, ...options });
  let handler;
  const relay = http.createServer((req, res) => handler(req, res, () => res.writeHead(404).end()));
  const relayUrl = await listen(relay);
  handler = createProviderHandler({ origin: relayUrl, gptJobHandler: createGptJobHandler({ allowLegacyBearer: true, service, origin: relayUrl }) });
  t.after(async () => {
    await Promise.all([...service.workers]);
    await Promise.all([mock, relay].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  });
  const request = async (method, suffix = '', body, credential = 'test-key', extra = {}) => {
    const response = await fetch(relayUrl + '/api/providers/gpt/jobs' + suffix, {
      method, headers: { Origin: relayUrl, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'stable', ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const submit = async (input = valid) => {
    const result = await request('POST', '', input); assert.equal(result.status, 202);
    await Promise.all([...service.workers]);
    return (await request('GET', '/' + result.body.job_id)).body;
  };
  return { service, seen, path, request, submit };
}

test('production constructor permits only loopback HTTP upstreams', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.doesNotThrow(() => new GptJobs({ path: 'unused', baseUrl: `http://${host}:8080/v1` }));
  for (const baseUrl of ['http://example.com/v1', 'http://10.0.0.1/v1', 'http://localhost.evil.test/v1', 'http://user@127.0.0.1/v1', 'http://127.0.0.1/v1?target=x']) assert.throws(() => new GptJobs({ path: 'unused', baseUrl }), /Invalid GPT upstream/);
});

test('real HTTP 429 rejection retries then succeeds and persists result', async t => {
  const h = await harness(t, (_req, res, n) => n === 1 ? res.writeHead(429, { 'Retry-After': '0' }).end() : success(res));
  const states = []; const change = h.service.change.bind(h.service);
  h.service.change = (...args) => { states.push(args[1]); return change(...args); };
  const done = await h.submit();
  assert.equal(done.status, 'succeeded'); assert.equal(h.seen.length, 2);
  assert.deepEqual(states, ['running', 'retrying', 'running', 'succeeded']);
  const saved = JSON.parse(await readFile(h.path, 'utf8'));
  assert.equal(saved[0].result.data[0].b64_json, png);
  assert.ok(!(await readFile(h.path, 'utf8')).includes('test-key'));
});

test('persistent 429 stops after three attempts', async t => {
  const h = await harness(t, (_req, res) => res.writeHead(429).end());
  assert.equal((await h.submit()).status, 'failed'); assert.equal(h.seen.length, 3);
});

for (const status of [400, 401, 403, 502, 504]) test(`HTTP ${status} never resubmits a paid request`, async t => {
  const h = await harness(t, (_req, res) => res.writeHead(status).end('private-provider-detail'));
  const done = await h.submit();
  assert.equal(done.status, status < 500 ? 'failed' : 'uncertain'); assert.equal(h.seen.length, 1);
  assert.equal(done.error.code, `upstream_${status}`);
  assert.equal((await h.request('POST', '', valid)).body.job_id, done.job_id);
  assert.equal(h.seen.length, 1);
});

test('upstream disconnect is uncertain with one submission', async t => {
  const h = await harness(t, req => req.socket.destroy());
  const done = await h.submit(); assert.equal(done.status, 'uncertain'); assert.equal(h.seen.length, 1);
  assert.equal(done.error.code, 'upstream_transport_uncertain');
});

test('upstream timeout is uncertain with one submission', async t => {
  const h = await harness(t, () => {}, { timeoutMs: 100 });
  assert.equal((await h.submit()).status, 'uncertain'); assert.equal(h.seen.length, 1);
});

test('edits reach real HTTP upstream as multipart images and mask', async t => {
  const h = await harness(t, (_req, res) => success(res));
  const dataURL = 'data:image/png;base64,' + png;
  const done = await h.submit({ operation: 'edits', body: { ...valid.body, images: [dataURL, dataURL], mask: dataURL } });
  assert.equal(done.status, 'succeeded');
  const sent = h.seen[0]; assert.equal(sent.url, '/v1/images/edits');
  assert.match(sent.headers['content-type'], /^multipart\/form-data; boundary=/);
  const form = await new Response(sent.body, { headers: { 'Content-Type': sent.headers['content-type'] } }).formData();
  assert.equal(form.get('model'), 'gpt-image-2'); assert.equal(form.getAll('image[]').length, 2);
  assert.deepEqual(Buffer.from(await form.getAll('image[]')[0].arrayBuffer()), Buffer.from(png, 'base64'));
  assert.equal(form.get('mask').type, 'image/png'); assert.equal(form.has('images'), false);
});

test('real HTTP owner isolation, same-origin and idempotency conflict', async t => {
  const h = await harness(t, (_req, res) => success(res)); const done = await h.submit();
  assert.equal((await h.request('GET', '/' + done.job_id, undefined, 'other-key')).status, 404);
  assert.equal((await h.request('POST', '', { ...valid, body: { ...valid.body, prompt: 'changed' } })).status, 409);
  assert.equal((await h.request('POST', '', valid, 'test-key', { Origin: 'https://foreign.test' })).status, 403);
  assert.equal(h.seen.length, 1);
});

test('GPT completed task exposes frozen progress and rejects cancel/retry without resubmit', async t => {
  const h = await harness(t, (_req, res) => success(res)); const done = await h.submit();
  assert.equal(done.progress.percent, 100);
  assert.equal(done.actions.cancel.allowed, false); assert.equal(done.actions.retry.allowed, false);
  assert.ok(done.started_at >= done.created_at); assert.ok(done.finished_at >= done.started_at);
  assert.equal(done.elapsed_ms, done.finished_at - done.created_at);
  for (const action of ['cancel', 'retry']) {
    const result = await h.request('POST', '/' + done.job_id, undefined, 'test-key', { 'X-Job-Action': action });
    assert.equal(result.status, 409);
    assert.equal((await h.request('POST', '/' + done.job_id, undefined, 'foreign', { 'X-Job-Action': action })).status, 404);
  }
  assert.equal(h.seen.length, 1);
  const restored = new GptJobs({ path: h.path });
  assert.equal((await restored.get(done.job_id, 'test-key')).elapsed_ms, done.elapsed_ms);
});

test('same owner may run a batch up to capacity; rejected key is safe to retry', async t => {
  const pending = [];
  const h = await harness(t, (_req, res) => pending.push(res), { maxActive: 2 });
  const first = await h.request('POST', '', valid, 'test-key', { 'Idempotency-Key': 'batch-1' });
  const second = await h.request('POST', '', valid, 'test-key', { 'Idempotency-Key': 'batch-2' });
  const rejected = await h.request('POST', '', valid, 'test-key', { 'Idempotency-Key': 'batch-3' });
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  assert.equal(rejected.status, 429); assert.equal(rejected.body.error.code, 'job_capacity');
  assert.equal(h.service.store.jobs.size, 2);
  const deadline = Date.now() + 5000;
  while (pending.length < 2) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 5)); }
  pending.splice(0).forEach(success); await Promise.all([...h.service.workers]);
  const retried = await h.request('POST', '', valid, 'test-key', { 'Idempotency-Key': 'batch-3' });
  assert.equal(retried.status, 202);
  while (!pending.length) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 5)); }
  pending.splice(0).forEach(success); await Promise.all([...h.service.workers]);
  assert.equal(h.seen.length, 3);
});

test('restart recovers active jobs as uncertain without any upstream resubmission', async t => {
  const h = await harness(t, (_req, res) => success(res));
  const owner = createHash('sha256').update('test-key').digest('hex');
  const statuses = ['queued', 'running', 'retrying', 'succeeded', 'failed', 'uncertain'];
  await writeFile(h.path, JSON.stringify(statuses.map((status, i) => ({ id: String(i), owner, status, result: status === 'succeeded' ? { data: [{ b64_json: png }] } : null }))));
  const restored = new GptJobs({ path: h.path });
  const results = await Promise.all(statuses.map((_, i) => restored.get(String(i), 'test-key')));
  assert.deepEqual(results.map(j => j.status), ['uncertain', 'uncertain', 'uncertain', 'succeeded', 'failed', 'uncertain']);
  assert.equal(results[3].result.data[0].b64_json, png);
  assert.equal(restored.workers.size, 0); assert.equal(h.seen.length, 0);
  assert.deepEqual(JSON.parse(await readFile(h.path, 'utf8')).map(j => j.status), results.map(j => j.status));
});

test('validates fixed GPT image models and operation bodies', () => {
  assert.doesNotThrow(() => validateGptInput(valid));
  assert.throws(() => validateGptInput({ ...valid, body: { ...valid.body, model: 'gpt-5.5' } }), { code: 'invalid_parameters' });
  assert.throws(() => validateGptInput({ operation: 'edits', body: { ...valid.body, images: [] } }), { code: 'invalid_images' });
});

test('runs GPT generation asynchronously and preserves idempotency', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const service = new GptJobs({ path: await storePath(), baseUrl: 'https://127.0.0.1/v1', allowLocalTest: true, maxActive: 2 });
    const first = await service.create(valid, 'caller-key', 'same-key');
    const second = await service.create(valid, 'caller-key', 'same-key');
    assert.equal(first.job_id, second.job_id);
    for (let i = 0; i < 20 && (await service.get(first.job_id, 'caller-key')).status !== 'succeeded'; i++) await new Promise(r => setTimeout(r, 5));
    const done = await service.get(first.job_id, 'caller-key');
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result.data[0].b64_json, 'aGVsbG8=');
    assert.equal(done.result.data[0].mime_type, 'image/png');
    assert.equal(done.result.output_format, 'png');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('HTTP adapter maps submit and query routes', async () => {
  const service = { async create() { return { job_id: '11111111-1111-4111-8111-111111111111', status: 'queued', result: null, error: null }; }, async get() { return { job_id: '11111111-1111-4111-8111-111111111111', status: 'running', result: null, error: null }; } };
  const handler = createGptJobHandler({ allowLegacyBearer: true, service, origin: 'https://app.test' });
  const invoke = async (url, method, body, headers = {}) => {
    const req = { url, method, headers: { host: 'app.test', origin: 'https://app.test', authorization: 'Bearer key', ...headers }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
    let result; const res = { destroyed: false, writeHead(status) { result = { status }; }, end(data) { result.body = JSON.parse(data); } };
    await handler(req, res); return result;
  };
  const created = await invoke('/api/providers/gpt/jobs', 'POST', JSON.stringify(valid), { 'content-type': 'application/json', 'content-length': String(JSON.stringify(valid).length), 'idempotency-key': 'one' });
  assert.equal(created.status, 202);
  assert.equal((await invoke('/api/providers/gpt/jobs/11111111-1111-4111-8111-111111111111', 'GET')).body.status, 'running');
});

test('persists requested jpeg format for b64 results across reload', async t => {
  const h = await harness(t, (_req, res) => success(res));
  const done = await h.submit({ operation: 'generations', body: { ...valid.body, output_format: 'jpeg' } });
  assert.equal(done.result.output_format, 'jpeg');
  assert.equal(done.result.data[0].mime_type, 'image/jpeg');
  const restored = new GptJobs({ path: h.path });
  const reloaded = await restored.get(done.job_id, 'test-key');
  assert.equal(reloaded.result.output_format, 'jpeg');
  assert.equal(reloaded.result.data[0].mime_type, 'image/jpeg');
});

