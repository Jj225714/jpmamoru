import { validateCategories } from "./category-rules";
import { COMMERCE_LOCALES, type AuditEvent, type CommerceCreativeBrief, type CommerceRequirementPreset, type PolicyPack } from "@/types/commerce";

export const POLICY_OPTIONS = {
    severity: ["BLOCK", "WARN", "GUIDE"], platforms: ["shopee", "tiktok"],
    locales: [...COMMERCE_LOCALES], locale: [...COMMERCE_LOCALES],
    assetStages: ["main-white", "scene", "detail", "usage-size", "detail-white", "marketing-preview", "marketing"],
    stage: ["scene", "detail", "usage-size", "detail-white", "marketing"],
    visualMode: ["generate", "white-layout"],
    visualKind: ["scene", "detail", "usage-size", "detail-white"],
    generationStrategy: ["single", "paired-before-after"],
    recipeRole: ["hero", "detail", "usage", "selling-point", "secondary-scene", "interaction", "lighting", "before-after"],
    slot: ["scene", "detail", "usage-size", "marketing"],
    phase: ["prompt", "preflight", "post-render"], checker: ["metadata", "text", "vision", "manual"],
    layout: ["single-hero", "feature-grid", "before-after", "competitor-comparison", "size-comparison", "color-options", "multi-scene", "layer-structure", "lighting-comparison", "installation-methods", "installation-steps", "faq", "custom-reference"],
    variantScope: ["per-sku", "per-color", "per-size", "per-site", "custom"], kind: ["reference", "example"],
} as const;

export function clonePolicy(pack: PolicyPack): PolicyPack { return structuredClone(pack); }

export function requiresPolicyReview(preset: CommerceRequirementPreset, previous?: CommerceRequirementPreset): boolean {
    const copyChanged = previous && (preset.chineseCopy !== previous.chineseCopy || COMMERCE_LOCALES.some((locale) => (preset.translationSeeds[locale] || "") !== (previous.translationSeeds[locale] || "")));
    const incomplete = !preset.recipeRole && preset.stage === "marketing" && (!preset.chineseCopy.trim()
        || (/[\u4e00-\u9fff]/.test(preset.chineseCopy) && /[A-Za-z]/.test(preset.chineseCopy))
        || COMMERCE_LOCALES.filter((locale) => locale !== "en-GB" || preset.translationSeeds[locale] !== undefined).some((locale) => !preset.translationSeeds[locale]?.trim() || /待翻译|未翻译|翻译未完成|\b(?:TODO|TBD)\b/i.test(preset.translationSeeds[locale]!)));
    return Boolean(copyChanged || incomplete || /^\s*无\s*$/.test(preset.prompt));
}

export function policyEntryMatches(section: string, item: Record<string, unknown>, pack: PolicyPack, country?: string, category?: string): boolean {
    if (section === "templates" && pack.requirementPresets.some((preset) => preset.id === item.id)) return false;
    if (country) {
        if (section === "profiles" && item.countryCode !== country) return false;
        if (section === "rules" && (item.countries as string[]).length && !(item.countries as string[]).includes(country)) return false;
        if (section === "siteReferences" && item.locale && !pack.profiles.some((profile) => profile.countryCode === country && profile.locale === item.locale)) return false;
    }
    if (category) {
        if (["requirementPresets", "templates"].includes(section) && item.category !== "通用" && item.category !== category) return false;
        if (section === "rules" && (item.categories as string[]).length && !(item.categories as string[]).includes(category) && !(item.categories as string[]).includes("通用")) return false;
    }
    return true;
}

/** The preset is canonical; templates sharing its ID remain readable by legacy jobs. */
export function synchronizePolicyTemplates(pack: PolicyPack, base?: PolicyPack): PolicyPack {
    const next = clonePolicy(pack);
    next.requirementPresets = next.requirementPresets.map((preset) => ({ ...preset,
        needsReview: preset.needsReview || requiresPolicyReview(preset, base?.requirementPresets.find((previous) => previous.id === preset.id)) }));
    next.templates = next.templates.map((template) => {
        const preset = next.requirementPresets.find((item) => item.id === template.id);
        return preset ? { ...template, category: preset.category, order: preset.order, title: preset.title,
            requirement: preset.prompt, slot: preset.stage === "detail-white" ? "detail" : preset.stage,
            chineseCopy: preset.chineseCopy, translationSeeds: { ...preset.translationSeeds },
            requiredVariables: [...preset.requiredFacts], referenceIds: [...preset.referenceIds] } : template;
    });
    return next;
}

const sections = ["profiles", "rules", "requirementPresets", "templates", "references", "siteReferences"] as const;
const labels: Record<string, string> = { categories: "类目规则", name: "名称", profiles: "国家配置", rules: "规则", requirementPresets: "需求方案", templates: "营销模板", references: "参考图", siteReferences: "站点参考", globalStandards: "全局标准", generationDefaults: "生成默认值", watermarkOpacityRange: "水印范围" };

export function policyChanges(base: PolicyPack, next: PolicyPack): string[] {
    return Object.keys(labels).flatMap((key) => {
        const k = key as keyof PolicyPack;
        if (JSON.stringify(base[k]) === JSON.stringify(next[k])) return [];
        if (sections.includes(key as typeof sections[number])) {
            const before = base[k] as unknown[];
            const after = next[k] as unknown[];
            const automaticReviews = key === "requirementPresets" ? next.requirementPresets.filter((item) => {
                const previous = base.requirementPresets.find((preset) => preset.id === item.id);
                return previous && !previous.needsReview && item.needsReview && requiresPolicyReview(item, previous);
            }).length : 0;
            const note = automaticReviews ? `（含 ${automaticReviews} 项自动补充待校对标记，保存后生效）` : "";
            return [`${labels[key]}：${after.filter((item, index) => JSON.stringify(item) !== JSON.stringify(before[index])).length} 项变更${note}`];
        }
        return [`${labels[key]}已修改`];
    });
}

export function validatePolicyEdit(base: PolicyPack, pack: PolicyPack): string[] {
    const errors: string[] = validateCategories(pack);
    for (const category of pack.categories || []) errors.push(...validateCreativeBrief(category.creativeBrief, category.name));
    for (const category of base.categories || []) if (!pack.categories?.some((item) => item.id === category.id)) errors.push("已有类目不能删除，请停用");
    const required = (value: string, label: string) => { if (!value?.trim()) errors.push(`${label}不能为空`); };
    const choice = (key: keyof typeof POLICY_OPTIONS, value: string, label: string) => {
        if (!(POLICY_OPTIONS[key] as readonly string[]).includes(value)) errors.push(`${label}无效`);
    };
    const integer = (value: number, min: number, max: number, label: string) => {
        if (!Number.isInteger(value) || value < min || value > max) errors.push(`${label}须为 ${min}–${max} 的整数`);
    };
    required(pack.name, "规则包名称");
    if (pack.creativeLibraryVersion !== undefined && pack.creativeLibraryVersion !== 1) errors.push("推荐方案库版本无效");
    if (pack.id !== base.id || pack.version !== base.version || pack.status !== base.status) errors.push("不能修改版本标识或状态");
    if (pack.createdAt !== base.createdAt || pack.publishedAt !== base.publishedAt || pack.sourceFileName !== base.sourceFileName) errors.push("不能修改版本来源或时间");
    for (const section of sections) {
        const before = base[section]; const after = pack[section];
        const lengthInvalid = section === "requirementPresets" ? after.length < before.length : before.length !== after.length;
        if (lengthInvalid || before.some((item, index) => "id" in item && (!after[index] || !("id" in after[index]) || item.id !== (after[index] as { id: string }).id))) errors.push(`${labels[section]}不能删除、重排或更换已有 ID（仅需求方案允许追加）`);
        const ids = after.flatMap((item) => "id" in item ? [item.id] : []);
        if (new Set(ids).size !== ids.length) errors.push(`${labels[section]} ID 重复`);
    }
    const countries = pack.profiles.map((item) => item.countryCode);
    if (new Set(countries).size !== countries.length) errors.push("国家代码不能重复");
    pack.profiles.forEach((item, i) => {
        required(item.countryName, `国家 ${i + 1} 名称`);
        if (!/^[A-Z]{2}$/.test(item.countryCode)) errors.push(`国家 ${i + 1} 代码须为两位大写字母`);
        choice("locale", item.locale, `国家 ${i + 1} 语言`);
    });
    pack.rules.forEach((item) => {
        required(item.title, "规则标题"); required(item.description, `规则 ${item.title} 描述`);
        integer(item.priority, 0, 100, `规则 ${item.title} 优先级`);
        for (const key of ["severity", "phase", "checker"] as const) choice(key, item[key], `${item.title} ${key}`);
        for (const key of ["platforms", "locales", "assetStages"] as const) item[key].forEach((v) => choice(key, v, `${item.title} ${key}`));
        // Country filters may include markets without a visual profile (e.g. US).
        if (item.countries.some((code) => !/^[A-Z]{2}$/.test(code))) errors.push(`${item.title} 国家代码无效`);
    });
    const referenceIds = new Set(pack.references.map((item) => item.id));
    const refs = (ids: string[], title: string) => { if (ids.some((id) => !referenceIds.has(id))) errors.push(`${title}包含不存在的参考图`); };
    const translations = (values: Record<string, string>) => Object.keys(values).forEach((key) => choice("locale", key, "翻译语言"));
    pack.requirementPresets.forEach((item) => {
        required(item.title, "方案标题"); required(item.category, `${item.title} 类目`); required(item.prompt, `${item.title} 提示词`);
        integer(item.order, 0, 9999, `${item.title} 排序`); integer(item.defaultCount, 0, 4, `${item.title} 数量`);
        for (const key of ["stage", "layout", "variantScope"] as const) choice(key, item[key], `${item.title} ${key}`);
        for (const key of ["visualMode", "visualKind", "generationStrategy", "recipeRole"] as const) if (item[key] !== undefined) choice(key, item[key], `${item.title} ${key}`);
        if (item.detailPurpose !== undefined && !["front-texture", "back", "edge", "side", "accessory", "other"].includes(item.detailPurpose)) errors.push(`${item.title} 素材用途无效`);
        errors.push(...validateCreativeBrief(item.creativeBrief, item.title));
        if (item.generationStrategy === "paired-before-after" && (item.stage !== "marketing" || item.layout !== "before-after" || item.visualMode === "white-layout")) errors.push(`${item.title} 成对对比须使用营销图、前后对比版式及生成底图`);
        if ((item.recipeRole === "detail" || item.generationStrategy === "paired-before-after") && item.creativeBrief?.people && item.creativeBrief.people !== "none") errors.push(`${item.title} 细节及前后对比不能加入人物`);
        refs(item.referenceIds, item.title); translations(item.translationSeeds);
        if (!item.needsReview && requiresPolicyReview(item, base.requirementPresets.find((previous) => previous.id === item.id))) errors.push(`${item.title} 文案已修改或翻译未完成，必须保留待校对标记`);
    });
    pack.templates.forEach((item) => {
        required(item.title, "模板标题"); required(item.category, `${item.title} 类目`); required(item.requirement, `${item.title} 要求`);
        integer(item.order, 0, 9999, `${item.title} 排序`); choice("slot", item.slot, `${item.title} 类型`);
        refs(item.referenceIds, item.title); translations(item.translationSeeds);
    });
    pack.siteReferences.forEach((item) => {
        required(item.product, "站点参考商品"); refs(item.referenceIds, item.product);
        if (item.locale) choice("locale", item.locale, "站点语言");
        if (item.url && !isHttpUrl(item.url)) errors.push(`${item.product} 网址须为 http/https 地址`);
    });
    pack.references.forEach((item, i) => {
        required(item.name, "参考图名称"); choice("kind", item.kind, "参考图类型");
        const previous = base.references[i];
        if (previous && (item.url !== previous.url || item.storageKey !== previous.storageKey || item.source !== previous.source)) errors.push("参考图素材不可替换，只能修改关联和说明");
    });
    if (pack.globalStandards.some((value) => !value.trim())) errors.push("全局标准不能为空行");
    const range = pack.watermarkOpacityRange || [0.03, 0.3];
    if (range.length !== 2 || range.some((v) => !Number.isFinite(v) || v < 0.03 || v > 0.3) || range[0] > range[1]) errors.push("水印范围须满足 3% ≤ 最小值 ≤ 最大值 ≤ 30%");
    const config = pack.generationDefaults;
    if (config) {
        errors.push(...validateCreativeBrief(config.creativeBrief, "默认拍摄设置"));
        if (config.assetCounts) Object.values(config.assetCounts).forEach((count) => integer(count, 0, 4, "默认图片数量"));
        if (config.outputSpec && (!Number.isFinite(config.outputSpec.maxBytes) || config.outputSpec.maxBytes < 256 * 1024 || config.outputSpec.maxBytes > 20 * 1024 * 1024)) errors.push("文件体积须在 256KB–20MB 之间");
        if (config.outputSpec) {
            if (![800, 1024, 1254, 1600].includes(config.outputSpec.size) || ![96, 120, 150].includes(config.outputSpec.dpi) || !["jpeg", "png"].includes(config.outputSpec.format) || config.outputSpec.colorSpace !== "sRGB") errors.push("输出规格无效");
        }
        if (config.siteImageMode !== undefined && !["shared", "per-site"].includes(config.siteImageMode)) errors.push("站点图片方式无效");
        if (config.delivery !== undefined && !["flattenedOnly", "editableCanvas"].includes(config.delivery)) errors.push("交付方式无效");
        if (config.marketingEnabled !== undefined && typeof config.marketingEnabled !== "boolean") errors.push("营销图开关无效");
        if (config.overlay) {
            const { logo, watermark } = config.overlay;
            if (!Number.isFinite(watermark.opacity) || watermark.opacity < range[0] || watermark.opacity > range[1]) errors.push("默认水印透明度超出规则范围");
            if (!["off", "top-left", "top-right", "bottom-left", "bottom-right"].includes(logo.placement)) errors.push("Logo 位置无效");
            if (!["off", "single", "tile"].includes(watermark.mode)) errors.push("水印方式无效");
            if (!["top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right"].includes(watermark.position)) errors.push("水印位置无效");
            for (const overlay of [logo, watermark]) {
                if (!["marketing", "all", "custom"].includes(overlay.applyTo)) errors.push("覆盖范围无效");
                overlay.customStages.forEach((stage) => choice("assetStages", stage, "覆盖图片类型"));
                if (overlay.applyTo === "custom" && !overlay.customStages.length) errors.push("自定义覆盖范围至少选择一种图片类型");
            }
        }
    }
    return [...new Set(errors)];
}

export function validateCreativeBrief(value: CommerceCreativeBrief | undefined, title = "拍摄设置"): string[] {
    if (value === undefined) return [];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [title + "格式无效"];
    const enums = { lighting: ["natural-window", "soft-studio", "warm-indoor", "side-light"], people: ["none", "adult-partial", "adult-half", "adult-full"], framing: ["auto", "close", "medium", "wide"] };
    const errors: string[] = [];
    for (const [key, options] of Object.entries(enums)) {
        const item = value[key as keyof CommerceCreativeBrief];
        if (item !== undefined && !options.includes(item)) errors.push(title + " " + key + "无效");
    }
    for (const key of ["scene", "audience"] as const) if (value[key] !== undefined && (typeof value[key] !== "string" || value[key]!.length > 2000)) errors.push(title + " " + key + "须为不超过2000字的文本");
    return errors;
}

function isHttpUrl(value: string) { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }

export function preparePolicySave(input: {
    packs: PolicyPack[]; base: PolicyPack; edited: PolicyPack; publish: boolean; actor: string;
    newId: string; auditId: string; now: string; referenced?: boolean;
}): { policyPacks: PolicyPack[]; saved: PolicyPack; audit: AuditEvent } {
    const { packs, base, publish, actor, now } = input;
    const current = packs.find((item) => item.id === base.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(base)) throw new Error("此版本已被其他操作修改，请关闭编辑器后重新打开");
    const edited = synchronizePolicyTemplates(input.edited, base);
    const errors = validatePolicyEdit(base, edited);
    if (errors.length) throw new Error(errors.join("；"));
    const clone = current.status !== "draft" || current.id === "builtin-sea-home" || input.referenced;
    if (clone && packs.some((item) => item.id === input.newId)) throw new Error("新版本 ID 冲突，请重试");
    const summary = policyChanges(base, edited);
    const saved: PolicyPack = { ...edited, id: clone ? input.newId : current.id,
        version: clone ? Math.max(0, ...packs.map((item) => item.version)) + 1 : current.version,
        status: publish ? "published" : "draft", createdAt: clone ? now : current.createdAt,
        publishedAt: publish ? now : undefined,
        editSummary: summary,
        diffSummary: { rulesAdded: 0, rulesRemoved: 0, templatesAdded: 0, templatesRemoved: 0,
            rulesChanged: edited.rules.filter((item, i) => JSON.stringify(item) !== JSON.stringify(base.rules[i])).length,
            severityChanged: edited.rules.filter((item, i) => item.severity !== base.rules[i]?.severity).length,
            templatesChanged: edited.templates.filter((item, i) => JSON.stringify(item) !== JSON.stringify(base.templates[i])).length },
    };
    const remaining = packs.filter((item) => item.id !== saved.id).map((item): PolicyPack => publish && item.status === "published" && item.id !== "builtin-sea-home" ? { ...item, status: "retired" } : item);
    return { saved, policyPacks: [saved, ...remaining], audit: { id: input.auditId, action: publish ? "编辑并发布规则版本" : "保存规则草稿", actor, policyPackId: saved.id,
        detail: `基于 v${base.version} → v${saved.version}；${summary.join("；") || "内容未变更"}`, createdAt: now } };
}
