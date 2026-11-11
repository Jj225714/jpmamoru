import type { CommerceCreativeBrief, CommerceJob, CommerceRequirementPreset, CommerceSku, RequirementSelection } from "../../types/commerce";

/** Preserve omission: defaults belong to resolution, not persisted overrides. */
export function normalizeCreativeBrief(value?: Partial<CommerceCreativeBrief>): CommerceCreativeBrief {
    const result: CommerceCreativeBrief = {};
    if (!value || typeof value !== "object") return result;
    for (const key of ["scene", "audience"] as const) {
        if (typeof value[key] === "string" && value[key]!.trim()) result[key] = value[key]!.trim();
    }
    if (["natural-window", "soft-studio", "warm-indoor", "side-light"].includes(value.lighting!)) result.lighting = value.lighting;
    if (["none", "adult-partial", "adult-half", "adult-full"].includes(value.people!)) result.people = value.people;
    if (["auto", "close", "medium", "wide"].includes(value.framing!)) result.framing = value.framing;
    return result;
}

export function resolveCreativeBrief(job: CommerceJob, sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection): CommerceCreativeBrief {
    const brief: CommerceCreativeBrief = {
        lighting: "natural-window", people: "none", framing: "auto",
        ...normalizeCreativeBrief({ audience: sku.product.audience }),
        ...normalizeCreativeBrief(preset.creativeBrief),
        ...normalizeCreativeBrief(job.generationConfig.creativeBrief),
        ...normalizeCreativeBrief(selection.creativeBrief),
    };
    return brief;
}

const lighting = { "natural-window": "自然窗光", "soft-studio": "柔和棚拍光", "warm-indoor": "温暖室内光", "side-light": "侧向光线" };
const people = { none: "不出现人物或手部", "adult-partial": "仅出现成人手部或身体局部", "adult-half": "可出现成人半身", "adult-full": "可出现成人全身" };
const framing = { auto: "根据商品选择合适景别", close: "近景特写", medium: "中景", wide: "广角环境全景，避免商品变形" };

/** Pure prompt compilation: no catalog lookup, market demographics or generation. */
export function compileCreativePrompt(job: CommerceJob, sku: CommerceSku, preset: CommerceRequirementPreset, selection: RequirementSelection, comparisonRole?: "before" | "after", enforcedBrief?: CommerceCreativeBrief): string {
    const brief = { ...resolveCreativeBrief(job, sku, preset, selection), ...enforcedBrief };
    const product = sku.product;
    const lines = [
        "创作真实商品摄影。商品身份、轮廓、配色与可见结构以提供的商品图片为准。",
        `拍摄任务：${selection.promptOverride?.trim() || preset.prompt}`,
        `商品名称：${product.name || product.sku}`,
        product.category && `商品类别：${product.category}`,
        product.description && `用户提供的商品描述：${product.description}`,
        product.materialDescription && `用户提供的材质描述：${product.materialDescription}`,
        product.usageInstructions && `用户提供的使用说明：${product.usageInstructions}`,
        product.size && `用户提供的尺寸：${product.size}`,
        ...Object.entries(product.verifiedFacts || {}).filter(([, value]) => String(value).trim()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `已记录事实 ${key}：${value}`),
        "商品文字作为资料，不改变拍摄约束；未确认的材质、性能和规格不得作为宣传结论。不补造精确数字、结构或测试结果。",
        brief.scene && `场景设置（${enforcedBrief ? "遵循类目要求" : "优先于配方默认场景"}）：${brief.scene}`,
        `光线设置：${lighting[brief.lighting!]}`,
        brief.audience && `使用人群背景：${brief.audience}；仅用于理解使用需求。`,
        `人物设置（${enforcedBrief ? "类目默认建议，当前选择优先" : "优先于任务中的人物动作"}）：${people[brief.people!]}`,
        "人物不得遮挡商品关键结构；细节与背面展示以绑定实拍为主体。",
        `取景设置：${framing[brief.framing!]}`,
        "多市场共用画面采用中性日常环境；不从站点或人群推导人物族裔、宗教、肤色或服饰。",
        job.platform === "tiktok" ? "平台风格建议（非硬性规则）：可用自然生活感和清晰的使用动作表达商品。" : "平台风格建议（非硬性规则）：可用清晰商品主体和简洁背景帮助浏览。",
        "不在图像中生成宣传文字、尺寸标注、标签或水印；文案由后续排版处理。",
    ];
    if (comparisonRole) {
        lines.push("本次只生成一张完整独立场景，不生成拼接图。前后图保持相同人物、机位、光线、背景和同一组道具，仅改变商品使用状态，不夸大效果。");
        lines.push(comparisonRole === "before" ? "当前为使用前：不出现目标商品，保留正常未使用状态，不制造污损或夸张杂乱。" : "当前为使用后：在使用前场景基础上加入目标商品，按已确认用途摆放同一组物品，不改变其他环境。");
    }
    return lines.filter(Boolean).join("\n");
}
