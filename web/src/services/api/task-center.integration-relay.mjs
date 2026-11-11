// Test-only relay process. All upstream traffic is constrained to the supplied loopback server.
import http from "node:http";
import { GptJobs, createGptJobHandler } from "../../../../provider-relay/gpt-jobs.mjs";
import { FalJobService, JsonJobStore, createFalJobHandler } from "../../../../provider-relay/job-service.mjs";
import { createProviderHandler } from "../../../../provider-relay/server.mjs";
import { createVaultSessionAuthenticator } from "../../../../provider-relay/job-auth.mjs";
const upstream = new URL(process.env.TASK_TEST_UPSTREAM);
if (upstream.hostname !== "127.0.0.1" || upstream.protocol !== "http:") throw new Error("Loopback test upstream required");
const key = Buffer.alloc(32, 73);
const gpt = new GptJobs({ path: process.env.TASK_TEST_STORE + ".gpt", baseUrl: upstream.href + "v1", queueKey: key, maxActive: 2, requireAccountOwnership: true });
const call = async (action, model, value, credential) => {
    const response = await fetch(new URL("fal/" + action, upstream), { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential }, body: JSON.stringify({ model, value }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Object.assign(new Error("Mock upstream failure"), { status: response.status });
    return response.json();
};
const fal = new FalJobService({
    requireAccountOwnership: true,
    store: new JsonJobStore(process.env.TASK_TEST_STORE),
    queueKey: key,
    maxActive: 2,
    maxPollRetries: 0,
    pollDelayMs: 10,
    provider: {
        submit: (m, body, auth) => call("submit", m, body, auth),
        status: (m, id, auth) => call("status", m, id, auth),
        result: (m, id, auth) => call("result", m, id, auth),
        cancel: (m, id, auth) => call("cancel", m, id, auth),
    },
});
let handler;
const server = http.createServer((req, res) =>
    handler(req, res, () => res.writeHead(404).end()).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
    }),
);
await new Promise((resolve) => server.listen(Number(process.env.TASK_TEST_PORT || 0), "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const authenticate = createVaultSessionAuthenticator({ origin, sessionUrl: new URL("api/config-vault/session", upstream).href });
handler = createProviderHandler({ origin, gptJobHandler: createGptJobHandler({ service: gpt, origin, authenticate }), jobHandler: createFalJobHandler({ service: fal, origin, authenticate }) });
await gpt.init();
await fal.init();
process.on("message", async (message) => {
    if (message === "snapshot") {
        await Promise.all([gpt.store.write, fal.store.write]);
        process.send({
            type: "snapshot",
            gpt: [...gpt.store.jobs.values()].map((j) => ({ id: j.id, status: j.status, queue: j.queueState, providerId: j.providerJobId })),
            fal: [...fal.store.jobs.values()].map((j) => ({ id: j.id, status: j.status, queue: j.queueState, providerId: j.providerJobId })),
        });
    }
});
process.send({ type: "ready", origin });
