import localforage from "localforage";
import { pollGptImageJob, type GptImageJob, type GptJobIntent } from "@/services/api/gpt-jobs";
import { resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { useServerConfigStore } from "@/services/server-config";
import type { ReferenceImage } from "@/types/image";
import { createImageJobSessionGuard } from "./image-job-session";

export type ImageJobRecord = {
    id: string; jobId?: string; intent: GptJobIntent; prompt: string; model: string;
    config: Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count">;
    createdAt: number; status: GptImageJob["status"] | "submitting"; error?: string;
    scope?: string; references?: ReferenceImage[];
};
export const imageJobStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_jobs" });

/** No credentials in durable records; bind to verified account and original channel/key hash. */
export async function imageJobScope(config: AiConfig, model = config.model) {
    const user = useServerConfigStore.getState().user;
    if (!user) throw new Error("请先登录后查询原任务");
    const channel = resolveModelChannel(config, model);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([channel.id, channel.baseUrl, channel.apiKey])));
    return JSON.stringify([String(user.id), Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("")]);
}

/** Pick at runtime: never spread AiConfig (which includes all channel credentials). */
export function createImageJobRecord(intent: GptJobIntent, prompt: string, config: AiConfig): ImageJobRecord {
    return {
        id: intent.idempotencyKey, intent, prompt, model: config.model, createdAt: Date.now(), status: "submitting",
        config: { model: config.model, imageModel: config.imageModel, size: config.size, quality: config.quality, count: "1" },
    };
}
export async function readImageJobs(scope: string) {
    const items: ImageJobRecord[] = [];
    await imageJobStore.iterate<ImageJobRecord, void>((value) => { if (value.id && value.intent && value.scope === scope) items.push(value); });
    return items.sort((a, b) => a.createdAt - b.createdAt);
}
export function updateImageJob(record: ImageJobRecord, job: GptImageJob): ImageJobRecord {
    return { ...record, jobId: job.jobId, status: job.status, error: job.status === "uncertain" ? "任务状态不确定，勿重新生成以免重复扣费；请查询原任务。" : job.error?.message };
}
/** Resume ignores the feature flag and never prepares references or invokes a synchronous image API. */
export async function recoverImageJob(record: ImageJobRecord, config: AiConfig, onJob: (job: GptImageJob) => Promise<void>, options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; guard?: () => void } = {}) {
    const sessionGuard = createImageJobSessionGuard({ ...config, model: record.model });
    options.guard?.();
    if (!record.scope || record.scope !== await imageJobScope(config, record.model)) throw new Error("账号或渠道已变化，请使用原账号和渠道查询任务");
    options.guard?.();
    if (!record.jobId) throw new Error("提交结果待核实：未收到任务编号，请在任务中心核实原任务，勿重新生成以免重复扣费");
    const current = resolveModelRequestConfig(config, record.model);
    if (!current.apiKey.trim()) throw new Error("请先恢复原渠道配置，再查询此任务");
    const client = { apiKey: current.apiKey, sessionGuard, sleep: options.sleep, fetch: (async (...args: Parameters<typeof fetch>) => {
        options.guard?.();
        const response = await (options.fetch || fetch)(...args);
        options.guard?.();
        return response;
    }) as typeof fetch };
    // Never create on recovery, including lost acknowledgement, disabled flag, or 404/409.
    const job = await pollGptImageJob(client, record.jobId);
    options.guard?.();
    await onJob(job);
    return job;
}
