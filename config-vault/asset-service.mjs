import { createHash, randomUUID } from 'node:crypto';
import { withStoreLock } from './asset-lock.mjs';
import { cleanAssetMetadata, validLocalId } from './asset-metadata.mjs';

const ROOT = '/api/config-vault/asset-library';
const fail = status => { throw Object.assign(new Error('Asset request failed'), { status }); };
const MAX_FILE = 20 * 1024 * 1024;
const publicAsset = ({ data, ...metadata }) => ({ ...metadata, metadataEntries: metadata.metadataEntries || [] });

export function createAssetService({ storeDir, read, write, body, memberships, quotaBytes = 100 * 1024 * 1024 }) {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new Error('Invalid asset quota');
    async function transaction(bucket, work) {
        const name = `asset-library-${bucket}`;
        return withStoreLock(storeDir, name, async () => {
            const state = await read(name) || { version: 1, assets: [], audit: [], sequence: 0 };
            if (state.version !== 1) fail(503);
            state.migrations ??= [];
            return await work(state, () => write(name, state));
        });
    }
    const used = state => state.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    const audit = (state, actor, action, id) => {
        state.audit.push({ sequence: ++state.sequence, actor, action, assetId: id, at: new Date().toISOString() });
        state.audit = state.audit.slice(-1000);
    };
    return { async handle(req, res, session, send) {
        const user = String(session.user.id);
        if (!/^[1-9][0-9]{0,19}$/.test(user)) fail(401);
        const url = new URL(req.url, 'http://local');
        for (const key of url.searchParams.keys()) {
            if (!['scope', 'trash', 'teamId', 'projectId'].includes(key) || url.searchParams.getAll(key).length !== 1) fail(400);
        }
        const scope = url.searchParams.get('scope') || 'personal';
        const teamId = url.searchParams.get('teamId') ?? undefined;
        const projectId = url.searchParams.get('projectId') ?? undefined;
        if (!['personal', 'team', 'project'].includes(scope)) fail(403);
        if (scope === 'personal' && (teamId !== undefined || projectId !== undefined)) fail(400);
        const target = { scope, teamId, projectId };
        if (scope !== 'personal' && (!memberships || !teamId || (scope === 'project' && !projectId))) fail(403);
        if (url.searchParams.has('trash') && !['true', 'false'].includes(url.searchParams.get('trash'))) fail(400);
        const suffix = url.pathname.slice(ROOT.length);
        const match = suffix.match(/^\/([0-9a-f-]{36})(?:\/(content|restore|thumbnail))?$/);
        const migrationMatch = suffix.match(/^\/migrations\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/);
        const migration = req.method === 'POST' && suffix === '/migrations';
        const uploading = req.method === 'POST' && (!suffix || migration);
        if (suffix && !['/quota', '/audit', '/migrations'].includes(suffix) && !match && !migrationMatch) fail(404);
        const mutation = ['POST', 'PUT', 'DELETE'].includes(req.method);
        if (mutation && String(req.headers['x-config-user'] || '') !== user) fail(409);
        let input;
        if (uploading) {
            input = await body(req, 28 * 1024 * 1024);
            if (input.scope !== scope) fail(403);
            if (Object.keys(input).some(k => !['scope', 'name', 'mimeType', 'data', 'metadata', ...(migration ? ['localId'] : [])].includes(k))) fail(400);
            if (migration && !validLocalId(input.localId)) fail(400);
            input.metadata = cleanAssetMetadata(input.metadata);
            if (migration && input.metadata.source?.localId !== undefined && input.metadata.source.localId !== input.localId) fail(400);
            if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 512 || /[\x00-\x1f\x7f]/.test(input.name)) fail(400);
            try { encodeURIComponent(input.name); } catch { fail(400); }
            if (typeof input.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(input.mimeType) || input.mimeType.length > 128) fail(400);
            if (typeof input.data !== 'string' || !input.data.length || input.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) fail(400);
            const bytes = Buffer.from(input.data, 'base64');
            if (bytes.toString('base64') !== input.data) fail(400);
            if (bytes.length > MAX_FILE) fail(413);
            input.bytes = bytes.length;
            input.sha256 = createHash('sha256').update(bytes).digest('hex');
        } else if (req.method === 'PUT' && match?.[2] === 'thumbnail') {
            input = await body(req, 1024);
            if (Object.keys(input).some(k => k !== 'thumbnailId') || !(input.thumbnailId === null || typeof input.thumbnailId === 'string')) fail(400);
        }
        const bucket = scope === 'personal' ? `user-${user}` : scope === 'team' ? `team-${teamId}` : `project-${projectId}`;
        const perform = () => transaction(bucket, async (state, commit) => {
            if (req.method === 'GET' && !suffix) return send({ assets: state.assets.filter(a => Boolean(a.deletedAt) === (url.searchParams.get('trash') === 'true')).map(publicAsset) });
            if (req.method === 'GET' && suffix === '/quota') return send({ ...target, limitBytes: quotaBytes, usedBytes: used(state), trashCounts: true, maxFileBytes: MAX_FILE, maxAssets: 1000 });
            if (req.method === 'GET' && suffix === '/audit') return send({ events: state.audit, lastSequence: state.sequence, retention: 1000 });
            if (req.method === 'GET' && migrationMatch) {
                const mapping = state.migrations.find(m => m.actorId === user && m.localId === migrationMatch[1]);
                if (!mapping) fail(404);
                const asset = state.assets.find(a => a.id === mapping.assetId);
                if (!asset) fail(503);
                return send({ mapping, asset: publicAsset(asset) });
            }
            if (uploading) {
                const fingerprint = createHash('sha256').update(JSON.stringify({ sha256: input.sha256, name: input.name, mimeType: input.mimeType, metadata: input.metadata })).digest('hex');
                const previous = migration && state.migrations.find(m => m.actorId === user && m.localId === input.localId);
                if (previous) {
                    if (previous.fingerprint !== fingerprint) fail(409);
                    const asset = state.assets.find(a => a.id === previous.assetId);
                    if (!asset) fail(503);
                    if (asset.deletedAt) fail(409);
                    return send({ mapping: previous, asset: publicAsset(asset), deduplicated: true, replayed: true });
                }
                // Validate references under the same scope lock as commit. Never resolve a global ID.
                for (const id of input.metadata.referenceIds || []) {
                    if (!state.assets.some(a => a.id === id && !a.deletedAt)) fail(404);
                }
                if (migration && state.migrations.length >= 10000) fail(413);
                const existing = state.assets.find(a => a.sha256 === input.sha256);
                if (existing?.deletedAt) fail(409);
                if (!existing && (used(state) + input.bytes > quotaBytes || state.assets.length >= 1000)) fail(413);
                const stamp = new Date().toISOString();
                const asset = existing || { id: randomUUID(), ownerId: user, ...target, name: input.name, mimeType: input.mimeType, bytes: input.bytes, sha256: input.sha256, createdAt: stamp, updatedAt: stamp, deletedAt: null, thumbnailId: null, data: input.data, metadataEntries: [] };
                const entries = asset.metadataEntries || [];
                const newMetadata = !entries.some(m => JSON.stringify(m) === JSON.stringify(input.metadata));
                if (newMetadata && entries.length >= 32) fail(413);
                if (input.metadata.referenceIds?.includes(asset.id)) fail(400);
                if (!existing) { state.assets.push(asset); audit(state, user, 'create', asset.id); }
                if (newMetadata) {
                    asset.metadataEntries = [...entries, input.metadata]; asset.updatedAt = stamp;
                    if (existing) audit(state, user, 'metadata.append', asset.id);
                }
                let mapping;
                if (migration) {
                    mapping = { actorId: user, localId: input.localId, assetId: asset.id, fingerprint, createdAt: stamp };
                    state.migrations.push(mapping); audit(state, user, 'migration.bind', asset.id);
                }
                if (!existing || newMetadata || migration) await commit();
                return send({ asset: publicAsset(asset), deduplicated: Boolean(existing), ...(mapping ? { mapping, replayed: false } : {}) });
            }
            const asset = match && state.assets.find(a => a.id === match[1]);
            if (!asset) fail(404);
            if (req.method === 'GET' && !match[2]) return send({ asset: publicAsset(asset) });
            if (req.method === 'GET' && match[2] === 'content') {
                if (asset.deletedAt) fail(404);
                // Untrusted MIME is metadata only; never serve uploaded HTML/SVG on the vault origin.
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(asset.name));
                res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
                res.setHeader('Content-Length', asset.bytes);
                return res.end(Buffer.from(asset.data, 'base64'));
            }
            let action;
            if (req.method === 'DELETE' && !match[2]) {
                if (asset.deletedAt) return send({ asset: publicAsset(asset) });
                asset.deletedAt = new Date().toISOString();
                for (const other of state.assets) if (other.thumbnailId === asset.id) { other.thumbnailId = null; other.updatedAt = asset.deletedAt; }
                action = 'trash';
            } else if (req.method === 'POST' && match[2] === 'restore') {
                if (!asset.deletedAt) return send({ asset: publicAsset(asset) });
                if (used(state) > quotaBytes) fail(413);
                asset.deletedAt = null; action = 'restore';
            } else if (req.method === 'PUT' && match[2] === 'thumbnail') {
                if (asset.deletedAt) fail(404);
                if (input.thumbnailId !== null) {
                    const thumbnail = state.assets.find(a => a.id === input.thumbnailId && !a.deletedAt);
                    if (!thumbnail || thumbnail.id === asset.id || !thumbnail.mimeType.startsWith('image/')) fail(404);
                }
                asset.thumbnailId = input.thumbnailId; action = 'thumbnail';
            } else fail(404);
            asset.updatedAt = new Date().toISOString(); audit(state, user, action, asset.id); await commit();
            return send({ asset: publicAsset(asset) });
        });
        return scope === 'personal' ? perform() : memberships.authorize(target, user, mutation, perform);
    } };
}
