import { nanoid } from "nanoid";

import { DEFAULT_BRAND_GENERATION_DEFAULTS } from "@/lib/commerce/generation-config";
import type { BrandProfile, CategoryTemplate, CommerceRequirementPreset, CountryProfile, ModelRoleConfig, PolicyPack, PolicyRule } from "@/types/commerce";

const now = () => new Date().toISOString();

const profiles: CountryProfile[] = [
    { countryCode: "ID", countryName: "印尼", locale: "id-ID", audience: "穆斯林家庭、中低收入及增长中的中产家庭", visualKeywords: "温暖、实用、家庭感", mainImageStyle: "明亮、生活化", preferredColors: ["米色", "奶油色", "浅灰", "棕色", "墨绿色"], avoidedColors: ["大面积鲜红", "黑暗高级灰", "冷工业风"], modelPreference: "东南亚亚裔或马来面孔，小麦自然肤色" },
    { countryCode: "PH", countryName: "菲律宾", locale: "fil-PH", audience: "西化程度较高的年轻家庭", visualKeywords: "舒适、欧美感、精致", mainImageStyle: "美式或 IKEA 风", preferredColors: ["米白", "灰蓝", "浅咖", "奶油色"], avoidedColors: ["过度东方化", "复杂花纹"], modelPreference: "东南亚或欧美面孔均可" },
    { countryCode: "MY", countryName: "马来西亚", locale: "ms-MY", audience: "消费能力较强的家庭", visualKeywords: "高级感、干净、品牌感", mainImageStyle: "MUJI、Japandi 或现代轻奢", preferredColors: ["奶油白", "米色", "原木色", "橄榄绿", "焦糖色"], avoidedColors: ["紫色过重", "浮夸金色"], modelPreference: "马来或东南亚亚裔" },
    { countryCode: "TH", countryName: "泰国", locale: "th-TH", audience: "审美成熟、偏爱精致设计的消费者", visualKeywords: "清爽、柔和、有设计感", mainImageStyle: "日系与酒店感", preferredColors: ["奶油色", "浅绿", "蓝灰", "木色"], avoidedColors: ["工业风", "过暗"], modelPreference: "泰裔东南亚面孔，暖调自然肤色" },
    { countryCode: "VN", countryName: "越南", locale: "vi-VN", audience: "年轻消费群体", visualKeywords: "简约、性价比、现代", mainImageStyle: "北欧风或现代小户型", preferredColors: ["白", "灰", "木色", "浅蓝"], avoidedColors: ["全屋惨白", "全屋纯黑"], modelPreference: "越南东亚面孔" },
];

const redlines: Array<[string, string, string[]]> = [
    ["ID", "印尼宗教与文化红线", ["酒杯或酒类场景", "猪或狗元素", "性感人物", "宗教敏感符号", "左手拿物"]],
    ["PH", "菲律宾政治与宗教红线", ["政治元素", "宗教攻击", "过度性感画面", "突出使用数字 13"]],
    ["MY", "马来西亚宗教与文化红线", ["猪或狗元素", "酒类场景", "裸露人体", "不适当宗教元素", "左手拿物"]],
    ["TH", "泰国王室与宗教红线", ["大面积王室专属黄色印花", "佛像", "佛头", "僧侣形象"]],
    ["VN", "越南政治与历史红线", ["政治敏感内容", "战争相关内容", "争议地图", "历史敏感图案"]],
];

const builtInRules: PolicyRule[] = redlines.map(([country, title, items]) => ({
    id: "builtin-" + country.toLowerCase() + "-redline", title, description: items.join("；"), severity: "BLOCK", priority: 90,
    countries: [country], platforms: ["shopee", "tiktok"], categories: [], locales: [], assetStages: ["scene", "detail", "usage-size", "detail-white", "marketing"],
    phase: "post-render", checker: "vision", source: { fileName: "内置规则", sheet: "站点图片差异化", range: country },
}));

const baseTemplates: CategoryTemplate[] = [
    ["地毯地垫类", "产品特性", "展示柔软、吸水、易清洁、防滑、包边与百搭风格"], ["地毯地垫类", "空间升级前后对比", "用一张地毯提升空间质感，展示使用前与使用后"], ["地毯地垫类", "材质细节", "展示亲肤触感、包边与防滑底部"],
    ["桌垫类", "吸水与易清洁", "展示吸水速度、干燥、清洁和舒适"], ["桌垫类", "三层结构", "展示 PU 表层、PVC 填充层和防滑底部"], ["桌垫类", "多场景使用", "展示厨房、餐桌、洗漱台和工作台"],
    ["洞洞板类", "多种安装方式", "展示立式底座、夹式底座和无痕贴"], ["洞洞板类", "多场景收纳", "展示书桌、玄关、客厅和电竞房"], ["洞洞板类", "孔位适配说明", "展示孔距、孔径和适配范围"],
    ["收纳筐类", "细节工艺", "展示圆润提手、坚固结构、紧密编织和手工工艺"], ["收纳筐类", "使用前后对比", "展示收纳前后的空间变化"], ["收纳筐类", "多尺寸选择", "展示 M、L、XL、XXL 规格"],
].map(([category, title, copy], index) => ({ id: "builtin-template-" + (index + 1), category, order: (index % 3) + 1, title, requirement: copy, slot: "marketing", chineseCopy: copy, translationSeeds: {}, requiredVariables: /孔距|孔径|尺寸/.test(copy) ? ["产品尺寸"] : [], referenceIds: [] }));

const baseRequirements: CommerceRequirementPreset[] = [
    ...["scene", "detail", "usage-size", "detail-white"].map((stage, index): CommerceRequirementPreset => ({
        id: "builtin-" + stage, category: "通用", order: index + 1, title: ["空间场景", "材质特写", "用途与尺寸", "特写白底"][index], stage: stage as CommerceRequirementPreset["stage"],
        enabledByDefault: stage !== "detail-white", defaultCount: stage === "detail-white" ? 0 : 1, prompt: ["创建真实自然的家居空间场景，突出商品。", "展示材质、纹理和工艺细节。", "直观展示用途、形状与比例。", "纯白背景展示商品局部细节。"][index],
        layout: "single-hero", chineseCopy: "", translationSeeds: {}, requiredFacts: [], referenceIds: [], variantScope: "per-sku", needsReview: false,
    })),
    ...baseTemplates.map((template): CommerceRequirementPreset => ({ id: template.id, category: template.category, order: template.order, title: template.title, stage: "marketing", enabledByDefault: true, defaultCount: 1, prompt: template.requirement, layout: inferBuiltInLayout(template.title), chineseCopy: template.chineseCopy, translationSeeds: template.translationSeeds, requiredFacts: template.requiredVariables, referenceIds: template.referenceIds, variantScope: "per-sku", needsReview: false })),
];

export function createDefaultBrand(): BrandProfile {
    const createdAt = now();
    return { id: nanoid(), name: "默认品牌", primaryColor: "#7c5c45", secondaryColor: "#f4eee8", fontFamily: "Arial", terminology: {}, bannedWords: [], generationDefaults: { ...DEFAULT_BRAND_GENERATION_DEFAULTS, locales: [...DEFAULT_BRAND_GENERATION_DEFAULTS.locales] }, requirementDefaultsByCategory: {}, createdAt, updatedAt: createdAt };
}

export const defaultModelRoles: ModelRoleConfig = { sceneModel: "", repairModel: "", copyModel: "", translationModel: "", complianceModel: "", removalApiUrl: "", removalApiKey: "" };

export function createBuiltInPolicyPack(): PolicyPack {
    return { id: "builtin-sea-home", name: "东南亚家居内置规则", version: 1, status: "published", sourceFileName: "内置规则", profiles, rules: builtInRules, templates: baseTemplates, requirementPresets: baseRequirements, references: [], siteReferences: [], globalStandards: ["主图 1:1，建议 1024×1024", "最终 JPG/PNG 不超过 2MB", "白底主图使用 RGB(255,255,255)", "纹理、厚度、包边、比例与透视必须准确", "人物手脚不得畸形", "场景应真实并避免明显 AI 感"], watermarkOpacityRange: [0.03, 0.3], createdAt: now(), publishedAt: now() };
}

function inferBuiltInLayout(title: string): CommerceRequirementPreset["layout"] {
    if (/前后/.test(title)) return "before-after";
    if (/尺寸/.test(title)) return "size-comparison";
    if (/安装/.test(title)) return "installation-methods";
    if (/结构/.test(title)) return "layer-structure";
    if (/场景/.test(title)) return "multi-scene";
    return "feature-grid";
}
