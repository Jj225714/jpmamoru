import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withStoreLock } from './asset-lock.mjs';

const ROOT = '/api/config-vault/memberships';
const RECORD = 'asset-memberships-v1';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const userId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const roles = ['read', 'write', 'admin'];
const fail = status => { throw Object.assign(new Error('Membership request failed'), { status }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const shape = (input, keys) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) fail(400); };
const title = value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) fail(400);
    try { encodeURIComponent(value); } catch { fail(400); }
    return value.trim();
};

export function createMembershipService({ storeDir, read, write, body, now = Date.now }) {
    async function transaction(work) {
        return withStoreLock(storeDir, RECORD, async () => {
            let state;
            try { state = await read(RECORD); } catch { fail(503); }
            if (state === null) state = { version: 1, teams: [], invitations: [], audit: [], sequence: 0 };
            if (!state || state.version !== 1 || !Array.isArray(state.teams) || !Array.isArray(state.invitations) || !Array.isArray(state.audit)) fail(503);
            return work(state, async () => { try { await write(RECORD, state); } catch { fail(503); } });
        });
    }
    const audit = (state, actor, action, teamId, targetId) => {
        state.audit.push({ sequence: ++state.sequence, actor, action, teamId, ...(targetId ? { targetId } : {}), at: new Date(now()).toISOString() });
        state.audit = state.audit.slice(-2000);
    };
    function teamFor(state, id, actor, admin = false) {
        const team = state.teams.find(t => t.id === id);
        const role = team?.members?.[actor];
        if (!team || !roles.includes(role) || (admin && role !== 'admin')) fail(403);
        return team;
    }
    function projectFor(team, id) {
        const project = team.projects.find(p => p.id === id);
        if (!project) fail(403);
        return project;
    }
    function effective(team, project, actor) {
        const role = team.members[actor];
        if (role === 'admin') return 'admin';
        if (!['read', 'write'].includes(role)) return null;
        if (!project) return role;
        const grant = project.members[actor];
        if (!['read', 'write'].includes(grant)) return null;
        return role === 'write' && grant === 'write' ? 'write' : 'read';
    }
    const summary = (team, actor) => ({
        id: team.id, name: team.name, role: team.members[actor],
        ...(team.members[actor] === 'admin' ? { members: team.members } : {}),
        projects: team.projects.filter(p => effective(team, p, actor)).map(p => ({ id: p.id, teamId: team.id, name: p.name, role: effective(team, p, actor), ...(team.members[actor] === 'admin' ? { members: p.members } : {}) })),
    });
    return {
        async authorize(target, actor, mutation, work) {
            if (!userId(actor)) fail(401);
            if (!['team', 'project'].includes(target.scope) || !uuid(target.teamId) || (target.scope === 'project' && !uuid(target.projectId)) || (target.scope === 'team' && target.projectId !== undefined)) fail(403);
            return transaction(async state => {
                const team = teamFor(state, target.teamId, actor);
                const project = target.scope === 'project' ? projectFor(team, target.projectId) : null;
                const role = effective(team, project, actor);
                if (!role || (mutation && role === 'read')) fail(403);
                // Lock remains held until the asset read/write and response are complete.
                return work();
            });
        },
        async handle(req, res, session, send) {
            const actor = String(session.user.id);
            if (!userId(actor)) fail(401);
            if (req.method !== 'GET' && String(req.headers['x-config-user'] || '') !== actor) fail(409);
            const url = new URL(req.url, 'http://local');
            if (url.search) fail(400);
            const route = url.pathname.slice(ROOT.length);
            const input = ['POST', 'PUT'].includes(req.method) ? await body(req, 8192) : null;
            return transaction(async (state, commit) => {
                if (req.method === 'GET' && route === '') return send({ teams: state.teams.filter(t => roles.includes(t.members[actor])).map(t => summary(t, actor)) });
                if (req.method === 'POST' && route === '/teams') {
                    shape(input, ['name']); const name = title(input.name);
                    if (state.teams.length >= 1000 || state.teams.filter(t => t.createdBy === actor).length >= 20) fail(413);
                    const team = { id: randomUUID(), name, createdBy: actor, members: { [actor]: 'admin' }, projects: [] };
                    state.teams.push(team); audit(state, actor, 'team.create', team.id); await commit();
                    return send({ team: summary(team, actor) });
                }
                if (req.method === 'POST' && route === '/invitations/accept') {
                    shape(input, ['token']);
                    if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) fail(400);
                    const invitation = state.invitations.find(i => i.tokenHash === digest(input.token));
                    if (!invitation || invitation.expiresAt <= now() || invitation.targetId !== actor) fail(403);
                    const team = state.teams.find(t => t.id === invitation.teamId);
                    if (!team || team.members[invitation.issuedBy] !== 'admin' || team.members[actor] || Object.keys(team.members).length >= 1000) fail(403);
                    team.members[actor] = invitation.role;
                    state.invitations = state.invitations.filter(i => i.id !== invitation.id);
                    audit(state, actor, 'invitation.accept', team.id, actor); await commit();
                    return send({ team: summary(team, actor) });
                }
                const match = route.match(/^\/teams\/([^/]+)(?:\/(.*))?$/);
                if (!match || !uuid(match[1])) fail(404);
                const team = teamFor(state, match[1], actor, true); const tail = match[2];
                if (req.method === 'GET' && tail === 'audit') return send({ events: state.audit.filter(e => e.teamId === team.id), retention: 2000 });
                if (req.method === 'POST' && tail === 'invitations') {
                    shape(input, ['targetId', 'role', 'ttlSeconds']);
                    const ttl = input.ttlSeconds ?? 3600;
                    if (!userId(input.targetId) || !['read', 'write'].includes(input.role) || !Number.isInteger(ttl) || ttl < 60 || ttl > 86400) fail(400);
                    if (team.members[input.targetId]) fail(409);
                    state.invitations = state.invitations.filter(i => i.expiresAt > now());
                    if (state.invitations.length >= 10000) fail(413);
                    const token = randomBytes(32).toString('base64url');
                    const invitation = { id: randomUUID(), teamId: team.id, targetId: input.targetId, role: input.role, issuedBy: actor, expiresAt: now() + ttl * 1000, tokenHash: digest(token) };
                    state.invitations.push(invitation); audit(state, actor, 'invitation.create', team.id, input.targetId); await commit();
                    return send({ invitation: { id: invitation.id, token, expiresAt: invitation.expiresAt, targetId: invitation.targetId, role: invitation.role } });
                }
                const cancel = tail?.match(/^invitations\/([^/]+)$/);
                if (req.method === 'DELETE' && cancel) {
                    const invitation = state.invitations.find(i => i.id === cancel[1] && i.teamId === team.id);
                    if (!invitation) fail(404);
                    state.invitations = state.invitations.filter(i => i !== invitation);
                    audit(state, actor, 'invitation.revoke', team.id, invitation.targetId); await commit(); return send({ ok: true });
                }
                const member = tail?.match(/^members\/([1-9][0-9]{0,19})$/);
                if (member && ['PUT', 'DELETE'].includes(req.method)) {
                    const target = member[1]; if (!roles.includes(team.members[target])) fail(404);
                    if (req.method === 'PUT') { shape(input, ['role']); if (!roles.includes(input.role)) fail(400); }
                    if (team.members[target] === 'admin' && (req.method === 'DELETE' || input.role !== 'admin') && Object.values(team.members).filter(r => r === 'admin').length === 1) fail(409);
                    if (req.method === 'DELETE') {
                        delete team.members[target];
                        for (const project of team.projects) delete project.members[target];
                    } else team.members[target] = input.role;
                    // Any authority change invalidates pending invitations by/to that account.
                    state.invitations = state.invitations.filter(i => i.teamId !== team.id || (i.issuedBy !== target && i.targetId !== target));
                    audit(state, actor, req.method === 'DELETE' ? 'member.remove' : 'member.role', team.id, target); await commit(); return send({ ok: true });
                }
                if (req.method === 'POST' && tail === 'projects') {
                    shape(input, ['name']); const name = title(input.name);
                    if (team.projects.length >= 100) fail(413);
                    const project = { id: randomUUID(), name, members: {} }; team.projects.push(project);
                    audit(state, actor, 'project.create', team.id, project.id); await commit(); return send({ project: { ...project, teamId: team.id } });
                }
                const projectMember = tail?.match(/^projects\/([^/]+)\/members\/([1-9][0-9]{0,19})$/);
                if (projectMember && ['PUT', 'DELETE'].includes(req.method)) {
                    const project = projectFor(team, projectMember[1]); const target = projectMember[2];
                    if (!roles.includes(team.members[target])) fail(403);
                    if (req.method === 'PUT') { shape(input, ['role']); if (!['read', 'write'].includes(input.role)) fail(400); project.members[target] = input.role; }
                    else delete project.members[target];
                    audit(state, actor, req.method === 'PUT' ? 'project.member.role' : 'project.member.remove', team.id, `${project.id}:${target}`); await commit(); return send({ ok: true });
                }
                fail(404);
            });
        },
    };
}
