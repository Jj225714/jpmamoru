// Local HTTPS browser proof only. Uses a committed localhost-only TEST certificate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../web/node_modules/esbuild/lib/main.js';
import { chromium } from '../web/node_modules/playwright/index.mjs';
import { createVaultHandler } from '../config-vault/server.mjs';
import { GptJobs, createGptJobHandler } from './gpt-jobs.mjs';
import { JsonJobStore, FalJobService, createFalJobHandler } from './job-service.mjs';
import { createVaultSessionAuthenticator, vaultSessionRequest } from './job-auth.mjs';

const sharedKey = 'BROWSER_SHARED_PROVIDER_KEY_TEST';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
async function until(fn) { const end = Date.now() + 10000; while (!await fn()) { if (Date.now() > end) throw new Error('Browser condition timed out'); await new Promise(r => setTimeout(r, 20)); } }

test('real HTTPS browser: dedicated task cookie path, verified users, logout revocation, no model-cookie leak', { timeout: 60000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'task-cookie-browser-'));
    let vault, router, origin;
    const helperBundle = await build({ stdin: { contents: 'export * from "./gpt-jobs"; export * from "./fal-jobs";', resolveDir: fileURLToPath(new URL('../web/src/services/api/', import.meta.url)) }, bundle: true, format: 'esm', write: false });
    const helperRequests = [];
    let loginSequence = 0;
    const gatewayCookies = [], providerCookies = [], verifierCookies = [], upstreamCookies = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const send = data => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
        if (req.url === '/auth/login') { const id = body.email.startsWith('alice') ? '101' : '202'; return send({ access_token: 'TEST_ACCESS_' + id, refresh_token: 'TEST_REFRESH_' + id, expires_in: 3600, user: { id } }); }
        if (req.url === '/auth/me') { const id = req.headers.authorization?.split('_').at(-1); return send({ id, status: 'active', email: id + '@test.invalid' }); }
        upstreamCookies.push(req.headers.cookie || '');
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }));
    });
    const internalVault = http.createServer((req, res) => vault(req, res));
    const web = https.createServer({ key: await readFile(new URL('./test-fixtures/localhost-test.key', import.meta.url)), cert: await readFile(new URL('./test-fixtures/localhost-test.crt', import.meta.url)) }, (req, res) => {
        if (req.url === '/helpers.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(helperBundle.outputFiles[0].text);
        if (req.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Local task session test</title>');
        if (req.url.startsWith('/api/config-vault/')) {
            // Synthetic proxy IP per login keeps this switch stress test independent of login throttling.
            if (req.url.endsWith('/login')) req.headers['x-real-ip'] = '192.0.2.' + (++loginSequence);
            return vault(req, res);
        }
        if (req.url.startsWith('/api/model-gateway/')) { gatewayCookies.push(req.headers.cookie || ''); return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); }
        providerCookies.push(req.headers.cookie || '');
        helperRequests.push({ path: req.url, method: req.method, intent: req.headers['idempotency-key'] });
        // Pre-admission HTTPS rate limit; this never reaches a model provider.
        if (req.headers['idempotency-key']?.startsWith('helper-429-')) return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture rate limit' } }));
        // Model the approved providers-only proxy allowlist; never forward a main/foreign cookie.
        const selected = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith('__Secure-provider_tasks='));
        req.headers.cookie = selected.join('; ');
        router(req, res, () => res.writeHead(404).end());
    });
    await listen(upstream); await listen(internalVault); await listen(web);
    origin = `https://127.0.0.1:${web.address().port}`;
    const authBaseUrl = `http://127.0.0.1:${upstream.address().port}`;
    vault = createVaultHandler({ origin, authBaseUrl, storeDir: join(dir, 'vault'), key: Buffer.alloc(32, 19) });
    const authenticate = createVaultSessionAuthenticator({ origin, sessionUrl: `http://127.0.0.1:${internalVault.address().port}/api/config-vault/session`, fetchImpl: async (url, init) => { verifierCookies.push(init.headers.Cookie); assert.equal(init.headers.Authorization, undefined); return vaultSessionRequest(url, init); } });
    const gpt = new GptJobs({ path: join(dir, 'gpt.account-v1'), queueKey: Buffer.alloc(32, 29), baseUrl: authBaseUrl + '/v1', requireAccountOwnership: true });
    const fal = new FalJobService({ store: new JsonJobStore(join(dir, 'fal.account-v1')), queueKey: Buffer.alloc(32, 29), requireAccountOwnership: true, provider: {} });
    gpt.schedule = () => {}; fal.schedule = () => {};
    const oldLog = process.env.AOWEISI_DIAGNOSTICS_LOG; process.env.AOWEISI_DIAGNOSTICS_LOG = join(dir, 'relay.log');
    const { createProviderHandler } = await import('./server.mjs?browser-cookie-proof');
    if (oldLog === undefined) delete process.env.AOWEISI_DIAGNOSTICS_LOG; else process.env.AOWEISI_DIAGNOSTICS_LOG = oldLog;
    router = createProviderHandler({ origin, gptJobHandler: createGptJobHandler({ service: gpt, origin, authenticate }), jobHandler: createFalJobHandler({ service: fal, origin, authenticate }), transport: async (route, body) => {
        assert.ok(Object.keys(route.headers).every(name => name.toLowerCase() !== 'cookie'));
        const response = await fetch(authBaseUrl + '/mock-fal-transport', { method: route.method, headers: route.headers, body });
        return { status: response.status, type: 'application/json', body: Buffer.from(await response.arrayBuffer()) };
    } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { gpt.stopped = true; fal.stopped = true; await browser.close(); await Promise.all([...gpt.workers]); await close(web); await close(internalVault); await close(upstream); await rm(dir, { recursive: true, force: true }); });
    const open = async () => { const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage(); await page.goto(origin); return { context, page }; };
    const a = await open(), b = await open(), a2 = await open(), anonymous = await open();
    const request = (tab, path, method = 'GET', body, action) => tab.page.evaluate(async ({ path, method, body, action, sharedKey }) => {
        const response = await fetch(path, { method, credentials: 'same-origin', headers: { Authorization: 'Bearer ' + sharedKey, 'Content-Type': 'application/json', 'Idempotency-Key': 'browser-shared-intent', 'X-User-ID': '101', ...(action ? { 'X-Job-Action': action } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, data: await response.json() };
    }, { path, method, body, action, sharedKey });
    const login = (tab, email) => request(tab, '/api/config-vault/login', 'POST', { email, password: 'TEST_ONLY_PASSWORD' });
    assert.equal((await login(a, 'alice@test.invalid')).status, 200);
    assert.equal((await login(b, 'bob@test.invalid')).status, 200);
    assert.equal((await login(a2, 'alice-device2@test.invalid')).status, 200);
    const cookies = await a.context.cookies();
    const main = cookies.find(c => c.name === '__Secure-config_vault'), task = cookies.find(c => c.name === '__Secure-provider_tasks');
    assert.ok(main); assert.ok(task); assert.equal(main.path, '/api/config-vault'); assert.equal(task.path, '/api/providers');
    assert.ok(main.httpOnly && main.secure && task.httpOnly && task.secure); assert.equal(task.sameSite, 'Strict');
    assert.equal(await a.page.evaluate(() => document.cookie), '');
    await request(a, '/api/model-gateway/cookie-probe'); assert.deepEqual(gatewayCookies, ['']);
    const ownedIds = [];
    for (const kind of ['gpt', 'fal']) {
        const root = kind === 'gpt' ? '/api/providers/gpt/jobs' : '/api/providers/fal/jobs/esrgan';
        const payload = kind === 'gpt' ? { operation: 'generations', body: { model: 'gpt-image-2', prompt: 'BROWSER_PRIVATE_PROMPT' } } : { prompt: 'BROWSER_PRIVATE_PROMPT' };
        const created = await request(a, root, 'POST', payload); assert.equal(created.status, 202); const id = created.data.job_id;
        ownedIds.push(root + '/' + id);
        assert.equal((await request(a2, root, 'POST', payload)).data.job_id, id);
        assert.deepEqual((await request(b, root)).data.items, []);
        assert.equal((await request(anonymous, root)).status, 401);
        for (const action of [undefined, 'cancel', 'retry']) assert.equal((await request(b, root + '/' + id, action ? 'POST' : 'GET', undefined, action)).status, 404);
        assert.equal((await request(a2, root + '/' + id, 'POST', undefined, 'cancel')).data.status, 'canceled');
    }
    // Run actual bundled legacy helpers against real vault and relay handlers over HTTPS.
    const race = await open();
    const helperEvidence = await race.page.evaluate(async sharedKey => {
        const h = await import('/helpers.js');
        let state = { accountId: '101', channelId: 'shared', revision: 1 };
        const loginAs = async (id, update = true) => {
            const res = await fetch('/api/config-vault/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: id === '101' ? 'alice@test.invalid' : 'bob@test.invalid', password: 'TEST_ONLY_PASSWORD' }) });
            if (res.status !== 200) throw Error('fixture login failed: ' + res.status + ' ' + await res.text());
            if (update) state = { ...state, accountId: id, revision: state.revision + 1 };
        };
        const config = { apiKey: sharedKey, sessionGuard: () => state };
        const stopped = async operation => { try { await operation(); throw Error('expected session barrier'); } catch (e) { if (e.code !== 'session_changed') throw e; } };
        const evidence = [];
        for (const mode of ['lost', '429']) for (const aba of [false, true]) {
            await loginAs('101'); let posts = 0;
            await stopped(() => h.submitGptImageJob({ ...config,
                fetch: async (...args) => { posts++; const res = await fetch(...args); if (mode === 'lost') { if (res.status !== 202) throw Error('submit was not accepted'); await res.text(); throw new TypeError('accepted response lost'); } return res; },
                sleep: async () => { await loginAs('202'); if (aba) await loginAs('101'); },
            }, 'generations', { model: 'gpt-image-2', prompt: 'BROWSER_PRIVATE_PROMPT' }, `helper-${mode}-${aba}`));
            if (posts !== 1) throw Error('cross-session resubmit');
            evidence.push({ mode, aba, posts });
        }
        for (const kind of ['gpt', 'fal']) {
            await loginAs('101');
            const created = kind === 'gpt' ? (await h.submitGptImageJob(config, 'generations', { model: 'gpt-image-2', prompt: 'BROWSER_PRIVATE_PROMPT' }, 'helper-poll-gpt')).job : await h.submitFalJob(config, 'esrgan', {}, { idempotencyKey: 'helper-poll-fal' });
            let gets = 0, updates = 0;
            const opts = { fetch: async (...args) => { gets++; return fetch(...args); }, onUpdate: () => { updates++; }, sleep: async () => { await loginAs('202'); await loginAs('101'); } };
            await stopped(() => kind === 'gpt' ? h.pollGptImageJob({ ...config, fetch: opts.fetch }, created.jobId, opts) : h.pollFalJob(config, 'esrgan', created.jobId, opts));
            if (gets !== 1 || updates !== 1) throw Error('poll crossed session revision');
            gets = 0; updates = 0;
            const late = { fetch: async (...args) => { gets++; const res = await fetch(...args); await loginAs('202'); return res; }, onUpdate: () => { updates++; } };
            await stopped(() => kind === 'gpt' ? h.pollGptImageJob({ ...config, fetch: late.fetch }, created.jobId, late) : h.pollFalJob(config, 'esrgan', created.jobId, late));
            if (gets !== 1 || updates !== 0) throw Error('stale poll callback');
            await loginAs('101');
            // Cookie changes before UI state: the verified-account precondition must refuse.
            await loginAs('202', false);
            await stopped(() => kind === 'gpt' ? h.submitGptImageJob(config, 'generations', { model: 'gpt-image-2', prompt: 'BROWSER_PRIVATE_PROMPT' }, 'helper-stale-gpt') : h.submitFalJob(config, 'esrgan', {}, { idempotencyKey: 'helper-stale-fal' }));
            if (kind === 'fal') {
                await stopped(() => h.cancelFalJob(config, 'esrgan', created.jobId));
                await loginAs('101');
                await stopped(() => h.cancelFalJob(config, 'esrgan', created.jobId, { fetch: async (...args) => { const res = await fetch(...args); if (res.status !== 200) throw Error('cancel failed'); await loginAs('202'); return res; } }));
            }
            evidence.push({ kind, pollSleepBlocked: true, lateResponseBlocked: true, staleCookieBlocked: true });
        }
        return evidence;
    }, sharedKey);
    for (const mode of ['lost', '429']) for (const aba of [false, true]) assert.equal(helperRequests.filter(r => r.intent === `helper-${mode}-${aba}`).length, 1);
    console.log('Actual legacy helper HTTPS race evidence:', JSON.stringify(helperEvidence));

    const queued = await request(b, '/api/providers/gpt/jobs', 'POST', { operation: 'generations', body: { model: 'gpt-image-2', prompt: 'BROWSER_PRIVATE_PROMPT' } });
    for (const item of gpt.store.jobs.values()) if (item.id !== queued.data.job_id && item.status === 'queued') item.status = 'canceled';
    delete gpt.schedule; gpt.schedule();
    await until(async () => (await request(b, '/api/providers/gpt/jobs/' + queued.data.job_id)).data.status === 'succeeded');
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.write('IHDR', 12); png.writeUInt32BE(64, 16); png.writeUInt32BE(32, 20);
    assert.equal((await request(b, '/api/providers/fal/submit/esrgan', 'POST', { image_url: 'data:image/png;base64,' + png.toString('base64'), scale: 2 })).status, 200);
    assert.deepEqual(upstreamCookies, ['', '']);
    assert.ok(providerCookies.filter(Boolean).every(c => c.startsWith('__Secure-provider_tasks=') && !c.includes('__Secure-config_vault=')));
    assert.ok(verifierCookies.every(c => /^__Secure-provider_tasks=[A-Za-z0-9_-]{43}$/.test(c)));
    assert.equal((await request(a, '/api/config-vault/logout', 'POST')).status, 200);
    assert.equal((await request(a, '/api/providers/gpt/jobs')).status, 401);
    await anonymous.context.addCookies([{ name: task.name, value: task.value, domain: task.domain, path: task.path, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    assert.equal((await request(anonymous, '/api/providers/gpt/jobs')).status, 401); // Captured task cookie was revoked with its vault session.
    assert.equal((await request(a2, '/api/providers/gpt/jobs')).status, 200);
    const previousDeviceCookie = (await a2.context.cookies()).find(c => c.name === '__Secure-provider_tasks');
    assert.equal((await login(a2, 'bob@test.invalid')).status, 200);
    for (const path of ownedIds) assert.equal((await request(a2, path)).status, 404);
    await anonymous.context.addCookies([{ name: previousDeviceCookie.name, value: previousDeviceCookie.value, domain: previousDeviceCookie.domain, path: previousDeviceCookie.path, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    assert.equal((await request(anonymous, '/api/providers/gpt/jobs')).status, 401); // Account switching revokes old session too.
    const scan = async directory => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name); if (entry.isDirectory()) { await scan(path); continue; }
            const text = await readFile(path, 'utf8');
            for (const secret of [main.value, task.value, sharedKey, 'BROWSER_PRIVATE_PROMPT', 'TEST_ONLY_PASSWORD']) assert.ok(!text.includes(secret), 'Sensitive data must not occur in persisted/log files');
        }
    };
    await until(async () => { try { return (await readFile(join(dir, 'relay.log'), 'utf8')).includes('provider-relay'); } catch { return false; } });
    await scan(dir);
    console.log('HTTPS browser evidence: dedicated cookie limited to providers; shared-key account isolation; two devices; logout/replay rejection; zero cookies to model-gateway and model upstream; persisted/log files contain no plaintext secrets.');
});

