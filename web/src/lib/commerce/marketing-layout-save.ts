import { nanoid } from "nanoid";
import { useCommerceStore } from "@/stores/use-commerce-store";
import { uploadImage } from "@/services/image-storage";
import type { CompositionLayer, LayeredComposition, CommerceSku } from "@/types/commerce";
import { captureCommerceRequestSession } from "./request-session";
import { inspectCompositionLayout, freezeCompositionTypography } from "./marketing-typography";
import { saveLayoutPreset } from "./marketing-layout";
import { bindCompositionRaster, marketingReviewSignature } from "./marketing-layout-binding";
import { renderLayeredComposition } from "./template-renderer";
import { comparisonCompositionErrors } from "./comparison-composition";

const subjectTypes = new Set(["product", "background", "flattened", "decoration"]);
const mainText = (composition: LayeredComposition) => composition.layers.filter(layer => layer.type === "text" && !layer.name.startsWith("comparison-label-"));
function canonicalCopy(composition: LayeredComposition) {
    const text = mainText(composition);
    if (text.length !== 1 || !text[0].visible) throw new Error("请保留一个可见的营销文案图层，避免与任务文案不一致");
    return text[0].content || "";
}
function validateDraft(original: LayeredComposition, draft: LayeredComposition) {
    if (["id", "jobId", "skuId", "assetId", "requirementId", "locale", "siteLocale", "variantKey", "revision"].some(key => original[key as keyof LayeredComposition] !== draft[key as keyof LayeredComposition]) || draft.layoutVersion !== 2) throw new Error("排版草稿不属于当前任务版本，请重新打开编辑器");
    if (draft.layers.length !== original.layers.length || new Set(draft.layers.map(layer => layer.id)).size !== draft.layers.length) throw new Error("排版图层结构已变化，请重新打开编辑器");
    for (const originalLayer of original.layers) {
        const layer = draft.layers.find(item => item.id === originalLayer.id);
        if (!layer || layer.type !== originalLayer.type || layer.name !== originalLayer.name) throw new Error("不能更换排版图层身份");
        if (!["text", "shape"].includes(layer.type)) {
            const sourceFields: Array<keyof CompositionLayer> = ["content", "storageKey", "mimeType", "sourceAssetId", "comparisonRole"];
            if (sourceFields.some(key => layer[key] !== originalLayer[key]) || subjectTypes.has(layer.type) && (!layer.visible || layer.opacity < 0.95)) throw new Error("不能替换、移除或隐藏商品来源图层；请回到生成步骤更换素材");
        }
    }
}

/** Save a rendered, reviewed draft as a new revision; all asynchronous work precedes the single store transaction. */
export async function saveMarketingLayout(jobId: string, skuId: string, originalCompositionId: string, input: LayeredComposition, reviewer: string, options?: { presetName?: string }): Promise<void> {
    const session = captureCommerceRequestSession();
    try {
        const state = useCommerceStore.getState();
        const job = state.jobs.find(item => item.id === jobId);
        const sku = job?.skus.find(item => item.id === skuId);
        const original = sku?.compositions.find(item => item.id === originalCompositionId && item.revision === sku.activeRevision);
        if (!job || !sku || !original) throw new Error("当前版本的营销排版不存在，请重新打开编辑器");
        const originalAsset = sku.assets.find(asset => asset.compositionId === original.id && asset.revision === sku.activeRevision);
        if (!originalAsset || !["marketing", "marketing-preview"].includes(originalAsset.stage)) throw new Error("当前排版没有匹配的营销成图");
        const draft = structuredClone(input);
        validateDraft(original, draft);
        for (const layer of draft.layers) if (JSON.stringify(layer.textRaster) !== JSON.stringify(original.layers.find(l => l.id === layer.id)?.textRaster)) delete layer.textRaster;
        const skuSnapshot = JSON.stringify(sku);
        const configuration = JSON.stringify([job.generationConfig, job.policyPackId, job.policyVersion, job.brandProfileId, state.policyPacks, state.brands]);
        const assertCurrent = () => {
            session.assertCurrent();
            const latest = useCommerceStore.getState();
            const latestJob = latest.jobs.find(item => item.id === jobId);
            if (!latestJob || latestJob.skus.find(item => item.id === skuId) !== sku || JSON.stringify(sku) !== skuSnapshot || JSON.stringify([latestJob.generationConfig, latestJob.policyPackId, latestJob.policyVersion, latestJob.brandProfileId, latest.policyPacks, latest.brands]) !== configuration) throw new Error("任务、规则或品牌已变化，排版草稿尚未保存，请重新打开编辑器");
        };
        const oldCopy = canonicalCopy(original), copy = canonicalCopy(draft);
        const copyChanged = copy !== oldCopy;
        if (copyChanged && sku.compositions.some(item => item.revision === sku.activeRevision && item.id !== original.id && item.requirementId === original.requirementId && item.locale === original.locale && canonicalCopy(item) !== copy)) throw new Error("同一需求和语言的其他图片仍使用不同文案，请先统一文案后重新生成；本次排版未保存");
        const report = await inspectCompositionLayout(draft);
        if (report.errors.length) throw new Error(report.errors.join("；"));
        const sources = originalAsset.sourceAssetIds?.map(id => sku.assets.find(asset => asset.id === id && asset.revision === sku.activeRevision)).filter(asset => Boolean(asset)) || [];
        if (draft.layers.some(layer => layer.comparisonRole)) {
            const errors = comparisonCompositionErrors(draft, sources as typeof sku.assets);
            if (errors.length) throw new Error(errors.join("；"));
        }
        assertCurrent();
        await freezeCompositionTypography(draft);
        const blob = await renderLayeredComposition(draft, job.generationConfig);
        assertCurrent();
        const stored = await uploadImage(blob);
        const binding = await bindCompositionRaster(draft, blob);
        assertCurrent();
        const revision = sku.activeRevision + 1, now = new Date().toISOString();
        const chineseCopyChanged = copyChanged && !original.locale;
        const currentAssets = sku.assets.filter(asset => asset.revision === sku.activeRevision && !(chineseCopyChanged && asset.stage === "marketing"));
        const removedCompositionIds = new Set(sku.assets.filter(asset => asset.revision === sku.activeRevision && chineseCopyChanged && asset.stage === "marketing").map(asset => asset.compositionId));
        const currentCompositions = sku.compositions.filter(item => item.revision === sku.activeRevision && !removedCompositionIds.has(item.id));
        const assetIds = new Map(currentAssets.map(asset => [asset.id, nanoid()]));
        const compositionIds = new Map(currentCompositions.map(item => [item.id, nanoid()]));
        const nextCompositions = currentCompositions.map(item => {
            const next = item.id === original.id ? draft : structuredClone(item);
            return { ...next, id: compositionIds.get(item.id)!, revision, assetId: next.assetId ? assetIds.get(next.assetId) || next.assetId : undefined, layers: next.layers.map(layer => ({ ...layer, sourceAssetId: layer.sourceAssetId ? assetIds.get(layer.sourceAssetId) || layer.sourceAssetId : undefined })), createdAt: now, updatedAt: now };
        });
        const nextAssets = currentAssets.map(asset => ({ ...asset, ...(asset.id === originalAsset.id ? { ...stored, ...binding, prompt: copy } : {}), id: assetIds.get(asset.id)!, revision, compositionId: asset.compositionId ? compositionIds.get(asset.compositionId) : undefined, sourceAssetIds: asset.sourceAssetIds?.map(id => assetIds.get(id) || id), createdAt: now }));
        const approvals = sku.approvals.filter(approval => approval.gate === "white-background" && approval.approved && approval.assetRevision === sku.activeRevision).map(approval => ({ ...approval, assetRevision: revision }));
        const copyZh = { ...sku.copyZh }, localizedCopy = structuredClone(sku.localizedCopy);
        if (copyChanged) {
            if (original.locale) localizedCopy[original.locale] = { ...localizedCopy[original.locale], [original.requirementId]: copy };
            else { copyZh[original.requirementId] = copy; for (const locale of Object.keys(localizedCopy) as Array<keyof typeof localizedCopy>) delete localizedCopy[locale]?.[original.requirementId]; }
        }
        const presetName = options?.presetName?.trim();
        const marketingLayouts = presetName ? [...(sku.marketingLayouts || []), saveLayoutPreset(draft, presetName)] : sku.marketingLayouts;
        const nextSku: CommerceSku = { ...sku, activeRevision: revision, assets: [...sku.assets, ...nextAssets], compositions: [...sku.compositions, ...nextCompositions], approvals, checks: [], copyZh, localizedCopy, marketingLayouts, marketingLayoutReview: undefined, stage: approvals.length ? "content-review" as const : "white-review" as const, stageMessage: chineseCopyChanged ? "中文文案和排版已更新，请重新审核并生成翻译终稿" : "营销排版已保存为新版本，请重新审核内容" };
        if (original.locale) nextSku.marketingLayoutReview = { revision, signature: marketingReviewSignature(job, nextSku) };
        assertCurrent();
        // Zustand persist returns its storage promise at runtime. Never report success before it settles.
        const previous = useCommerceStore.getState();
        const transaction = useCommerceStore.setState as unknown as (update: Partial<typeof previous>) => unknown;
        const patch = { jobs: previous.jobs.map(item => item.id === jobId ? { ...item, skus: item.skus.map(value => value.id === skuId ? nextSku : value), status: "waiting-review" as const, updatedAt: now } : item), audit: [{ id: nanoid(), action: "保存营销自定义排版", actor: reviewer, jobId, skuId, detail: `版本 ${revision}`, createdAt: now }, ...previous.audit].slice(0, 2000) };
        const pending = transaction(patch);
        const committed = useCommerceStore.getState();
        try { await pending; } catch (error) {
            if (useCommerceStore.getState() === committed) {
                try { await transaction({ jobs: previous.jobs, audit: previous.audit }); } catch { /* Preserve original persistence error. */ }
            }
            throw error;
        }
    } finally { session.dispose(); }
}
