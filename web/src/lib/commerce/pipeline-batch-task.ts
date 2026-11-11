import { createTaskCenterClient, TaskCenterError, type Task } from "@/services/api/task-center";
import { intentDigest } from "@/services/api/intent-store";
import { isGptImageJobEligible } from "@/services/api/gpt-jobs";
import { getGptImageJobsEnabled } from "@/constant/runtime-config";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export type BatchOperation = { key: string; intentId: string; attempt: number; channel: string; status: string; jobId?: string; percent?: number | null; fingerprint?: string; text?: string };
export type BatchSkuState = { status: "queued" | "running" | "review" | "succeeded" | "failed" | "paused"; message?: string };
export type BatchJournal = { version: 1; jobId: string; account: string; stopped: boolean; skus: Record<string, BatchSkuState>; operations: Record<string, BatchOperation> };
export function readBatchJournal(jobId: string, account: string): BatchJournal {
    const raw = localStorage.getItem(batchKey(jobId, account));
    if (!raw) return { version: 1, jobId, account, stopped: false, skus: {}, operations: {} };
    const value = JSON.parse(raw) as BatchJournal;
    if (value.version !== 1 || value.jobId !== jobId || value.account !== account || !value.skus || !value.operations) throw new Error("批次恢复记录损坏，请核对原任务，勿重新提交");
    return value;
}
const batchKey = (jobId: string, account: string) => "commerce-batch-v1:" + JSON.stringify([account, jobId]);
export function writeBatchJournal(journal: BatchJournal) { localStorage.setItem(batchKey(journal.jobId, journal.account), JSON.stringify(journal)); }
export function taskImageResult(task: Task) {
    if (task.status !== "succeeded" || task.resultExpired) throw new Error("原任务未成功或结果已过期，请先核对任务，不能自动重发");
    const data = task.result?.data;
    if (!Array.isArray(data) || !data.length) throw new Error("原任务缺少图片结果，请查询原任务");
    return data.map((item: unknown, index) => {
        const value = item as { b64_json?: unknown; mime_type?: unknown };
        if (!value || typeof value.b64_json !== "string" || !value.b64_json || !/^[A-Za-z0-9+/=\r\n]+$/.test(value.b64_json)) throw new Error("原任务图片格式无效");
        const mime = value.mime_type ?? "image/png";
        if (!["image/png", "image/jpeg", "image/webp"].includes(String(mime))) throw new Error("原任务图片类型不支持");
        return { id: task.jobId + "-" + index, dataUrl: `data:${mime};base64,${value.b64_json}` };
    });
}
export type BatchTaskOptions = {
    journal: BatchJournal; skuId: string; revision: number;
    assertCurrent: () => void; changed: () => void;
    retryFailed?: boolean; confirmSameInput?: boolean;
    signal: AbortSignal;
    clients: Set<ReturnType<typeof createTaskCenterClient>>;
    active: Map<ReturnType<typeof createTaskCenterClient>, Task>;
};
export function batchImageRunner(options: BatchTaskOptions) {
    return async (slot: string, config: AiConfig, prompt: string, refs: ReferenceImage[]) => {
        options.assertCurrent();
        const resolved = resolveModelRequestConfig(config, config.model || config.imageModel);
        if (!isGptImageJobEligible(resolved, getGptImageJobsEnabled())) throw new Error("批量恢复仅支持已启用的 GPT 图片任务渠道（指定直连或同源 Sub2API）与 gpt-image- 模型；请调整模型，未发送请求。");
        const channel = await intentDigest(JSON.stringify([resolved.baseUrl, resolved.apiKey]));
        options.assertCurrent();
        const key = JSON.stringify([options.skuId, options.revision, slot]);
        const previous = options.journal.operations[key];
        const fingerprint = await intentDigest(JSON.stringify([resolved.model, prompt, refs.map((ref) => ref.storageKey || ref.dataUrl)]));
        if (previous?.fingerprint && previous.fingerprint !== fingerprint) throw new Error("商品输入已变化，请核对原任务，不能复用旧结果或自动重新提交");
        if (previous && previous.channel !== channel) throw new Error("本项原渠道凭据已变化，请切回原渠道查询，勿重复生成");
        if (previous?.status === "canceled") throw new Error("原任务已取消，保留记录，不会自动重新生成");
        if (previous && ["uncertain", "unknown", "recoverable"].includes(previous.status)) throw new Error("原任务状态待核实，请在任务中心查询，禁止新建重试");
        if (previous?.status === "failed" && !options.retryFailed) throw new Error("该项失败，请使用“仅重试失败项”明确重试");
        const attempt = previous?.status === "failed" && options.retryFailed ? previous.attempt + 1 : previous?.attempt || 1;
        const intentId = "commerce-" + await intentDigest(JSON.stringify([options.journal.jobId, key, attempt]));
        const record: BatchOperation = previous && previous.attempt === attempt ? previous : { key, intentId, attempt, channel, fingerprint, status: "prepared" };
        options.journal.operations[key] = record;
        options.changed(); // Disk acknowledgement before prepare/submit; storage errors fail closed.
        const client = createTaskCenterClient({ target: { provider: "gpt" }, getSession: () => {
            try { options.assertCurrent(); return { accountId: options.journal.account, channelId: channel, revision: 0, apiKey: resolved.apiKey }; } catch { return null; }
        } });
        options.clients.add(client);
        const update = (task: Task) => {
            options.assertCurrent();
            Object.assign(record, { jobId: task.jobId, status: task.status, percent: task.progress.percent });
            options.active.set(client, task); options.changed();
        };
        try {
            const restored = (await client.restoreIntents(resolved.model)).find((entry) => entry.intent.intentId === intentId);
            if (!restored && previous && previous.attempt === attempt) {
                if (!record.jobId) throw new Error("原创建意图记录缺失，请核对原任务，禁止重新提交");
                let original = await client.get(record.jobId, options.signal); update(original);
                if (["queued", "running", "retrying"].includes(original.status)) original = await client.poll(original.jobId, { signal: options.signal, onUpdate: update });
                update(original);
                return taskImageResult(original);
            }
            let handle = restored?.intent;
            if (!restored?.jobId) {
                if (restored && !options.confirmSameInput) throw new TaskCenterError("intent_input_required");
                const images = await Promise.all(refs.map((ref) => imageToDataUrl(ref)));
                options.assertCurrent();
                if (!images.length || images.some((data) => !/^data:image\/(png|jpeg|webp);base64,/.test(data))) throw new Error("商品参考图不可读取，未发送请求");
                handle = await client.prepareIntent(intentId, { provider: "gpt", operation: "edits", body: { model: resolved.model, prompt, images, n: 1, size: "1024x1024", output_format: "png" } }, { confirmedSameInput: options.confirmSameInput });
            }
            let task = await client.submit(handle!, options.signal); update(task);
            if (["queued", "running", "retrying"].includes(task.status)) task = await client.poll(task.jobId, { signal: options.signal, onUpdate: update });
            update(task);
            if (task.status !== "succeeded") throw new Error(`原任务状态：${task.status}；${task.status === "failed" ? "可单独重试失败项" : "请先核对原任务"}`);
            return taskImageResult(task);
        } finally { options.active.delete(client); options.clients.delete(client); client.dispose(); }
    };
}
