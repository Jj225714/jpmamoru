import { categoryPreflightErrors, categoryPrompt, isCategoryPeopleRule, resolveCategory } from "@/lib/commerce/category-rules";
import { detailPrompt, detailSourceImages, usesDetailSources } from "@/lib/commerce/detail-sources";
import type { CommerceCreativeBrief, CommerceJob, CommerceRequirementPreset, CommerceSku, GenerationAssetStage, PolicyPack, RequirementSelection, StoredImageRef } from "@/types/commerce";

export const COMMERCE_REFERENCE_LIMIT = 16;

export function effectiveVisualKind(preset: CommerceRequirementPreset, selection: RequirementSelection): GenerationAssetStage {
    return selection.visualKind || preset.visualKind || (preset.stage === "marketing" ? "scene" : preset.stage);
}

export function categoryBrief(pack: PolicyPack, sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection): CommerceCreativeBrief | undefined {
    const resolved = resolveCategory(pack, sku.product);
    if (!resolved) return undefined;
    const kind = effectiveVisualKind(preset, selection);
    const brief = {
        ...resolved.creativeBrief,
        ...(kind === "detail" || kind === "detail-white" ? { people: "none" as const, framing: "close" as const, scene: "" } : {}),
    };
    for (const rule of resolved.rules.filter((rule) => rule.strength === "required" && rule.stages.includes(kind) && !(selection.creativeBrief?.people === "none" && isCategoryPeopleRule(rule)))) {
        if (rule.key === "people") brief.people = rule.value as CommerceCreativeBrief["people"];
        if (rule.key === "scene") brief.scene = rule.value;
    }
    if (selection.creativeBrief?.people) brief.people = selection.creativeBrief.people;
    return brief;
}

export function categorySelectionErrors(pack: PolicyPack, job: CommerceJob, sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection) {
    const errors = categoryPreflightErrors(pack, sku.product);
    const resolved = resolveCategory(pack, sku.product);
    if (!resolved) return errors;
    if (!resolved.requirementIds.includes(preset.id)) errors.push(`${preset.title}不属于当前类目，请重新选择方案`);
    const kind = effectiveVisualKind(preset, selection);
    return errors;
}

export function generationReferences(pack: PolicyPack, sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection, variantKey: string, white?: StoredImageRef): StoredImageRef[] {
    if (usesDetailSources(sku, preset, selection)) return detailSourceImages(sku, preset, selection, variantKey);
    const kind = effectiveVisualKind(preset, selection);
    const category = resolveCategory(pack, sku.product);
    const ids = kind === "detail" || kind === "detail-white" ? selection.referenceIds : [...(category?.referenceIds || []), ...selection.referenceIds];
    const refs = ids.map((id) => {
        const ref = pack.references.find((candidate) => candidate.id === id);
        if (!ref) throw new Error(`${preset.title}：参考图不存在 ${id}`);
        return ref;
    });
    return [...new Map([...(white ? [white] : []), ...sku.product.images, ...refs].map((ref) => [ref.id, ref])).values()];
}

export function generationCategoryPrompt(pack: PolicyPack, sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection, comparisonRole?: "before" | "after") {
    const kind = effectiveVisualKind(preset, selection);
    const guidance = categoryPrompt(pack, sku.product, kind, selection.creativeBrief?.people);
    if (usesDetailSources(sku, preset, selection)) return [guidance, detailPrompt(preset, selection)].filter(Boolean).join("\n");
    return [
        guidance,
        guidance && "以上类目硬性要求优先于下方补充描述和示例图；示例只参考空间、光线和摆放，不复制其商品花色、文字或标志。",
        comparisonRole === "before" && "使用前画面只沿用上述环境、机位、光线和人物设置，目标商品不得出现；商品平铺、人物与商品接触及商品完整度要求仅在使用后画面执行。",
    ]
        .filter(Boolean)
        .join("\n");
}
