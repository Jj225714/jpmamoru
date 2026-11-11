import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

// Same local-filesystem locking policy as personal assets. Never steal stale locks.
export async function withStoreLock(storeDir, name, work) {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const path = join(storeDir, `${name}.lock`);
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt++) {
        try { await mkdir(path, { mode: 0o700 }); acquired = true; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!acquired) throw Object.assign(new Error('Store busy'), { status: 503 });
    try { return await work(); } finally { await rmdir(path); }
}
