import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GptJobs } from './gpt-jobs.mjs';
import { QueueCipher, loadQueueKey } from './queue-crypto.mjs';

const input = (i, model = 'gpt-image-2') => ({ operation: 'generations', body: { model, prompt: `PRIVATE_PROMPT_${i}` } });
const credential = 'PRIVATE_CALLER_KEY';
async function until(check) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, 'condition timed out'); await new Promise(r => setTimeout(r, 5)); } }
const finish = res => { if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] })); } };
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'durable-queue-'));
  const file = join(directory, 'jobs.json'); const key = randomBytes(32);
  const requests = []; let auto = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push({ res, input: JSON.parse(Buffer.concat(chunks).toString()) });
    if (auto) finish(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const service = new GptJobs({ path: file, queueKey: key, baseUrl: base, ...options });
  t.after(async () => {
    service.stopped = true; requests.forEach(x => finish(x.res));
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await Promise.all([...service.workers]);
  });
  return { directory, file, key, requests, service, base, drain: () => { auto = true; requests.forEach(x => finish(x.res)); } };
}

test('five encrypted jobs queue under two slots; model caps and same-key dedup hold', async t => {
  const h = await setup(t, { modelLimits: { 'gpt-image-2': 1 } });
  const jobs = [];
  for (let i = 0; i < 5; i++) jobs.push(await h.service.create(input(i, i < 3 ? 'gpt-image-2' : 'gpt-image-1'), credential, `key-${i}`));
  await until(() => h.requests.length === 2);
  assert.equal(h.service.active.size, 2);
  assert.deepEqual(h.requests.map(x => x.input.model).sort(), ['gpt-image-1', 'gpt-image-2']);
  assert.equal([...h.service.store.jobs.values()].filter(j => j.queueState === 'waiting').length, 3);
  const copies = await Promise.all(Array.from({ length: 5 }, () => h.service.create(input(2), credential, 'key-2')));
  assert.ok(copies.every(j => j.job_id === jobs[2].job_id));
  await assert.rejects(h.service.create(input('different'), credential, 'key-2'), { status: 409 });
  for (const file of await readdir(h.directory)) {
    const raw = await readFile(join(h.directory, file), 'utf8');
    assert.ok(!raw.includes(credential)); assert.ok(!raw.includes('PRIVATE_PROMPT'));
  }
  h.drain(); await until(() => [...h.service.store.jobs.values()].every(j => j.status === 'succeeded'));
  await Promise.all([...h.service.workers]); assert.equal(h.requests.length, 5);
  assert.equal((await h.service.list(credential)).items.length, 5);
});

test('waiting cancel wins before dispatch; running cancel is refused and never duplicates', async t => {
  const h = await setup(t, { maxActive: 1 });
  const running = await h.service.create(input(0), credential, 'run'); await until(() => h.requests.length === 1);
  const waiting = await h.service.create(input(1), credential, 'wait');
  assert.equal((await h.service.get(waiting.job_id, credential)).actions.cancel.allowed, true);
  await assert.rejects(h.service.cancel(waiting.job_id, 'foreign'), { status: 404 });
  await assert.rejects(h.service.cancel(running.job_id, credential), { status: 409 });
  const canceled = await h.service.cancel(waiting.job_id, credential);
  assert.equal(canceled.status, 'canceled'); assert.equal(h.service.store.jobs.get(waiting.job_id).sealed, undefined);
  h.drain(); await until(() => h.service.workers.size === 0);
  assert.equal(h.requests.length, 1);
  assert.equal((await h.service.create(input(1), credential, 'wait')).status, 'canceled');
  const restored = new GptJobs({ path: h.file, baseUrl: h.base, queueKey: h.key }); await restored.init();
  assert.equal((await restored.get(waiting.job_id, credential)).status, 'canceled'); assert.equal(restored.workers.size, 0);
});

test('disabled queue rejects capacity and invalid encryption configuration never enables plaintext', async t => {
  const h = await setup(t, { queueKey: null, maxActive: 1 });
  await h.service.create(input(0), credential, 'first'); await until(() => h.requests.length === 1);
  await assert.rejects(h.service.create(input(1), credential, 'second'), { status: 429 });
  assert.throws(() => new GptJobs({ path: h.file, queueKey: Buffer.alloc(1) }), /Invalid queue/);
  assert.equal(loadQueueKey(undefined), null);
  const badFile = join(h.directory, 'key'); await writeFile(badFile, 'invalid', { mode: 0o600 });
  assert.throws(() => loadQueueKey(badFile));
  assert.ok(!(await readFile(h.file, 'utf8')).includes(credential)); h.drain();
});

test('authenticated encryption binds job/context and rejects wrong key or tampering', () => {
  const cipher = new QueueCipher(randomBytes(32)); const sealed = cipher.seal({ secret: credential }, 'job-1');
  assert.equal(cipher.open(sealed, 'job-1').secret, credential);
  assert.throws(() => cipher.open(sealed, 'job-2'));
  assert.throws(() => new QueueCipher(randomBytes(32)).open(sealed, 'job-1'));
  assert.throws(() => cipher.open({ ...sealed, data: Buffer.from('tampered').toString('base64') }, 'job-1'));
});

test('submission disconnect stays uncertain, identical key never makes another call', async t => {
  const h = await setup(t);
  const job = await h.service.create(input(0), credential, 'once'); await until(() => h.requests.length === 1);
  h.requests[0].res.destroy(); await until(() => h.service.workers.size === 0);
  assert.equal((await h.service.get(job.job_id, credential)).status, 'uncertain');
  const restored = new GptJobs({ path: h.file, queueKey: h.key, baseUrl: h.base });
  assert.equal((await restored.create(input(0), credential, 'once')).job_id, job.job_id);
  assert.equal(restored.workers.size, 0); assert.equal(h.requests.length, 1);
});

test('queue byte cap refuses excess and storage failure prevents network dispatch', async t => {
  const h = await setup(t, { maxQueueBytes: 1 });
  await assert.rejects(h.service.create(input(0), credential, 'oversize'), { code: 'queue_bytes_capacity' });
  assert.equal(h.requests.length, 0);
  h.service.maxQueueBytes = 100000; await h.service.init();
  h.service.store.flush = async () => { throw new Error('disk full'); };
  await assert.rejects(h.service.create(input(0), credential, 'disk'), { status: 503 });
  assert.equal(h.service.stopped, true); assert.equal(h.requests.length, 0);
});

test('failed durable submission marker prevents any upstream request', async t => {
  const h = await setup(t); await h.service.init();
  const flush = h.service.store.flush.bind(h.service.store);
  h.service.store.flush = async () => {
    if ([...h.service.store.jobs.values()].some(j => j.queueState === 'submitting')) throw new Error('intent disk failure');
    return flush();
  };
  const job = await h.service.create(input(0), credential, 'marker');
  await until(() => h.service.stopped);
  assert.equal(h.requests.length, 0); assert.equal((await h.service.get(job.job_id, credential)).status, 'uncertain');
});

test('cancel cannot cross an in-progress durable dispatch claim', async t => {
  const h = await setup(t); await h.service.init();
  let release; const barrier = new Promise(r => release = r);
  const flush = h.service.store.flush.bind(h.service.store); let claimed = false;
  h.service.store.flush = async () => {
    if (!claimed && [...h.service.store.jobs.values()].some(j => j.queueState === 'submitting')) { claimed = true; await barrier; }
    return flush();
  };
  const job = await h.service.create(input(0), credential, 'race'); await until(() => claimed);
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.service.cancel(job.job_id, credential), { status: 409 });
  release(); await until(() => h.requests.length === 1); h.drain(); await until(() => h.service.workers.size === 0);
  assert.equal((await h.service.get(job.job_id, credential)).status, 'succeeded'); assert.equal(h.requests.length, 1);
});

test('missing key leaves recovered queue locked; wrong key fails without network; identity survives result expiry', async t => {
  const h = await setup(t);
  // Hold scheduling before initialization to model a persisted waiting entry.
  h.service.schedule = () => {};
  await h.service.init();
  const job = await h.service.create(input(0), credential, 'encrypted');
  const locked = new GptJobs({ path: h.file, baseUrl: h.base }); await locked.init();
  assert.equal((await locked.get(job.job_id, credential)).status, 'queued'); assert.equal(locked.workers.size, 0);
  const wrong = new GptJobs({ path: h.file, baseUrl: h.base, queueKey: randomBytes(32) });
  await wrong.init(); await until(() => wrong.store.jobs.get(job.job_id).status === 'failed'); await Promise.all([...wrong.workers]);
  assert.equal(wrong.store.jobs.get(job.job_id).error.code, 'queue_decryption_failed'); assert.equal(h.requests.length, 0);
  const j = wrong.store.jobs.get(job.job_id); j.result = { data: [] }; j.finishedAt = 1;
  await wrong.store.flush(); await wrong.store.cleanup();
  assert.ok(wrong.store.jobs.has(job.job_id)); assert.equal(j.result, null);
  assert.equal((await wrong.create(input(0), credential, 'encrypted')).job_id, job.job_id);
  assert.equal(h.requests.length, 0);
});

// Real process kill: queued input survives; submitted work must never be replayed.
test('process restart dispatches only waiting jobs, not committed submitting intents', async t => {
  const h = await setup(t); const children = [];
  const moduleUrl = new URL('./gpt-jobs.mjs', import.meta.url).href;
  const script = `import { GptJobs } from ${JSON.stringify(moduleUrl)};
    const s = new GptJobs({path:process.env.TEST_STORE,baseUrl:process.env.TEST_BASE,queueKey:Buffer.from(process.env.TEST_KEY,'base64'),maxActive:1});
    await s.init();
    if(process.env.TEST_CREATE==='1') for(let i=0;i<5;i++) await s.create({operation:'generations',body:{model:'gpt-image-2',prompt:'PRIVATE_PROMPT_'+i}},'PRIVATE_CALLER_KEY','key-'+i);
    process.on('message', async () => { let error; try { await s.store.write; } catch(e) { error=e.code; } process.send({stopped:s.stopped,error,statuses:[...s.store.jobs.values()].map(j=>j.status)}); });
    process.send('ready'); setInterval(()=>{},1000);`;
  const start = async create => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TEST_STORE: h.file, TEST_BASE: h.base, TEST_KEY: h.key.toString('base64'), TEST_CREATE: create ? '1' : '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    children.push(child);
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('worker exited early'); })]); return child;
  };
  const kill = async child => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; };
  t.after(async () => { for (const child of children) await kill(child); });
  const first = await start(true); await until(() => h.requests.length === 1);
  const before = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(before.filter(j => j.queueState === 'waiting').length, 4);
  assert.equal(before.filter(j => j.queueState === 'submitting').length, 1);
  await kill(first);
  const raw = await readFile(h.file, 'utf8'); assert.ok(!raw.includes(credential)); assert.ok(!raw.includes('PRIVATE_PROMPT'));
  h.drain(); const second = await start(false);
  try { await until(async () => { const answer = once(second, 'message'); second.send('status'); const [state] = await answer; return state.statuses.filter(s => s === 'succeeded').length === 4; }); }
  catch { const answer = once(second, 'message'); second.send('status'); const [state] = await answer; assert.fail(JSON.stringify({ state, calls: h.requests.length, jobs: JSON.parse(await readFile(h.file, 'utf8')).map(j => ({ status: j.status, stage: j.stage, code: j.error?.code })) })); }
  const after = JSON.parse(await readFile(h.file, 'utf8')); assert.equal(after.filter(j => j.status === 'uncertain').length, 1);
  assert.equal(h.requests.length, 5);
  assert.equal(new Set(h.requests.map(x => x.input.prompt)).size, 5);
  await kill(second);
});
