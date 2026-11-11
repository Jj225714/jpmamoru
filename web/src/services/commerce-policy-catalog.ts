import { validatePolicyEdit } from "@/lib/commerce/policy-editor";
import { COMMERCE_LOCALES, type PolicyPack } from "@/types/commerce";

export const SERVER_POLICY_PREFIX = "server-aoweisi-";
export type PolicyCatalog = { schemaVersion: 1; revision: string; publishedAt: string; policyPacks: PolicyPack[] };
export type CatalogStatus = { phase: "idle" | "loading" | "disabled" | "success" | "error"; count?: number; revision?: string; error?: string };

export function catalogBlocksNewJob(status: CatalogStatus, packs: PolicyPack[]): boolean {
    return status.phase === "idle" || status.phase === "loading" || (status.phase === "error" && !packs.some((pack) => pack.id.startsWith(SERVER_POLICY_PREFIX)));
}

type Shape = "string" | "number" | "boolean" | { [key: string]: Shape } | readonly [Shape];
const strings: Shape = ["string"];
const translations: Shape = Object.fromEntries(COMMERCE_LOCALES.map((key) => [key + "?", "string"]));
const overlay = { applyTo: "string", customStages: strings } as const;
const creativeBriefShape: Shape = { "scene?": "string", "lighting?": "string", "audience?": "string", "people?": "string", "framing?": "string" };
const packShape: Shape = {
    id: "string", name: "string", version: "number", status: "string", sourceFileName: "string", createdAt: "string", publishedAt: "string", "creativeLibraryVersion?": "number",
    "categories?": [{ id: "string", "parentId?": "string", name: "string", aliases: strings, active: "boolean", order: "number",
        rules: [{ id: "string", text: "string", strength: "string", stages: strings, "key?": "string", "value?": "string" }],
        referenceIds: strings, requirementIds: strings, "creativeBrief?": creativeBriefShape,
        "source?": { fileName: "string", sheet: "string", range: "string", originalText: "string" } }],
    profiles: [{ countryCode: "string", countryName: "string", locale: "string", audience: "string", visualKeywords: "string", mainImageStyle: "string", preferredColors: strings, avoidedColors: strings, modelPreference: "string" }],
    rules: [{ id: "string", title: "string", description: "string", severity: "string", priority: "number", countries: strings, platforms: strings, categories: strings, locales: strings, assetStages: strings, phase: "string", checker: "string", source: { fileName: "string", sheet: "string", range: "string" } }],
    templates: [{ id: "string", category: "string", order: "number", title: "string", requirement: "string", slot: "string", chineseCopy: "string", translationSeeds: translations, requiredVariables: strings, referenceIds: strings }],
    requirementPresets: [{ id: "string", category: "string", order: "number", title: "string", stage: "string", enabledByDefault: "boolean", defaultCount: "number", prompt: "string", layout: "string", chineseCopy: "string", translationSeeds: translations, requiredFacts: strings, referenceIds: strings, variantScope: "string", needsReview: "boolean", "visualMode?": "string", "visualKind?": "string", "creativeBrief?": creativeBriefShape, "recipeRole?": "string", "generationStrategy?": "string", "detailPurpose?": "string" }],
    references: [{ id: "string", name: "string", url: "string", source: "string", sheet: "string", anchor: "string", kind: "string" }],
    siteReferences: [{ id: "string", product: "string", "locale?": "string", "url?": "string", referenceIds: strings, "note?": "string" }],
    globalStandards: strings, "watermarkOpacityRange?": ["number"],
    "generationDefaults?": {
        "assetCounts?": { scene: "number", detail: "number", "usage-size": "number", "detail-white": "number" },
        "marketingEnabled?": "boolean", "siteImageMode?": "string", "delivery?": "string",
        "creativeBrief?": creativeBriefShape,
        "outputSpec?": { size: "number", format: "string", maxBytes: "number", colorSpace: "string", dpi: "number" },
        "overlay?": { logo: { ...overlay, placement: "string" }, watermark: { ...overlay, mode: "string", position: "string", opacity: "number" } },
    },
};

// Reconstruct only public policy fields; envelope extras can never become store state.
function readShape(value: unknown, shape: Shape): unknown {
    if (typeof shape === "string") {
        if (typeof value !== shape || (typeof value === "number" && !Number.isFinite(value))) throw new Error("字段类型无效");
        return value;
    }
    if (Array.isArray(shape)) {
        if (!Array.isArray(value) || value.length > 10000) throw new Error("数组格式或数量无效");
        return value.map((item) => readShape(item, shape[0]));
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("对象格式无效");
    const record = value as Record<string, unknown>;
    if (shape === translations && Object.keys(record).some((key) => !(COMMERCE_LOCALES as readonly string[]).includes(key))) {
        throw new Error("翻译预设包含不支持的 locale");
    }
    if ("storageKey" in record) throw new Error("公共参考图不能包含 storageKey");
    return Object.fromEntries(Object.entries(shape).flatMap(([field, child]) => {
        const optional = field.endsWith("?"); const key = optional ? field.slice(0, -1) : field;
        return optional && record[key] === undefined ? [] : [[key, readShape(record[key], child)]];
    }));
}

export function publicRulesUrl(value: string, origin: string): string {
    const url = new URL(value, origin);
    if (!/^https?:$/.test(url.protocol) || url.origin !== origin || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith("/public-rules/") || /[%\\\s]/.test(value)) throw new Error("地址必须为同源 /public-rules/ 路径，不能包含认证或查询参数");
    return url.href;
}

export function parsePolicyCatalog(value: unknown, origin: string): PolicyCatalog {
    const envelope = value as Partial<PolicyCatalog> | null;
    if (!envelope || envelope.schemaVersion !== 1 || typeof envelope.revision !== "string" || !/^[A-Za-z0-9_-]+$/.test(envelope.revision)
        || typeof envelope.publishedAt !== "string" || !Number.isFinite(Date.parse(envelope.publishedAt)) || !Array.isArray(envelope.policyPacks) || envelope.policyPacks.length > 100) throw new Error("公共规则目录格式无效");
    const policyPacks = envelope.policyPacks.map((raw) => {
        const pack = readShape(raw, packShape) as PolicyPack;
        if (!/^server-aoweisi-.+-v[1-9]\d*-[a-f0-9]{12}$/.test(pack.id) || !pack.id.endsWith(`-v${pack.version}-${pack.id.slice(-12)}`)
            || !Number.isSafeInteger(pack.version) || pack.version < 1 || pack.status !== "published") throw new Error("公共规则必须使用服务器版本 ID 且已发布");
        for (const ref of pack.references) {
            const url = new URL(publicRulesUrl(ref.url, origin));
            if (!new RegExp(`^/public-rules/releases/${envelope.revision}/images/[a-f0-9]{64}\\.(?:png|jpg|webp|gif)$`).test(url.pathname)
                || !["upload", "url", "zip", "generated", "rule-reference"].includes(ref.source)) throw new Error("公共参考图地址或来源无效");
            ref.url = url.pathname;
        }
        for (const ref of pack.siteReferences) if (ref.url) ref.url = publicRulesUrl(ref.url, origin);
        // Editorial review flags are not an import requirement. Validate all structural/enumerated policy values.
        const check = { ...pack, requirementPresets: pack.requirementPresets.map((preset) => ({ ...preset, needsReview: true })) };
        const errors = validatePolicyEdit(check, check);
        if (errors.length) throw new Error(errors.join("；"));
        return pack;
    });
    if (new Set(policyPacks.map((pack) => pack.id)).size !== policyPacks.length) throw new Error("公共规则 ID 重复");
    return { schemaVersion: 1, revision: envelope.revision, publishedAt: envelope.publishedAt, policyPacks };
}

export function mergePolicyCatalog(existing: PolicyPack[], incoming: PolicyPack[]): PolicyPack[] {
    const latest = new Set(incoming.map((pack) => pack.id));
    const known = new Set(existing.map((pack) => pack.id));
    return [...existing.map((pack): PolicyPack => {
        if (pack.id.startsWith("server-aoweisi-team-")) return pack;
        if (!pack.id.startsWith(SERVER_POLICY_PREFIX)) return pack;
        if (latest.has(pack.id) && pack.status === "retired") return { ...pack, status: "published" };
        if (!latest.has(pack.id) && pack.status === "published") return { ...pack, status: "retired" };
        return pack;
    }), ...incoming.filter((pack) => !known.has(pack.id))];
}

export async function fetchPolicyCatalog(url: string, origin: string, timeoutMs = 15000): Promise<PolicyCatalog> {
    const target = publicRulesUrl(url, origin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(target, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parsePolicyCatalog(await response.json(), origin);
    } catch (error) {
        throw new Error(controller.signal.aborted ? "公共规则加载超时，请检查网络后重试" : `公共规则加载失败：${error instanceof Error ? error.message : "网络异常"}。请检查网络或联系管理员后重试`);
    } finally { clearTimeout(timer); }
}
