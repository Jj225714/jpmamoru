import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createMembershipService } from './membership-service.mjs';

async function fixture(t, quotaBytes = 20) {
    const storeDir = await mkdtemp(join(tmpdir(), 'membership-test-')); const key = randomBytes(32).toString('hex');
    await writeFile(join(storeDir, 'rules-admins.json'), '["3"]');
    const children = [];
    async function start() {
        const child = fork(new URL('./membership-test-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); children.push(child);
        const ready = once(child, 'message'); child.send({ storeDir, key, quotaBytes });
        const [{ port }] = await ready;
        const cookies = {};
        async function call(path, { id = '1', method = 'GET', data, raw = false, headers = {} } = {}) {
            return new Promise((resolve, reject) => {
                const req = request({ hostname: '127.0.0.1', port, path: '/api/config-vault' + path, method, headers: { host: 'vault.test', origin: 'https://vault.test', 'x-config-user': id, cookie: cookies[id] || '', 'content-type': 'application/json', ...headers } }, res => {
                    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const data = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, value: raw ? data : JSON.parse(data) }); });
                }); req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
            });
        }
        for (const id of ['1', '2', '3', '4']) { const result = await call('/login', { id, method: 'POST', data: { email: `${id}@example.test`, password: 'fake' } }); cookies[id] = result.headers['set-cookie'][0].split(';')[0]; }
        return { call, child };
    }
    const stop = async child => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.send({ stop: true }); await ended; } };
    t.after(async () => { for (const child of children) await stop(child); await rm(storeDir, { recursive: true, force: true }); });
    const first = await start(); const second = await start();
    return { ...first, second, start, stop, storeDir, key };
}
const membership = '/memberships';
async function team(call, id = '1', name = 'Team') {
    const r = await call(membership + '/teams', { id, method: 'POST', data: { name } }); assert.equal(r.status, 200); return r.value.team.id;
}
async function invite(call, teamId, targetId, role = 'write', id = '1') {
    const r = await call(`${membership}/teams/${teamId}/invitations`, { id, method: 'POST', data: { targetId, role } }); assert.equal(r.status, 200); return r.value.invitation;
}
async function joinTeam(call, teamId, targetId = '2', role = 'write', id = '1') {
    const invitation = await invite(call, teamId, targetId, role, id);
    assert.equal((await call(membership + '/invitations/accept', { id: targetId, method: 'POST', data: { token: invitation.token } })).status, 200);
}
const query = (scope, teamId, projectId) => '?' + new URLSearchParams({ scope, ...(teamId ? { teamId } : {}), ...(projectId ? { projectId } : {}) });
const upload = (call, target, scope = 'team', text = 'hello', id = '1') => call('/asset-library' + target, { id, method: 'POST', data: { scope, name: 'file', mimeType: 'text/plain', data: Buffer.from(text).toString('base64') } });


import { cleanAssetMetadata } from './asset-metadata.mjs';
import { decrypt, writeEncrypted } from './server.mjs';
const payload = (scope = 'personal', text = 'bytes', metadata = { version: 1, kind: 'original' }) => ({ scope, name: 'image.png', mimeType: 'image/png', data: Buffer.from(text).toString('base64'), metadata });
const migrate = (call, q = '', localId = 'old-1', options = {}) => call('/asset-library/migrations' + q, { method: 'POST', data: { ...payload(), localId }, ...options });
const generated = { version: 1, kind: 'generated', source: { taskId: 'task-1', nodeId: 'node-2', localId: 'old-1' }, generation: { version: 1, prompt: '白色背景，柔和光线', model: 'image-model-v1', parameters: { width: 1024, height: 1024, seed: 42, guidance: 7.5, quality: 'high' } } };

test('strict metadata schema, bounded text and parameter allowlist', () => {
    assert.deepEqual(cleanAssetMetadata(generated), generated);
    const r1 = '00000000-0000-4000-8000-000000000001';
    const r2 = '00000000-0000-4000-8000-000000000002';
    assert.deepEqual(cleanAssetMetadata({ kind: 'original', referenceIds: [r2, r1], version: 1 }), cleanAssetMetadata({ version: 1, kind: 'original', referenceIds: [r1, r2] }));
    const invalid = [
        { ...generated, url: 'https://example.test' },
        { ...generated, version: 2 }, { ...generated, kind: 'script' },
        { ...generated, source: { localId: '../bad' } },
        { ...generated, generation: { version: 1, apiKey: 'key' } },
        ...['https://example.test/x', 'data:text/plain,test', 'https:example.test', '//example.test', 'eval(1)', 'require(1)', '<script>alert(1)</script>', 'apiKey=abc', 'Bearer abc', 'sk-abcdefghijk', '\ud800', 'x'.repeat(4001)].map(prompt => ({ ...generated, generation: { version: 1, prompt } })),
        ...[{ seed: -1 }, { width: 99999 }, { count: 17 }, { callback: 'alert(1)' }, { modelUrl: 'http://a' }, { guidance: Infinity }, { steps: 0.5 }, { extra: { key: 'value' } }].map(parameters => ({ ...generated, generation: { version: 1, parameters } })),
        { ...generated, referenceIds: ['https://example.test'] },
        { ...generated, generation: { version: 1, prompt: '字'.repeat(4000) } },
    ];
    for (const value of invalid) assert.throws(() => cleanAssetMetadata(value), { status: 400 });
});

test('migration is atomic, concurrent and persistent; duplicate content preserves source variants', async t => {
    const f = await fixture(t, 20);
    const data = { ...payload('personal', 'bytes', generated), localId: 'old-1' };
    const both = await Promise.all([f.call, f.second.call].map(call => migrate(call, '', 'old-1', { data })));
    assert.ok(both.every(r => r.status === 200));
    assert.equal(both[0].value.asset.id, both[1].value.asset.id);
    assert.deepEqual(both.map(r => r.value.replayed).sort(), [false, true]);
    const id = both[0].value.asset.id;
    const metadata = { version: 1, kind: 'white-background', source: { localId: 'old-white' } };
    const white = await migrate(f.call, '', 'old-white', { data: { ...payload('personal', 'bytes', metadata), localId: 'old-white' } });
    assert.equal(white.value.asset.id, id); assert.equal(white.value.asset.metadataEntries.length, 2);
    assert.equal((await f.call('/asset-library/quota')).value.usedBytes, 5);
    assert.deepEqual((await f.call('/asset-library/audit')).value.events.map(e => e.action), ['create', 'migration.bind', 'metadata.append', 'migration.bind']);
    assert.equal((await migrate(f.call, '', 'old-1', { data: { ...data, data: Buffer.from('different').toString('base64') } })).status, 409);
    assert.equal((await migrate(f.call, '', 'old-1', { data: { ...data, metadata: { version: 1, kind: 'other' } } })).status, 409);
    await f.stop(f.child); const restart = await f.start();
    assert.equal((await restart.call('/asset-library/migrations/old-1')).value.mapping.assetId, id);
    assert.equal((await migrate(restart.call, '', 'old-1', { data })).value.replayed, true);
    assert.equal((await restart.call('/asset-library/migrations/old-1', { id: '2' })).status, 404);
    await restart.call(`/asset-library/${id}`, { method: 'DELETE' });
    assert.equal((await migrate(restart.call, '', 'old-1', { data })).status, 409);
    assert.ok((await restart.call('/asset-library/migrations/old-1')).value.asset.deletedAt);
});

test('same-scope references only, metadata size limits and failures never create migration mappings', async t => {
    const f = await fixture(t, 100);
    const original = (await f.call('/asset-library', { method: 'POST', data: payload() })).value.asset;
    assert.equal((await f.call('/asset-library', { method: 'POST', data: payload('personal', 'bytes', { version: 1, kind: 'original', referenceIds: [original.id] }) })).status, 400);
    const foreign = (await f.call('/asset-library', { id: '2', method: 'POST', data: payload() })).value.asset;
    const a = await team(f.call); const q = query('team', a);
    const shared = (await f.call('/asset-library' + q, { method: 'POST', data: payload('team') })).value.asset;
    for (const ref of [foreign.id, shared.id]) {
        const r = await migrate(f.call, '', 'bad-ref', { data: { ...payload('personal', 'new', { version: 1, kind: 'generated', referenceIds: [ref] }), localId: 'bad-ref' } });
        assert.equal(r.status, 404);
        assert.equal((await f.call('/asset-library/migrations/bad-ref')).status, 404);
    }
    const valid = await migrate(f.call, '', 'good', { data: { ...payload('personal', 'result', { version: 1, kind: 'generated', referenceIds: [original.id] }), localId: 'good' } });
    assert.equal(valid.status, 200);
    await f.call(`/asset-library/${original.id}`, { method: 'DELETE' });
    assert.equal((await migrate(f.call, '', 'good', { data: { ...payload('personal', 'result', { version: 1, kind: 'generated', referenceIds: [original.id] }), localId: 'good' } })).value.replayed, true);
    assert.equal((await migrate(f.call, '', 'bad-ref', { data: { ...payload('personal', 'new', { version: 1, kind: 'generated', referenceIds: [original.id] }), localId: 'bad-ref' } })).status, 404);
    const oversized = await migrate(f.call, '', 'too-big', { data: { ...payload('personal', 'x'.repeat(101)), localId: 'too-big' } });
    assert.equal(oversized.status, 413);
    assert.equal((await f.call('/asset-library/migrations/too-big')).status, 404);
    for (let i = 0; i < 31; i++) assert.equal((await f.call('/asset-library', { method: 'POST', data: payload('personal', 'result', { version: 1, kind: 'generated', source: { nodeId: `n-${i}` } }) })).status, 200);
    assert.equal((await migrate(f.call, '', 'limit', { data: { ...payload('personal', 'result', { version: 1, kind: 'other' }), localId: 'limit' } })).status, 413);
    assert.equal((await f.call('/asset-library/migrations/limit')).status, 404);
    assert.equal((await f.call(`/asset-library/${valid.value.asset.id}`)).value.asset.metadataEntries.length, 32);
});

test('migration ACL and mapping namespaces are isolated by actor/team/project', async t => {
    const f = await fixture(t, 100); const a = await team(f.call); const b = await team(f.call); await joinTeam(f.call, a, '2', 'read');
    const q = query('team', a); const qb = query('team', b);
    const data = { ...payload('team'), localId: 'same-old' };
    const first = await migrate(f.call, q, 'same-old', { data }); assert.equal(first.status, 200);
    assert.equal((await migrate(f.call, q, 'same-old', { id: '2', data })).status, 403);
    assert.equal((await f.call('/asset-library/migrations/same-old' + q, { id: '2' })).status, 404);
    assert.equal((await f.call('/asset-library/migrations/same-old' + q, { id: '3' })).status, 403);
    await f.call(`${membership}/teams/${a}/members/2`, { method: 'PUT', data: { role: 'write' } });
    const otherActor = await migrate(f.second.call, q, 'same-old', { id: '2', data });
    assert.equal(otherActor.status, 200); assert.equal(otherActor.value.asset.id, first.value.asset.id);
    assert.equal(otherActor.value.mapping.actorId, '2');
    const otherTeam = await migrate(f.call, qb, 'same-old', { data }); assert.notEqual(otherTeam.value.asset.id, first.value.asset.id);
    const p = (await f.call(`${membership}/teams/${a}/projects`, { method: 'POST', data: { name: 'P' } })).value.project.id;
    const qp = query('project', a, p);
    assert.equal((await migrate(f.call, qp, 'same-old', { id: '2', data: { ...data, scope: 'project' } })).status, 403);
    await f.call(`${membership}/teams/${a}/projects/${p}/members/2`, { method: 'PUT', data: { role: 'write' } });
    const project = await migrate(f.call, qp, 'same-old', { id: '2', data: { ...data, scope: 'project' } }); assert.equal(project.status, 200);
    assert.notEqual(project.value.asset.id, first.value.asset.id);
    const p2 = (await f.call(`${membership}/teams/${a}/projects`, { method: 'POST', data: { name: 'P2' } })).value.project.id;
    assert.equal((await migrate(f.call, query('project', a, p2), 'project-cross', { data: { ...payload('project', 'new', { version: 1, kind: 'generated', referenceIds: [project.value.asset.id] }), localId: 'project-cross' } })).status, 404);
    const badRef = { ...payload('project', 'new', { version: 1, kind: 'generated', referenceIds: [first.value.asset.id] }), localId: 'wrong-scope' };
    assert.equal((await migrate(f.call, qp, 'wrong-scope', { data: badRef })).status, 404);
    await f.call(`${membership}/teams/${a}/members/2`, { method: 'DELETE' });
    assert.equal((await f.second.call('/asset-library/migrations/same-old' + q, { id: '2' })).status, 403);
});

test('legacy snapshot without metadata or migrations is readable, appendable, and restart compatible', async t => {
    const f = await fixture(t, 100);
    const saved = await f.call('/asset-library', { method: 'POST', data: payload() }); const id = saved.value.asset.id;
    const path = join(f.storeDir, 'asset-library-user-1.enc'); const key = Buffer.from(f.key, 'hex');
    const legacy = decrypt(await readFile(path, 'utf8'), key);
    delete legacy.migrations; delete legacy.assets[0].metadataEntries;
    await writeEncrypted(path, legacy, key);
    assert.deepEqual((await f.call(`/asset-library/${id}`)).value.asset.metadataEntries, []);
    assert.equal((await f.call(`/asset-library/${id}/content`, { raw: true })).value.toString(), 'bytes');
    const migrated = await migrate(f.call); assert.equal(migrated.status, 200); assert.equal(migrated.value.asset.id, id);
    await f.stop(f.child); const restart = await f.start();
    assert.equal((await restart.call('/asset-library/migrations/old-1')).value.mapping.assetId, id);
});

import { createAssetService } from './asset-service.mjs';
test('pre-commit failure preserves snapshot and retry binds once without touching caller data', async t => {
    const storeDir = await mkdtemp(join(tmpdir(), 'asset-metadata-fault-')); t.after(() => rm(storeDir, { recursive: true, force: true }));
    let persisted = null; let broken = true;
    const service = createAssetService({ storeDir, read: async () => structuredClone(persisted), write: async (_, value) => { if (broken) throw new Error('disk full'); persisted = structuredClone(value); }, body: async req => structuredClone(req.input) });
    const local = { ...payload(), localId: 'keep-local' }; const before = structuredClone(local);
    const req = { method: 'POST', url: '/api/config-vault/asset-library/migrations', headers: { 'x-config-user': '1' }, input: local };
    const session = { user: { id: '1' } }; let reply;
    await assert.rejects(service.handle(req, {}, session, v => { reply = v; }));
    assert.equal(persisted, null); assert.equal(reply, undefined); assert.deepEqual(local, before);
    broken = false;
    await service.handle(req, {}, session, v => { reply = v; });
    assert.equal(persisted.assets.length, 1); assert.equal(persisted.migrations.length, 1);
    await service.handle(req, {}, session, v => { reply = v; });
    assert.equal(reply.replayed, true); assert.equal(persisted.audit.length, 2); assert.deepEqual(local, before);
});

test('conflicting cross-process migrations cannot overwrite an existing local-ID binding', async t => {
    const f = await fixture(t, 100);
    const candidates = await Promise.all([f.call, f.second.call].map((call, index) => migrate(call, '', 'collision', { data: { ...payload('personal', `bytes-${index}`), localId: 'collision' } })));
    assert.deepEqual(candidates.map(r => r.status).sort(), [200, 409]);
    const winner = candidates.find(r => r.status === 200).value.asset;
    assert.equal((await f.call('/asset-library/migrations/collision')).value.mapping.assetId, winner.id);
    assert.equal((await f.call('/asset-library')).value.assets.length, 1);
});



test('mapping count limit rejects new binding without commit', async t => {
    const storeDir = await mkdtemp(join(tmpdir(), 'asset-map-limit-')); t.after(() => rm(storeDir, { recursive: true, force: true }));
    const state = { version: 1, assets: [], audit: [], sequence: 0, migrations: Array.from({ length: 10000 }, (_, index) => ({ actorId: '1', localId: `old-${index}`, assetId: 'prior' })) };
    let committed = false;
    const service = createAssetService({ storeDir, read: async () => structuredClone(state), write: async () => { committed = true; }, body: async () => ({ ...payload(), localId: 'new-binding' }) });
    await assert.rejects(service.handle({ method: 'POST', url: '/api/config-vault/asset-library/migrations', headers: { 'x-config-user': '1' } }, {}, { user: { id: '1' } }, () => assert.fail('must not succeed')), { status: 413 });
    assert.equal(committed, false);
});

test('closed legacy model selector and requested size extensions preserve original values', () => {
    const metadata = (model, parameters = {}) => ({ version: 1, kind: 'generated', generation: { version: 1, model, parameters } });
    for (const model of ['bare-model', 'provider/model.v1', 'channel::model', 'channel-1::provider/model.v1', 'a::' + 'b'.repeat(125)]) {
        assert.equal(cleanAssetMetadata(metadata(model)).generation.model, model);
    }
    for (const model of ['', '::model', 'channel::', 'a::b::c', 'a:::b', 'a:b', 'a/b::model', 'channel::https://example.test', 'https://example.test', 'a::b//c', 'a::b\n', 'a\t::b', 'a::' + 'b'.repeat(126)]) {
        assert.throws(() => cleanAssetMetadata(metadata(model)), { status: 400 });
    }
    for (const requestedSize of ['auto', '1:1', '16:9', '10000:1', '1024x1024', '1x16384']) {
        const input = metadata('channel::model', { requestedSize, quality: 'auto', background: 'unspecified' });
        const cleaned = cleanAssetMetadata(input);
        assert.equal(cleaned.generation.parameters.requestedSize, requestedSize);
        assert.equal(cleaned.generation.parameters.width, undefined);
        assert.equal(cleaned.generation.parameters.height, undefined);
        assert.deepEqual(cleaned.generation.parameters, { quality: 'auto', background: 'unspecified', requestedSize });
    }
    for (const requestedSize of ['', 'AUTO', '0:1', '01:1', '1.2345:1', '10001:1', '16385x1', '1X1', '1×1', '1:1:1', '1x1\n', ' 1:1', 'http://a', 1024, { size: '1:1' }]) {
        assert.throws(() => cleanAssetMetadata(metadata('channel::model', { requestedSize })), { status: 400 });
    }
    for (const parameters of [{ size: '1:1' }, { background: '' }, { quality: 'custom' }, { channelId: 'admin' }, { url: 'https://example.test' }]) {
        assert.throws(() => cleanAssetMetadata(metadata('channel::model', parameters)), { status: 400 });
    }
});

test('default generated metadata migrates exactly once and legacy fingerprint is unchanged', async t => {
    const f = await fixture(t, 100);
    const legacyMetadata = { version: 1, kind: 'generated', generation: { version: 1, model: 'legacy/model-v1', parameters: { format: 'png', quality: 'high', width: 1024, height: 1024, background: 'white' } } };
    const old = await migrate(f.call, '', 'legacy-fingerprint', { data: { ...payload('personal', 'bytes', legacyMetadata), localId: 'legacy-fingerprint' } });
    assert.equal(old.status, 200);
    assert.equal(old.value.mapping.fingerprint, 'c5e51a9e8c7e792be87e9b5cb8d0ec0176bf9033c91ecf0afb2af2ef5d2904d7');
    const metadata = { version: 1, kind: 'generated', generation: { version: 1, model: 'channel::model', parameters: { requestedSize: '1:1', quality: 'auto', background: 'unspecified' } } };
    const data = { ...payload('personal', 'default-result', metadata), localId: 'defaults' };
    const results = await Promise.all([f.call, f.second.call].map(call => migrate(call, '', 'defaults', { data })));
    assert.ok(results.every(r => r.status === 200));
    assert.equal(results[0].value.asset.id, results[1].value.asset.id);
    assert.deepEqual(results.map(r => r.value.replayed).sort(), [false, true]);
    assert.equal(results[0].value.asset.metadataEntries[0].generation.model, 'channel::model');
    assert.deepEqual(results[0].value.asset.metadataEntries[0].generation.parameters, { quality: 'auto', background: 'unspecified', requestedSize: '1:1' });
    const reordered = { ...data, metadata: { ...metadata, generation: { parameters: { background: 'unspecified', quality: 'auto', requestedSize: '1:1' }, model: 'channel::model', version: 1 } } };
    assert.equal((await migrate(f.call, '', 'defaults', { data: reordered })).value.replayed, true);
    await f.stop(f.child); const restarted = await f.start();
    assert.equal((await migrate(restarted.call, '', 'defaults', { data })).value.replayed, true);
    assert.equal((await migrate(restarted.call, '', 'legacy-fingerprint', { data: { ...payload('personal', 'bytes', legacyMetadata), localId: 'legacy-fingerprint' } })).value.replayed, true);
    assert.equal((await restarted.call('/asset-library')).value.assets.length, 2);
});


test('decimal ratio and nanoid channel forms are closed, exact and unchanged in storage', () => {
    const input = (model, requestedSize) => ({ version: 1, kind: 'generated', generation: { version: 1, model, parameters: { requestedSize } } });
    for (const model of ['_abc::model', '-abc::provider/model', '_::model', '-::model']) {
        for (const size of ['1.9:1', '2.5:1', '1:2.5', '0.1:0.3', '0.3:0.1', '1.000:3.000', '3.000:1.000', '10000.000:10000', '0.001:0.003']) {
            const value = cleanAssetMetadata(input(model, size));
            assert.equal(value.generation.model, model);
            assert.equal(value.generation.parameters.requestedSize, size);
            assert.equal(value.generation.parameters.width, undefined);
        }
    }
    for (const size of ['0.1:0.301', '0.301:0.1', '3.001:1', '1:3.001', '0.0:1', '1:0.000', '.5:1', '1.:1', '01.9:1', '00.1:0.1', '+1.9:1', '-1.9:1', '1e0:1.0', '1.9e0:1', 'NaN:1.0', 'Infinity:1.0', '1.0000:1', '10000.001:10000', '10001.0:10001', '1.9 :1', '1.9:1\n', '1.9:\t1', '1.9:1:1', '1.9x1', 'https://1.9:1']) {
        assert.throws(() => cleanAssetMetadata(input('_abc::model', size)), { status: 400 });
    }
    for (const model of ['.abc::model', '_abc:::model', '_abc::model::extra', '_abc::', '_abc::https://model', '_abc/part::model', '-abc\n::model', '_abc::model\t', '_abc:model']) {
        assert.throws(() => cleanAssetMetadata(input(model, '1.9:1')), { status: 400 });
    }
    // Existing integer acceptance is unchanged; new bounds apply only to decimal ratio syntax.
    assert.equal(cleanAssetMetadata(input('legacy', '10000:1')).generation.parameters.requestedSize, '10000:1');
});

test('decimal ratio migration with nanoid selector replays across processes and restart', async t => {
    const f = await fixture(t, 100);
    const metadata = { version: 1, kind: 'generated', generation: { version: 1, model: '_channel-1::provider/model', parameters: { requestedSize: '1.9:1', quality: 'auto', background: 'unspecified' } } };
    const data = { ...payload('personal', 'decimal-result', metadata), localId: 'decimal-old' };
    const results = await Promise.all([f.call, f.second.call].map(call => migrate(call, '', 'decimal-old', { data })));
    assert.ok(results.every(r => r.status === 200));
    assert.equal(results[0].value.asset.id, results[1].value.asset.id);
    assert.deepEqual(results.map(r => r.value.replayed).sort(), [false, true]);
    assert.equal(results[0].value.asset.metadataEntries[0].generation.parameters.requestedSize, '1.9:1');
    const changedSpelling = { ...data, metadata: { ...metadata, generation: { ...metadata.generation, parameters: { ...metadata.generation.parameters, requestedSize: '1.90:1' } } } };
    assert.equal((await migrate(f.call, '', 'decimal-old', { data: changedSpelling })).status, 409);
    await f.stop(f.child); const restart = await f.start();
    assert.equal((await migrate(restart.call, '', 'decimal-old', { data })).value.replayed, true);
    assert.equal((await restart.call('/asset-library')).value.assets.length, 1);
});
