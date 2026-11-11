import { nanoid } from "nanoid";
import type { FalJobModel } from "./fal-jobs";
import { createTaskIntentStore, intentDigest, type StoredTaskIntent, type TaskIntentStore } from "./intent-store";

export type TaskTarget = { provider: "gpt" } | { provider: "fal"; model: FalJobModel };
export type TaskStatus = "queued" | "running" | "retrying" | "recoverable" | "succeeded" | "failed" | "canceled" | "uncertain" | "unknown";
/** revision MUST increase on every account/channel/credential switch, including A -> B -> A. */
export type TaskSession = { accountId: string; channelId: string; revision: number; apiKey: string };
export type TaskErrorCode =
    | "session_changed"
    | "aborted"
    | "invalid_request"
    | "invalid_response"
    | "network_error"
    | "unauthorized"
    | "not_found"
    | "conflict"
    | "capacity"
    | "service_unavailable"
    | "request_failed"
    | "action_disabled"
    | "poll_timeout"
    | "intent_input_required"
    | "intent_storage_unavailable"
    | "intent_expired";
const messages: Record<TaskErrorCode, string> = {
    session_changed: "账号或渠道已切换，已丢弃旧请求结果",
    aborted: "已停止等待；这不会取消服务端任务",
    invalid_request: "任务请求参数无效",
    invalid_response: "任务响应格式无效，请查询原任务",
    network_error: "连接中断，请查询原任务，勿新建生成",
    unauthorized: "请检查当前渠道凭据",
    not_found: "任务不存在、已过期或不属于当前渠道",
    conflict: "任务状态或创建意图冲突",
    capacity: "任务容量不足，请保留原创建意图",
    service_unavailable: "任务服务暂不可用",
    request_failed: "任务请求失败",
    action_disabled: "当前任务不允许此操作",
    poll_timeout: "已停止轮询，可继续查询原任务",
    intent_expired: "创建意图已超出安全重放窗口，请先核对历史任务",
    intent_input_required: "已找回原创建意图；请先核对历史任务及原渠道凭据，再明确确认并重新准备相同输入",
    intent_storage_unavailable: "创建意图记录无法安全保存或读取，请人工核对，勿重新生成",
};
export class TaskCenterError extends Error {
    readonly preventResubmit = true;
    constructor(
        readonly code: TaskErrorCode,
        readonly httpStatus?: number,
    ) {
        super(messages[code]);
        this.name = "TaskCenterError";
    }
    get retryableRead() {
        return ["network_error", "capacity", "service_unavailable"].includes(this.code);
    }
}
export type Task = {
    jobId: string;
    target: TaskTarget;
    model: string | null;
    status: TaskStatus;
    createdAt: number | null;
    updatedAt: number | null;
    startedAt: number | null;
    finishedAt: number | null;
    elapsedMs: number | null;
    progress: { stage: string; percent: number | null };
    queueMode: "encrypted_persistent" | "admission_only" | "unknown";
    actions: { cancel: { allowed: boolean }; retry: { allowed: boolean; mode: "resume_query" | null } };
    result: Record<string, unknown> | null;
    resultJobId: string | null;
    resultExpired: boolean;
    expiresAt: number | null;
    error: { code: "task_error"; message: string } | null;
};
export type TaskPage = { items: Task[]; nextCursor: string | null; retentionMs: number | null };
export type TaskCreateInput = { provider: "gpt"; operation: "generations" | "edits"; body: Record<string, unknown> } | { provider: "fal"; payload: Record<string, unknown> };
/** Opaque handle. Keep it for the whole user intent; no credentials or input are exposed. */
export type TaskIntent = Readonly<{ intentId: string; idempotencyKey: string; model: string }>;
export type RestoredTaskIntent = { intent: TaskIntent; jobId: string | null; needsInputReview: boolean; expired: boolean };
export type TaskPollOptions = {
    signal?: AbortSignal;
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    onUpdate?: (task: Task) => void;
};
type Options = {
    target: TaskTarget;
    /** Resolve from the current user's selected model channel, never an app/shared default key. */
    getSession: () => TaskSession | null;
    fetch?: typeof globalThis.fetch;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    intentStore?: TaskIntentStore;
};
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const numberOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const statuses: TaskStatus[] = ["queued", "running", "retrying", "recoverable", "succeeded", "failed", "canceled", "uncertain", "unknown"];
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const stages = new Set(["waiting", "queued", "submitting", "provider_queue", "generating", "running", "retrying", "collecting_result", "cancel_requested", "succeeded", "failed", "canceled", "uncertain", "recoverable", "querying_provider"]);

/**
 * One client per account/channel session and list source (GPT or a single Fal model).
 * UI: list({cursor}), get(id), poll(id), cancel(task), resumeQuery(task).
 * Commerce: await prepareIntent(localIntentId,input), submit(intent), then poll(jobId).
 * Call dispose() and clear UI data on switch; recreate the client. No store mutation here.
 * Refresh: await restoreIntents(model); submit(handle) queries a known ID without input.
 * Missing ID: show review UI, then prepareIntent(id,sameInput,{confirmedSameInput:true}).
 * List cursors are independent. Only metadata persists; request bodies stay in memory.
 * Channel IDs must be immutable credential-binding IDs: rotate channel ID on key replacement.
 * Callers must select a channel supported by the server's fixed provider routes;
 * this client never forwards credentials to arbitrary channel base URLs.
 */
export function createTaskCenterClient(options: Options) {
    const target = Object.freeze({ ...options.target });
    if (target.provider !== "gpt" && (target.provider !== "fal" || !["flux-fill", "esrgan", "qwen-layered"].includes(target.model))) throw new TaskCenterError("invalid_request");
    const initial = options.getSession();
    if (!initial?.accountId || !initial.channelId || !Number.isSafeInteger(initial.revision) || !/^[A-Za-z0-9._~+/:=-]{1,512}$/.test(initial.apiKey)) throw new TaskCenterError("unauthorized");
    const session = { ...initial };
    const root = target.provider === "gpt" ? "/api/providers/gpt/jobs" : `/api/providers/fal/jobs/${target.model}`;
    const lifetime = new AbortController();
    const tasks = new WeakSet<Task>();
    const intents = new Map<TaskIntent, { scope: string; stored: StoredTaskIntent; body?: string }>();
    const intentStore = options.intentStore ?? createTaskIntentStore();
    const check = (signal?: AbortSignal) => {
        const current = options.getSession();
        if (lifetime.signal.aborted || !current || current.accountId !== session.accountId || current.channelId !== session.channelId || current.revision !== session.revision || current.apiKey !== session.apiKey) {
            lifetime.abort();
            throw new TaskCenterError("session_changed");
        }
        if (signal?.aborted) throw new TaskCenterError("aborted");
    };
    const scopeFor = async (model: string) => {
        check();
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(model) || (target.provider === "fal" && model !== target.model)) throw new TaskCenterError("invalid_request");
        const scope = await storageCall(() => intentDigest(JSON.stringify([session.accountId, session.channelId, target.provider, model])));
        check();
        return scope;
    };
    const storageCall = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
            const value = await operation();
            check();
            return value;
        } catch (error) {
            check();
            if (error instanceof TaskCenterError) throw error;
            throw new TaskCenterError("intent_storage_unavailable");
        }
    };
    const expired = (stored: StoredTaskIntent) => Date.now() < stored.createdAt || Date.now() - stored.createdAt >= 7 * 86400000;
    const remember = (scope: string, model: string, stored: StoredTaskIntent, body?: string) => {
        for (const [handle, saved] of intents)
            if (saved.scope === scope && handle.intentId === stored.intentId) {
                // A failed disk update must not erase an ID already accepted in this client.
                saved.stored = saved.stored.jobId ? { ...stored, jobId: saved.stored.jobId } : stored;
                if (body !== undefined) saved.body = body;
                return handle;
            }
        const handle = Object.freeze({ intentId: stored.intentId, idempotencyKey: stored.idempotencyKey, model });
        intents.set(handle, { scope, stored, body });
        return handle;
    };
    const normalize = (raw: unknown, detail: boolean): Task => {
        check();
        const v = record(raw),
            progress = record(v.progress),
            actions = record(v.actions),
            retry = record(actions.retry);
        if (typeof v.job_id !== "string" || !idPattern.test(v.job_id) || typeof v.status !== "string") throw new TaskCenterError("invalid_response");
        const status = statuses.includes(v.status as TaskStatus) ? (v.status as TaskStatus) : "unknown";
        const active = ["queued", "running", "retrying", "recoverable"].includes(status);
        const task: Task = {
            jobId: v.job_id,
            target,
            model: typeof v.model === "string" ? v.model : target.provider === "fal" ? target.model : null,
            status,
            createdAt: numberOrNull(v.created_at),
            updatedAt: numberOrNull(v.updated_at),
            startedAt: numberOrNull(v.started_at),
            finishedAt: numberOrNull(v.finished_at),
            elapsedMs: numberOrNull(v.elapsed_ms),
            progress: { stage: typeof progress.stage === "string" && stages.has(progress.stage) ? progress.stage : "unknown", percent: numberOrNull(progress.percent) },
            queueMode: v.queue_mode === "encrypted_persistent" || v.queue_mode === "admission_only" ? v.queue_mode : "unknown",
            actions: {
                cancel: { allowed: active && record(actions.cancel).allowed === true },
                retry: { allowed: target.provider === "fal" && status === "recoverable" && retry.allowed === true && retry.mode === "resume_query", mode: retry.mode === "resume_query" ? "resume_query" : null },
            },
            result: detail && v.result !== null && typeof v.result === "object" && !Array.isArray(v.result) ? record(v.result) : null,
            resultJobId: typeof v.result_job_id === "string" && idPattern.test(v.result_job_id) ? v.result_job_id : null,
            resultExpired: v.result_expired === true,
            expiresAt: numberOrNull(v.expires_at),
            error: v.error == null ? null : { code: "task_error", message: "任务未完成，请查看任务状态与可用操作" },
        };
        tasks.add(task);
        return task;
    };
    const request = async (path: string, init: RequestInit, expected: number, signal?: AbortSignal): Promise<unknown> => {
        check(signal);
        const controller = new AbortController();
        const abort = () => controller.abort();
        lifetime.signal.addEventListener("abort", abort, { once: true });
        signal?.addEventListener("abort", abort, { once: true });
        try {
            const response = await (options.fetch || globalThis.fetch)(path, {
                ...init,
                signal: controller.signal,
                credentials: "same-origin",
                cache: "no-store",
                redirect: "error",
                headers: { ...init.headers, Authorization: `Bearer ${session.apiKey}` },
            });
            check(signal);
            if (response.status !== expected) {
                const status = response.status;
                throw new TaskCenterError(status === 401 || status === 403 ? "unauthorized" : status === 404 ? "not_found" : status === 409 ? "conflict" : status === 429 ? "capacity" : status >= 500 ? "service_unavailable" : "request_failed", status);
            }
            let data: unknown;
            try {
                data = await response.json();
            } catch {
                check(signal);
                throw new TaskCenterError("invalid_response");
            }
            check(signal);
            return data;
        } catch (error) {
            check(signal);
            if (error instanceof TaskCenterError) throw error;
            throw new TaskCenterError("network_error");
        } finally {
            lifetime.signal.removeEventListener("abort", abort);
            signal?.removeEventListener("abort", abort);
        }
    };
    const get = async (jobId: string, signal?: AbortSignal) => {
        if (!idPattern.test(jobId)) throw new TaskCenterError("invalid_request");
        const task = normalize(await request(`${root}/${jobId}`, { method: "GET" }, 200, signal), true);
        if (task.jobId !== jobId) throw new TaskCenterError("invalid_response");
        return task;
    };
    const action = async (task: Task, kind: "cancel" | "retry", signal?: AbortSignal) => {
        check(signal);
        if (!tasks.has(task) || !task.actions[kind].allowed) throw new TaskCenterError("action_disabled");
        const result = normalize(await request(`${root}/${task.jobId}`, { method: "POST", headers: { "X-Job-Action": kind } }, 200, signal), true);
        if (result.jobId !== task.jobId) throw new TaskCenterError("invalid_response");
        return result;
    };
    return {
        dispose() {
            lifetime.abort();
            intents.clear();
        },
        async list(page: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {}): Promise<TaskPage> {
            const limit = page.limit ?? 20;
            if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (page.cursor != null && !/^[A-Za-z0-9_-]{1,512}$/.test(page.cursor))) throw new TaskCenterError("invalid_request");
            const params = new URLSearchParams({ limit: String(limit) });
            if (page.cursor != null) params.set("cursor", page.cursor);
            const v = record(await request(`${root}?${params}`, { method: "GET" }, 200, page.signal));
            check(page.signal);
            if (!Array.isArray(v.items) || (v.next_cursor !== null && (typeof v.next_cursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(v.next_cursor)))) throw new TaskCenterError("invalid_response");
            return { items: v.items.map((item) => normalize(item, false)), nextCursor: v.next_cursor as string | null, retentionMs: numberOrNull(v.retention_ms) };
        },
        get,
        cancel: (task: Task, signal?: AbortSignal) => action(task, "cancel", signal),
        resumeQuery: (task: Task, signal?: AbortSignal) => action(task, "retry", signal),
        async restoreIntents(model: string): Promise<RestoredTaskIntent[]> {
            const scope = await scopeFor(model);
            const rows = await storageCall(() => intentStore.list(scope));
            return rows.map((stored) => ({ intent: remember(scope, model, stored), jobId: stored.jobId ?? null, needsInputReview: !stored.jobId, expired: expired(stored) }));
        },
        async prepareIntent(intentId: string, input: TaskCreateInput, review: { confirmedSameInput?: boolean } = {}): Promise<TaskIntent> {
            check();
            if (!/^[A-Za-z0-9._~-]{1,200}$/.test(intentId) || input.provider !== target.provider || (input.provider === "gpt" && !["generations", "edits"].includes(input.operation))) throw new TaskCenterError("invalid_request");
            let body: string;
            try {
                body = JSON.stringify(input.provider === "gpt" ? { operation: input.operation, body: input.body } : input.payload);
            } catch {
                throw new TaskCenterError("invalid_request");
            }
            if (!body) throw new TaskCenterError("invalid_request");
            const model = input.provider === "gpt" ? input.body.model : target.provider === "fal" ? target.model : undefined;
            if (typeof model !== "string") throw new TaskCenterError("invalid_request");
            const scope = await scopeFor(model),
                fingerprint = await storageCall(() => intentDigest(body));
            check();
            const stored = await storageCall(() =>
                intentStore.update(scope, intentId, (previous) => {
                    check();
                    if (previous) {
                        if (previous.fingerprint !== fingerprint) throw new TaskCenterError("conflict");
                        if (!previous.jobId && expired(previous)) throw new TaskCenterError("intent_expired");
                        const inMemory = [...intents.values()].some((saved) => saved.scope === scope && saved.stored.intentId === intentId && saved.body === body);
                        if (!previous.jobId && !inMemory && !review.confirmedSameInput) throw new TaskCenterError("intent_input_required");
                        return previous;
                    }
                    return { version: 1, intentId, idempotencyKey: nanoid(), fingerprint, createdAt: Date.now() };
                }),
            );
            return remember(scope, model, stored, body);
        },
        async submit(intent: TaskIntent, signal?: AbortSignal): Promise<Task> {
            check(signal);
            const saved = intents.get(intent);
            if (!saved) throw new TaskCenterError("invalid_request");
            if (saved.stored.jobId) return get(saved.stored.jobId, signal);
            // Re-read under a cross-tab lock before any POST; never resurrect removed/corrupt metadata.
            const stored = await storageCall(() =>
                intentStore.update(saved.scope, intent.intentId, (previous) => {
                    check(signal);
                    if (!previous || previous.idempotencyKey !== intent.idempotencyKey || previous.fingerprint !== saved.stored.fingerprint) throw new TaskCenterError("intent_storage_unavailable");
                    return previous;
                }),
            );
            saved.stored = stored;
            if (stored.jobId) return get(stored.jobId, signal);
            // Legacy dedup expires after seven days. Never blindly replay an old intent.
            if (expired(stored)) throw new TaskCenterError("intent_expired");
            if (!saved.body) throw new TaskCenterError("intent_input_required");
            const task = normalize(await request(root, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": intent.idempotencyKey }, body: saved.body }, 202, signal), true);
            // Keep known ID in memory even if its persistence fails; do not fall back to POST.
            saved.stored = { ...stored, jobId: task.jobId };
            await storageCall(() =>
                intentStore.update(saved.scope, intent.intentId, (previous) => {
                    check(signal);
                    if (!previous || previous.idempotencyKey !== stored.idempotencyKey || (previous.jobId && previous.jobId !== task.jobId)) throw new TaskCenterError("intent_storage_unavailable");
                    return { ...previous, jobId: task.jobId };
                }),
            );
            return task;
        },
        async poll(jobId: string, poll: TaskPollOptions = {}): Promise<Task> {
            const attempts = poll.maxAttempts ?? 60,
                maximum = poll.maxDelayMs ?? 10000;
            let delay = poll.initialDelayMs ?? 1000;
            if (!Number.isInteger(attempts) || attempts < 1 || attempts > 1000 || !Number.isFinite(delay) || delay < 0 || !Number.isFinite(maximum) || maximum < delay || maximum > 60000) throw new TaskCenterError("invalid_request");
            for (let i = 0; i < attempts; i++) {
                check(poll.signal);
                let task: Task | undefined;
                try {
                    task = await get(jobId, poll.signal);
                } catch (error) {
                    if (!(error instanceof TaskCenterError) || !error.retryableRead || i === attempts - 1) throw error;
                }
                if (task) {
                    check(poll.signal);
                    poll.onUpdate?.(task);
                    check(poll.signal);
                    if (["succeeded", "failed", "canceled", "uncertain", "unknown", "recoverable"].includes(task.status)) return task;
                }
                if (i < attempts - 1) {
                    await (options.sleep || sleep)(delay, poll.signal);
                    check(poll.signal);
                    delay = Math.min(maximum, Math.max(1, delay * 2));
                }
            }
            throw new TaskCenterError("poll_timeout");
        },
    };
}

export type TaskCenterClient = ReturnType<typeof createTaskCenterClient>;

function sleep(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(new TaskCenterError("aborted"));
    return new Promise<void>((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(new TaskCenterError("aborted"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}
