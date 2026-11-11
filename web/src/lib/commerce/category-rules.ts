import type { CommerceCategory, CommerceCategoryRule, CommerceCreativeBrief, CommerceRequirementPreset, GenerationAssetStage, PolicyPack, ProductRecord } from "../../types/commerce";

type CategoryProduct = Pick<ProductRecord, "category" | "categoryId" | "subcategoryId">;
export type ResolvedCategory = { node: CommerceCategory; ancestors: CommerceCategory[]; rules: CommerceCategoryRule[]; referenceIds: string[]; requirementIds: string[]; creativeBrief: CommerceCreativeBrief };

export function isCategoryPeopleRule(rule: CommerceCategoryRule) {
    return rule.key === "people" || rule.text.includes("人物");
}

function inheritedRules(parent: CommerceCategory | undefined, child: CommerceCategory) {
    return (parent?.rules || []).filter((rule) => child.id !== "small-glass-mouse-pad" || !/布料|布面|织物|纺织|吸水|包边|缝线/.test(rule.text));
}

/** IDs are authoritative. Legacy names never silently select a child category. */
export function resolveCategory(pack: PolicyPack, product: CategoryProduct): ResolvedCategory | undefined {
    const nodes = pack.categories || [];
    const id = product.subcategoryId || product.categoryId;
    const node = id ? nodes.find((item) => item.id === id) : nodes.find((item) => !item.parentId && (item.name === product.category || item.aliases.includes(product.category)));
    if (!node) return undefined;
    const parent = node.parentId ? nodes.find((item) => item.id === node.parentId) : undefined;
    const ancestors = parent ? [parent] : [];
    const rules = new Map<string, CommerceCategoryRule>();
    for (const current of [...ancestors, node])
        for (const rule of current === parent ? inheritedRules(parent, node) : current.rules) {
            if (rules.get(rule.id)?.strength !== "required") rules.set(rule.id, rule);
        }
    return {
        node,
        ancestors,
        rules: [...rules.values()],
        referenceIds: [...new Set(node.referenceIds.length ? node.referenceIds : parent?.referenceIds || [])],
        requirementIds: [...new Set(node.requirementIds.length ? node.requirementIds : parent?.requirementIds || [])],
        creativeBrief: { ...parent?.creativeBrief, ...node.creativeBrief },
    };
}

export function categoryRequirements(pack: PolicyPack, product: CategoryProduct): CommerceRequirementPreset[] {
    const resolved = resolveCategory(pack, product);
    if (!pack.categories?.length) return pack.requirementPresets.filter((preset) => preset.category === product.category || preset.category === "通用");
    if (!resolved) return [];
    return resolved.requirementIds
        .flatMap((id) => {
            const preset = pack.requirementPresets.find((item) => item.id === id);
            return preset ? [preset] : [];
        })
        .sort((a, b) => a.order - b.order);
}

export function categoryPreflightErrors(pack: PolicyPack, product: CategoryProduct): string[] {
    if (!pack.categories?.length) return [];
    const resolved = resolveCategory(pack, product);
    if (!resolved) return ["请选择有效的商品类目"];
    if (!resolved.node.active || resolved.ancestors.some((node) => !node.active)) return ["所选类目已停用，请重新选择"];
    if (product.subcategoryId && (!resolved.node.parentId || (product.categoryId && resolved.node.parentId !== product.categoryId))) return ["细分类目与大类不匹配"];
    if (!resolved.node.parentId && pack.categories.some((node) => node.parentId === resolved.node.id && node.active)) return ["请选择细分类目后再生成"];
    return [];
}

export function categoryPrompt(pack: PolicyPack, product: CategoryProduct, kind: GenerationAssetStage, peopleOverride?: CommerceCreativeBrief["people"]): string {
    const resolved = resolveCategory(pack, product);
    if (!resolved) return "";
    const applicable = resolved.rules.filter((rule) => rule.stages.includes(kind) && !(peopleOverride === "none" && isCategoryPeopleRule(rule)));
    if (!applicable.length) return "";
    return [`当前商品类目：${resolved.node.name}。以下类目硬性要求优先于补充拍摄设置。`, ...applicable.map((rule) => `${rule.strength === "required" ? "必须" : "建议"}：${rule.text}`)].join("\n");
}

export function validateCategories(pack: PolicyPack): string[] {
    const nodes = pack.categories || [];
    const errors: string[] = [];
    const refs = new Set(pack.references.map((ref) => ref.id));
    const presets = new Map(pack.requirementPresets.map((preset) => [preset.id, preset]));
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length) errors.push("类目 ID 重复");
    const names = new Map<string, string>();
    for (const node of nodes) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(node.id) || !node.name.trim()) errors.push("类目 ID 或名称无效");
        for (const name of new Set([node.name, ...node.aliases].map((value) => value.trim()))) {
            if (!name) {
                errors.push(`${node.name} 别名不能为空`);
                continue;
            }
            if (names.has(name) && names.get(name) !== node.id) errors.push(`类目名称或别名重复：${name}`);
            names.set(name, node.id);
        }
        if (!Number.isInteger(node.order) || node.order < 0) errors.push(`${node.name} 排序无效`);
        const parent = node.parentId ? nodes.find((item) => item.id === node.parentId) : undefined;
        if (node.parentId && (!parent || parent.parentId || parent.id === node.id)) errors.push(`${node.name} 只能归属一个有效大类`);
        if (node.referenceIds.some((id) => !refs.has(id))) errors.push(`${node.name} 引用了不存在的示例图`);
        if (node.requirementIds.some((id) => !presets.has(id))) errors.push(`${node.name} 引用了不存在的方案`);
        if (new Set(node.rules.map((rule) => rule.id)).size !== node.rules.length) errors.push(`${node.name} 规则 ID 重复`);
        for (const rule of node.rules) {
            if (!rule.id.trim() || !rule.text.trim() || !["required", "guide"].includes(rule.strength) || !rule.stages.length || rule.stages.some((stage) => !["scene", "detail", "usage-size", "detail-white"].includes(stage)))
                errors.push(`${node.name} 规则格式无效`);
            if (rule.key && (!["people", "scene"].includes(rule.key) || !rule.value?.trim())) errors.push(`${node.name} 结构化规则无效`);
            if (rule.key === "people" && !["none", "adult-partial", "adult-half", "adult-full"].includes(rule.value || "")) errors.push(`${node.name} 人物要求无效`);
            if (rule.key === "people" && rule.value !== "none" && rule.stages.some((stage) => stage === "detail" || stage === "detail-white")) errors.push(`${node.name} 细节图片不能要求人物，请将人物规则限定为场景或用途图`);
            const inherited = inheritedRules(parent, node).find((item) => item.id === rule.id && item.strength === "required");
            if (inherited && JSON.stringify(inherited) !== JSON.stringify(rule)) errors.push(`${node.name} 不得覆盖大类硬性规则 ${rule.id}，请用新 ID 补充`);
        }
        const all = [...inheritedRules(parent, node), ...node.rules];
        for (const stage of ["scene", "detail", "usage-size", "detail-white"] as const)
            for (const key of ["people", "scene"] as const) {
                const values = new Set(all.filter((rule) => rule.strength === "required" && rule.key === key && rule.stages.includes(stage)).map((rule) => rule.value));
                if (values.size > 1) errors.push(`${node.name} ${stage} 的 ${key} 硬性要求冲突`);
            }
        if (!node.active || nodes.some((child) => child.parentId === node.id && child.active)) continue;
        if (parent && !parent.active) errors.push(`${node.name} 的大类已停用`);
        const resolved = resolveCategory(pack, { category: node.name, categoryId: parent?.id || node.id, subcategoryId: parent ? node.id : undefined })!;
        if (!resolved.requirementIds.length) errors.push(`${node.name} 至少需要一个可用方案`);
        const requirements = resolved.requirementIds.flatMap((id) => (presets.get(id) ? [presets.get(id)!] : []));
        if (requirements.some((preset) => ["scene", "usage-size"].includes(preset.visualKind || (preset.stage === "marketing" ? "scene" : preset.stage))) && !resolved.referenceIds.length) errors.push(`${node.name} 的场景方案缺少示例图`);
        if (requirements.some((preset) => ["detail", "detail-white"].includes(preset.visualKind || preset.stage) && !preset.detailPurpose)) errors.push(`${node.name} 的细节方案须指定素材用途`);
    }
    return [...new Set(errors)];
}
