import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:https';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '../web/node_modules/playwright/index.mjs';
import { createVaultHandler, decrypt } from './server.mjs';

const COOKIE = '__Secure-config_vault';
const TASK_COOKIE = '__Secure-provider_tasks';
test('real HTTPS Chromium: scoped task cookie, broad-path cleanup, duplicate rejection, switch/logout, CSRF and cookie containment', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-cookie-browser-'));
    let browser; let server;
    t.after(async () => { await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
    const openssl = process.env.VAULT_TEST_OPENSSL || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const key = randomBytes(32); const storeDir = join(dir, 'store'); let authChecks = 0; const disabled = new Set(); const upstreamHeaders = [];
    const fetchImpl = async (url, options) => {
        upstreamHeaders.push(Object.keys(options.headers || {}));
        const id = url.endsWith('/auth/login') ? JSON.parse(options.body).email.split('@')[0] : options.headers.authorization.slice(7);
        const user = { id, email: `${id}@example.test`, status: disabled.has(id) ? 'disabled' : 'active' };
        if (url.endsWith('/auth/me')) authChecks++;
        return { ok: true, json: async () => ({ data: url.endsWith('/auth/login') ? { user, access_token: id, refresh_token: id, expires_in: 86400 } : user }) };
    };
    let handler; let providerCookieCount = -1; let rejected = 0; const active = new Set();
    server = createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, (req, res) => {
        // Probe represents only browser routing; it does not implement or modify Relay.
        if (req.url.startsWith('/api/providers/') || req.url.startsWith('/api/model-gateway/')) {
            providerCookieCount = (req.headers.cookie || '').split(';').filter(v => v.trim().startsWith(TASK_COOKIE + '=')).length;
            res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ cookiePresent: providerCookieCount === 1, mainPresent: (req.headers.cookie || '').includes(COOKIE + '=') }));
        }
        if (!req.url.startsWith('/api/config-vault')) { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Local cookie test</title>'); }
        res.on('finish', () => { if (res.statusCode === 403) rejected++; });
        const work = handler(req, res); active.add(work); work.then(() => active.delete(work), () => active.delete(work));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; const origin = `https://localhost:${port}`;
    handler = createVaultHandler({ origin, authBaseUrl: 'https://mock.invalid', storeDir, key, fetchImpl });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
    await page.goto(origin);
    const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
        const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json', 'x-config-user': '1' }, body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
    }, { path: '/api/config-vault' + path, method, body });
    const login = id => call('/login', 'POST', { email: `${id}@example.test`, password: 'fake' });
    async function native(path, cookie, headers = {}, method = 'GET') {
        return new Promise((resolve, reject) => {
            const req = request(origin + '/api/config-vault' + path, { rejectUnauthorized: false, method, headers: { cookie, origin, ...headers } }, res => {
                const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
            }); req.on('error', reject); req.end();
        });
    }
    assert.equal((await call('/session')).status, 401);
    assert.equal((await login('1')).status, 200);
    let cookies = (await context.cookies()).filter(c => c.name === COOKIE);
    assert.equal(cookies.length, 1); assert.equal(cookies[0].path, '/api/config-vault');
    assert.ok(cookies[0].httpOnly && cookies[0].secure && cookies[0].sameSite === 'Strict');
    assert.equal(await page.evaluate(() => document.cookie), '');
    const token1 = cookies[0].value; const header1 = COOKIE + '=' + token1;
    assert.equal((await page.evaluate(() => fetch('/api/providers/probe').then(r => r.json()))).cookiePresent, true);
    assert.equal(providerCookieCount, 1);
    const taskCookie = (await context.cookies()).find(c => c.name === TASK_COOKIE);
    assert.equal(taskCookie.path, '/api/providers');
    assert.ok(taskCookie.httpOnly && taskCookie.secure && taskCookie.sameSite === 'Strict');
    assert.deepEqual(await page.evaluate(() => fetch('/api/providers/probe').then(r => r.json())), { cookiePresent: true, mainPresent: false });
    assert.deepEqual(await page.evaluate(() => fetch('/api/model-gateway/probe').then(r => r.json())), { cookiePresent: false, mainPresent: false });
    const checks = authChecks; await call('/session'); await call('/session'); assert.equal(authChecks, checks + 2);
    const bridge = await native('/session', TASK_COOKIE + '=' + token1); assert.equal(bridge.status, 200);
    assert.deepEqual(JSON.parse(bridge.body), { user: { id: '1', email: '1@example.test' } });
    assert.ok(!bridge.body.includes(token1)); assert.equal(bridge.headers['cache-control'], 'no-store');
    assert.equal((await native('/config', TASK_COOKIE + '=' + token1)).status, 401);
    const bridgeChecks = authChecks;
    await native('/session', TASK_COOKIE + '=' + token1);
    await native('/session', TASK_COOKIE + '=' + token1);
    assert.equal(authChecks, bridgeChecks + 2);
    assert.ok(bridge.headers['set-cookie'].some(c => c.includes('Path=/api;') && c.includes('Max-Age=0')));
    // Simulate a browser that only has the historical narrow-path cookie.
    await context.clearCookies();
    await context.addCookies([{ name: COOKIE, value: token1, domain: 'localhost', path: '/api/config-vault', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    assert.equal((await page.evaluate(() => fetch('/api/providers/probe').then(r => r.json()))).cookiePresent, false);
    assert.equal((await call('/session')).status, 200);
    cookies = (await context.cookies()).filter(c => c.name === COOKIE);
    assert.equal(cookies.length, 1); assert.equal(cookies[0].path, '/api/config-vault');
    assert.equal((await page.evaluate(() => fetch('/api/providers/probe').then(r => r.json()))).cookiePresent, true);
    // Same-name different paths must not silently choose one identity.
    await context.addCookies([{ name: COOKIE, value: token1, domain: 'localhost', path: '/api', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    assert.equal((await call('/session')).status, 401);
    assert.equal((await context.cookies()).filter(c => c.name === COOKIE).length, 0);
    // Restore old session then switch: the presented old session is invalidated server-side.
    await context.addCookies([{ name: COOKIE, value: token1, domain: 'localhost', path: '/api/config-vault', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    assert.equal((await login('2')).status, 200);
    assert.equal((await native('/session', header1)).status, 401);
    assert.equal((await native('/session', TASK_COOKIE + '=' + token1)).status, 401);
    assert.equal((await call('/session')).body.user.id, '2');
    const token2 = (await context.cookies()).find(c => c.name === COOKIE).value;
    assert.equal((await native('/session', COOKIE + '=' + token2, { origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await native('/logout', COOKIE + '=' + token2, { origin: '' }, 'POST')).status, 403);
    const cross = await context.newPage(); await cross.goto(`https://127.0.0.1:${port}`);
    await cross.evaluate(origin => fetch(origin + '/api/providers/probe', { mode: 'no-cors', credentials: 'include' }), origin);
    assert.equal(providerCookieCount, 0);
    const before = rejected;
    await cross.evaluate(origin => fetch(origin + '/api/config-vault/logout', { method: 'POST', mode: 'no-cors', credentials: 'include' }), origin);
    assert.equal(rejected, before + 1); assert.equal((await call('/session')).status, 200);
    // Actual cookie value is never forwarded to JAPI, and response/storage containment is checked without printing it.
    assert.ok(upstreamHeaders.every(keys => !keys.some(k => k.toLowerCase() === 'cookie')));
    assert.equal((await call('/logout', 'POST')).status, 200);
    assert.equal((await context.cookies()).filter(c => c.name === COOKIE).length, 0);
    assert.equal((await native('/session', COOKIE + '=' + token2)).status, 401);
    assert.equal((await native('/session', TASK_COOKIE + '=' + token2)).status, 401);
    assert.equal((await context.cookies()).filter(c => c.name === TASK_COOKIE).length, 0);
    assert.equal((await page.evaluate(() => fetch('/api/providers/probe').then(r => r.json()))).cookiePresent, false);
    await login('1');
    const token3 = (await context.cookies()).find(c => c.name === COOKIE).value;
    const upload = await call('/asset-library', 'POST', { scope: 'personal', name: 'test', mimeType: 'text/plain', data: 'eA==' }); assert.equal(upload.status, 200);
    assert.ok(!JSON.stringify(upload).includes(token3));
    const audit = await call('/asset-library/audit'); assert.ok(!JSON.stringify(audit).includes(token3));
    await Promise.allSettled([...active]);
    for (const name of await readdir(storeDir)) {
        if (!name.endsWith('.enc')) continue;
        const raw = await readFile(join(storeDir, name), 'utf8');
        assert.ok(!raw.includes(token3));
        assert.ok(!JSON.stringify(decrypt(raw, key)).includes(token3));
    }
    // Logout must revoke both different identities if old/new paths coexist.
    const secondContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const secondPage = await secondContext.newPage(); await secondPage.goto(origin);
    await secondPage.evaluate(() => fetch('/api/config-vault/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: '2@example.test', password: 'fake' }) }));
    const secondToken = (await secondContext.cookies()).find(c => c.name === COOKIE).value;
    await context.addCookies([{ name: COOKIE, value: secondToken, domain: 'localhost', path: '/api', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    assert.equal((await call('/logout', 'POST')).status, 200);
    assert.equal((await context.cookies()).filter(c => c.name === COOKIE).length, 0);
    assert.equal((await native('/session', COOKIE + '=' + token3)).status, 401);
    assert.equal((await native('/session', COOKIE + '=' + secondToken)).status, 401);
    await login('1'); disabled.add('1'); assert.equal((await call('/session')).status, 401);
});

