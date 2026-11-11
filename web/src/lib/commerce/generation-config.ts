import { COMMERCE_LOCALES, type BrandGenerationDefaults, type CommerceGenerationConfig, type CommerceJob, type CommerceLocale, type CommerceRequirementPreset, type CommerceSku, type GenerationAssetStage, type RequirementSelection } from "@/types/commerce";
import { normalizeCreativeBrief } from "./creative-brief";

export const GENERATION_ASSET_STAGES: GenerationAssetStage[] = ["scene", "detail", "usage-size", "detail-white"];

export const GENERATION_STAGE_LABELS: Record<GenerationAssetStage, string> = {
    scene: "空间场景图", detail: "材质特写图", "usage-size": "用途与尺寸图", "detail-white": "特写白底图",
};

export const LOCALE_LABELS: Record<CommerceLocale, string> = {
    "en-US": "英语（美国）", "en-GB": "英语（英国）", "th-TH": "泰语", "vi-VN": "越南语", "ms-MY": "马来语", "fil-PH": "菲律宾语", "id-ID": "印尼语",
};

export const DEFAULT_COMMERCE_GENERATION_CONFIG: CommerceGenerationConfig = {
    assetCounts: { scene: 1, detail: 1, "usage-size": 1, "detail-white": 0 },
    marketingEnabled: true,
    outputSpec: { size: 1024, format: "jpeg", maxBytes: 2 * 1024 * 1024, colorSpace: "sRGB", dpi: 96 },
    siteImageMode: "shared",
    delivery: "editableCanvas",
    overlay: {
        logo: { placement: "top-right", applyTo: "marketing", customStages: [] },
        watermark: { mode: "single", position: "center", opacity: 0.05, applyTo: "marketing", customStages: [] },
    },
};

export const DEFAULT_BRAND_GENERATION_DEFAULTS: BrandGenerationDefaults = {
    ...cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG), locales: COMMERCE_LOCALES.filter((locale) => locale !== "en-GB"),
};

type LegacyConfig = Partial<CommerceGenerationConfig> & { logoPlacement?: CommerceGenerationConfig["overlay"]["logo"]["placement"]; watermark?: Partial<CommerceGenerationConfig["overlay"]["watermark"]> };

export function normalizeGenerationConfig(value?: LegacyConfig, watermarkRange: [number, number] = [0.03, 0.3]): CommerceGenerationConfig {
    const assetCounts = Object.fromEntries(GENERATION_ASSET_STAGES.map((stage) => [stage, clampCount(value?.assetCounts?.[stage] ?? DEFAULT_COMMERCE_GENERATION_CONFIG.assetCounts[stage])])) as CommerceGenerationConfig["assetCounts"];
    const legacyLogo = value?.logoPlacement;
    const legacyWatermark = value?.watermark;
    const overlay = value?.overlay;
    return {
        assetCounts,
        ...(value?.creativeBrief !== undefined ? { creativeBrief: normalizeCreativeBrief(value.creativeBrief) } : {}),
        marketingEnabled: value?.marketingEnabled ?? DEFAULT_COMMERCE_GENERATION_CONFIG.marketingEnabled,
        outputSpec: {
            size: [800, 1024, 1254, 1600].includes(Number(value?.outputSpec?.size)) ? value!.outputSpec!.size : 1024,
            format: value?.outputSpec?.format === "png" ? "png" : "jpeg",
            maxBytes: Math.max(256 * 1024, Number(value?.outputSpec?.maxBytes) || 2 * 1024 * 1024),
            colorSpace: "sRGB",
            dpi: [96, 120, 150].includes(Number(value?.outputSpec?.dpi)) ? value!.outputSpec!.dpi : 96,
        },
        siteImageMode: value?.siteImageMode === "per-site" ? "per-site" : "shared",
        delivery: value?.delivery === "flattenedOnly" ? "flattenedOnly" : "editableCanvas",
        overlay: {
            logo: {
                placement: overlay?.logo?.placement || legacyLogo || DEFAULT_COMMERCE_GENERATION_CONFIG.overlay.logo.placement,
                applyTo: overlay?.logo?.applyTo || "marketing",
                customStages: [...(overlay?.logo?.customStages || [])],
            },
            watermark: {
                mode: overlay?.watermark?.mode || legacyWatermark?.mode || DEFAULT_COMMERCE_GENERATION_CONFIG.overlay.watermark.mode,
                position: overlay?.watermark?.position || legacyWatermark?.position || DEFAULT_COMMERCE_GENERATION_CONFIG.overlay.watermark.position,
                opacity: clampOpacity(overlay?.watermark?.opacity ?? legacyWatermark?.opacity, watermarkRange),
                applyTo: overlay?.watermark?.applyTo || "marketing",
                customStages: [...(overlay?.watermark?.customStages || [])],
            },
        },
    };
}

export function normalizeLocales(locales?: CommerceLocale[]) {
    const values = (locales || []).filter((locale): locale is CommerceLocale => COMMERCE_LOCALES.includes(locale));
    return values.length ? Array.from(new Set(values)) : [...DEFAULT_BRAND_GENERATION_DEFAULTS.locales];
}

export function createRequirementSelections(presets: CommerceRequirementPreset[], defaults?: RequirementSelection[]) {
    const overrides = new Map((defaults || []).map((item) => [item.requirementId, item]));
    return presets.map((preset): RequirementSelection => {
        const override = overrides.get(preset.id);
        return {
            requirementId: preset.id, enabled: override?.enabled ?? preset.enabledByDefault, count: clampCount(override?.count ?? preset.defaultCount),
            promptOverride: override?.promptOverride, referenceIds: [...(override?.referenceIds ?? preset.referenceIds)],
            ...(preset.detailPurpose ? { detailPurpose: preset.detailPurpose, detailRenderMode: "optimize" as const } : {}),
            visualMode: override?.visualMode ?? preset.visualMode ?? "generate", visualKind: override?.visualKind ?? preset.visualKind ?? (preset.stage === "marketing" ? "scene" : preset.stage),
            layout: override?.layout || preset.layout, variantScope: override?.variantScope || preset.variantScope, variantValues: [...(override?.variantValues || [])],
            siteLocales: override?.siteLocales ? [...override.siteLocales] : undefined, reviewed: preset.needsReview ? false : (override?.reviewed ?? true),
            ...(override?.creativeBrief !== undefined ? { creativeBrief: normalizeCreativeBrief(override.creativeBrief) } : {}),
        };
    });
}

export function selectedRequirementPresets(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[]) {
    const map = new Map(presets.map((item) => [item.id, item]));
    return (sku.requirementSelections || []).filter((item) => item.enabled && item.count > 0).map((selection) => ({ selection, preset: map.get(selection.requirementId) })).filter((item): item is { selection: RequirementSelection; preset: CommerceRequirementPreset } => Boolean(item.preset));
}

export function requirementVariantValues(sku: CommerceSku, selection: RequirementSelection) {
    if (selection.variantScope === "custom") return selection.variantValues.length ? selection.variantValues : [""];
    if (selection.variantScope === "per-color") return splitVariants(sku.product.verifiedFacts["颜色"] || sku.product.extraFields["颜色"] || sku.product.extraFields["花色"]);
    if (selection.variantScope === "per-size") return splitVariants(sku.product.verifiedFacts["尺寸列表"] || sku.product.size);
    return [""];
}

export function requirementFactFields(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[]): string[] {
    return Array.from(new Set(selectedRequirementPresets(job, sku, presets)
        .filter(({ preset }) => preset.stage !== "marketing" || job.generationConfig.marketingEnabled)
        .flatMap(({ preset, selection }) => [...preset.requiredFacts,
            ...(selection.variantScope === "per-color" ? ["颜色"] : selection.variantScope === "per-size" ? ["尺寸列表"] : [])])));
}

export function requirementOutputCount(job: CommerceJob, sku: CommerceSku, selection: RequirementSelection, preset: CommerceRequirementPreset) {
    if (!selection.enabled || selection.count <= 0) return 0;
    const variants = requirementVariantValues(sku, selection).length;
    const locales = [...new Set(selection.siteLocales?.length ? job.locales.filter((locale) => selection.siteLocales!.includes(locale)) : job.locales)];
    if (preset.stage === "marketing") return job.generationConfig.marketingEnabled ? selection.count * variants * locales.length : 0;
    const siteCount = job.generationConfig.siteImageMode === "per-site" || selection.variantScope === "per-site" ? locales.length : 1;
    return selection.count * variants * siteCount;
}

export function contentAssetCount(config: CommerceGenerationConfig) {
    return GENERATION_ASSET_STAGES.reduce((sum, stage) => sum + config.assetCounts[stage], 0);
}

export function expectedAssetCount(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[] = []) {
    if (sku.requirementSelections?.length) return 1 + selectedRequirementPresets(job, sku, presets).reduce((sum, item) => sum + requirementOutputCount(job, sku, item.selection, item.preset), 0);
    return 1 + contentAssetCount(job.generationConfig) * fallbackSiteCount(job) + (job.generationConfig.marketingEnabled ? job.locales.length * sku.selectedTemplateIds.length : 0);
}

export function expectedStageCounts(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[] = []) {
    if (sku.requirementSelections?.length) {
        const result: Record<string, number> = { "main-white": 1, scene: 0, detail: 0, "usage-size": 0, "detail-white": 0, "marketing-base": 0, marketing: 0 };
        for (const item of selectedRequirementPresets(job, sku, presets)) result[item.preset.stage] += requirementOutputCount(job, sku, item.selection, item.preset);
        return result;
    }
    const counts = Object.fromEntries(GENERATION_ASSET_STAGES.map((stage) => [stage, job.generationConfig.assetCounts[stage] * fallbackSiteCount(job)])) as CommerceGenerationConfig["assetCounts"];
    return { "main-white": 1, "marketing-base": 0, ...counts, marketing: job.generationConfig.marketingEnabled ? job.locales.length * sku.selectedTemplateIds.length : 0 };
}

function fallbackSiteCount(job: CommerceJob) {
    return (job.visualPipelineVersion === 2 || job.visualPipelineVersion === 3) && job.generationConfig.siteImageMode === "per-site" ? job.locales.length : 1;
}

export function cloneGenerationConfig(config: CommerceGenerationConfig): CommerceGenerationConfig {
    return {
        assetCounts: { ...config.assetCounts }, marketingEnabled: config.marketingEnabled, outputSpec: { ...config.outputSpec }, siteImageMode: config.siteImageMode, delivery: config.delivery,
        ...(config.creativeBrief !== undefined ? { creativeBrief: normalizeCreativeBrief(config.creativeBrief) } : {}),
        overlay: { logo: { ...config.overlay.logo, customStages: [...config.overlay.logo.customStages] }, watermark: { ...config.overlay.watermark, customStages: [...config.overlay.watermark.customStages] } },
    };
}

export function overlayApplies(applyTo: "marketing" | "all" | "custom", customStages: string[], stage: string) {
    return applyTo === "all" || (applyTo === "marketing" && ["marketing", "marketing-preview"].includes(stage)) || (applyTo === "custom" && customStages.includes(stage));
}

function splitVariants(value: string) { const values = String(value || "").split(/[、,，/|;；\n]+/).map((item) => item.trim()).filter(Boolean); return values.length ? Array.from(new Set(values)) : [""]; }
function clampCount(value: unknown) { return Math.max(0, Math.min(4, Math.round(Number(value) || 0))); }
function clampOpacity(value: unknown, range: [number, number]) { return Math.max(range[0], Math.min(range[1], Number(value) || 0.05)); }
