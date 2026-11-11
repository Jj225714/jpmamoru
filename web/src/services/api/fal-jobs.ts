import { nanoid } from "nanoid";
import { captureJobSession, JobSessionError, type JobSessionGuard } from "./gpt-jobs";

export const FAL_JOB_MODELS = ["flux-fill", "esrgan", "qwen-layered"] as const;
export type FalJobModel = (typeof FAL_JOB_MODELS)[number];
export type FalJobStatus = "queued" | "running" | "recoverable" | "succeeded" | "failed" | "canceled" | "uncertain";

export type FalJobError = {
    code?: string;
    message: string;
    retryable?: boolean;
};

export type FalJobResult = {
    url?: string;
    image_url?: string;
    images?: Array<{ url?: string; b64_json?: string }>;
    [key: string]: unknown;
};

export type FalJob = {
    jobId: string;
    status: FalJobStatus;
    providerJobId?: string;
    result?: FalJobResult | null;
    error?: FalJobError | null;
    createdAt?: string;
    updatedAt?: string;
};

export type FalJobClientConfig = {
    apiKey: string;
    sessionGuard?: JobSessionGuard;
    /** Defaults to the current origin. Useful for tests or a same-origin proxy. */
    baseUrl?: string;
};

export type FalJobRequestOptions = {
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    idempotencyKey?: string;
};

export type FalJobPollOptions = FalJobRequestOptions & {
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
    maxAttempts?: number;
    onUpdate?: (job: FalJob) => void | Promise<void>;
    /** Injectable delay hook keeps polling tests deterministic; production uses the timer below. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export class FalJobApiError extends Error {
    readonly status?: number;
    readonly code?: string;
    readonly retryable?: boolean;

    constructor(message: string, options: { status?: number; code?: string; retryable?: boolean } = {}) {
        super(message);
        this.name = "FalJobApiError";
        this.status = options.status;
        this.code = options.code;
        this.retryable = options.retryable;
    }
}

export function createFalJobClient(config: FalJobClientConfig) {
    const request = (input: RequestInfo | URL, init?: RequestInit & { fetch?: typeof globalThis.fetch }) => requestFal(config, input, init);

    return {
        submit: (model: FalJobModel, payload: unknown, options?: FalJobRequestOptions) => submitFalJob(config, model, payload, options),
        get: (model: FalJobModel, jobId: string, options?: FalJobRequestOptions) => getFalJob(config, model, jobId, options),
        cancel: (model: FalJobModel, jobId: string, options?: FalJobRequestOptions) => cancelFalJob(config, model, jobId, options),
        poll: (model: FalJobModel, jobId: string, options?: FalJobPollOptions) => pollFalJob(config, model, jobId, options),
        request,
    };
}

export async function submitFalJob(config: FalJobClientConfig, model: FalJobModel, payload: unknown, options: FalJobRequestOptions = {}): Promise<FalJob> {
    const idempotencyKey = options.idempotencyKey || nanoid();
    return requestJob(config, model, undefined, {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        signal: options.signal,
        fetch: options.fetch,
        expectedStatuses: [202],
    });
}

export async function getFalJob(config: FalJobClientConfig, model: FalJobModel, jobId: string, options: FalJobRequestOptions = {}): Promise<FalJob> {
    return requestJob(config, model, jobId, { method: "GET", signal: options.signal, fetch: options.fetch, expectedStatuses: [200] });
}

export async function cancelFalJob(config: FalJobClientConfig, model: FalJobModel, jobId: string, options: FalJobRequestOptions = {}): Promise<FalJob> {
    return requestJob(config, model, jobId, { method: "POST", headers: { "X-Job-Action": "cancel" }, signal: options.signal, fetch: options.fetch, expectedStatuses: [200] });
}

export async function pollFalJob(config: FalJobClientConfig, model: FalJobModel, jobId: string, options: FalJobPollOptions = {}): Promise<FalJob> {
    const session = captureJobSession(config);
    const initialDelayMs = Math.max(0, options.initialDelayMs ?? 1000);
    const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 10_000);
    const backoffFactor = Math.max(1, options.backoffFactor ?? 2);
    const maxAttempts = Math.max(1, options.maxAttempts ?? 60);
    let delayMs = initialDelayMs;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const job = await requestJob(config, model, jobId, { method: "GET", signal: options.signal, fetch: options.fetch, expectedStatuses: [200] }, session);
        session.assertCurrent();
        try { await options.onUpdate?.(job); } finally { session.assertCurrent(); }
        if (isFalJobTerminal(job.status)) return job;
        if (attempt === maxAttempts - 1) break;
        await (options.sleep || delay)(delayMs, options.signal);
        session.assertCurrent();
        delayMs = Math.min(maxDelayMs, Math.max(1, delayMs * backoffFactor));
    }
    throw new FalJobApiError("Fal 任务轮询超时", { code: "poll_timeout", retryable: true });
}

export function isFalJobTerminal(status: FalJobStatus) {
    return status === "succeeded" || status === "failed" || status === "canceled" || status === "uncertain";
}

export function falJobResultUrl(job: FalJob) {
    const result = job.result;
    if (!result) return undefined;
    if (typeof result.url === "string" && result.url) return result.url;
    if (typeof result.image_url === "string" && result.image_url) return result.image_url;
    const image = Array.isArray(result.images) ? result.images[0] : undefined;
    if (typeof image?.url === "string" && image.url) return image.url;
    if (typeof image?.b64_json === "string" && image.b64_json) return `data:image/png;base64,${image.b64_json}`;
    return undefined;
}

async function requestFal(config: FalJobClientConfig, input: RequestInfo | URL, init: RequestInit & { fetch?: typeof globalThis.fetch } = {}, session?: ReturnType<typeof captureJobSession>) {
    const fetchImpl = init.fetch || globalThis.fetch;
    const { fetch: _fetch, ...requestInit } = init;
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    let sameOriginJob = false;
    try {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin);
        const isJob = /^\/api\/providers\/fal\/jobs\/(flux-fill|esrgan|qwen-layered)(?:\/[A-Za-z0-9_-]{1,100})?$/.test(url.pathname);
        if (isJob && (url.origin !== origin || url.username || url.password)) throw new FalJobApiError("任务地址必须与页面同源", { code: "invalid_job_origin" });
        sameOriginJob = isJob && url.origin === origin;
    } catch (error) { if (error instanceof FalJobApiError) throw error; throw new FalJobApiError("无效的任务地址", { code: "invalid_job_url" }); }
    if (sameOriginJob) { session ??= captureJobSession(config); session.assertCurrent(); }
    // Preserve the generic request API, but cookies are only enabled for the
    // exact same-origin jobs namespace. Never forward caller-supplied cookies.
    const headers: Record<string, string> = {};
    new Headers(requestInit.headers).forEach((value, name) => {
        if (!["cookie", "cookie2", "authorization", "x-task-user"].includes(name)) headers[name === "x-job-action" ? "X-Job-Action" : name === "idempotency-key" ? "Idempotency-Key" : name === "content-type" ? "Content-Type" : name] = value;
    });
    headers.Authorization = `Bearer ${config.apiKey}`;
    if (sameOriginJob && session) headers["X-Task-User"] = session.accountId;
    try { const response = await fetchImpl(input, {
        ...requestInit,
        credentials: sameOriginJob ? "same-origin" : "omit",
        redirect: "error",
        cache: "no-store",
        headers,
    }); session?.assertCurrent(); return response; }
    catch (error) { session?.assertCurrent(); throw error; }
}

async function requestJob(config: FalJobClientConfig, model: FalJobModel, jobId: string | undefined, options: { method: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal; fetch?: typeof globalThis.fetch; expectedStatuses: number[] }, session = captureJobSession(config)) {
    session.assertCurrent();
    if (!FAL_JOB_MODELS.includes(model) || (jobId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(jobId))) throw new FalJobApiError("无效的任务标识", { code: "invalid_job_identity" });
    const path = `/api/providers/fal/jobs/${model}${jobId ? `/${encodeURIComponent(jobId)}` : ""}`;
    const baseUrl = (config.baseUrl || "").replace(/\/$/, "");
    const response = await requestFal(config, `${baseUrl}${path}`, { method: options.method, body: options.body, headers: options.headers, signal: options.signal, fetch: options.fetch }, session);
    const payload = await response.json().catch(() => null);
    session.assertCurrent();
    if (response.status === 409 && (payload?.error?.code === "account_changed" || payload?.error?.message === "account_changed")) throw new JobSessionError("session_changed");
    if (!options.expectedStatuses.includes(response.status) || !payload) throw parseFalError(response.status, payload);
    return normalizeFalJob(payload);
}

function normalizeFalJob(payload: unknown): FalJob {
    const value = isRecord(payload) ? payload : {};
    const jobId = typeof value.job_id === "string" ? value.job_id : "";
    const status = value.status;
    if (!jobId || !isFalStatus(status)) throw new FalJobApiError("Fal 返回了无效的任务响应", { code: "invalid_job_response" });
    return {
        jobId,
        status,
        providerJobId: typeof value.provider_job_id === "string" ? value.provider_job_id : undefined,
        result: isRecord(value.result) ? value.result : value.result == null ? null : undefined,
        error: normalizeFalError(value.error),
        createdAt: typeof value.created_at === "string" ? value.created_at : undefined,
        updatedAt: typeof value.updated_at === "string" ? value.updated_at : undefined,
    };
}

function parseFalError(status: number, payload: unknown): FalJobApiError {
    const value = isRecord(payload) ? payload : {};
    const nested = isRecord(value.error) ? value.error : {};
    const message = typeof nested.message === "string" ? nested.message : typeof value.message === "string" ? value.message : `Fal 请求失败（${status}）`;
    return new FalJobApiError(message, { status, code: typeof nested.code === "string" ? nested.code : typeof value.code === "string" ? value.code : undefined, retryable: status >= 500 || status === 429 });
}

function normalizeFalError(value: unknown): FalJobError | null {
    if (!isRecord(value)) return null;
    if (typeof value.message !== "string") return null;
    return { message: value.message, code: typeof value.code === "string" ? value.code : undefined, retryable: typeof value.retryable === "boolean" ? value.retryable : undefined };
}

function isFalStatus(value: unknown): value is FalJobStatus {
    return typeof value === "string" && ["queued", "running", "recoverable", "succeeded", "failed", "canceled", "uncertain"].includes(value);
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === "object";
}

function delay(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("已取消", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
