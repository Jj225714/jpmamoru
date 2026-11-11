import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultHandler } from '../config-vault/server.mjs';
import { GptJobs, createGptJobHandler } from './gpt-jobs.mjs';
import { JsonJobStore, FalJobService, createFalJobHandler } from './job-service.mjs';
import { createProviderHandler } from './server.mjs';
import { createVaultSessionAuthenticator, vaultSessionRequest, loadLegacyIntentGuard, accountCredential, credentialOwner } from './job-auth.mjs';

const SHARED = 'SYNTHETIC_SHARED_TEAM_PROVIDER_KEY';
const body = kind => kind === 'gpt' ? { operation: 'generations', body: { model: 'gpt-image-2', prompt: 'PRIVATE_IMAGE_INPUT' } } : { prompt: 'PRIVATE_IMAGE_INPUT' };
async function until(fn) { const end = Date.now() + 5000; while (!await fn()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); } }
async function fixture(t, kind) {
    const dir = await mkdtemp(join(tmpdir(), 'account-jobs-'));
    const calls = [], authCalls = [], disabled = new Set();
    const upstream = http.createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const send = (data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
        if (req.url === '/auth/login') {
            const id = input.email.startsWith('a') ? '101' : '202';
            return send({ access_token: 'JAPI_ACCESS_' + id, refresh_token: 'JAPI_REFRESH_' + id, expires_in: 3600, user: { id } });
        }
        if (req.url === '/auth/me') {
            authCalls.push(req.headers.authorization);
            const id = req.headers.authorization?.split('_').at(-1);
            return ['101', '202'].includes(id) && !disabled.has(id) ? send({ id, email: id + '@test.invalid', status: 'active' }) : send({}, 401);
        }
        if (req.url === '/auth/refresh') return send({}, 401);
        calls.push({ kind: 'submit', auth: req.headers.authorization, cookie: req.headers.cookie, input });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }));
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${upstream.address().port}`;
    const storePath = join(dir, 'relay-account.json');
    const provider = {
        submit: async (_model, payload, key) => { calls.push({ kind: 'submit', auth: key, input: payload }); return { request_id: 'provider-' + calls.length }; },
        status: async (_model, id, key) => { calls.push({ kind: 'status', id, auth: key }); return { status: 'COMPLETED' }; },
        result: async (_model, id, key) => { calls.push({ kind: 'result', id, auth: key }); return { images: [] }; },
        cancel: async (_model, id, key) => { calls.push({ kind: 'cancel', id, auth: key }); return {}; },
    };
    const make = (path = storePath, extra = {}) => kind === 'gpt' ? new GptJobs({ path, baseUrl: base + '/v1', queueKey: Buffer.alloc(32, 9), requireAccountOwnership: true, ...extra }) : new FalJobService({ store: new JsonJobStore(path), provider, queueKey: Buffer.alloc(32, 9), requireAccountOwnership: true, pollDelayMs: 1, ...extra });
    let service = make(); service.schedule = () => {};
    let router, vault; const server = http.createServer((req, res) => {
        if (req.url.startsWith('/api/config-vault/')) return vault(req, res);
        return router(req, res, () => res.writeHead(404).end());
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    vault = createVaultHandler({ origin, authBaseUrl: base, storeDir: join(dir, 'vault'), key: Buffer.alloc(32, 3) });
    const verifierRequests = [];
    const authenticate = createVaultSessionAuthenticator({ sessionUrl: origin + '/api/config-vault/session', origin, fetchImpl: async (url, init) => { verifierRequests.push(init.headers); return vaultSessionRequest(url, init); } });
    const mount = current => {
        service = current;
        const handler = (kind === 'gpt' ? createGptJobHandler : createFalJobHandler)({ service, origin, authenticate });
        router = createProviderHandler({ origin, ...(kind === 'gpt' ? { gptJobHandler: handler } : { jobHandler: handler }) });
    };
    mount(service);
    const root = kind === 'gpt' ? '/api/providers/gpt/jobs' : '/api/providers/fal/jobs/esrgan';
    const request = async (cookie, suffix = '', method = 'GET', payload, extra = {}) => {
        const response = await fetch(origin + root + suffix, { method, headers: { Origin: origin, Authorization: 'Bearer ' + SHARED, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': 'same-intent', ...extra }, body: payload ? JSON.stringify(payload) : undefined });
        return { status: response.status, data: await response.json() };
    };
    const login = async email => {
        const res = await fetch(origin + '/api/config-vault/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'SYNTHETIC_PASSWORD' }) });
        assert.equal(res.status, 200); await res.json();
        // Handles old-path deletion plus new-path set during the concurrent vault rollout.
        return res.headers.getSetCookie().find(c => /^__Secure-provider_tasks=[A-Za-z0-9_-]{43};/.test(c)).split(';')[0];
    };
    t.after(async () => { service.stopped = true; await Promise.all(service.workers instanceof Map ? [...service.workers.values()] : [...service.workers]); server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]); await rm(dir, { recursive: true, force: true }); });
    return { dir, origin, root, storePath, service, make, mount, request, login, calls, authCalls, disabled, verifierRequests };
}

for (const kind of ['gpt', 'fal']) {
    test(`${kind}: shared key is isolated by verified vault/JAPI user; same user two sessions share tasks`, async t => {
        const h = await fixture(t, kind);
        const a = await h.login('a-device1@test.invalid'), b = await h.login('b@test.invalid'), a2 = await h.login('a-device2@test.invalid');
        assert.notEqual(a, a2);
        const created = await h.request(a, '', 'POST', body(kind)); assert.equal(created.status, 202); const id = created.data.job_id;
        for (const headers of [{ Origin: 'https://untrusted.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
            assert.equal((await h.request(a, '', 'POST', body(kind), headers)).status, 403);
            assert.equal((await h.request(a, '/' + id, 'POST', undefined, { ...headers, 'X-Job-Action': 'cancel' })).status, 403);
            assert.equal((await h.request(a, '/' + id, 'POST', undefined, { ...headers, 'X-Job-Action': 'retry' })).status, 403);
        }
        assert.equal((await h.request(a2, '', 'POST', body(kind))).data.job_id, id);
        assert.deepEqual((await h.request(b)).data.items, []);
        for (const [method, action] of [['GET', undefined], ['POST', 'cancel'], ['POST', 'retry']]) {
            const denied = await h.request(b, '/' + id, method, undefined, { 'X-User-ID': '101', 'X-Config-User': '101', 'X-Forwarded-User': '101', ...(action ? { 'X-Job-Action': action } : {}) });
            assert.equal(denied.status, 404);
        }
        assert.equal((await h.request(undefined, '/' + id, 'GET', undefined, { 'X-User-ID': '101' })).status, 401);
        assert.equal((await h.request('__Secure-provider_tasks=' + 'x'.repeat(43))).status, 401);
        assert.equal((await h.request(a + '; ' + b)).status, 401);
        const ownB = await h.request(b, '', 'POST', body(kind)); assert.equal(ownB.status, 202); assert.notEqual(ownB.data.job_id, id);
        assert.equal((await h.request(a2)).data.items.length, 1);
        assert.equal((await h.request(a2, '/' + id, 'POST', undefined, { 'X-Job-Action': 'cancel' })).data.status, 'canceled');
        assert.equal((await h.request(b, '/' + ownB.data.job_id)).data.status, 'queued');
        assert.equal(h.calls.length, 0);
        const raw = await readFile(h.storePath, 'utf8');
        for (const job of h.service.store.jobs.values()) if (job.sealed) {
            const decrypted = JSON.stringify(h.service.cipher.open(job.sealed, h.service.context(job)));
            for (const cookie of [a, b, a2]) assert.ok(!decrypted.includes(cookie.split('=')[1]));
        }
        assert.equal((await h.request('__Secure-config_vault=' + a.split('=')[1])).status, 401);
        assert.equal((await h.request(a + '; __Secure-config_vault=' + 'z'.repeat(43))).status, 200);
        for (const secret of [SHARED, a.split('=')[1], b.split('=')[1], 'JAPI_ACCESS_', 'PRIVATE_IMAGE_INPUT', 'SYNTHETIC_PASSWORD']) assert.ok(!raw.includes(secret));
        assert.ok(h.verifierRequests.every(headers => !('Authorization' in headers) && !('X-User-ID' in headers)));
        assert.ok(h.verifierRequests.every(headers => /^__Secure-provider_tasks=[A-Za-z0-9_-]{43}$/.test(headers.Cookie)));
        assert.ok(h.authCalls.every(auth => !auth.includes(SHARED)));
        // Restart with the same encrypted store: only B's uncanceled waiting job executes.
        const restarted = h.make(); await restarted.init(); h.mount(restarted);
        await until(async () => (await h.request(b, '/' + ownB.data.job_id)).data.status === 'succeeded');
        assert.equal(h.calls.filter(c => c.kind === 'submit').length, 1);
        assert.equal((await h.request(a2, '/' + ownB.data.job_id)).status, 404);
        assert.ok(h.calls.every(c => c.auth === SHARED || c.auth === 'Bearer ' + SHARED));
        assert.ok(h.calls.every(c => !c.cookie));
        h.disabled.add('101');
        assert.equal((await h.request(a2)).status, 401); // Every request revalidates active JAPI account.
        assert.equal((await h.request(b)).status, 200);
    });

    test(`${kind}: legacy keys are quarantined, cannot self-claim or replay across owner migration`, async t => {
        const h = await fixture(t, kind), oldPath = join(h.dir, 'legacy.json');
        const old = h.make(oldPath, { requireAccountOwnership: false }); old.schedule = () => {};
        if (kind === 'gpt') await old.create(body(kind), SHARED, 'same-intent');
        else await old.create({ model: 'esrgan', payload: body(kind), credential: SHARED, idempotencyKey: 'same-intent' });
        const before = await readFile(oldPath, 'utf8');
        const legacyGuard = await loadLegacyIntentGuard(oldPath, kind);
        const secure = h.make(h.storePath, { legacyGuard }); secure.schedule = () => {}; h.mount(secure);
        const a = await h.login('a@test.invalid'), b = await h.login('b@test.invalid');
        for (const cookie of [a, b]) {
            assert.equal((await h.request(cookie, '', 'POST', body(kind))).status, 409);
            assert.deepEqual((await h.request(cookie)).data.items, []);
            assert.equal((await h.request(cookie, '/' + JSON.parse(before)[0].id)).status, 404);
        }
        assert.equal(await readFile(oldPath, 'utf8'), before); assert.equal(h.calls.length, 0);
        assert.equal((await h.request(a, '', 'POST', body(kind), { 'Idempotency-Key': 'genuinely-new-intent' })).status, 202);
        assert.throws(() => createVaultSessionAuthenticator({ origin: h.origin, sessionUrl: 'http://evil.example/api/config-vault/session' }));
        assert.throws(() => createVaultSessionAuthenticator({ origin: h.origin, sessionUrl: h.origin + '/arbitrary' }));
    });
}

test('Fal recovery and cancel cannot cross account boundaries with guessed provider-backed job ID', async t => {
    const h = await fixture(t, 'fal'), a = await h.login('a@test.invalid'), b = await h.login('b@test.invalid'), a2 = await h.login('a2@test.invalid');
    const created = await h.request(a, '', 'POST', body('fal')), id = created.data.job_id;
    const internal = h.service.store.jobs.get(id); Object.assign(internal, { providerJobId: 'provider-existing', status: 'recoverable', stage: 'recoverable', queueState: 'submitting' }); await h.service.store.flush();
    assert.equal((await h.request(b, '/' + id, 'POST', undefined, { 'X-Job-Action': 'retry' })).status, 404);
    assert.equal((await h.request(b, '/' + id, 'POST', undefined, { 'X-Job-Action': 'cancel' })).status, 404);
    assert.equal(h.calls.length, 0);
    assert.equal((await h.request(a2, '/' + id, 'POST', undefined, { 'X-Job-Action': 'retry' })).status, 200);
    await h.service.waitForIdle();
    assert.equal(h.calls.filter(c => c.kind === 'submit').length, 0); assert.ok(h.calls.some(c => c.kind === 'status'));
    assert.equal((await h.request(a2, '/' + id)).data.status, 'succeeded');
});

test('default HTTP handlers reject missing verifier; session failures never fall back to provider bearer', async () => {
    for (const factory of [createGptJobHandler, createFalJobHandler]) {
        const gpt = factory === createGptJobHandler;
        const handler = factory({ service: { list: () => { throw new Error('Must not reach service'); } }, origin: 'https://app.test' });
        let status; const res = { writeHead: s => { status = s; }, end: () => {}, destroyed: false };
        await handler({ url: gpt ? '/api/providers/gpt/jobs' : '/api/providers/fal/jobs/esrgan', method: 'GET', headers: { host: 'app.test', origin: 'https://app.test', authorization: 'Bearer ' + SHARED } }, res);
        assert.equal(status, 503);
    }
    const req = { headers: { cookie: '__Secure-provider_tasks=' + 'x'.repeat(43) } };
    for (const response of [new Response('redirect', { status: 302 }), new Response('bad', { status: 503 }), new Response(JSON.stringify({ user: { id: 'forged-user' } }))]) {
        const verify = createVaultSessionAuthenticator({ origin: 'https://app.test', sessionUrl: 'http://127.0.0.1:3183/api/config-vault/session', fetchImpl: async () => response });
        await assert.rejects(verify(req));
    }
    assert.notEqual(credentialOwner(accountCredential(SHARED, '101')), credentialOwner(accountCredential(SHARED, '202')));
    assert.throws(() => createVaultSessionAuthenticator({ origin: 'https://app.test', sessionUrl: 'http://127.0.0.1:3183/api/config-vault/session', cookieName: '__Secure-config_vault' }));
});

test('unknown legacy identity schema fails closed without mutating the quarantine', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'legacy-schema-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'legacy.json'), raw = JSON.stringify([{ id: 'unknown-old-record' }]);
    await writeFile(path, raw);
    await assert.rejects(loadLegacyIntentGuard(path, 'gpt'), /requires review/);
    await assert.rejects(loadLegacyIntentGuard(path, 'fal'), /requires review/);
    assert.equal(await readFile(path, 'utf8'), raw);
});

for (const kind of ['gpt', 'fal']) test(`${kind}: expected account is only a verified-session precondition`, async t => {
    const h = await fixture(t, kind), a = await h.login('a@test.invalid');
    const created = await h.request(a, '', 'POST', body(kind), { 'X-Task-User': '101' });
    assert.equal(created.status, 202);
    for (const action of ['cancel', 'retry']) {
        assert.equal((await h.request(a, '/' + created.data.job_id, 'POST', undefined, { 'X-Task-User': '202', 'X-Job-Action': action })).status, 409);
    }
    assert.equal((await h.request(a, '', 'POST', body(kind), { 'X-Task-User': '202', 'Idempotency-Key': 'new-mismatched' })).status, 409);
    assert.equal((await h.request(undefined, '', 'POST', body(kind), { 'X-Task-User': '101' })).status, 401);
    assert.equal((await h.request(a)).data.items.length, 1);
    assert.equal((await h.request(a, '/' + created.data.job_id)).data.status, 'queued');
    assert.equal(h.calls.length, 0);
});
