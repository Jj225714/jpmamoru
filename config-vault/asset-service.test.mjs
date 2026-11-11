import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultHandler } from './server.mjs';

async function fixture(t, quota = 12) {
    const storeDir = await mkdtemp(join(tmpdir(), 'asset-contract-'));
    const key = randomBytes(32); const disabled = new Set(); const servers = [];
    const fetchImpl = async (url, options) => {
        const id = url.endsWith('/auth/login') ? JSON.parse(options.body).email.split('@')[0] : options.headers.authorization.slice(7);
        const user = { id, email: `${id}@example.com`, status: disabled.has(id) ? 'disabled' : 'active' };
        return { ok: true, json: async () => ({ data: url.endsWith('/auth/login') ? { user, access_token: id, refresh_token: id, expires_in: 86400 } : user }) };
    };
    async function start() {
        const server = createServer(createVaultHandler({ origin: 'https://vault.example', authBaseUrl: 'https://auth.example', storeDir, key, fetchImpl, assetQuotaBytes: quota }));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
        return server;
    }
    let server = await start(); const cookies = {};
    const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    t.after(async () => { for (const s of servers) if (s.listening) await close(s); await rm(storeDir, { recursive: true, force: true }); });
    async function call(path = '', { id = '1', method = 'GET', data, raw = false, target = server, headers = {} } = {}) {
        return new Promise((resolve, reject) => {
            const req = request({ hostname: '127.0.0.1', port: target.address().port, path: '/api/config-vault' + path, method, headers: { host: 'vault.example', origin: 'https://vault.example', cookie: cookies[id] || '', 'x-config-user': id, 'content-type': 'application/json', ...headers } }, res => {
                const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    resolve({ status: res.statusCode, headers: res.headers, value: raw ? buffer : JSON.parse(buffer.toString()) });
                });
            }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
        });
    }
    for (const id of ['1', '2']) { const login = await call('/login', { id, method: 'POST', data: { email: `${id}@example.com`, password: 'test' } }); cookies[id] = login.headers['set-cookie'][0].split(';')[0]; }
    const api = (path = '', options) => call('/asset-library' + path, options);
    const upload = (text, options = {}) => api('', { method: 'POST', data: { scope: 'personal', name: 'asset.bin', mimeType: 'application/octet-stream', data: Buffer.from(text).toString('base64') }, ...options });
    return { api, call, upload, start, disabled, storeDir, restart: async () => { await close(server); server = await start(); } };
}

test('HTTP permission matrix, scoped dedup, recycle bin, audit and restart', async t => {
    const f = await fixture(t);
    const first = await f.upload('hello'); assert.equal(first.status, 200);
    const id = first.value.asset.id;
    assert.equal((await f.upload('hello')).value.asset.id, id);
    const other = await f.upload('hello', { id: '2' }); assert.notEqual(other.value.asset.id, id);
    for (const [path, method, data] of [[`/${id}`, 'GET'], [`/${id}/content`, 'GET'], [`/${id}`, 'DELETE'], [`/${id}/restore`, 'POST'], [`/${id}/thumbnail`, 'PUT', { thumbnailId: null }]]) {
        assert.equal((await f.api(path, { id: '2', method, data })).status, 404);
    }
    for (const scope of ['team', 'project', 'other']) {
        assert.equal((await f.api(`?scope=${scope}`)).status, 403);
        assert.equal((await f.upload('x', { data: { scope } })).status, 403);
    }
    assert.equal((await f.api('', { headers: { cookie: '' } })).status, 401);
    assert.equal((await f.upload('x', { headers: { 'x-config-user': '2' } })).status, 409);
    assert.equal((await f.upload('x', { headers: { origin: 'https://evil.example' } })).status, 403);
    const content = await f.api(`/${id}/content`, { raw: true }); assert.equal(content.value.toString(), 'hello'); assert.equal(content.headers['content-type'], 'application/octet-stream');
    assert.equal((await f.api(`/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await f.api()).value.assets.length, 0);
    assert.equal((await f.api('?trash=true')).value.assets[0].id, id);
    assert.equal((await f.api('/quota')).value.usedBytes, 5);
    assert.equal((await f.api(`/${id}/content`)).status, 404);
    assert.equal((await f.upload('hello')).status, 409);
    assert.equal((await f.api(`/${id}/restore`, { method: 'POST' })).status, 200);
    await f.restart();
    assert.equal((await f.api(`/${id}/content`, { raw: true })).value.toString(), 'hello');
    assert.deepEqual((await f.api('/audit')).value.events.map(e => e.action), ['create', 'trash', 'restore']);
    for (const name of await readdir(f.storeDir)) assert.ok(!(await readFile(join(f.storeDir, name), 'utf8')).includes('hello'));
    f.disabled.add('1'); assert.equal((await f.api()).status, 401);
});

test('quota race across independent handlers, duplicate race, trash charged and quota persisted', async t => {
    const f = await fixture(t, 8); const second = await f.start();
    const result = await Promise.all([f.upload('12345'), f.upload('67890', { target: second })]);
    assert.deepEqual(result.map(r => r.status).sort(), [200, 413]);
    const winner = result.find(r => r.status === 200).value.asset;
    assert.equal((await f.api('/quota')).value.usedBytes, 5);
    await f.api(`/${winner.id}`, { method: 'DELETE' });
    assert.equal((await f.upload('ABCD')).status, 413);
    await f.restart(); assert.equal((await f.api('/quota')).value.usedBytes, 5);
    const duplicate = await Promise.all([f.upload('xy'), f.upload('xy', { target: second })]);
    assert.ok(duplicate.every(r => r.status === 200)); assert.equal(duplicate[0].value.asset.id, duplicate[1].value.asset.id);
    assert.equal((await f.api('/quota')).value.usedBytes, 7);
});

test('thumbnail ownership, unlink on trash, validation and legacy personal attachment compatibility', async t => {
    const f = await fixture(t, 1000);
    const image = { scope: 'personal', name: 'tiny.gif', mimeType: 'image/gif', data: Buffer.from('GIF89aabcdefgh;').toString('base64') };
    const main = (await f.upload('main')).value.asset;
    const thumb = (await f.upload('', { data: image })).value.asset;
    const foreign = (await f.upload('', { id: '2', data: image })).value.asset;
    assert.equal((await f.api(`/${main.id}/thumbnail`, { method: 'PUT', data: { thumbnailId: foreign.id } })).status, 404);
    assert.equal((await f.api(`/${main.id}/thumbnail`, { method: 'PUT', data: { thumbnailId: thumb.id } })).status, 200);
    await f.api(`/${thumb.id}`, { method: 'DELETE' });
    assert.equal((await f.api(`/${main.id}`)).value.asset.thumbnailId, null);
    assert.equal((await f.upload('', { data: { ...image, ownerId: '2' } })).status, 400);
    assert.equal((await f.upload('', { data: { ...image, data: '!!!!' } })).status, 400);
    const legacy = await f.call('/assets', { method: 'POST', data: image }); assert.equal(legacy.status, 200);
    const legacyPath = legacy.value.url.slice('/api/config-vault'.length);
    assert.equal((await f.call(legacyPath, { raw: true })).value.toString(), 'GIF89aabcdefgh;');
    assert.equal((await f.call(legacyPath, { id: '2' })).status, 404);
});

test('orphan lock fails closed without modifying persisted assets', async t => {
    const f = await fixture(t);
    await f.upload('kept');
    const { mkdir, rmdir } = await import('node:fs/promises');
    const lock = join(f.storeDir, 'asset-library-user-1.lock');
    await mkdir(lock);
    assert.equal((await f.upload('new')).status, 503);
    await rmdir(lock);
    assert.equal((await f.api('/quota')).value.usedBytes, 4);
    assert.equal((await f.api()).value.assets.length, 1);
});

test('rejects malformed Unicode names before committing content', async t => {
    const f = await fixture(t);
    const result = await f.upload('x', { data: { scope: 'personal', name: '\ud800', mimeType: 'text/plain', data: 'eA==' } });
    assert.equal(result.status, 400);
    assert.equal((await f.api('/quota')).value.usedBytes, 0);
});
