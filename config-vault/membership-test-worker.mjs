// Dedicated child-process fixture; never connects to a real identity provider.
import { createServer } from 'node:http';
import { createVaultHandler } from './server.mjs';
import { join } from 'node:path';
let server;
const active = new Set();
process.on('message', async ({ storeDir, key, quotaBytes, stop }) => {
    if (stop) {
        await new Promise(resolve => server.close(resolve));
        await Promise.allSettled([...active]);
        process.exit(0);
    }
    const fetchImpl = async (url, options) => {
        const id = url.endsWith('/auth/login') ? JSON.parse(options.body).email.split('@')[0] : options.headers.authorization.slice(7);
        const user = { id, email: `${id}@example.test`, status: 'active' };
        return { ok: true, json: async () => ({ data: url.endsWith('/auth/login') ? { user, access_token: id, refresh_token: id, expires_in: 86400 } : user }) };
    };
    const handler = createVaultHandler({ origin: 'https://vault.test', authBaseUrl: 'https://mock.test', storeDir, key: Buffer.from(key, 'hex'), assetQuotaBytes: quotaBytes, fetchImpl, adminUsersFile: join(storeDir, 'rules-admins.json') });
    server = createServer((req, res) => {
        const work = handler(req, res); active.add(work);
        work.then(() => active.delete(work), () => active.delete(work));
    });
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
});
