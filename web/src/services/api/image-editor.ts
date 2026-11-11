import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { editorChannel, editorOperationNames } from "@/lib/editor-providers";
import type { EditOperation, EditTask, OcrLine } from "@/types/image-editor";

const prefix = "/api/providers";
export type EditRequest = { operation: EditOperation; documentId: string; revision: number; idempotencyKey: string; image: string; mask?: string; scale?: number; width: number; height: number; prompt?: string };
type ChannelSnapshot = ReturnType<typeof editorChannel>;
export type EditorSnapshot = { channels: Partial<Record<EditOperation, ChannelSnapshot>>; errors: Partial<Record<EditOperation, string>> };
export function captureEditorConfig(config: AiConfig = useConfigStore.getState().config): EditorSnapshot {
    const channels: EditorSnapshot["channels"] = {},
        errors: EditorSnapshot["errors"] = {};
    for (const operation of Object.keys(editorOperationNames) as EditOperation[]) {
        try {
            channels[operation] = { ...editorChannel(config, operation) };
        } catch (error) {
            errors[operation] = error instanceof Error ? error.message : "请先配置渠道";
        }
    }
    return { channels, errors };
}
export async function editCapabilities(config?: AiConfig) {
    const snapshot = captureEditorConfig(config);
    return {
        operations: Object.fromEntries((Object.keys(editorOperationNames) as EditOperation[]).map((operation) => [operation, { enabled: !!snapshot.channels[operation], message: snapshot.errors[operation] || "" }])) as Record<
            EditOperation,
            { enabled: boolean; message: string }
        >,
    };
}
async function request(path: string, channel: ChannelSnapshot, body?: unknown, signal?: AbortSignal) {
    const response = await fetch(prefix + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${channel.apiKey}`, ...(channel.provider === "azure-vision" ? { "X-Azure-Resource": new URL(channel.baseUrl).hostname.split(".")[0] } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.error?.message || "专用接口不可用，请检查渠道配置及转发服务");
    return data;
}
function pause(signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("已取消", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, 1200);
        signal.addEventListener("abort", abort, { once: true });
    });
}
const jobs = new Map<string, Promise<EditTask>>();
export function runEditTask(input: EditRequest, signal: AbortSignal, onTask: (task: EditTask) => void, snapshot = captureEditorConfig()): Promise<EditTask> {
    if (signal.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
    const key = `${input.documentId}:${input.idempotencyKey}`;
    const existing = jobs.get(key);
    if (existing) return existing;
    const promise = perform(input, signal, onTask, snapshot);
    jobs.set(key, promise);
    promise
        .finally(() => {
            if (jobs.size > 100) jobs.delete(jobs.keys().next().value!);
        })
        .catch(() => undefined);
    return promise;
}
async function perform(input: EditRequest, signal: AbortSignal, onTask: (task: EditTask) => void, snapshot: EditorSnapshot): Promise<EditTask> {
    const channel = snapshot.channels[input.operation];
    if (!channel) throw new Error(snapshot.errors[input.operation] || "请先配置此工具的渠道");
    const task: EditTask = { id: input.idempotencyKey, documentId: input.documentId, revision: input.revision, status: "running" };
    onTask({ ...task });
    if (input.operation === "ocr") {
        const result = await request("/azure/read", channel, { image_url: input.image }, signal);
        signal.throwIfAborted();
        const lines: OcrLine[] = (result.readResult?.blocks || []).flatMap((block: { lines?: Array<{ text: string; boundingPolygon: OcrLine["polygon"]; words?: Array<{ confidence: number }> }> }) =>
            (block.lines || []).map((line) => ({ text: line.text, polygon: line.boundingPolygon, confidence: Math.min(...(line.words || []).map((word) => word.confidence), 1) })),
        );
        task.status = "succeeded";
        task.result = { lines: lines.slice(0, 200) };
        onTask({ ...task });
        return task;
    }
    const alias = input.operation === "erase" || input.operation === "expand" ? "flux-fill" : input.operation === "upscale" ? "esrgan" : "qwen-layered";
    const body = {
        image_url: input.image,
        ...(alias === "flux-fill" ? { mask_url: input.mask, prompt: input.prompt || "Remove the masked object and seamlessly reconstruct the background. No text or new objects." } : alias === "esrgan" ? { scale: input.scale } : {}),
    };
    // Await the submission ID even if canceled; then cancel that exact job without resubmitting.
    signal.throwIfAborted();
    const submitted = await request(`/fal/submit/${alias}`, channel, body);
    if (typeof submitted.request_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(submitted.request_id)) throw new Error("服务返回了无效的任务编号");
    const path = `/fal/requests/${alias}/${submitted.request_id}`;
    let cancelPromise: Promise<unknown> | undefined;
    const cancel = () => {
        cancelPromise ||= request(path + "/cancel", channel, {}).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        if (signal.aborted) {
            cancel();
            signal.throwIfAborted();
        }
        const deadline = Date.now() + 9 * 60_000;
        while (Date.now() < deadline) {
            await pause(signal);
            const status = await request(path + "/status", channel, undefined, signal);
            signal.throwIfAborted();
            if (status.status === "COMPLETED") {
                const result = await request(path + "/result", channel, undefined, signal);
                signal.throwIfAborted();
                const images = result.images || (result.image ? [result.image] : []);
                if (!Array.isArray(images) || !images.length || images.length > 16) throw new Error("模型未返回有效图片");
                task.result = {
                    images: images.map((image: { url: string }) => {
                        const url = new URL(image.url);
                        if (url.protocol !== "https:" || url.username || url.password || url.port || !/^(?:[a-z0-9-]+\.)*fal\.media$/i.test(url.hostname)) throw new Error("模型图片地址不受支持");
                        return { url: prefix + "/media?url=" + encodeURIComponent(url.href) };
                    }),
                };
                task.status = "succeeded";
                onTask({ ...task });
                return task;
            }
            if (!["IN_QUEUE", "IN_PROGRESS"].includes(status.status)) throw new Error("专用模型处理失败");
            task.status = status.status === "IN_QUEUE" ? "queued" : "running";
            onTask({ ...task });
        }
        throw new Error("图片处理超时，请在服务商后台确认后再重试");
    } catch (error) {
        cancel();
        throw error;
    } finally {
        signal.removeEventListener("abort", cancel);
    }
}
