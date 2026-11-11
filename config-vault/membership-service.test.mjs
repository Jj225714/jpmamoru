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
    return { ...first, second, start, stop, storeDir };
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

test('team sharing role matrix, targeted invitation replay, cross-team isolation and immediate revoke', async t => {
    const f = await fixture(t); const a = await team(f.call); const b = await team(f.call, '3'); const qa = query('team', a); const qb = query('team', b);
    const invitation = await invite(f.call, a, '2', 'read');
    assert.equal((await f.call(membership + '/invitations/accept', { id: '3', method: 'POST', data: { token: invitation.token } })).status, 403);
    const accepts = await Promise.all([f.call, f.second.call].map(call => call(membership + '/invitations/accept', { id: '2', method: 'POST', data: { token: invitation.token } })));
    assert.deepEqual(accepts.map(r => r.status).sort(), [200, 403]);
    const created = await upload(f.call, qa); assert.equal(created.status, 200); const id = created.value.asset.id;
    for (const path of ['', '/quota', '/audit', `/${id}`, `/${id}/content`]) {
        assert.equal((await f.second.call('/asset-library' + path + qa, { id: '2', raw: path.endsWith('/content') })).status, 200);
        assert.equal((await f.call('/asset-library' + path + qa, { id: '3' })).status, 403);
    }
    for (const [path, method, data] of [[`/${id}`, 'DELETE'], [`/${id}/restore`, 'POST'], [`/${id}/thumbnail`, 'PUT', { thumbnailId: null }]]) assert.equal((await f.call('/asset-library' + path + qa, { id: '2', method, data })).status, 403);
    assert.equal((await upload(f.call, qa, 'team', 'read-only', '2')).status, 403);
    assert.equal((await f.call(`/asset-library/${id}` + qb, { id: '3' })).status, 404);
    assert.equal((await f.call(`${membership}/teams/${a}/members/2`, { id: '2', method: 'PUT', data: { role: 'admin' } })).status, 403);
    assert.equal((await f.call(`${membership}/teams/${a}/members/1`, { method: 'DELETE' })).status, 409);
    assert.equal((await f.call(`${membership}/teams/${a}/members/2`, { method: 'PUT', data: { role: 'write' } })).status, 200);
    assert.equal((await upload(f.second.call, qa, 'team', 'written by 2', '2')).status, 200);
    assert.equal((await f.second.call(`/asset-library/${id}` + qa, { id: '2', method: 'DELETE' })).status, 200);
    assert.equal((await f.second.call(`/asset-library/${id}/restore` + qa, { id: '2', method: 'POST' })).status, 200);
    assert.equal((await f.call(`${membership}/teams/${a}/members/2`, { method: 'DELETE' })).status, 200);
    for (const call of [f.call, f.second.call]) {
        assert.equal((await call(`/asset-library/${id}/content` + qa, { id: '2' })).status, 403);
        assert.equal((await upload(call, qa, 'team', 'blocked', '2')).status, 403);
    }
    assert.equal((await f.call(membership, { id: '2' })).value.teams.length, 0);
});

test('project grants require current team membership, cap write, clear on removal, and survive restart', async t => {
    const f = await fixture(t); const a = await team(f.call); await joinTeam(f.call, a);
    const created = await f.call(`${membership}/teams/${a}/projects`, { method: 'POST', data: { name: 'Project' } }); assert.equal(created.status, 200);
    const p = created.value.project.id; const qp = query('project', a, p);
    const id = (await upload(f.call, qp, 'project')).value.asset.id;
    assert.equal((await f.call('/asset-library' + qp, { id: '2' })).status, 403);
    const grant = `${membership}/teams/${a}/projects/${p}/members/2`;
    assert.equal((await f.call(grant, { method: 'PUT', data: { role: 'read' } })).status, 200);
    assert.equal((await f.call(`/asset-library/${id}/content` + qp, { id: '2', raw: true })).value.toString(), 'hello');
    assert.equal((await upload(f.call, qp, 'project', 'no', '2')).status, 403);
    for (const [path, method, data] of [[`/${id}`, 'DELETE'], [`/${id}/restore`, 'POST'], [`/${id}/thumbnail`, 'PUT', { thumbnailId: null }]]) {
        assert.equal((await f.call('/asset-library' + path + qp, { id: '2', method, data })).status, 403);
    }
    assert.equal((await f.call(grant, { method: 'PUT', data: { role: 'write' } })).status, 200);
    assert.equal((await upload(f.call, qp, 'project', 'yes', '2')).status, 200);
    assert.equal((await f.call(`/asset-library/${id}` + qp, { id: '2', method: 'DELETE' })).status, 200);
    assert.equal((await f.call(`/asset-library/${id}/restore` + qp, { id: '2', method: 'POST' })).status, 200);
    await f.call(`${membership}/teams/${a}/members/2`, { method: 'PUT', data: { role: 'read' } });
    assert.equal((await upload(f.call, qp, 'project', 'no', '2')).status, 403);
    const otherTeam = await team(f.call, '1', 'Other');
    assert.equal((await f.call('/asset-library' + query('project', otherTeam, p))).status, 403);
    await f.stop(f.child); const restarted = await f.start();
    assert.equal((await restarted.call(`/asset-library/${id}/content` + qp, { id: '2', raw: true })).value.toString(), 'hello');
    assert.equal((await restarted.call(grant, { method: 'DELETE' })).status, 200);
    assert.equal((await f.second.call('/asset-library' + qp, { id: '2' })).status, 403);
    await restarted.call(grant, { method: 'PUT', data: { role: 'read' } });
    await restarted.call(`${membership}/teams/${a}/members/2`, { method: 'DELETE' });
    await joinTeam(restarted.call, a);
    assert.equal((await restarted.call('/asset-library' + qp, { id: '2' })).status, 403);
});

test('cross-process shared quota/dedup and personal/team/project quota isolation', async t => {
    const f = await fixture(t, 8); const a = await team(f.call); await joinTeam(f.call, a); const q = query('team', a);
    const uploads = await Promise.all([upload(f.call, q, 'team', '12345'), upload(f.second.call, q, 'team', '67890', '2')]);
    assert.deepEqual(uploads.map(r => r.status).sort(), [200, 413]);
    const duplicates = await Promise.all([upload(f.call, q, 'team', 'xy'), upload(f.second.call, q, 'team', 'xy', '2')]);
    assert.ok(duplicates.every(r => r.status === 200)); assert.equal(duplicates[0].value.asset.id, duplicates[1].value.asset.id);
    assert.equal((await f.call('/asset-library/quota' + q)).value.usedBytes, 7);
    assert.equal((await upload(f.call, '', 'personal', '12345678')).status, 200);
    const b = await team(f.call); assert.equal((await upload(f.call, query('team', b), 'team', '12345678')).status, 200);
    const p = (await f.call(`${membership}/teams/${a}/projects`, { method: 'POST', data: { name: 'P' } })).value.project.id;
    assert.equal((await upload(f.call, query('project', a, p), 'project', '12345678')).status, 200);
    const winner = uploads.find(r => r.status === 200).value.asset.id;
    await f.call(`/asset-library/${winner}` + q, { method: 'DELETE' });
    assert.equal((await upload(f.call, q, 'team', 'zzz')).status, 413);
    await f.stop(f.child); const restarted = await f.start();
    assert.equal((await restarted.call('/asset-library/quota' + q)).value.usedBytes, 7);
});

test('corrupt membership store fails closed while personal assets remain available', async t => {
    const f = await fixture(t); const a = await team(f.call); const q = query('team', a);
    await upload(f.call, q); const record = join(f.storeDir, 'asset-memberships-v1.enc'); const previous = await readFile(record);
    await writeFile(record, 'corrupt');
    assert.equal((await f.call('/asset-library' + q)).status, 503);
    assert.equal((await f.call('/memberships')).status, 503);
    assert.equal((await upload(f.call, '', 'personal', 'safe')).status, 200);
    await writeFile(record, previous);
    assert.equal((await f.call('/asset-library' + q)).status, 200);
});

test('expiration, invitation cancellation and issuer demotion invalidate acceptance', async t => {
    const storeDir = await mkdtemp(join(tmpdir(), 'membership-clock-')); t.after(() => rm(storeDir, { recursive: true, force: true }));
    let state = null; let now = 100000;
    const service = createMembershipService({ storeDir, read: async () => structuredClone(state), write: async (_, value) => { state = structuredClone(value); }, body: async req => req.input, now: () => now });
    async function call(path, { id = '1', method = 'POST', data } = {}) {
        let value;
        try { await service.handle({ url: membership.replace('/memberships', '/api/config-vault/memberships') + path, method, headers: { 'x-config-user': id }, input: data }, {}, { user: { id } }, v => { value = v; }); return { status: 200, value }; }
        catch (error) { return { status: error.status }; }
    }
    const a = (await call('/teams', { data: { name: 'T' } })).value.team.id;
    const expired = (await call(`/teams/${a}/invitations`, { data: { targetId: '2', role: 'write', ttlSeconds: 60 } })).value.invitation;
    now += 60000;
    assert.equal((await call('/invitations/accept', { id: '2', data: { token: expired.token } })).status, 403);
    const canceled = (await call(`/teams/${a}/invitations`, { data: { targetId: '2', role: 'write' } })).value.invitation;
    await call(`/teams/${a}/invitations/${canceled.id}`, { method: 'DELETE' });
    assert.equal((await call('/invitations/accept', { id: '2', data: { token: canceled.token } })).status, 403);
    const invite2 = (await call(`/teams/${a}/invitations`, { data: { targetId: '2', role: 'write' } })).value.invitation;
    await call('/invitations/accept', { id: '2', data: { token: invite2.token } });
    await call(`/teams/${a}/members/2`, { method: 'PUT', data: { role: 'admin' } });
    const pending = (await call(`/teams/${a}/invitations`, { data: { targetId: '3', role: 'write' } })).value.invitation;
    await call(`/teams/${a}/members/1`, { id: '2', method: 'PUT', data: { role: 'read' } });
    assert.equal((await call('/invitations/accept', { id: '3', data: { token: pending.token } })).status, 403);
    assert.ok(!JSON.stringify(state).includes(pending.token));
});

test('cross-process revoke races with writes without permitting any subsequent access', async t => {
    const f = await fixture(t, 100); const a = await team(f.call); await joinTeam(f.call, a); const q = query('team', a);
    const [removed, writing] = await Promise.all([
        f.call(`${membership}/teams/${a}/members/2`, { method: 'DELETE' }),
        upload(f.second.call, q, 'team', 'racing write', '2'),
    ]);
    assert.equal(removed.status, 200);
    assert.ok([200, 403].includes(writing.status));
    assert.equal((await upload(f.second.call, q, 'team', 'after revoke', '2')).status, 403);
    assert.equal((await f.second.call('/asset-library' + q, { id: '2' })).status, 403);
    const events = (await f.call('/asset-library/audit' + q)).value.events;
    assert.equal(events.length, writing.status === 200 ? 1 : 0);
});

test('pre-commit membership failure grants nothing and does not consume invitation', async t => {
    const storeDir = await mkdtemp(join(tmpdir(), 'membership-failure-')); t.after(() => rm(storeDir, { recursive: true, force: true }));
    let state = null; let broken = false;
    const service = createMembershipService({ storeDir, read: async () => structuredClone(state), write: async (_, value) => { if (broken) throw new Error('disk full'); state = structuredClone(value); }, body: async req => req.input });
    async function call(path, id, data) {
        let value;
        try { await service.handle({ url: '/api/config-vault/memberships' + path, method: 'POST', headers: { 'x-config-user': id }, input: data }, {}, { user: { id } }, v => { value = v; }); return { status: 200, value }; }
        catch (error) { return { status: error.status }; }
    }
    const a = (await call('/teams', '1', { name: 'T' })).value.team.id;
    const invitation = (await call(`/teams/${a}/invitations`, '1', { targetId: '2', role: 'write' })).value.invitation;
    broken = true;
    assert.equal((await call('/invitations/accept', '2', { token: invitation.token })).status, 503);
    await assert.rejects(service.authorize({ scope: 'team', teamId: a }, '2', false, () => assert.fail('must not authorize')), { status: 403 });
    broken = false;
    assert.equal((await call('/invitations/accept', '2', { token: invitation.token })).status, 200);
});

test('post-commit persistence error is indeterminate and membership reload reports committed authority', async t => {
    const storeDir = await mkdtemp(join(tmpdir(), 'membership-postcommit-')); t.after(() => rm(storeDir, { recursive: true, force: true }));
    let state = null; let failAfterCommit = false;
    const service = createMembershipService({ storeDir, read: async () => structuredClone(state), write: async (_, value) => { state = structuredClone(value); if (failAfterCommit) throw new Error('directory sync failed after rename'); }, body: async req => req.input });
    async function call(path, id, data, method = 'POST') {
        let value;
        try { await service.handle({ url: '/api/config-vault/memberships' + path, method, headers: { 'x-config-user': id }, input: data }, {}, { user: { id } }, v => { value = v; }); return { status: 200, value }; }
        catch (error) { return { status: error.status }; }
    }
    const a = (await call('/teams', '1', { name: 'T' })).value.team.id;
    const invitation = (await call(`/teams/${a}/invitations`, '1', { targetId: '2', role: 'read' })).value.invitation;
    failAfterCommit = true;
    assert.equal((await call('/invitations/accept', '2', { token: invitation.token })).status, 503);
    assert.equal((await call('', '2', undefined, 'GET')).value.teams[0].role, 'read');
    assert.equal((await call('/invitations/accept', '2', { token: invitation.token })).status, 403);
    await assert.rejects(service.authorize({ scope: 'team', teamId: a }, '3', false, () => assert.fail('foreign user')), { status: 403 });
});


