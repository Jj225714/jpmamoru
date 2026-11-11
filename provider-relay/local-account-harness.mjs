/** LOCAL TEST HARNESS ONLY. Never deploy. All listeners and upstreams are loopback. */
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createVaultHandler } from '../config-vault/server.mjs';
import { GptJobs, createGptJobHandler } from './gpt-jobs.mjs';
import { JsonJobStore, FalJobService, createFalJobHandler } from './job-service.mjs';
import { createVaultSessionAuthenticator } from './job-auth.mjs';

const port = Number(process.env.TASK_TEST_HTTPS_PORT || 3443);
const webUrl = process.env.TASK_TEST_WEB_URL ? new URL(process.env.TASK_TEST_WEB_URL) : null;
if (!Number.isInteger(port) || port < 0 || port > 65535 || (webUrl && (webUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(webUrl.hostname) || webUrl.username || webUrl.password))) throw new Error('Invalid local test address');
const dir = await mkdtemp(join(tmpdir(), 'trusted-task-harness-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const counters = { gptSubmits: 0, falSubmits: 0, upstreamCookies: 0 };
let vault, router, origin, stopping = false;
const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let body = {}; try { body = JSON.parse(raw); } catch {}
    const send = (data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.url === '/auth/login') {
        if (!['alice@test.invalid', 'bob@test.invalid'].includes(body.email) || body.password !== 'local-test-only') return send({}, 401);
        const id = body.email.startsWith('alice') ? '101' : '202';
        return send({ data: { access_token: 'LOCAL_ACCESS_' + id, refresh_token: 'LOCAL_REFRESH_' + id, expires_in: 3600, user: { id } } });
    }
    if (req.url === '/auth/me') {
        const id = req.headers.authorization?.split('_').at(-1);
        return ['101', '202'].includes(id) ? send({ data: { id, email: id === '101' ? 'alice@test.invalid' : 'bob@test.invalid', status: 'active' } }) : send({}, 401);
    }
    if (req.url === '/auth/refresh') return send({}, 401);
    if (!['/v1/images/generations', '/v1/images/edits'].includes(req.url)) return send({}, 404);
    counters.gptSubmits++; if (req.headers.cookie) counters.upstreamCookies++;
    if (raw.includes('[test:uncertain]')) { req.socket.destroy(); return; }
    if (raw.includes('[test:fail]')) return send({ error: { message: 'Synthetic validation failure' } }, 400);
    await new Promise(r => setTimeout(r, Math.min(30000, Math.max(0, Number(process.env.TASK_TEST_DELAY_MS || 400)))));
    if (!res.destroyed) send({ data: Array.from({ length: Number.isInteger(body.n) ? Math.min(body.n, 10) : 1 }, () => ({ b64_json: png, mime_type: 'image/png' })) });
});
const internal = http.createServer((req, res) => vault(req, res));
const web = https.createServer({ key: await readFile(new URL('./test-fixtures/localhost-test.key', import.meta.url)), cert: await readFile(new URL('./test-fixtures/localhost-test.crt', import.meta.url)) }, (req, res) => {
    if (req.url.startsWith('/api/config-vault/')) return vault(req, res);
    if (/^\/api\/providers\/(?:gpt|fal)\/jobs(?:\/|\?|$)/.test(req.url)) {
        req.headers.cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith('__Secure-provider_tasks=')).join('; ');
        return router(req, res, () => res.writeHead(404).end());
    }
    if (req.url === '/__task_test/health') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ testOnly: true, ...counters }));
    if (req.url.startsWith('/api/model-gateway') || req.url.startsWith('/api/providers/')) return res.writeHead(403).end('Test harness permits jobs only; no real upstream fallback');
    if (!webUrl) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Trusted task harness</title><p>Local test API ready. Set TASK_TEST_WEB_URL to proxy a local Vite page.</p>');
    const target = new URL(req.url, webUrl);
    if (target.origin !== webUrl.origin) return res.writeHead(403).end();
    const proxy = http.request(target, { method: req.method, headers: { ...req.headers, host: webUrl.host, cookie: '' } }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Local Vite unavailable'); }); req.pipe(proxy);
});
web.on('upgrade', (req, socket, head) => {
    if (!webUrl || req.url.startsWith('/api/')) return socket.destroy();
    const target = new URL(req.url, webUrl); if (target.origin !== webUrl.origin) return socket.destroy();
    const proxy = http.request(target, { headers: { ...req.headers, host: webUrl.host, cookie: '' } });
    proxy.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
        if (head.length) upstreamSocket.write(head); if (upstreamHead.length) socket.write(upstreamHead);
        socket.pipe(upstreamSocket).pipe(socket); upstreamSocket.on('error', () => socket.destroy()); socket.on('error', () => upstreamSocket.destroy());
    });
    proxy.on('response', () => socket.destroy()); proxy.on('error', () => socket.destroy()); proxy.end();
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
await new Promise(r => internal.listen(0, '127.0.0.1', r));
await new Promise(r => web.listen(port, '127.0.0.1', r));
origin = `https://127.0.0.1:${web.address().port}`;
const mockBase = `http://127.0.0.1:${mock.address().port}`;
vault = createVaultHandler({ origin, authBaseUrl: mockBase, storeDir: join(dir, 'vault'), key: Buffer.alloc(32, 51) });
const authenticate = createVaultSessionAuthenticator({ origin, sessionUrl: `http://127.0.0.1:${internal.address().port}/api/config-vault/session` });
const gpt = new GptJobs({ path: join(dir, 'gpt.account-v1'), baseUrl: mockBase + '/v1', queueKey: Buffer.alloc(32, 61), requireAccountOwnership: true });
const fal = new FalJobService({ store: new JsonJobStore(join(dir, 'fal.account-v1')), queueKey: Buffer.alloc(32, 61), requireAccountOwnership: true, provider: {
    submit: async () => { counters.falSubmits++; return { request_id: randomUUID() }; }, status: async () => ({ status: 'COMPLETED' }), result: async () => ({ images: [{ b64_json: png }] }), cancel: async () => ({}),
} });
process.env.AOWEISI_DIAGNOSTICS_LOG = join(dir, 'relay.log');
const { createProviderHandler } = await import('./server.mjs');
router = createProviderHandler({ origin, gptJobHandler: createGptJobHandler({ service: gpt, origin, authenticate }), jobHandler: createFalJobHandler({ service: fal, origin, authenticate }) });
await gpt.init(); await fal.init();
const shutdown = async () => {
    if (stopping) return; stopping = true; gpt.stopped = true; fal.stopped = true;
    for (const server of [web, internal, mock]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    await Promise.allSettled([...gpt.workers, ...fal.workers.values()]); await rm(dir, { recursive: true, force: true }); process.exit(0);
};
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
console.log(JSON.stringify({ event: 'trusted-task-harness-ready', origin, webUrl: webUrl?.href || null, vaultPort: internal.address().port, mockPort: mock.address().port, testOnly: true }));
