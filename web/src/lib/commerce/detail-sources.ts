import type { CommerceDetailImage, CommerceRequirementPreset, CommerceSku, DetailImagePurpose, RequirementSelection } from "@/types/commerce";

export const DETAIL_PURPOSE_LABELS: Record<DetailImagePurpose, string> = { "front-texture": "正面纹理", back: "背面", edge: "包边", side: "侧面", accessory: "配件", other: "其他细节" };

export function isDetailRequirement(preset: CommerceRequirementPreset, selection: RequirementSelection) {
    const kind = selection.visualKind || preset.visualKind || preset.stage;
    return kind === "detail" || kind === "detail-white" || preset.recipeRole === "detail";
}

export function usesDetailSources(sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection) {
    return isDetailRequirement(preset, selection) && Boolean(sku.product.categoryId || sku.product.subcategoryId || preset.detailPurpose || selection.detailPurpose || selection.sourceImageIds?.length);
}

export function detailSourceImages(sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection, variantKey = ""): CommerceDetailImage[] {
    const purpose = selection.detailPurpose || preset.detailPurpose || "front-texture";
    const ids = [...new Set(selection.sourceImageIds || [])];
    const photos = sku.product.detailImages || [];
    const error = (message: string): never => {
        throw new Error(`${preset.title}：${message}，请补充素材或关闭该方案`);
    };
    if (!ids.length) return error(`缺少${DETAIL_PURPOSE_LABELS[purpose]}实拍`);
    const chosen = ids.map((id) => photos.find((image) => image.id === id));
    if (chosen.some((image) => !image)) return error("绑定的细节素材已删除");
    const matches = (chosen as CommerceDetailImage[]).filter((image) => image.shared || image.variantKey === variantKey);
    if (!matches.length) return error(`缺少${variantKey || "当前商品"}的对应细节实拍`);
    if (matches.some((image) => !image.purposes.includes(purpose))) return error(`所选素材没有标记为${DETAIL_PURPOSE_LABELS[purpose]}`);
    if (matches.some((image) => !image.contentHash || image.source === "generated" || image.source === "rule-reference")) return error("必须使用带内容记录的真实商品照片");
    const primaryId = selection.primaryImageIds?.[variantKey] || selection.primaryImageId;
    const primary = matches.find((image) => image.id === primaryId);
    if (!primary) return error(`请选择${variantKey || "当前商品"}的主参考图`);
    const ordered = [primary, ...matches.filter((image) => image !== primary)];
    if (selection.detailRenderMode === "original" && selection.count !== 1) return error("原图排版每个方案每个变体只能输出一张，请为不同原图分别建立方案");
    return ordered;
}

export function detailPrompt(preset: CommerceRequirementPreset, selection: RequirementSelection) {
    const purpose = selection.detailPurpose || preset.detailPurpose || "front-texture";
    return [
        `本次只展示商品的${DETAIL_PURPOSE_LABELS[purpose]}。第1张是本次主参考实拍，其余是同一部位的补充实拍。`,
        "以这些实拍为唯一外观依据，保持可见纹理、颜色、针脚、孔洞、包边和结构，不从正面推测背面，不补造隐藏结构、剖面或材质层次。",
        "仅优化光线、背景与构图，不抹掉或重绘材质特征，不把图片外观解释为防滑、耐热等已验证性能。",
        "保留所选展示部位；局部特写无需展示整件商品四角，不放入场景家具或人物。",
        "不生成广告文字、标志、尺寸标签或水印。",
    ].join("\n");
}

/** Only effective source dependencies enter the cache; adding an unrelated back photo does not expire a front detail. */
export function detailSourceFingerprint(sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection, variantKey: string) {
    const selected = (sku.product.detailImages || []).filter((image) => selection.sourceImageIds?.includes(image.id) && (image.shared || image.variantKey === variantKey));
    return {
        purpose: selection.detailPurpose || preset.detailPurpose || "front-texture",
        mode: selection.detailRenderMode || "optimize",
        primary: selection.primaryImageIds?.[variantKey] || selection.primaryImageId,
        images: selected.map((image) => [image.id, image.contentHash, image.purposes, image.variantKey, image.shared]),
    };
}
