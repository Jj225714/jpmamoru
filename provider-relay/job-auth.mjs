import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

const hash = value => createHash('sha256').update(value).digest('hex');
const fault = (status, code) => Object.assign(new Error(code), { status, code });
export function providerCredential(value) {
    if (typeof value === 'string') return value; // Explicit legacy/internal test API only.
    if (value?.version !== 'account-v1' || typeof value.principal !== 'string' || !value.principal || typeof value.key !== 'string') throw fault(401, 'account_authentication_required');
    return value.key;
}
export function credentialOwner(value) {
    const key = providerCredential(value);
    return typeof value === 'string' ? hash(key) : hash(JSON.stringify(['account-v1', value.principal, hash(key)]));
}
export function accountCredential(key, principal) {
    if (typeof principal !== 'string' || !principal || principal.length > 1024) throw fault(401, 'account_authentication_required');
    return Object.freeze({ version: 'account-v1', principal, key });
}
export function ownershipVersion(credential) { return typeof credential === 'string' ? 'bearer-v0' : 'account-v1'; }
export async function authenticateJob(req, key, { authenticate, allowLegacyBearer = false }) {
    if (authenticate) return accountCredential(key, await authenticate(req));
    if (allowLegacyBearer) return key; // Test/explicit historical adapter only; never wired by server.mjs.
    throw fault(503, 'account_authentication_unconfigured');
}

// Node fetch discards a custom Host in some supported runtimes. The vault checks
// the public Host while this connection targets a fixed private listener.
export function vaultSessionRequest(url, { headers, signal }) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.request(url, { method: 'GET', headers, signal }, response => {
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size > 16384) request.destroy(new Error('Session response too large')); else chunks.push(chunk); });
            response.on('error', reject);
            response.on('end', () => {
                try { const bytes = Buffer.concat(chunks); resolve(new Response(bytes.length ? bytes : null, { status: response.statusCode })); }
                catch { reject(new Error('Invalid session response')); }
            });
        });
        request.on('error', reject); request.end();
    });
}

/** Fixed trusted endpoint, no user-controlled URL, no redirect, no bearer forwarding, no caching. */
export function createVaultSessionAuthenticator({ sessionUrl, origin, cookieName = '__Secure-provider_tasks', fetchImpl = vaultSessionRequest, timeoutMs = 10000 }) {
    const site = new URL(origin), endpoint = new URL(sessionUrl);
    if (site.origin !== origin || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/config-vault/session' || !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error('Invalid task session verifier configuration');
    if (!/^__Secure-[A-Za-z0-9_-]{1,64}$/.test(cookieName) || cookieName === '__Secure-config_vault') throw new Error('A dedicated task session cookie is required');
    return async req => {
        const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(cookieName + '='));
        // Reject duplicate old/new-path cookies rather than choosing an attacker/stale value.
        if (cookies.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(cookies[0].slice(cookieName.length + 1))) throw fault(401, 'account_authentication_required');
        let response;
        try {
            response = await fetchImpl(endpoint, { method: 'GET', headers: { Host: site.host, Origin: site.origin, 'Sec-Fetch-Site': 'same-origin', Cookie: cookies[0] }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        } catch { throw fault(503, 'account_authentication_unavailable'); }
        if (!response.ok) { await response.body?.cancel(); throw fault([401, 403].includes(response.status) ? 401 : 503, 'account_authentication_failed'); }
        let data;
        try {
            let size = 0; const chunks = [];
            for await (const chunk of response.body) { size += chunk.length; if (size > 16384) throw Error(); chunks.push(chunk); }
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch { throw fault(503, 'account_authentication_unavailable'); }
        const id = data?.user?.id;
        if (!(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) || !/^[1-9][0-9]{0,19}$/.test(String(id))) throw fault(401, 'account_authentication_failed');
        // Client header is only a stale-session precondition, NEVER an identity source.
        // Authenticate first, then refuse if the browser's cookie has changed accounts.
        if (req.headers['x-task-user'] !== undefined && req.headers['x-task-user'] !== String(id)) throw fault(409, 'account_changed');
        // Stable across login sessions and devices, but bound to the configured identity authority.
        return JSON.stringify([site.origin, String(id)]);
    };
}

/** Read-only quarantine index. Never load legacy stores through JsonJobStore or dispatch their jobs. */
export async function loadLegacyIntentGuard(path, kind) {
    let rows;
    try { rows = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') rows = []; else throw new Error('Legacy task quarantine cannot be read'); }
    if (!Array.isArray(rows)) throw new Error('Invalid legacy task quarantine');
    if (!['gpt', 'fal'].includes(kind) || rows.some(j => !j || typeof j.id !== 'string' || (j.ownershipVersion && j.ownershipVersion !== 'bearer-v0') || (kind === 'gpt' ? !/^[a-f0-9]{64}$/.test(j.identity) : typeof j.key !== 'string' || !j.key || j.key.length > 512))) throw new Error('Unknown legacy identity schema requires review');
    const identities = new Set(rows.map(j => kind === 'gpt' ? j.identity : j.key));
    return (credential, key, model) => {
        const legacyOwner = hash(providerCredential(credential));
        const identity = kind === 'gpt' ? hash(legacyOwner + ':' + key) : `${legacyOwner}:${model}:${key}`;
        if (identities.has(identity)) throw fault(409, 'legacy_task_requires_review');
    };
}
