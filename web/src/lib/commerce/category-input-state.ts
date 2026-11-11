import { buildVisualPlan } from "@/lib/commerce/visual-plan";
import type { CommerceJob, CommerceSku, PolicyPack, ProductRecord } from "@/types/commerce";

/** Imported names resolve only exact, unique aliases; broad/ambiguous categories stay pending. */
export function mapProductCategory(pack: PolicyPack, product: ProductRecord): ProductRecord {
    if (!pack.categories?.length || product.categoryId) return product;
    const hint = product.extraFields["细分类目"] || product.category;
    const candidates = pack.categories.filter((node) => node.active && (node.name === hint || node.aliases.includes(hint)));
    if (candidates.length !== 1) return product;
    const node = candidates[0];
    return { ...product, categoryId: node.parentId || node.id, subcategoryId: node.parentId ? node.id : undefined };
}

export function invalidateCategoryInputs(job: CommerceJob, previous: CommerceSku, next: CommerceSku, pack?: PolicyPack): CommerceSku {
    const categoryChanged = previous.product.categoryId !== next.product.categoryId || previous.product.subcategoryId !== next.product.subcategoryId;
    const detailChanged = JSON.stringify(previous.product.detailImages || []) !== JSON.stringify(next.product.detailImages || []);
    if (!categoryChanged && !detailChanged) return next;
    const presets = pack?.requirementPresets || [];
    const after = new Map(buildVisualPlan(job, next, presets).map((item) => [item.key, item.fingerprint]));
    const changedKeys = new Set(
        buildVisualPlan(job, previous, presets)
            .filter((item) => item.fingerprint !== after.get(item.key))
            .map((item) => item.key),
    );
    const changedRequirements = new Set(
        previous.requirementSelections
            .filter(
                (selection) =>
                    detailChanged &&
                    JSON.stringify((previous.product.detailImages || []).filter((image) => selection.sourceImageIds?.includes(image.id))) !==
                        JSON.stringify((next.product.detailImages || []).filter((image) => selection.sourceImageIds?.includes(image.id))),
            )
            .map((selection) => selection.requirementId),
    );
    const removed = new Set(
        next.assets.filter((asset) => asset.revision === next.activeRevision && asset.stage !== "main-white" && (categoryChanged || changedKeys.has(asset.visualKey || "") || changedRequirements.has(asset.requirementId || ""))).map((asset) => asset.id),
    );
    let expanded = true;
    while (expanded) {
        expanded = false;
        for (const asset of next.assets)
            if (asset.revision === next.activeRevision && !removed.has(asset.id) && asset.sourceAssetIds?.some((id) => removed.has(id))) {
                removed.add(asset.id);
                expanded = true;
            }
    }
    if (!categoryChanged && !changedKeys.size && !changedRequirements.size && !removed.size) return next;
    const affected = new Set([...changedRequirements, ...next.assets.filter((asset) => removed.has(asset.id)).map((asset) => asset.requirementId || "")]);
    const copy = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([key]) => !categoryChanged && !affected.has(key)));
    const whiteApproved = next.approvals.some((approval) => approval.gate === "white-background" && approval.approved && approval.assetRevision === next.activeRevision);
    return {
        ...next,
        assets: next.assets.filter((asset) => !removed.has(asset.id)),
        compositions: next.compositions.filter((item) => item.revision !== next.activeRevision || (!categoryChanged && !affected.has(item.requirementId))),
        approvals: next.approvals.filter((approval) => approval.assetRevision !== next.activeRevision || approval.gate !== "content"),
        checks: [],
        copyZh: copy(next.copyZh),
        localizedCopy: Object.fromEntries(Object.entries(next.localizedCopy).map(([locale, value]) => [locale, copy(value)])),
        stage: whiteApproved ? "content-generation" : next.stage,
        stageMessage: "类目或细节素材已更新，请生成并审核受影响图片",
    };
}
