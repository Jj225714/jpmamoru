import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultHandler, encrypt, decrypt, writeEncrypted } from './server.mjs';

const config = { channels: [{ id: 'personal', name: 'Personal', baseUrl: 'https://example.com/v1', apiKey: 'SECRET-MODEL-KEY', apiFormat: 'openai', models: [{ name: 'gpt-image-2', capability: 'image' }] }], editorBindings: { edit: 'personal::gpt-image-2' }, proxyEnabled: true, proxyUrl: 'http://localhost:1234', managedPrincipalId: 'untrusted' };
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('encryption authenticates every record and uses random nonces', () => {
    const key = randomBytes(32); const one = encrypt(config, key); const two = encrypt(config, key);
    assert.notEqual(one, two); assert.ok(!one.includes('SECRET-MODEL-KEY')); assert.deepEqual(decrypt(one, key), config);
    const altered = JSON.parse(one); altered.tag = randomBytes(16).toString('base64');
    assert.throws(() => decrypt(JSON.stringify(altered), key)); assert.throws(() => decrypt(one, randomBytes(32)));
});

test('HTTP authentication, isolation, persistence, conflict, bootstrap and revocation', async t => {
    const storeDir = await mkdtemp(join(tmpdir(), 'config-vault-test-')); const key = randomBytes(32);
    const origin = 'https://vault.example'; const disabled = new Set(); let refreshCount = 0;
    const user = id => ({ id: Number(id), email: `${id}@example.com`, status: disabled.has(String(id)) ? 'disabled' : 'active' });
    const auth = id => ({ access_token: `token-${id}`, refresh_token: `refresh-${id}`, expires_in: 86400, user: user(id) });
    const upstream = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        let data;
        if (req.url === '/auth/login') { const input = JSON.parse(raw); if (input.password !== 'correct') { res.statusCode = 401; return res.end('{}'); } data = auth(input.email.split('@')[0]); }
        else if (req.url === '/auth/refresh') { refreshCount++; data = auth(JSON.parse(raw).refresh_token.split('-')[1]); }
        else { const id = req.headers.authorization?.split('-')[1]; if (!id) { res.statusCode = 401; return res.end('{}'); } data = user(id); }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data }));
    });
    const authBaseUrl = await listen(upstream);
    let server = createServer(createVaultHandler({ origin, authBaseUrl, storeDir, key })); let base = await listen(server);
    t.after(async () => { await close(server); await close(upstream); await rm(storeDir, { recursive: true, force: true }); });
    async function request(route, { method = 'GET', body, cookie, foreign = false, omitOrigin = false } = {}) {
        const headers = { host: 'vault.example', ...(omitOrigin ? {} : { origin: foreign ? 'https://evil.example' : origin }), ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) };
        return new Promise((resolve, reject) => {
            const req = httpRequest(base + '/api/config-vault' + route, { method, headers }, res => {
                let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => {
                    const rawCookie = res.headers['set-cookie']?.[0];
                    resolve({ status: res.statusCode, body: JSON.parse(raw), cookie: rawCookie?.split(';')[0], rawCookie });
                });
            });
            req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
        });
    }
    assert.equal((await request('/config')).status, 401);
    assert.equal((await request('/config', { foreign: true })).status, 403);
    assert.equal((await request('/config', { omitOrigin: true })).status, 403);
    const first = await request('/login', { method: 'POST', body: { email: '1@example.com', password: 'correct' } });
    assert.equal(first.status, 200); assert.match(first.rawCookie, /HttpOnly; Secure; SameSite=Strict/);
    const second = await request('/login', { method: 'POST', body: { email: '2@example.com', password: 'correct' } });
    const c1 = first.cookie; const c2 = second.cookie;
    assert.deepEqual((await request('/config', { cookie: c1 })).body, { revision: 0, config: null, savedAt: null });
    assert.equal((await request('/config', { method: 'PUT', cookie: c1, body: { revision: 0, config } })).status, 200);
    assert.equal((await request('/config', { method: 'PUT', cookie: c1, body: { revision: 0, config } })).status, 409);
    assert.equal((await request('/config', { cookie: c2 })).body.config, null);
    const saved = (await request('/config', { cookie: c1 })).body;
    assert.equal(saved.config.channels[0].apiKey, 'SECRET-MODEL-KEY'); assert.equal(saved.config.proxyEnabled, undefined); assert.equal(saved.config.managedPrincipalId, undefined);
    assert.deepEqual(saved.config.editorBindings, config.editorBindings);
    const concurrent = await Promise.all([1, 2].map(() => request('/config', { method: 'PUT', cookie: c1, body: { revision: 1, config } })));
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
    const invalid = { ...config, webdav: { password: 'never-store' } };
    assert.equal((await request('/config', { method: 'PUT', cookie: c1, body: { revision: 2, config: invalid } })).status, 400);
    for (const file of await readdir(storeDir)) { const raw = await readFile(join(storeDir, file), 'utf8'); assert.ok(!raw.includes('SECRET-MODEL-KEY')); assert.ok(!raw.includes('token-1')); }
    const record = decrypt(await readFile(join(storeDir, 'user-1.enc'), 'utf8'), key);
    assert.equal(record.source, 'browser'); assert.equal(record.channelCount, 1);
    await close(server); server = createServer(createVaultHandler({ origin, authBaseUrl, storeDir, key })); base = await listen(server);
    assert.equal((await request('/config', { cookie: c1 })).body.revision, 2);
    const sessionFile = join(storeDir, `session-${createHash('sha256').update(c1.split('=')[1]).digest('hex')}.enc`);
    const session = decrypt(await readFile(sessionFile, 'utf8'), key); session.tokenExpiresAt = 0; await writeEncrypted(sessionFile, session, key);
    assert.ok((await Promise.all([1, 2, 3].map(() => request('/session', { cookie: c1 })))).every(r => r.status === 200)); assert.equal(refreshCount, 1);
    const code = randomBytes(32).toString('base64url');
    const bootstrapPath = join(storeDir, `bootstrap-${createHash('sha256').update(code).digest('hex')}.enc`);
    await writeEncrypted(bootstrapPath, { expiresAt: Date.now() - 1000, auth: auth(1), revision: 2 }, key);
    assert.equal((await request('/bootstrap', { method: 'POST', body: { code } })).status, 401);
    await writeEncrypted(bootstrapPath, { expiresAt: Date.now() + 60000, auth: auth(1), revision: 2 }, key);
    const boots = await Promise.all([1, 2].map(() => request('/bootstrap', { method: 'POST', body: { code } })));
    assert.deepEqual(boots.map(r => r.status).sort(), [200, 401]); assert.equal(boots.find(r => r.status === 200).body.bootstrapRevision, 2);
    assert.equal((await request('/logout', { method: 'POST', cookie: c1 })).status, 200);
    assert.equal((await request('/session', { cookie: c1 })).status, 401);
    disabled.add('2'); assert.equal((await request('/session', { cookie: c2 })).status, 401);
    disabled.delete('2'); assert.equal((await request('/session', { cookie: c2 })).status, 401);
});
