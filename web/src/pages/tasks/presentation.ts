import type { Task, TaskStatus } from "@/services/api/task-center";
export const taskStatusLabels: Record<TaskStatus, string> = { queued: "排队", running: "运行中", retrying: "服务端重试中", succeeded: "成功", failed: "失败", canceled: "已取消", uncertain: "结果不确定", recoverable: "可恢复查询", unknown: "未知状态" };
const stages: Record<string, string> = { ...taskStatusLabels, waiting: "等待调度", queued: "排队", submitting: "提交上游", provider_queue: "上游排队", generating: "生成中", running: "运行中", retrying: "服务端重试", collecting_result: "读取结果", cancel_requested: "已请求取消，等待确认", querying_provider: "查询上游" };
export const stageLabel = (stage: string) => stages[stage] || "阶段未知";
export function elapsedLabel(ms: number | null) { return ms === null ? "耗时未知" : `${Math.floor(ms / 60000)} 分 ${Math.floor(ms / 1000) % 60} 秒`; }
export function taskResultLinks(task: Task): string[] {
    if (task.status !== "succeeded" || task.resultExpired || !task.result) return [];
    const urls: string[] = [];
    const add = (value: unknown) => {
        if (typeof value !== "string") return;
        if (/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value)) { urls.push(value); return; }
        try { const url = new URL(value); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) urls.push(value); } catch { /* Ignore malformed provider results. */ }
    };
    const result = task.result;
    for (const value of [result.image, ...(Array.isArray(result.images) ? result.images : []), ...(Array.isArray(result.layers) ? result.layers : []), ...(Array.isArray(result.data) ? result.data : [])]) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        add(item.url);
        if (typeof item.b64_json === "string") {
            const format = result.output_format === "jpeg" || result.output_format === "jpg" ? "jpeg" : result.output_format === "webp" ? "webp" : "png";
            add(`data:image/${format};base64,${item.b64_json}`);
        }
    }
    return [...new Set(urls)];
}
