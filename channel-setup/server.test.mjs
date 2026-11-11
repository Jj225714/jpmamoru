import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { createSetupHandler } from "./server.mjs";

test("private setup checks authorization and expires after verified persistence", async () => {
    const config = { token: "test-capability", origin: "", expiresAt: Date.now() + 60000, channelFile: { channel: { apiKey: "test-private-key" } } };
    const receipts = [];
    const server = http.createServer(createSetupHandler(config, (r) => receipts.push(r)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    config.origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { Origin: config.origin, Authorization: "Bearer test-capability", "Content-Type": "application/json" };
    try {
        const request = (path, overrides = {}) => fetch(config.origin + "/api/channel-setup/" + path, { method: "POST", headers, ...overrides });
        assert.equal((await request("claim", { headers: { ...headers, Authorization: "Bearer wrong" } })).status, 401);
        assert.equal((await request("claim", { headers: { ...headers, Origin: "https://other.test" } })).status, 403);
        assert.equal((await request("claim", { method: "GET" })).status, 405);
        assert.deepEqual(await (await request("claim")).json(), config.channelFile);
        assert.equal((await request("complete", { body: JSON.stringify({ saved: true }) })).status, 400);
        assert.equal((await request("complete", { body: JSON.stringify({ saved: true, imageModel: "gpt-image-2", textModel: "gpt-5.5", keyHash: createHash("sha256").update("test-private-key").digest("hex") }) })).status, 204);
        assert.equal(receipts.length, 1);
        assert.equal((await request("claim")).status, 410);
        assert.equal((await request("complete")).status, 204);
        assert.equal(receipts.length, 1);
        assert.ok(!JSON.stringify(receipts).includes("test-private-key"));
        config.expiresAt = 0;
        assert.equal((await request("claim")).status, 410);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
