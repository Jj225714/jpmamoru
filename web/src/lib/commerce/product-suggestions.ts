import type { CommerceProductInformation, CommerceProductSuggestion, CommerceUncertaintyResolution, ProductRecord } from "@/types/commerce";

const fieldTargets = { name: "name", audience: "audience", sellingPoints: "description", material: "materialDescription", usage: "usageInstructions", category: "categoryPath" } as const;
const uncertain = /待确认|待核实|待验证|待补充|无法确认|不能确认|不确定|未知|不详|可能|疑似|推测|或许|似乎|以.*(?:说明书|洗标).*为准|\b(?:unknown|uncertain|unverified|possibly|perhaps|might|may|to be confirmed|needs? verification)\b/i;

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

/** Opaque, deterministic input identity. Drafts and transient loading status do not invalidate it. */
export function productSuggestionFingerprint(product: ProductRecord): string {
    const { informationSuggestion: _draft, imageStatus: _status, ...inputs } = product;
    // Keeping the canonical input avoids hash collisions in stale-response checks.
    return `product-suggestion-v1:${canonical(inputs)}`;
}

/** Advisory internal category only. Ambiguous or conflicting identities remain unclassified. */
export function suggestedProductCategory(product: Pick<ProductRecord, "name" | "productType">, information: CommerceProductInformation): string | undefined {
    const identity = `${product.productType}\n${product.name}\n${information.name}`;
    const leaf = information.category.split(">").at(-1)?.trim() || "";
    const categories = [
        { category: "地毯地垫类", name: /地毯|地垫/, english: /^(?:Area Rugs|Rugs|Door Mats|Bath Mats)$/i },
        { category: "桌垫类", name: /桌垫/, english: /^(?:Desk Mats|Desk Pads|Placemats)$/i },
        { category: "洞洞板类", name: /洞洞板/, english: /^Pegboards$/i },
        { category: "收纳筐类", name: /收纳[筐篮]/, english: /^Storage Baskets$/i },
    ].filter((item) => item.name.test(identity) || item.english.test(leaf));
    return categories.length === 1 ? categories[0].category : undefined;
}

export class ProductSuggestionFormatError extends Error {
    constructor() { super("识图模型未返回有效的六项商品建议，请重试或手动填写。"); this.name = "ProductSuggestionFormatError"; }
}

/** Empty strings are deliberate: unknown attributes must never become placeholder claims. */
export function parseCommerceProductSuggestion(answer: string): Pick<CommerceProductSuggestion, "information" | "uncertainties"> {
    try {
        if (answer.length > 20_000) throw new Error();
        const data = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
        if (!data || !data.information || typeof data.information !== "object" || Array.isArray(data.information) || !Array.isArray(data.uncertainties) || data.uncertainties.length > 50 || data.uncertainties.some((item: unknown) => typeof item !== "string" || item.length > 2000)) throw new Error();
        const uncertainties: string[] = data.uncertainties.map((item: string) => item.trim()).filter(Boolean);
        const information = {} as CommerceProductInformation;
        for (const field of Object.keys(fieldTargets) as Array<keyof CommerceProductInformation>) {
            const value = data.information[field];
            if (typeof value !== "string" || value.length > 2000) throw new Error();
            // Drop the entire sentence rather than retaining a claim separated from its qualifier.
            information[field] = value.split(/(?<=[。！？!?\n])/).filter((clause: string) => {
                if (!uncertain.test(clause)) return true;
                uncertainties.push(clause.trim());
                return false;
            }).join("").trim();
        }
        if (information.category) {
            const segments = information.category.split(">").map((item) => item.trim());
            if (segments.length < 2 || segments.some((item) => !/^[A-Za-z][A-Za-z0-9 &'(),/.-]*$/.test(item))) throw new Error();
            information.category = segments.join(" > ");
        }
        if (!Object.values(information).some(Boolean) && !uncertainties.length) throw new Error();
        return { information, uncertainties: [...new Set(uncertainties)] };
    } catch { throw new ProductSuggestionFormatError(); }
}

/** Explicit selection only; taxonomy suggestions target categoryPath, never internal category. */
export function adoptProductSuggestion(product: ProductRecord, draft: CommerceProductSuggestion, fields: Array<keyof CommerceProductInformation>, replaceExisting = false): ProductRecord {
    if (draft.sourceFingerprint !== productSuggestionFingerprint(product)) throw new Error("商品信息已改变，请重新生成建议。");
    const { information } = parseCommerceProductSuggestion(JSON.stringify(draft));
    const result = { ...product };
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(fieldTargets, field)) continue;
        const target = fieldTargets[field];
        const value = information[field];
        if (value && (replaceExisting || !result[target]?.trim())) result[target] = value;
    }
    return result;
}

export function uncertaintyResolutionKey(item: string) { return item.trim(); }

export function suggestedUncertaintyFactKey(item: string) {
    if (/商品类型|品类|类目/.test(item)) return "商品类型";
    if (/尺寸|规格/.test(item)) return "尺寸规格";
    if (/材质|材料|成分|面料/.test(item)) return "材质";
    if (/文字|英文|标识/.test(item)) return "图中文字";
    if (/防滑|水洗|耐磨|功能|性能/.test(item)) return "功能特性";
    return "补充事实";
}

/** Resolve one advisory item without ever certifying all product facts. */
export function resolveProductUncertainty(product: ProductRecord, draft: CommerceProductSuggestion, item: string, resolution?: CommerceUncertaintyResolution): ProductRecord {
    if (draft.sourceFingerprint !== productSuggestionFingerprint(product)) throw new Error("商品信息已改变，请重新生成建议。");
    const key = uncertaintyResolutionKey(item);
    if (!draft.uncertainties.includes(item)) throw new Error("待确认信息已变化，请重新识别。");
    const resolutions = { ...(draft.uncertaintyResolutions || {}) };
    if (!resolution) delete resolutions[key];
    else resolutions[key] = { ...resolution };
    let next: ProductRecord = { ...product };
    if (resolution?.status === "confirmed") {
        const factKey = resolution.factKey?.trim();
        const value = resolution.value?.trim();
        if (!factKey || !value) throw new Error("请填写事实名称和核实后的内容。");
        if (uncertain.test(value)) throw new Error("核实内容仍包含待确认表述，请修改后再确认。");
        next = { ...next, verifiedFacts: { ...next.verifiedFacts, [factKey]: value }, factsConfirmed: false };
    }
    const nextDraft = { ...draft, uncertaintyResolutions: resolutions };
    nextDraft.sourceFingerprint = productSuggestionFingerprint(next);
    return { ...next, informationSuggestion: nextDraft };
}
