import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, open } from "node:fs/promises";
import { dirname } from "node:path";
import { taskView, TaskLimits } from './task-contract.mjs';
import { listTasks } from './task-list.mjs';
import { QueueCipher } from './queue-crypto.mjs';
import { credentialOwner, providerCredential, ownershipVersion, authenticateJob } from './job-auth.mjs';

export const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "canceled", "uncertain"]);

function publicJob(job) {
  return {
    job_id: job.id,
    status: job.status,
    provider_job_id: job.providerJobId || null,
    error: job.error || null,
    result: job.result || null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    ...taskView(job),
  };
}

function ownerHash(credential) {
  return credentialOwner(credential);
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Small atomic JSON store. Caller credentials and input payloads are ciphertext only. */
export class JsonJobStore {
  constructor(path, { now = () => Date.now(), retentionMs = 7 * 86400000 } = {}) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new Error('Invalid retention period');
    this.retentionMs = retentionMs;
    this.path = path;
    this.now = now;
    this.jobs = new Map();
    this.loaded = false;
    this.write = Promise.resolve();
  }

  async load() {
    this.loading ||= this.loadOnce();
    return this.loading;
  }

  async loadOnce() {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      for (const job of Array.isArray(parsed) ? parsed : []) {
        if (job && typeof job.id === "string") this.jobs.set(job.id, job);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // A process restart cannot safely replay a paid submit. Jobs with a provider id
    // can be resumed by the caller; jobs without one are explicitly uncertain.
    for (const job of this.jobs.values()) {
      // Old terminal records receive a full retention window at migration.
      if (['succeeded', 'failed', 'canceled'].includes(job.status) && !Number.isFinite(job.finishedAt)) job.finishedAt = this.now();
      if (job.durableQueue && job.queueState === 'waiting' && job.status === 'queued' && job.sealed) continue;
      if (["queued", "running", "retrying", "recoverable"].includes(job.status)) {
        job.status = job.providerJobId ? "recoverable" : "uncertain";
        job.updatedAt = this.now();
        job.stage = job.status;
        if (job.status === 'uncertain') { job.finishedAt = job.updatedAt; delete job.sealed; }
      }
    }
    await this.flush();
    this.loaded = true;
  }

  async cleanup() {
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.cleanupOnce();
    try { return await this.cleaning; } finally { this.cleaning = null; }
  }

  async cleanupOnce() {
    // Durable queue identities are never recycled automatically. Results may expire.
    const archived = [...this.jobs.values()].filter(j => j.durableQueue && j.result && ['succeeded', 'failed', 'canceled'].includes(j.status) && j.finishedAt + this.retentionMs <= this.now());
    const expired = [...this.jobs.values()].filter(j => !j.durableQueue && ['succeeded', 'failed', 'canceled'].includes(j.status) && Number.isFinite(j.finishedAt) && j.finishedAt + this.retentionMs <= this.now());
    if (archived.length) { for (const job of archived) { job.result = null; job.resultExpired = true; } await this.flush(); }
    if (!expired.length) return 0;
    for (const job of expired) this.jobs.delete(job.id);
    try { await this.flush(); } catch (error) {
      for (const job of expired) if (!this.jobs.has(job.id)) this.jobs.set(job.id, job);
      throw error; // A failed write must not authorize a replacement paid submission.
    }
    return expired.length;
  }

  async flush() {
    const data = JSON.stringify([...this.jobs.values()]);
    this.write = this.write.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      let lastError;
      for (let attempt = 0; attempt < 6; attempt++) {
        try { await rename(temp, this.path); lastError = undefined; break; }
        catch (error) {
          lastError = error;
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        }
      }
      if (lastError) throw lastError;
      if (process.platform !== 'win32') { const dir = await open(dirname(this.path), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    });
    return this.write;
  }
}

function retryable(error) {
  return Boolean(error?.retryable || [408, 425, 429, 500, 502, 503, 504].includes(error?.status));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fal queue job coordinator. submit is intentionally never retried: after a network
 * break the provider may have accepted the paid request, so the job becomes uncertain.
 */
export class FalJobService {
  constructor({ store, provider, now = () => Date.now(), sleepFn = sleep, maxPollRetries = 3, pollDelayMs = 1200, maxActive = 2, modelLimits = {}, pollTimeoutMs = 540000, queueKey = null, maxQueueBytes = 128 * 1024 * 1024, requireAccountOwnership = false, legacyGuard } = {}) {
    if (!store || !provider) throw new TypeError("store and provider are required");
    this.store = store;
    this.provider = provider;
    this.now = now;
    this.sleep = sleepFn;
    this.maxPollRetries = maxPollRetries;
    this.pollDelayMs = pollDelayMs;
    this.limits = new TaskLimits(maxActive, modelLimits);
    this.workers = new Map();
    this.pollTimeoutMs = pollTimeoutMs;
    this.cipher = queueKey === null ? null : new QueueCipher(queueKey);
    if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < 1) throw new Error('Invalid queue byte limit');
    this.maxQueueBytes = maxQueueBytes;
    this.recovery = new Set();
    this.stopped = false; this.requireAccountOwnership = requireAccountOwnership; this.legacyGuard = legacyGuard;
  }

  async init() {
    this.initializing ||= this.store.load().then(() => {
      if (this.requireAccountOwnership && [...this.store.jobs.values()].some(j => j.ownershipVersion !== 'account-v1')) throw new Error('Legacy tasks require quarantine');
      for (const j of this.store.jobs.values()) if (j.durableQueue && j.status === 'recoverable' && j.providerJobId && j.sealed) this.recovery.add(j.id);
      this.schedule();
    });
    await this.initializing;
    await this.store.cleanup();
  }

  context(j) { return JSON.stringify(['fal', 'https://queue.fal.run', j.id, j.owner, j.key, j.model]); }

  schedule() {
    if (!this.cipher || this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.stopped) return;
      for (const j of this.store.jobs.values()) {
        const recovery = this.recovery.has(j.id) && j.status === 'recoverable' && j.providerJobId;
        const waiting = j.durableQueue && j.status === 'queued' && j.queueState === 'waiting' && !j.providerJobId;
        if ((!recovery && !waiting) || !j.sealed || this.workers.has(j.id)) continue;
        try { if (!this.limits.acquire(j.id, j.model)) continue; }
        catch (error) { if (error.status === 429) continue; this.stopped = true; return; }
        this.recovery.delete(j.id);
        j.status = 'running'; j.stage = recovery ? 'querying_provider' : 'submitting';
        if (!recovery) { j.queueState = 'submitting'; j.startedAt = this.now(); }
        j.updatedAt = this.now();
        this.track(j, () => this.dispatch(j, recovery));
      }
    });
  }

  async dispatch(j, recovery) {
    await this.store.flush();
    let data;
    try {
      data = this.cipher.open(j.sealed, this.context(j));
      if (ownerHash(data.credential) !== j.owner || (!recovery && fingerprint(data.payload) !== j.bodyHash)) throw new Error('Invalid queue binding');
    } catch {
      delete j.sealed;
      j.error = { code: 'queue_decryption_failed', message: 'Queue data cannot be safely decrypted; no upstream request was made.' };
      await this.update(j, recovery ? 'recoverable' : 'failed'); return;
    }
    if (recovery) { await this.poll(j, data.credential); return; }
    // Drop image/input data before network, retain only encrypted query credentials.
    j.sealed = this.cipher.seal({ credential: data.credential }, this.context(j));
    await this.store.flush();
    await this.run(j.id, data.credential, data.payload);
  }

  async list(credential, search = '', model) {
    await this.init();
    return listTasks(this.store, ownerHash(credential), search, model);
  }

  async create({ model, idempotencyKey, credential, payload }) {
    await this.init();
    if (this.requireAccountOwnership && ownershipVersion(credential) !== 'account-v1') throw Object.assign(new Error('account_authentication_required'), { status: 401 });
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(model) || !/^[A-Za-z0-9._~-]{1,200}$/.test(idempotencyKey)) {
      const error = new Error("invalid job identity"); error.status = 400; throw error;
    }
    const owner = ownerHash(credential);
    const key = `${owner}:${model}:${idempotencyKey}`;
    const bodyHash = fingerprint(payload);
    const existing = [...this.store.jobs.values()].find((job) => job.key === key);
    if (existing) {
      if (existing.bodyHash !== bodyHash) { const error = new Error("idempotency key was reused with different input"); error.status = 409; throw error; }
      await this.store.write;
      return publicJob(existing);
    }
    this.legacyGuard?.(credential, idempotencyKey, model);
    const now = this.now();
    const job = { id: randomUUID(), ownershipVersion: ownershipVersion(credential), key, owner, model, bodyHash, status: "queued", createdAt: now, updatedAt: now };
    if (this.store.jobs.size >= 1000) throw Object.assign(new Error('job_capacity'), { status: 429 });
    if (this.stopped) throw Object.assign(new Error('job_service_stopped'), { status: 503 });
    if (this.cipher) {
      Object.assign(job, { durableQueue: true, queueState: 'waiting', stage: 'waiting' });
      job.sealed = this.cipher.seal({ payload, credential }, this.context(job));
      const bytes = [...this.store.jobs.values()].reduce((n, j) => n + (j.sealed?.data.length || 0), job.sealed.data.length);
      if (bytes > this.maxQueueBytes) throw Object.assign(new Error('queue_bytes_capacity'), { status: 429 });
      this.store.jobs.set(job.id, job);
      try { await this.store.flush(); } catch (error) { this.stopped = true; throw error; }
      this.schedule(); return publicJob(job);
    }
    this.limits.acquire(job.id, model);
    this.store.jobs.set(job.id, job);
    try { await this.store.flush(); } catch (error) { this.limits.release(job.id); throw error; }
    // Keep payload and credential process-local only; neither is persisted.
    this.track(job, () => this.run(job.id, credential, payload));
    return publicJob(job);
  }

  async get(jobId, credential, { resume = true } = {}) {
    await this.init();
    const job = this.store.jobs.get(jobId);
    if (!job || job.owner !== ownerHash(credential)) { const error = new Error("job not found"); error.status = 404; throw error; }
    if (resume && job.status === "recoverable" && job.providerJobId) {
      // GET must remain readable even when recovery slots are full.
      this.resume(job.id, credential).catch(() => {});
    }
    return publicJob(job);
  }

  async cancel(jobId, credential) {
    await this.init();
    const job = this.store.jobs.get(jobId);
    if (!job || job.owner !== ownerHash(credential)) { const error = new Error("job not found"); error.status = 404; throw error; }
    if (job.durableQueue && job.queueState === 'waiting' && job.status === 'queued' && !job.providerJobId) {
      job.queueState = 'canceled';
      await this.update(job, 'canceled'); return publicJob(job);
    }
    if (TERMINAL_JOB_STATUSES.has(job.status) || !job.providerJobId) throw Object.assign(new Error('not_cancelable'), { status: 409 });
    if (job.cancelRequested) return publicJob(job);
    job.cancelRequested = true;
    try { await this.provider.cancel(job.model, job.providerJobId, providerCredential(credential)); }
    catch {
      job.cancelRequested = false;
      if (!TERMINAL_JOB_STATUSES.has(job.status)) job.error = { code: 'cancel_unconfirmed', message: 'Cancellation was not confirmed; query the existing job.' };
      await this.store.flush(); return publicJob(job);
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status)) { job.stage = 'cancel_requested'; job.updatedAt = this.now(); await this.store.flush(); }
    // A successful cancel HTTP response is a request acknowledgement, not a final state.
    return publicJob(job);
  }

  async resume(jobId, credential, { background = false } = {}) {
    await this.init();
    const job = this.store.jobs.get(jobId);
    if (!job || job.owner !== ownerHash(credential)) throw Object.assign(new Error('job not found'), { status: 404 });
    if (this.workers.has(job.id)) return background ? publicJob(job) : this.workers.get(job.id);
    if (!job.providerJobId || job.status !== 'recoverable') throw Object.assign(new Error('paid_resubmit_disabled'), { status: 409 });
    this.limits.acquire(job.id, job.model);
    this.recovery.delete(job.id);
    job.status = "running";
    job.stage = 'querying_provider'; job.error = null;
    job.updatedAt = this.now();
    const work = this.track(job, async () => { await this.store.flush(); await this.poll(job, credential); });
    return background ? publicJob(job) : work;
  }

  track(job, operation) {
    const work = Promise.resolve().then(operation).catch(() => {
      this.stopped = true;
      if (!TERMINAL_JOB_STATUSES.has(job.status)) {
        job.status = 'uncertain'; job.stage = 'uncertain'; job.finishedAt = this.now();
        job.error = { code: 'worker_failed', message: 'Task outcome cannot be confirmed.' };
      }
    }).finally(() => { this.workers.delete(job.id); this.limits.release(job.id); this.schedule(); });
    this.workers.set(job.id, work); return work;
  }

  async waitForIdle() {
    do { await new Promise(resolve => setImmediate(resolve)); await Promise.all([...this.workers.values()]); }
    while (this.workers.size || this.scheduled);
    await this.store.write;
  }

  async update(job, status, stage = status) {
    if (TERMINAL_JOB_STATUSES.has(job.status)) return;
    job.status = status; job.stage = stage; job.updatedAt = this.now();
    if (TERMINAL_JOB_STATUSES.has(status)) { job.finishedAt = job.updatedAt; delete job.sealed; }
    try { await this.store.flush(); } catch (error) { this.stopped = true; throw error; }
  }

  async run(jobId, credential, payload) {
    const job = this.store.jobs.get(jobId);
    if (!job || job.providerJobId || !(job.status === 'queued' || (job.durableQueue && job.queueState === 'submitting' && job.status === 'running'))) return;
    try {
      job.startedAt = this.now(); await this.update(job, 'running', 'submitting');
      const submitted = await this.provider.submit(job.model, payload, providerCredential(credential));
      if (!submitted || typeof submitted.request_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(submitted.request_id)) {
        return this.fail(job, "submit_uncertain", "provider returned an invalid job id");
      }
      job.providerJobId = submitted.request_id;
      job.status = "running";
      job.updatedAt = this.now();
      await this.store.flush();
      await this.poll(job, credential);
    } catch (error) {
      // A submit transport error is ambiguous: do not issue a second paid submit.
      return this.fail(job, "submit_uncertain", "provider acceptance is uncertain");
    }
  }

  async poll(job, credential) {
    let retries = 0;
    const deadline = this.now() + this.pollTimeoutMs;
    try {
      for (;;) {
        if (TERMINAL_JOB_STATUSES.has(job.status)) return;
        if (this.now() >= deadline) return this.fail(job, 'status_unavailable', 'Polling deadline reached; resume querying the same provider job.');
        let status;
        try {
          status = await this.provider.status(job.model, job.providerJobId, providerCredential(credential));
          retries = 0;
        } catch (error) {
          if (!retryable(error) || retries >= this.maxPollRetries) return this.fail(job, "status_unavailable", "provider status could not be confirmed");
          await this.sleep(this.pollDelayMs * 2 ** retries++);
          continue;
        }
        if (status?.status === "COMPLETED") {
          await this.update(job, 'running', 'collecting_result');
          let result;
          try { result = await this.provider.result(job.model, job.providerJobId, providerCredential(credential)); }
          catch (error) { return this.fail(job, retryable(error) ? "result_unavailable" : "result_failed", "provider result could not be retrieved"); }
          if (TERMINAL_JOB_STATUSES.has(job.status)) return;
          job.result = result; job.error = null; await this.update(job, 'succeeded'); return;
        }
        if (['CANCELED', 'CANCELLED'].includes(status?.status)) { job.error = null; await this.update(job, 'canceled'); return; }
        if (!["IN_QUEUE", "IN_PROGRESS"].includes(status?.status)) return this.fail(job, "provider_failed", "provider reported task failure");
        await this.update(job, status.status === 'IN_QUEUE' ? 'queued' : 'running', job.cancelRequested ? 'cancel_requested' : status.status === 'IN_QUEUE' ? 'provider_queue' : 'generating');
        await this.sleep(this.pollDelayMs);
      }
    } catch (error) {
      await this.fail(job, "poll_failed", "provider polling failed");
    }
  }

  async fail(job, code, message) {
    if (TERMINAL_JOB_STATUSES.has(job.status)) return publicJob(job);
    const recover = !!job.providerJobId && ['status_unavailable', 'result_unavailable', 'result_failed', 'poll_failed'].includes(code);
    job.error = { code, message };
    await this.update(job, recover ? 'recoverable' : code === 'submit_uncertain' ? 'uncertain' : 'failed');
    return publicJob(job);
  }
}

/** Optional HTTP adapter. Existing /submit and /requests routes remain unchanged. */
export function createFalJobHandler({ service, origin, authenticate, allowLegacyBearer = false }) {
  const allowed = /^\/api\/providers\/fal\/jobs\/(flux-fill|esrgan|qwen-layered)(?:\/([A-Za-z0-9_-]{1,100}))?$/;
  return async (req, res) => {
    const [pathname, search = ''] = (req.url || '').split('?');
    const match = allowed.exec(pathname);
    if (!match) return false;
    const fail = (status, message) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message } })); };
    if (origin && (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin) || (req.method === 'POST' && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])))) { fail(403, "请求来源不允许"); return true; }
    const auth = req.headers.authorization || "";
    if (!/^Bearer [A-Za-z0-9._~+/:=-]{1,512}$/.test(auth)) { fail(401, "请在渠道中填写有效 API Key"); return true; }
    let credential;
    try {
      credential = await authenticateJob(req, auth.slice(7), { authenticate, allowLegacyBearer });
      if (!match[2] && req.method === 'GET') {
        const result = await service.list(credential, search, match[1]);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); return true;
      }
      if (search) throw Object.assign(new Error('invalid_query'), { status: 400 });
      if (!match[2] && req.method === "POST") {
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string") { fail(400, "缺少 Idempotency-Key"); return true; }
        const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 48 * 1024 * 1024) throw Object.assign(new Error('payload_too_large'), { status: 413 }); chunks.push(chunk); }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await service.create({ model: match[1], idempotencyKey: key, credential, payload });
        res.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(result)); return true;
      }
      if (match[2] && req.method === "GET") {
        const result = await service.get(match[2], credential); res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(result)); return true;
      }
      if (match[2] && req.method === "POST" && (req.headers["x-job-action"] || "") === "cancel") {
        const result = await service.cancel(match[2], credential); res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(result)); return true;
      }
      if (match[2] && req.method === 'POST' && req.headers['x-job-action'] === 'retry') {
        await service.resume(match[2], credential, { background: true });
        const result = await service.get(match[2], credential, { resume: false });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); return true;
      }
      fail(405, "不支持的方法");
    } catch (error) { fail(error.status || 502, error.message || "任务服务不可用"); }
    return true;
  };
}

