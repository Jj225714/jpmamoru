import type { CommerceJob, CommerceSku, GeneratedAsset } from "@/types/commerce";
import { validateConsistencyConstraint } from "./consistency-check";
export type ConsistencyScope = "white" | "content" | "all";
export const canonicalConsistency = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function currentConsistencyAssets(sku: CommerceSku, scope: ConsistencyScope) { return sku.assets.filter(a => a.revision === sku.activeRevision && (scope === "white" ? a.stage === "main-white" : scope === "content" ? !["marketing", "marketing-preview"].includes(a.stage) : !["marketing-preview", "marketing-base", "comparison-source"].includes(a.stage))); }
export function consistencyStateSignature(job: CommerceJob | undefined, sku: CommerceSku, asset: GeneratedAsset) {
    const composition = sku.compositions.find(c => c.id === asset.compositionId && c.revision === sku.activeRevision);
    return canonicalConsistency({ constraint: sku.consistency?.constraints, source: sku.product.images.find(i => i.id === sku.consistency?.constraints.sourceImageId), revision: sku.activeRevision,
        asset: { id: asset.id, revision: asset.revision, url: asset.url, storageKey: asset.storageKey, width: asset.width, height: asset.height, compositionId: asset.compositionId, request: asset.consistencyRequest },
        config: job?.generationConfig, locales: job?.locales, composition });
}
export function latestConsistencyReport(sku: CommerceSku, assetId: string) { return Array.isArray(sku.consistency?.reports) ? sku.consistency.reports.filter(r => r && r.assetId === assetId).at(-1) : undefined; }
function matchesSignature(saved: string, job: CommerceJob | undefined, sku: CommerceSku, asset: GeneratedAsset) {
    if (job) return saved === consistencyStateSignature(job, sku, asset);
    try { const parsed = JSON.parse(saved); delete parsed.config; delete parsed.locales; return canonicalConsistency(parsed) === consistencyStateSignature(undefined, sku, asset); } catch { return false; }
}
/** Pure gate: callers without a job check SKU evidence; export additionally verifies current job and bytes. */
export function consistencyBlockReason(job: CommerceJob | undefined, sku: CommerceSku, scope: ConsistencyScope = "all"): string | undefined {
    const c = sku.consistency?.constraints;
    if (!c) return sku.consistency || sku.assets.some(a => a.consistencyRequest) ? "已受约束任务缺少约束，不能跳过一致性复核" : undefined;
    if (validateConsistencyConstraint(c).length) return "尺寸/图案约束数据无效，请重新确认";
    if (!c.confirmedAt || !c.confirmedBy || !c.plane.frontViewConfirmed) return "尺寸/图案约束尚未确认";
    const assets = currentConsistencyAssets(sku, scope); if (!assets.length) return "尚无当前版本结果可完成一致性复核";
    for (const asset of assets) {
        if (!asset.consistencyRequest || canonicalConsistency(asset.consistencyRequest.constraints) !== canonicalConsistency(c)) return asset.title + " 未按当前确认约束生成，请返修";
        const report = latestConsistencyReport(sku, asset.id);
        if (!report || report.status !== "pass" || report.numericStatus !== "pass" || report.decision?.action !== "accept") return asset.title + " 尚未通过尺寸/图案人工复核";
        if (!matchesSignature(report.stateSignature, job, sku, asset) || report.constraintRevision !== c.revision || report.constraintHash !== asset.consistencyRequest.hash || report.requestHash !== asset.consistencyRequest.hash) return asset.title + " 的一致性报告已过期";
    }
    return undefined;
}
