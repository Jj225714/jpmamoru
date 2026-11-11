import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GptJobs, createGptJobHandler } from './gpt-jobs.mjs';
import { FalJobService, JsonJobStore, createFalJobHandler } from './job-service.mjs';

for (const kind of ['gpt', 'fal']) test(`legacy ${kind}: two synthetic users sharing bearer can list/read/cancel each other's task`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'legacy-owner-proof-'));
    const service = kind === 'gpt' ? new GptJobs({ path: join(dir, 'jobs'), queueKey: Buffer.alloc(32, 4) }) : new FalJobService({ store: new JsonJobStore(join(dir, 'jobs')), provider: {}, queueKey: Buffer.alloc(32, 4) });
    service.schedule = () => {};
    let handler; const server = http.createServer((req, res) => handler(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    handler = (kind === 'gpt' ? createGptJobHandler : createFalJobHandler)({ service, origin, allowLegacyBearer: true });
    const root = kind === 'gpt' ? '/api/providers/gpt/jobs' : '/api/providers/fal/jobs/esrgan';
    const request = async (user, path = '', method = 'GET', body, action) => {
        const response = await fetch(origin + root + path, { method, headers: { Origin: origin, Authorization: 'Bearer SHARED_TEAM_KEY_TEST', Cookie: `synthetic_user=${user}`, 'X-User-ID': user, 'Content-Type': 'application/json', 'Idempotency-Key': 'intent-a', ...(action ? { 'X-Job-Action': action } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, data: await response.json() };
    };
    const created = await request('A', '', 'POST', kind === 'gpt' ? { operation: 'generations', body: { model: 'gpt-image-2', prompt: 'private A' } } : { prompt: 'private A' });
    assert.equal(created.status, 202);
    const id = created.data.job_id;
    assert.equal((await request('B')).data.items[0].job_id, id);
    assert.equal((await request('B', '/' + id)).status, 200);
    assert.equal((await request('B', '/' + id, 'POST', undefined, 'cancel')).data.status, 'canceled');
});
