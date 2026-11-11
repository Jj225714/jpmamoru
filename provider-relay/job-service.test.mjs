import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonJobStore, FalJobService, createFalJobHandler } from "./job-service.mjs";

async function setup(provider, path) {
  path ||= join(await mkdtemp(join(tmpdir(), "relay-jobs-")), "jobs.json");
  const store = new JsonJobStore(path);
  const service = new FalJobService({ store, provider, pollDelayMs: 0, sleepFn: async () => {} });
  await service.init();
  return { service, store, path };
}

async function settled(service, id) {
  const deadline = Date.now() + 5000;
  while (!['succeeded', 'failed', 'uncertain', 'canceled'].includes((await service.get(id, 'key', { resume: false })).status)) {
    assert.ok(Date.now() < deadline, 'job did not reach a terminal state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await service.store.write;
}

test("returns stable job id and deduplicates identical submissions", async () => {
  let submits = 0;
  const { service } = await setup({
    async submit() { submits++; return { request_id: "provider-1" }; },
    async status() { return { status: "COMPLETED" }; },
    async result() { return { images: [{ url: "https://fal.media/result.png" }] }; },
  });
  const first = await service.create({ model: "flux-fill", idempotencyKey: "same", credential: "key", payload: { image_url: "data" } });
  const second = await service.create({ model: "flux-fill", idempotencyKey: "same", credential: "key", payload: { image_url: "data" } });
  assert.equal(first.job_id, second.job_id);
  await settled(service, first.job_id);
  assert.equal(submits, 1);
  assert.equal((await service.get(first.job_id, "key")).status, "succeeded");
});

test("rejects idempotency reuse with different input", async () => {
  const { service } = await setup({ submit: async () => ({ request_id: "p" }), status: async () => ({ status: "COMPLETED" }), result: async () => ({}) });
  const job = await service.create({ model: "esrgan", idempotencyKey: "same", credential: "key", payload: { image_url: "a" } });
  await assert.rejects(() => service.create({ model: "esrgan", idempotencyKey: "same", credential: "key", payload: { image_url: "b" } }), { status: 409 });
  await settled(service, job.job_id);
});

test("does not retry ambiguous submit and persists uncertain state", async () => {
  const { service, path } = await setup({ submit: async () => { throw Object.assign(new Error("timeout"), { status: 504 }); }, status: async () => ({ status: "IN_PROGRESS" }) });
  const job = await service.create({ model: "qwen-layered", idempotencyKey: "once", credential: "key", payload: { image_url: "a" } });
  await settled(service, job.job_id);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved[0].id, job.job_id);
  assert.equal(saved[0].status, "uncertain");
  assert.equal((await service.get(job.job_id, "key")).status, "uncertain");
});

test("recovers a persisted provider job and retries transient status failures", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "relay-jobs-")), "jobs.json");
  const first = await setup({ submit: async () => ({ request_id: "provider-2" }), status: async () => ({ status: "COMPLETED" }), result: async () => ({}) }, path);
  const job = await first.service.create({ model: "flux-fill", idempotencyKey: "recover", credential: "key", payload: { image_url: "a" } });
  await settled(first.service, job.job_id);
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved[0].status = "running";
  saved[0].providerJobId = "provider-2";
  await writeFile(path, JSON.stringify(saved));
  const statuses = [Object.assign(new Error("busy"), { status: 503 }), { status: "COMPLETED" }];
  const second = await setup({
    async status() { const value = statuses.shift(); if (value instanceof Error) throw value; return value; },
    async result() { return { images: [{ url: "https://fal.media/result.png" }] }; },
  }, path);
  assert.equal((await second.service.get(job.job_id, "key", { resume: false })).status, "recoverable");
  await second.service.resume(job.job_id, "key");
  assert.equal((await second.service.get(job.job_id, "key", { resume: false })).status, "succeeded");
});

test("HTTP adapter exposes submit/status/cancel without changing legacy routes", async () => {
  const calls = [];
  const service = {
    async create(input) { calls.push(["create", input]); return { job_id: "stable-1", status: "queued" }; },
    async get(id) { calls.push(["get", id]); return { job_id: id, status: "running" }; },
    async cancel(id) { calls.push(["cancel", id]); return { job_id: id, status: "canceled" }; },
  };
  const handler = createFalJobHandler({ allowLegacyBearer: true, service, origin: "https://app.example" });
  const invoke = async (url, method, body, headers = {}) => {
    const req = { url, method, headers: { host: "app.example", origin: "https://app.example", authorization: "Bearer key", ...headers }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
    let result;
    const res = { writeHead(status) { result = { status }; }, end(data) { result.body = JSON.parse(data); } };
    assert.equal(await handler(req, res), true); return result;
  };
  assert.equal((await invoke("/api/providers/fal/jobs/flux-fill", "POST", "{}", { "idempotency-key": "k" })).status, 202);
  assert.equal((await invoke("/api/providers/fal/jobs/flux-fill/stable-1", "GET")).body.status, "running");
  assert.equal((await invoke("/api/providers/fal/jobs/flux-fill/stable-1", "POST", "", { "x-job-action": "cancel" })).body.status, "canceled");
  assert.deepEqual(calls.map(([kind]) => kind), ["create", "get", "cancel"]);
});

