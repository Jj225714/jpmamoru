import { useCommerceStore } from "@/stores/use-commerce-store";
import { useServerConfigStore } from "@/services/server-config";
import { useConfigStore } from "@/stores/use-config-store";
import { getCommerceAccountEpoch } from "./request-session";
import { generateContent, prepareWhiteBackground, localizeAndRender, runCompliance, type CommercePipelineRuntime } from "./pipeline";
import { requestImageQuestion } from "@/services/api/image";
import { intentDigest } from "@/services/api/intent-store";
import { batchImageRunner, readBatchJournal, writeBatchJournal, type BatchJournal, type BatchSkuState } from "./pipeline-batch-task";
import type { TaskCenterClient, Task } from "@/services/api/task-center";

export const batchAccount = () => String(useServerConfigStore.getState().user?.id ?? "local");
const listeners = new Set<() => void>();
let revision = 0;
export const batchSubscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const batchSnapshot = () => revision;
const emit = () => { revision++; listeners.forEach((listener) => listener()); };
const activeRuns = new Map<string, { stop: () => Promise<void> }>();
export function isBatchRunning(jobId: string) { return activeRuns.has(JSON.stringify([batchAccount(), jobId])); }
export async function stopCommerceBatch(jobId: string) { await activeRuns.get(JSON.stringify([batchAccount(), jobId]))?.stop(); }
export async function runCommerceBatch(jobId: string, options: { retryFailed?: boolean; confirmSameInput?: boolean } = {}) {
    if (!useServerConfigStore.getState().user) throw new Error("请先登录统一账号再运行批次；未提交模型请求");
    const account = batchAccount(), epoch = getCommerceAccountEpoch(), config = useConfigStore.getState().config;
    const runKey = JSON.stringify([account, jobId]);
    if (!navigator.locks) throw new Error("浏览器不支持安全批次锁，未提交任务");
    return navigator.locks.request("commerce-batch:" + runKey, { ifAvailable: true }, async (lock) => {
        if (!lock || activeRuns.has(runKey)) throw new Error("此批次正在其他页面运行，请查看原批次");
        const journal = readBatchJournal(jobId, account);
        const clients = new Set<TaskCenterClient>(), active = new Map<TaskCenterClient, Task>();
        const abort = new AbortController();
        let stopped = false;
        const assertSession = () => {
            if (account !== batchAccount() || epoch !== getCommerceAccountEpoch() || config !== useConfigStore.getState().config) throw new Error("账号或配置已改变，批次已停止，旧结果不会写回");
        };
        const assertCurrent = () => { assertSession(); if (stopped || abort.signal.aborted) throw new Error("批次已暂停，请恢复查询原任务"); };
        const changed = () => { assertSession(); writeBatchJournal(journal); emit(); };
        const row = (skuId: string, value: BatchSkuState) => { journal.skus[skuId] = value; changed(); };
        journal.stopped = false; changed();
        activeRuns.set(runKey, { stop: async () => {
            stopped = true; journal.stopped = true; changed();
            await Promise.allSettled([...active].map(async ([client, task]) => {
                if (task.actions.cancel.allowed) {
                    const canceled = await client.cancel(task);
                    const record = Object.values(journal.operations).find((op) => op.jobId === task.jobId);
                    if (record) { record.status = canceled.status; changed(); }
                }
            }));
            abort.abort();
        } });
        const unsubscribe = useServerConfigStore.subscribe(() => { try { assertSession(); } catch { stopped = true; abort.abort(); clients.forEach((client) => client.dispose()); } });
        try {
            const job = useCommerceStore.getState().jobs.find((item) => item.id === jobId);
            if (!job) throw new Error("任务不存在");
            for (const initial of job.skus) {
                assertCurrent();
                if (options.retryFailed && journal.skus[initial.id]?.status !== "failed") continue;
                if (!journal.skus[initial.id]) row(initial.id, { status: "queued" });
            }
            // Sequential scheduling keeps the model request owner explicit and preserves successful rows.
            for (const initial of job.skus) {
                if (stopped) break;
                assertCurrent();
                if (options.retryFailed && journal.skus[initial.id]?.status !== "failed") continue;
                const sku = useCommerceStore.getState().jobs.find((item) => item.id === jobId)!.skus.find((item) => item.id === initial.id)!;
                if (sku.stage === "ready") { row(sku.id, { status: "succeeded" }); continue; }
                if (["white-review", "content-review"].includes(sku.stage)) { row(sku.id, { status: "review", message: "等待人工审核后继续" }); continue; }
                row(sku.id, { status: "running" });
                const runtime: CommercePipelineRuntime = {
                    assertCurrent,
                    image: batchImageRunner({ journal, skuId: sku.id, revision: sku.activeRevision, assertCurrent: assertSession, changed, signal: abort.signal, clients, active, ...options }),
                    text: async (slot, modelConfig, messages) => {
                        assertCurrent();
                        const key = JSON.stringify([sku.id, sku.activeRevision, "text-" + slot]);
                        const fingerprint = await intentDigest(JSON.stringify([modelConfig.textModel, messages]));
                        const prior = journal.operations[key];
                        if (prior) {
                            if (prior.fingerprint !== fingerprint) throw new Error("文案输入变化，请核对原调用");
                            if (prior.status === "succeeded" && prior.text) return prior.text;
                            throw new Error("原文案调用结果待核实，禁止重复付费提交；可手动填写文案");
                        }
                        const record = { key, intentId: key, attempt: 1, channel: "text", fingerprint, status: "uncertain", text: "" };
                        journal.operations[key] = record; changed();
                        const answer = await requestImageQuestion(modelConfig, messages, () => undefined, { signal: abort.signal });
                        assertCurrent(); record.text = answer; record.status = "succeeded"; changed(); return answer;
                    },
                };
                try {
                    if (!sku.product.images.length || sku.product.imageStatus !== "ready") throw new Error("缺少可读商品图片，请先纠正该 SKU 映射");
                    const approved = sku.approvals.some((item) => item.gate === "white-background" && item.approved && item.assetRevision === sku.activeRevision);
                    const contentApproved = sku.approvals.some(item => item.gate === "content" && item.approved && item.assetRevision === sku.activeRevision);
                    if (sku.stage === "compliance") await runCompliance(jobId, sku.id, runtime);
                    else if (contentApproved) await localizeAndRender(jobId, sku.id, runtime);
                    else if (!approved) await prepareWhiteBackground(jobId, sku.id, "local", runtime);
                    else await generateContent(jobId, sku.id, runtime);
                    assertCurrent();
                    const completed = useCommerceStore.getState().jobs.find(item => item.id === jobId)!.skus.find(item => item.id === sku.id)!.stage === "ready";
                    row(sku.id, { status: completed ? "succeeded" : "review", message: completed ? "交付阶段完成" : "本阶段完成，等待人工审核" });
                } catch (error) {
                    assertSession();
                    row(sku.id, { status: stopped ? "paused" : "failed", message: error instanceof Error ? error.message : "生成失败" });
                }
            }
        } finally {
            unsubscribe(); abort.abort(); clients.forEach((client) => client.dispose()); activeRuns.delete(runKey); emit();
        }
    });
}
export type { BatchJournal };
