import { GENERATION_ASSET_STAGES, GENERATION_STAGE_LABELS, requirementVariantValues, selectedRequirementPresets } from "@/lib/commerce/generation-config";
import { detailSourceFingerprint, detailSourceImages, usesDetailSources } from "@/lib/commerce/detail-sources";
import type { CommerceJob, CommerceLocale, CommerceRequirementPreset, CommerceSku, GeneratedAsset, GenerationAssetStage, RequirementSelection } from "@/types/commerce";

export type VisualPlanItem = {
    key: string; fingerprint: string; preset: CommerceRequirementPreset; selection: RequirementSelection;
    stage: GenerationAssetStage | "marketing-base" | "comparison-source"; sequence: number; variantKey: string; siteLocale?: CommerceLocale;
    comparisonRole?: "before" | "after"; comparisonGroupKey?: string;
};

export function requirementLocales(job: CommerceJob, selection: RequirementSelection): CommerceLocale[] {
    return [...new Set(selection.siteLocales?.length ? job.locales.filter((locale) => selection.siteLocales!.includes(locale)) : job.locales)];
}

export function visualSiteLocales(job: CommerceJob, selection: RequirementSelection): Array<CommerceLocale | undefined> {
    return job.generationConfig.siteImageMode === "per-site" || selection.variantScope === "per-site" ? requirementLocales(job, selection) : [undefined];
}

export function visualMode(preset: CommerceRequirementPreset, selection: RequirementSelection) {
    return selection.visualMode || preset.visualMode || "generate";
}

export function visualKey(requirementId: string, sequence: number, variantKey = "", siteLocale?: CommerceLocale) {
    return JSON.stringify([requirementId, sequence, variantKey, siteLocale || "shared"]);
}

export function isPairedVisual(job: CommerceJob, preset: CommerceRequirementPreset) {
    return job.visualPipelineVersion === 3 && preset.generationStrategy === "paired-before-after";
}

/** Stable across canvas revision clones; a replaced bitmap invalidates its dependents. */
export function visualContentIdentity(asset: GeneratedAsset) { return asset.storageKey || asset.url; }

export function matchVisualPlanItem(sku: CommerceSku, item: VisualPlanItem): GeneratedAsset {
    const matches = sku.assets.filter((asset) => asset.revision === sku.activeRevision && asset.visualKey === item.key && asset.visualFingerprint === item.fingerprint && asset.stage === item.stage && asset.requirementId === item.preset.id && asset.sequence === item.sequence && (asset.variantKey || "") === item.variantKey && asset.siteLocale === item.siteLocale && asset.comparisonRole === item.comparisonRole && asset.comparisonGroupKey === item.comparisonGroupKey);
    if (matches.length !== 1) throw new Error(item.preset.title + "：缺少对应场景画面或画面已过期，请先生成需求画面（不再自动套用白底图）");
    return matches[0];
}

/** Pure planning is also the contract used by retry, review and export. */
export function buildVisualPlan(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[]): VisualPlanItem[] {
    let selected = selectedRequirementPresets(job, sku, presets);
    // An explicit (even wholly disabled) selection list is authoritative.
    if (!sku.requirementSelections.length) {
        selected = GENERATION_ASSET_STAGES.filter((stage) => job.generationConfig.assetCounts[stage] > 0).map((stage) => {
            const preset: CommerceRequirementPreset = {
                id: "compat-" + stage, category: sku.product.category, order: 0, title: GENERATION_STAGE_LABELS[stage], stage,
                enabledByDefault: true, defaultCount: job.generationConfig.assetCounts[stage], prompt: GENERATION_STAGE_LABELS[stage],
                layout: "single-hero", chineseCopy: "", translationSeeds: {}, requiredFacts: [], referenceIds: [], variantScope: "per-sku", needsReview: false,
            };
            return { preset, selection: { requirementId: preset.id, enabled: true, count: preset.defaultCount, referenceIds: [], variantScope: "per-sku" as const, variantValues: [] } };
        });
    }
    const white = sku.assets.find((asset) => asset.revision === sku.activeRevision && asset.stage === "main-white");
    const result: VisualPlanItem[] = [];
    for (const { preset, selection } of selected) {
        const paired = isPairedVisual(job, preset);
        if (preset.stage === "marketing" && (!job.generationConfig.marketingEnabled || (!paired && visualMode(preset, selection) === "white-layout"))) continue;
        for (const siteLocale of visualSiteLocales(job, selection)) for (const variantKey of requirementVariantValues(sku, selection)) for (let sequence = 1; sequence <= selection.count; sequence += 1) {
            const key = visualKey(preset.id, sequence, variantKey, siteLocale);
            const detail = usesDetailSources(sku, preset, selection);
            const fingerprint = JSON.stringify({
                version: job.visualPipelineVersion === 3 ? 3 : 2, key, stage: preset.stage, kind: selection.visualKind || preset.visualKind || (preset.stage === "marketing" ? "scene" : preset.stage),
                ...(job.visualPipelineVersion === 3 ? { creative: [job.generationConfig.creativeBrief, preset.creativeBrief, selection.creativeBrief], strategy: preset.generationStrategy, recipeRole: preset.recipeRole,
                    information: [sku.product.audience, sku.product.materialDescription, sku.product.usageInstructions] } : {}),
                prompt: selection.promptOverride ?? preset.prompt, layout: selection.layout || preset.layout, references: selection.referenceIds,
                white: !detail && white ? white.storageKey || white.url : null,
                ...(detail ? { detail: detailSourceFingerprint(sku, preset, selection, variantKey) } : {}),
                ...(sku.product.categoryId ? { category: [sku.product.categoryId, sku.product.subcategoryId] } : {}),
                product: { name: sku.product.name, category: sku.product.category, description: sku.product.description, size: sku.product.size,
                    facts: Object.entries(sku.product.verifiedFacts).sort(([a], [b]) => a.localeCompare(b)),
                    photos: detail ? [] : sku.product.images.map((image) => image.storageKey || image.url) },
                policy: [job.policyPackId, job.policyVersion], platform: job.platform,
                sites: siteLocale ? [siteLocale] : job.locales, siteMode: job.generationConfig.siteImageMode,
                output: job.generationConfig.outputSpec,
            });
            if (paired) {
                const before: VisualPlanItem = { key: key + ":before", fingerprint: JSON.stringify([fingerprint, "before"]), preset, selection, stage: "comparison-source", sequence, variantKey, siteLocale, comparisonRole: "before", comparisonGroupKey: key };
                result.push(before);
                let source: GeneratedAsset | undefined;
                try { source = matchVisualPlanItem(sku, before); } catch { /* AFTER stays unready until BEFORE exists. */ }
                result.push({ ...before, key: key + ":after", comparisonRole: "after", fingerprint: JSON.stringify([fingerprint, "after", source ? [source.visualFingerprint, visualContentIdentity(source)] : null]) });
            } else result.push({ key, fingerprint, preset, selection, stage: preset.stage === "marketing" ? "marketing-base" : preset.stage, sequence, variantKey, siteLocale });
        }
    }
    return result;
}

export function visualPreflightErrors(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[]): string[] {
    const errors: string[] = [];
    const placeholder = /X{2,}|待填写|待确认|TODO|\{[^}]+\}/i;
    const selected = selectedRequirementPresets(job, sku, presets).filter(({ preset }) => preset.stage !== "marketing" || job.generationConfig.marketingEnabled);
    const known = new Set(presets.map((preset) => preset.id));
    for (const selection of sku.requirementSelections) if (selection.enabled && selection.count > 0 && !known.has(selection.requirementId)) errors.push("找不到所选需求方案：" + selection.requirementId);
    for (const { preset, selection } of selected) {
        if (usesDetailSources(sku, preset, selection)) {
            if (visualMode(preset, selection) === "white-layout") errors.push(preset.title + "：细节素材不能使用正面白底排版，请选择保真优化或原图排版");
            for (const variant of requirementVariantValues(sku, selection)) {
                try { detailSourceImages(sku, preset, selection, variant); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
            }
        }
        if (isPairedVisual(job, preset)) {
            if (visualMode(preset, selection) === "white-layout") errors.push(preset.title + "：前后对比不支持白底排版，请使用独立生成画面");
            if ((selection.layout || preset.layout) !== "before-after") errors.push(preset.title + "：前后对比必须使用 before-after 版式");
        }
        const prompt = (selection.promptOverride ?? preset.prompt).trim();
        if (!prompt || /^(无|none|null)$/i.test(prompt)) errors.push(preset.title + "：请补充明确的画面要求");
        if (!requirementLocales(job, selection).length) errors.push(preset.title + "：适用站点与任务目标站点没有交集");
        for (const fact of preset.requiredFacts) if (!sku.product.verifiedFacts[fact]?.trim() || placeholder.test(sku.product.verifiedFacts[fact])) errors.push(preset.title + "：缺少已确认参数“" + fact + "”");
        if (preset.requiredFacts.length && !sku.product.factsConfirmed) errors.push(preset.title + "：请先确认产品事实");
        if (["per-color", "per-size", "custom"].includes(selection.variantScope) && requirementVariantValues(sku, selection).some((value) => !value.trim())) errors.push(preset.title + "：请补充颜色、尺寸或组合变体");
    }
    return [...new Set(errors)];
}

export function matchVisualSources(job: CommerceJob, sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection, sequence: number, variantKey: string, siteLocale?: CommerceLocale, assets: GeneratedAsset[] = sku.assets): GeneratedAsset[] {
    if (!isPairedVisual(job, preset) && visualMode(preset, selection) === "white-layout") {
        const white = assets.find((asset) => asset.revision === sku.activeRevision && asset.stage === "main-white") || sku.assets.find((asset) => asset.revision === sku.activeRevision && asset.stage === "main-white");
        if (!white || !sku.approvals.some((approval) => approval.gate === "white-background" && approval.approved && approval.assetRevision === sku.activeRevision)) throw new Error("请先批准白底主图");
        return [white];
    }
    const effectiveSite = visualSiteLocales(job, selection)[0] === undefined ? undefined : siteLocale;
    const key = visualKey(preset.id, sequence, variantKey, effectiveSite);
    const sourceSku = { ...sku, assets, requirementSelections: [selection] };
    // Callers may supply only candidate visuals; retain the SKU's white identity
    // for fingerprinting, while BEFORE/AFTER must both be in the candidate set.
    const planSku = assets.some((asset) => asset.revision === sku.activeRevision && asset.stage === "main-white") ? sourceSku : { ...sourceSku, assets: [...assets, ...sku.assets.filter((asset) => asset.revision === sku.activeRevision && asset.stage === "main-white")] };
    const plan = buildVisualPlan(job, planSku, [preset]).filter((item) => item.key === key || item.comparisonGroupKey === key);
    if (plan.length !== (isPairedVisual(job, preset) ? 2 : 1)) throw new Error(preset.title + "：缺少对应场景画面");
    const sources = plan.map((item) => matchVisualPlanItem(sourceSku, item));
    if (sources.length === 2 && (sources[0].id === sources[1].id || visualContentIdentity(sources[0]) === visualContentIdentity(sources[1]))) throw new Error(preset.title + "：前后画面必须使用不同素材");
    return sources;
}

export function matchVisualSource(...args: Parameters<typeof matchVisualSources>): GeneratedAsset { return matchVisualSources(...args)[0]; }

export function assertVisualsReady(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[]): void {
    if (!sku.approvals.some((approval) => approval.gate === "white-background" && approval.approved && approval.assetRevision === sku.activeRevision)) throw new Error("请先批准白底主图");
    const errors = visualPreflightErrors(job, sku, presets);
    if (errors.length) throw new Error(errors.join("；"));
    for (const item of buildVisualPlan(job, sku, presets)) matchVisualSource(job, sku, item.preset, item.selection, item.sequence, item.variantKey, item.siteLocale);
}

export function isFinalAsset(asset: GeneratedAsset): boolean {
    return asset.stage !== "marketing-preview" && asset.stage !== "marketing-base" && asset.stage !== "comparison-source";
}
