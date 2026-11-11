import { nanoid } from "nanoid";

export type GptJobOperation = "generations" | "edits";
export type GptJobStatus = "queued" | "running" | "retrying" | "succeeded" | "failed" | "uncertain" | "canceled";
export type GptImageJobResult = { output_format?: string; data?: Array<{ b64_json?: string; url?: string; mime_type?: string }> };
export type GptJobIntent = { operation: GptJobOperation; body: Record<string, unknown>; idempotencyKey: string };
export type GptImageJob = { jobId: string; status: GptJobStatus; result?: GptImageJobResult | null; error?: { code?: string; message: string } | null };
export type JobSessionSnapshot = { accountId: string; channelId: string; revision: number };
/** Must read live state. revision increases on EVERY switch, including A -> B -> A. */
export type JobSessionGuard = () => JobSessionSnapshot | null;
export class JobSessionError extends Error {
    readonly preventResubmit = true;
    readonly retryable = false;
    constructor(readonly code: "session_guard_required" | "session_changed") {
        super(code === "session_guard_required" ? "任务调用缺少可信会话保护，请更新调用入口" : "账号或渠道已切换，已停止原任务请求；请勿重新生成");
        this.name = "JobSessionError";
    }
}
export function captureJobSession(options: { apiKey: string; sessionGuard?: JobSessionGuard }) {
    const read = options.sessionGuard;
    let initial: JobSessionSnapshot | null | undefined;
    try { initial = read?.(); } catch { throw new JobSessionError("session_guard_required"); }
    if (!read || !initial?.accountId || !initial.channelId || !Number.isSafeInteger(initial.revision)) throw new JobSessionError("session_guard_required");
    const snapshot = { ...initial }, key = options.apiKey;
    return { accountId: snapshot.accountId, assertCurrent() {
        let current: JobSessionSnapshot | null;
        try { current = read(); } catch { throw new JobSessionError("session_changed"); }
        if (!current || current.accountId !== snapshot.accountId || current.channelId !== snapshot.channelId || current.revision !== snapshot.revision || options.apiKey !== key) throw new JobSessionError("session_changed");
    } };
}
export type GptJobClientOptions = { apiKey: string; sessionGuard?: JobSessionGuard; fetch?: typeof globalThis.fetch; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> };
export type GptJobPollOptions = { signal?: AbortSignal; initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number; onUpdate?: (job: GptImageJob) => void | Promise<void>; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> };
export class GptJobApiError extends Error { readonly preventResubmit = true; readonly status?: number; readonly retryable?: boolean; constructor(message: string, options: { status?: number; retryable?: boolean } = {}) { super(message); this.name = "GptJobApiError"; this.status = options.status; this.retryable = options.retryable; } }

export function isGptImageJobEligible(config: { apiKey: string; baseUrl: string; model: string }, enabled: boolean) {
    if (!enabled || !/^gpt-image-/i.test(config.model.trim()) || !config.apiKey.trim()) return false;
    try {
        const url = new URL(config.baseUrl, typeof window === "undefined" ? "http://localhost" : window.location.origin);
        if (url.username || url.password || url.search || url.hash) return false;
        return (url.origin === "https://llm.zhitouzhuan.com" && /^\/(v1\/?)?$/.test(url.pathname))
            || (url.origin === (typeof window === "undefined" ? "http://localhost" : window.location.origin) && /^\/api\/model-gateway\/sub2api(\/v1)?\/?$/.test(url.pathname));
    } catch { return false; }
}

export async function submitGptImageJob(options: GptJobClientOptions, operation: GptJobOperation, body: Record<string, unknown>, idempotencyKey = nanoid()): Promise<{ job: GptImageJob; idempotencyKey: string }> {
    const session = captureJobSession(options);
    const serialized = JSON.stringify({ operation, body });
    for (let attempt = 0; ; attempt++) {
        try {
            const job = await requestJob(options, "/api/providers/gpt/jobs", { method: "POST", body: serialized, headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, expected: 202 }, session);
            session.assertCurrent();
            return { job, idempotencyKey };
        } catch (error) {
            session.assertCurrent();
            if (!(error instanceof GptJobApiError) || !error.retryable || attempt >= 4) throw error;
            await (options.sleep || delay)(Math.min(10_000, 1000 * 2 ** attempt));
            session.assertCurrent();
        }
    }
}

export function getGptImageJob(options: GptJobClientOptions, jobId: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) return Promise.reject(new GptJobApiError("无效的任务 ID"));
    return requestJob(options, `/api/providers/gpt/jobs/${encodeURIComponent(jobId)}`, { method: "GET", signal, expected: 200 });
}

export async function pollGptImageJob(options: GptJobClientOptions, jobId: string, poll: GptJobPollOptions = {}): Promise<GptImageJob> {
    const session = captureJobSession(options);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new GptJobApiError("无效的任务 ID");
    let delayMs = Math.max(0, poll.initialDelayMs ?? 1000);
    const maxDelayMs = Math.max(delayMs, poll.maxDelayMs ?? 10_000);
    const maxAttempts = Math.max(1, poll.maxAttempts ?? 60);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let job: GptImageJob;
        try { job = await requestJob(options, `/api/providers/gpt/jobs/${encodeURIComponent(jobId)}`, { method: "GET", signal: poll.signal, expected: 200 }, session); } catch (error) {
            session.assertCurrent();
            if (!(error instanceof GptJobApiError) || !error.retryable || attempt === maxAttempts - 1) throw error;
            await (poll.sleep || options.sleep || delay)(delayMs, poll.signal);
            session.assertCurrent();
            delayMs = Math.min(maxDelayMs, Math.max(1, delayMs * 2));
            continue;
        }
        session.assertCurrent();
        try { await poll.onUpdate?.(job); } finally { session.assertCurrent(); }
        if (["succeeded", "failed", "uncertain", "canceled"].includes(job.status)) return job;
        if (attempt === maxAttempts - 1) break;
        await (poll.sleep || options.sleep || delay)(delayMs, poll.signal);
        session.assertCurrent();
        delayMs = Math.min(maxDelayMs, Math.max(1, delayMs * 2));
    }
    throw new GptJobApiError("GPT 生图任务轮询超时", { retryable: true });
}

export function gptImageDataUrls(job: GptImageJob, outputFormat = "png") {
    const format = job.result?.output_format || outputFormat;
    const mime = format === "jpeg" || format === "jpg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
    return (job.result?.data || []).flatMap((item) => item.b64_json ? [`data:${item.mime_type || mime};base64,${item.b64_json}`] : item.url ? [item.url] : []);
}

async function requestJob(options: GptJobClientOptions, path: string, init: RequestInit & { expected: number }, session = captureJobSession(options)) {
    session.assertCurrent();
    const fetchImpl = options.fetch || globalThis.fetch;
    const { expected, ...requestInit } = init;
    let response: Response;
    try {
        // Fixed relative jobs paths only. Browser attaches the HttpOnly task cookie;
        // redirects cannot carry the request to an alternate service.
        response = await fetchImpl(path, { ...requestInit, cache: "no-store", credentials: "same-origin", redirect: "error", headers: { Authorization: `Bearer ${options.apiKey}`, ...(requestInit.headers || {}), "X-Task-User": session.accountId } });
        session.assertCurrent();
    } catch (error) {
        session.assertCurrent();
        if (init.signal?.aborted) throw error;
        throw new GptJobApiError("连接中断，请继续查询原任务，勿重新生成", { retryable: true });
    }
    const payload = await response.json().catch(() => null);
    session.assertCurrent();
    if (response.status === 409 && payload?.error?.code === "account_changed") throw new JobSessionError("session_changed");
    if (response.status !== expected || !payload) {
        const message = typeof payload?.error?.message === "string" ? payload.error.message : `GPT 任务请求失败（${response.status}）`;
        throw new GptJobApiError(message, { status: response.status, retryable: response.status >= 500 || response.status === 429 });
    }
    return normalizeJob(payload);
}

function normalizeJob(payload: unknown): GptImageJob {
    const value = payload && typeof payload === "object" ? payload as Record<string, any> : {};
    if (typeof value.job_id !== "string" || !["queued", "running", "retrying", "succeeded", "failed", "uncertain", "canceled"].includes(value.status)) throw new GptJobApiError("GPT 返回了无效的任务响应");
    return { jobId: value.job_id, status: value.status, result: value.result && typeof value.result === "object" ? value.result : null, error: value.error && typeof value.error === "object" && typeof value.error.message === "string" ? value.error : null };
}

function delay(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
    return new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("已取消", "AbortError")); }, { once: true }); });
}
