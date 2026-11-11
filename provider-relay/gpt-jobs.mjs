import { createHash, randomUUID } from 'node:crypto';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { JsonJobStore } from './job-service.mjs';
import { taskView, TaskLimits } from './task-contract.mjs';
import { listTasks } from './task-list.mjs';
import { QueueCipher } from './queue-crypto.mjs';
import { credentialOwner, providerCredential, ownershipVersion, authenticateJob } from './job-auth.mjs';

const PREFIX = '/api/providers/gpt/jobs';
const LIMIT = 48 * 1024 * 1024;
const TERMINAL = new Set(['succeeded', 'failed', 'uncertain', 'canceled']);
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const issue = (status, code) => Object.assign(new Error(code), { status, code });
const view = j => ({ job_id: j.id, status: j.status, result: j.result || null, error: j.error || null, ...taskView(j) });

function imageBytes(value) {
  const match = typeof value === 'string' && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw issue(400, 'invalid_image');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw issue(413, 'invalid_image_size');
  const mime = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (mime !== match[1]) throw issue(400, 'invalid_image');
  return { bytes, mime };
}

export function validateGptInput(input) {
  if (!input || !['generations', 'edits'].includes(input.operation) || Object.keys(input).some(k => !['operation', 'body'].includes(k))) throw issue(400, 'invalid_operation');
  const b = input.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw issue(400, 'invalid_body');
  const allowed = ['model', 'prompt', 'n', 'size', 'quality', 'background', 'output_format', 'output_compression', 'moderation'];
  if (input.operation === 'edits') allowed.push('images', 'mask', 'input_fidelity');
  if (Object.keys(b).some(k => !allowed.includes(k)) || !/^gpt-image-[a-zA-Z0-9.-]{1,64}$/.test(b.model) || typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 64000) throw issue(400, 'invalid_parameters');
  if (b.n !== undefined && (!Number.isInteger(b.n) || b.n < 1 || b.n > 10)) throw issue(400, 'invalid_count');
  for (const [key, values] of Object.entries({ quality: ['auto', 'low', 'medium', 'high'], background: ['auto', 'opaque', 'transparent'], output_format: ['png', 'jpeg', 'webp'], moderation: ['auto', 'low'], input_fidelity: ['low', 'high'] })) {
    if (b[key] !== undefined && !values.includes(b[key])) throw issue(400, 'invalid_parameters');
  }
  if (b.size !== undefined && (typeof b.size !== 'string' || !/^(auto|[1-9][0-9]{2,3}x[1-9][0-9]{2,3})$/.test(b.size))) throw issue(400, 'invalid_size');
  if (b.output_compression !== undefined && (!Number.isInteger(b.output_compression) || b.output_compression < 0 || b.output_compression > 100)) throw issue(400, 'invalid_compression');
  if (input.operation === 'edits') {
    if (!Array.isArray(b.images) || !b.images.length || b.images.length > 16) throw issue(400, 'invalid_images');
    b.images.forEach(imageBytes);
    if (b.mask !== undefined) imageBytes(b.mask);
  }
  return input;
}

// Result URLs are untrusted. Pin a public IPv4 DNS answer, prohibit redirects,
// strip credentials, enforce a hard timeout and a bounded raster response.
export async function downloadResult(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw issue(502, 'result_url_rejected');
  const addresses = await Promise.race([lookup(url.hostname, { family: 4, all: true }), new Promise((_, reject) => { const t = setTimeout(() => reject(issue(504, 'result_dns_timeout')), 5000); t.unref(); })]);
  const publicIP = address => {
    const [a, b] = address.split('.').map(Number);
    return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) && !(a === 198 && [18, 19].includes(b));
  };
  if (!addresses.length || addresses.some(a => !publicIP(a.address))) throw issue(502, 'result_url_rejected');
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal: AbortSignal.timeout(30000), lookup: (_host, options, callback) => options.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4) }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(issue(502, 'result_download_failed')); return; }
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 20 * 1024 * 1024) request.destroy(issue(502, 'result_too_large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const mime = String(response.headers['content-type'] || '').split(';')[0];
        const b64 = Buffer.concat(chunks).toString('base64');
        try { imageBytes(`data:${mime};base64,${b64}`); resolve({ b64, mime }); } catch { reject(issue(502, 'invalid_result_image')); }
      });
    });
    request.on('error', reject);
  });
}

async function boundedJson(response) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > LIMIT) throw issue(502, 'result_too_large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export class GptJobs {
  constructor({ path, baseUrl = process.env.GPT_IMAGE_UPSTREAM_BASE_URL || 'https://llm.zhitouzhuan.com/v1', maxActive = 2, modelLimits = {}, timeoutMs = 610000, retryDelayMs = 1000, allowLocalTest = false, queueKey = null, maxQueueBytes = 128 * 1024 * 1024, requireAccountOwnership = false, legacyGuard } = {}) {
    const url = new URL(baseUrl);
    const loopbackHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash) throw new Error('Invalid GPT upstream configuration');
    this.base = url.href.replace(/\/$/, ''); this.store = new JsonJobStore(path);
    this.active = new Set(); this.workers = new Set(); this.maxActive = maxActive; this.timeoutMs = timeoutMs; this.retryDelayMs = retryDelayMs;
    this.limits = new TaskLimits(maxActive, modelLimits);
    this.cipher = queueKey === null ? null : new QueueCipher(queueKey);
    if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < 1) throw new Error('Invalid queue byte limit');
    this.maxQueueBytes = maxQueueBytes;
    this.stopped = false; this.requireAccountOwnership = requireAccountOwnership; this.legacyGuard = legacyGuard;
  }
  context(j) { return JSON.stringify([j.id, j.owner, j.identity, this.base]); }
  async init() {
    this.initializing ||= this.store.load().then(() => { if (this.requireAccountOwnership && [...this.store.jobs.values()].some(j => j.ownershipVersion !== 'account-v1')) throw new Error('Legacy tasks require quarantine'); this.schedule(); });
    await this.initializing;
  }
  schedule() {
    if (!this.cipher || this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.stopped) return;
      for (const j of this.store.jobs.values()) {
        if (j.status !== 'queued' || j.queueState !== 'waiting' || !j.sealed) continue;
        try { if (!this.limits.acquire(j.id, j.model)) continue; }
        catch (error) { if (error.status === 429) continue; this.stopped = true; return; }
        // Claim synchronously: cancellation can win before this line, never after it.
        j.queueState = 'submitting'; j.status = 'running'; j.stage = 'submitting';
        j.startedAt = Date.now(); j.updatedAt = j.startedAt; this.active.add(j.id);
        this.track(j, () => this.dispatch(j));
      }
    });
  }
  track(j, operation) {
    const work = Promise.resolve().then(operation).catch(() => {
      this.stopped = true; // Fail closed on storage errors; no more paid dispatches.
      j.status = 'uncertain'; j.stage = 'uncertain'; j.finishedAt = Date.now();
      j.result = null; j.error = { code: 'job_store_unavailable', message: '任务状态写入失败，请勿重新付费提交' };
    }).finally(() => { this.active.delete(j.id); this.limits.release(j.id); this.workers.delete(work); this.schedule(); });
    this.workers.add(work);
  }
  async dispatch(j) {
    // No network before this fsync + atomic replacement has acknowledged intent.
    await this.store.flush();
    let data;
    try {
      data = this.cipher.open(j.sealed, this.context(j));
      validateGptInput(data.input);
      if (credentialOwner(data.credential) !== j.owner || hash(canonical(data.input)) !== j.fingerprint) throw new Error('Invalid queue binding');
    } catch {
      delete j.sealed;
      await this.change(j, 'failed', { code: 'queue_decryption_failed', message: '等待任务无法安全解密，未调用上游' }); return;
    }
    delete j.sealed; await this.store.flush();
    await this.run(j, data.input, data.credential);
  }
  async cancel(id, credential) {
    await this.init();
    const j = this.store.jobs.get(id);
    if (!j || j.owner !== credentialOwner(credential)) throw issue(404, 'job_not_found');
    if (!j.durableQueue || j.queueState !== 'waiting' || j.status !== 'queued') throw issue(409, 'not_cancelable');
    // No await between eligibility check and terminal transition.
    delete j.sealed; j.queueState = 'canceled';
    await this.change(j, 'canceled'); return view(j);
  }
  async create(input, credential, key) {
    validateGptInput(input);
    if (this.requireAccountOwnership && ownershipVersion(credential) !== 'account-v1') throw issue(401, 'account_authentication_required');
    if (typeof key !== 'string' || !/^[A-Za-z0-9._~-]{1,200}$/.test(key)) throw issue(400, 'invalid_idempotency_key');
    await this.init();
    await this.store.cleanup();
    const owner = credentialOwner(credential), identity = hash(owner + ':' + key), fingerprint = hash(canonical(input));
    const existing = [...this.store.jobs.values()].find(j => j.identity === identity);
    if (existing) { if (existing.fingerprint !== fingerprint) throw issue(409, 'idempotency_conflict'); await this.store.write; return view(existing); }
    this.legacyGuard?.(credential, key, input.body.model);
    if (this.stopped) throw issue(503, 'job_service_stopped');
    if (this.cipher) {
      if (this.store.jobs.size >= 1000) throw issue(429, 'job_capacity');
      const j = { id: randomUUID(), ownershipVersion: ownershipVersion(credential), owner, identity, fingerprint, model: input.body.model, status: 'queued', stage: 'waiting', queueState: 'waiting', durableQueue: true, createdAt: Date.now() };
      j.sealed = this.cipher.seal({ input, credential }, this.context(j));
      const bytes = [...this.store.jobs.values()].reduce((n, job) => n + (job.sealed?.data.length || 0), j.sealed.data.length);
      if (bytes > this.maxQueueBytes) throw issue(429, 'queue_bytes_capacity');
      this.store.jobs.set(j.id, j);
      try { await this.store.flush(); } catch { this.stopped = true; throw issue(503, 'job_store_unavailable'); }
      this.schedule(); return view(j);
    }
    if (this.active.size >= this.maxActive || this.store.jobs.size >= 1000) throw issue(429, 'job_capacity');
    const j = { id: randomUUID(), ownershipVersion: ownershipVersion(credential), owner, identity, fingerprint, model: input.body.model, status: 'queued', createdAt: Date.now() };
    this.limits.acquire(j.id, j.model);
    this.store.jobs.set(j.id, j); this.active.add(j.id);
    try { await this.store.flush(); } catch { this.active.delete(j.id); this.limits.release(j.id); throw issue(503, 'job_store_unavailable'); }
    const accepted = view(j);
    const work = this.run(j, input, credential).catch(() => {
      j.status = 'uncertain'; j.result = null; j.error = { code: 'job_store_unavailable', message: '任务状态写入失败，请勿重新付费提交' };
    }).finally(() => { this.active.delete(j.id); this.limits.release(j.id); this.workers.delete(work); });
    this.workers.add(work);
    return accepted;
  }
  async get(id, credential) {
    await this.init();
    await this.store.cleanup();
    const j = this.store.jobs.get(id);
    if (!j || j.owner !== credentialOwner(credential)) throw issue(404, 'job_not_found');
    return view(j);
  }
  async list(credential, search = '') {
    await this.init(); await this.store.cleanup();
    return listTasks(this.store, credentialOwner(credential), search);
  }
  async change(j, status, error = null, result = null) {
    if (TERMINAL.has(j.status)) return;
    Object.assign(j, { status, error, result, updatedAt: Date.now() });
    j.stage = status;
    if (status === 'running') j.startedAt ??= j.updatedAt;
    if (TERMINAL.has(status)) j.finishedAt = j.updatedAt;
    await this.store.flush();
  }
  async run(j, input, credential) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.change(j, 'running');
      let response;
      try {
        let body, headers = { Authorization: `Bearer ${providerCredential(credential)}` };
        if (input.operation === 'generations') { body = JSON.stringify(input.body); headers['Content-Type'] = 'application/json'; }
        else {
          body = new FormData();
          for (const [k, v] of Object.entries(input.body)) {
            if (k === 'images') v.forEach((data, i) => { const { bytes, mime } = imageBytes(data); body.append(v.length === 1 ? 'image' : 'image[]', new Blob([bytes], { type: mime }), `image-${i}.${mime.split('/')[1]}`); });
            else if (k === 'mask') { const { bytes, mime } = imageBytes(v); body.append('mask', new Blob([bytes], { type: mime }), 'mask.png'); }
            else body.append(k, String(v));
          }
        }
        response = await fetch(`${this.base}/images/${input.operation}`, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      } catch { await this.change(j, 'uncertain', { code: 'upstream_transport_uncertain', message: '上游是否受理无法确认，请勿重复提交' }); return; }
      if (response.status === 429 && attempt < 2) {
        const retry = response.headers.get('retry-after'); await response.body?.cancel();
        await this.change(j, 'retrying', { code: 'upstream_rate_limited', message: '上游限流，等待重试' });
        const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : this.retryDelayMs * 2 ** attempt;
        await new Promise(resolve => setTimeout(resolve, Math.min(60000, Math.max(this.retryDelayMs, delay)))); continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const definite = [400, 401, 403, 404, 413, 422, 429].includes(response.status);
        await this.change(j, definite ? 'failed' : 'uncertain', { code: `upstream_${response.status}`, message: definite ? '上游明确拒绝请求，请检查参数、密钥或额度' : '上游是否完成无法确认，请勿重复提交' }); return;
      }
      try {
        j.stage = 'collecting_result'; j.updatedAt = Date.now(); await this.store.flush();
        const data = await boundedJson(response);
        if (!Array.isArray(data.data) || !data.data.length || data.data.length > 10) throw new Error('Invalid result');
        const images = [];
        const requestedMime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[input.body.output_format || 'png'];
        for (const item of data.data) {
          const downloaded = typeof item.url === 'string' ? await downloadResult(item.url) : null;
          const b64 = item.b64_json || downloaded?.b64 || null;
          const mime = downloaded?.mime || item.mime_type || requestedMime;
          if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > 28 * 1024 * 1024) throw new Error('Invalid result');
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Invalid result MIME');
          images.push({ b64_json: b64, mime_type: mime });
        }
        await this.change(j, 'succeeded', null, { data: images, output_format: input.body.output_format || 'png' });
      } catch { await this.change(j, 'uncertain', { code: 'result_unavailable', message: '上游已响应，但结果无法可靠保存；请勿重复付费提交' }); }
      return;
    }
  }
}

export function createGptJobHandler({ service, origin, authenticate, allowLegacyBearer = false }) {
  const site = new URL(origin);
  let uploads = 0;
  return async (req, res) => {
    if (!req.url?.startsWith(PREFIX)) return false;
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
    let admitted = false;
    try {
      const [pathname, search = ''] = req.url.split('?');
      const match = /^\/api\/providers\/gpt\/jobs(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
      if (!match) throw issue(404, 'not_found');
      if (req.headers.host !== site.host || (req.headers.origin !== undefined && req.headers.origin !== site.origin) || (req.method === 'POST' && req.headers.origin !== site.origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) throw issue(403, 'origin_denied');
      if (!/^Bearer [A-Za-z0-9._~+/:=-]{1,512}$/.test(req.headers.authorization || '')) throw issue(401, 'authentication_required');
      const key = await authenticateJob(req, req.headers.authorization.slice(7), { authenticate, allowLegacyBearer });
      if (req.method === 'GET' && !match[1]) { reply(200, await service.list(key, search)); return true; }
      if (search) throw issue(400, 'invalid_query');
      if (req.method === 'GET' && match[1]) reply(200, await service.get(match[1], key));
      else if (req.method === 'POST' && match[1]) {
        await service.get(match[1], key); // Authenticate owner before reporting capabilities.
        if (req.headers['x-job-action'] === 'cancel') { reply(200, await service.cancel(match[1], key)); return true; }
        throw issue(409, req.headers['x-job-action'] === 'cancel' ? 'not_cancelable' : 'paid_resubmit_disabled');
      }
      else if (req.method === 'POST' && !match[1]) {
        if (uploads >= 4) throw issue(429, 'upload_capacity');
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) throw issue(400, 'invalid_content_type');
        if (Number(req.headers['content-length'] || 0) > LIMIT) throw issue(413, 'payload_too_large');
        uploads++; admitted = true;
        const timer = setTimeout(() => req.destroy(), 30000);
        let size = 0; const chunks = [];
        try { for await (const chunk of req) { size += chunk.length; if (size > LIMIT) throw issue(413, 'payload_too_large'); chunks.push(chunk); } } finally { clearTimeout(timer); }
        let input; try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw issue(400, 'invalid_json'); }
        reply(202, await service.create(input, key, req.headers['idempotency-key']));
      } else throw issue(405, 'method_not_allowed');
    } catch (error) { reply(error.status || 503, { error: { code: error.status ? error.code : 'job_service_unavailable', message: '任务请求未完成，请检查请求或稍后查询原任务' } }); }
    finally { if (admitted) uploads--; }
    return true;
  };
}
