// Test-only subprocess: real vault implementation and persistent temporary storage.
import { createServer } from 'node:http';
import { createVaultHandler } from '../../../../config-vault/server.mjs';
process.once('message', ({ origin, authBaseUrl, storeDir, key }) => {
    const server = createServer(createVaultHandler({origin, authBaseUrl, storeDir, key:Buffer.from(key,'hex'),assetQuotaBytes:1024}));
    process.on('disconnect',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
    server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
    process.on('message', async message => {
        if(message === 'stop') { server.closeAllConnections(); server.close(()=>process.exit(0)); }
    });
});
