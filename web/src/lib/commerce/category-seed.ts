import type { CommerceCategory, CommerceRequirementPreset, PolicyPack } from "../../types/commerce";
import sourceRows from "./fixtures/category-source.json";
import { createCreativeRequirementPresets } from "./creative-presets";

const sourceFileName = "奥维斯平台类目细分要求（无命名规则版）(1).xlsx";
const childIds = ["living-room-rug", "dining-room-rug", "bedside-mat", "kitchen-mat", "bathroom-mat", "entrance-mat", "shower-mat", "large-mouse-pad", "dining-table-mat", "draining-mat"];
const scenes = ["客厅沙发旁", "餐厅餐桌下", "卧室床边", "厨房水槽或柜体前", "浴室、浴缸、淋浴房门口或洗手台前", "入户门口内或外", "淋浴房或浴缸内", "书桌桌面", "餐桌桌面", "水槽旁台面"];
const roots = [
    { id: "rugs", name: "地毯类", source: "地毯地垫类", aliases: ["地毯"] },
    { id: "floor-mats", name: "地垫类", source: "地毯地垫类", aliases: ["地垫"] },
    { id: "table-mats", name: "桌垫类", source: "桌垫类", aliases: ["桌垫"] },
    { id: "pegboards", name: "洞洞板类", source: "洞洞板类", aliases: ["洞洞板"] },
    { id: "baskets", name: "收纳筐类", source: "收纳筐类", aliases: ["收纳筐"] },
];

/** A new editable draft; existing published jobs and preset IDs are untouched. */
export function createCategorySeedPack(base: PolicyPack): PolicyPack {
    const pack = structuredClone(base);
    // Opening a new draft from an already managed catalog must preserve administrator edits.
    if (pack.categories?.length) {
        pack.status = "draft";
        pack.publishedAt = undefined;
        return pack;
    }
    const creative = createCreativeRequirementPresets();
    const presets: CommerceRequirementPreset[] = [];
    const categories: CommerceCategory[] = roots.map((root, index) => {
        const bound: CommerceRequirementPreset[] = creative
            .filter((preset) => preset.category === root.source)
            .map((preset) => {
                const detail = preset.recipeRole === "detail";
                const genericScene =
                    preset.recipeRole === "before-after"
                        ? "在所选类目的同一环境、同一机位展示使用前后；前图无目标商品，后图加入目标商品，家具与道具保持一致。"
                        : preset.recipeRole === "secondary-scene"
                          ? "在所选细分类目的同类环境中变换机位或布景，不改变用途与摆放位置。"
                          : "遵循所选类目的场景、摆放和人物要求，以当前商品为主体。";
                return {
                    ...preset,
                    id: `category-v1-${root.id}-${preset.recipeRole}`,
                    category: root.name,
                    prompt: index < 3 && !detail ? genericScene : preset.prompt,
                    creativeBrief: { ...preset.creativeBrief, ...(index < 3 ? { scene: "", people: undefined } : {}) },
                    detailPurpose: detail ? ("front-texture" as const) : undefined,
                };
            });
        const front = bound.find((preset) => preset.recipeRole === "detail")!;
        bound.push({ ...front, id: `category-v1-${root.id}-back`, order: 9, title: "背面展示", enabledByDefault: false, detailPurpose: "back", prompt: "仅依据绑定的背面实拍展示真实背面纹理、边缘与结构，不根据正面图推测，不声称未经证实的性能。" });
        presets.push(...bound);
        const referenceIds = base.requirementPresets.filter((preset) => preset.category === root.source).flatMap((preset) => preset.referenceIds);
        const matchingRefs = base.references.filter((ref) => `${ref.name} ${ref.sheet}`.includes(root.name.replace("类", ""))).map((ref) => ref.id);
        // The existing Aoweisi source workbook labels its examples by cell, not category name.
        // D57 is the pegboard hero example; D77 is the living-room storage basket example.
        const legacyAnchor = root.id === "pegboards" ? "D57" : root.id === "baskets" ? "D77" : undefined;
        const legacyRefs = legacyAnchor ? base.references.filter((ref) => ref.sheet === "各类目图片需求" && ref.anchor === legacyAnchor).map((ref) => ref.id) : [];
        const examples = [...new Set([...referenceIds, ...matchingRefs, ...legacyRefs])];
        // The workbook supplies examples only for its first three roots. Keep other legacy
        // categories available to edit, but don't activate incomplete scene recipes.
        return { id: root.id, name: root.name, aliases: root.aliases, active: index < 3 || examples.length > 0, order: index, rules: [], referenceIds: examples, requirementIds: bound.map((preset) => preset.id) };
    });
    sourceRows.forEach((row, index) => {
        const id = childIds[index];
        const parentId = index < 2 ? "rugs" : index < 7 ? "floor-mats" : "table-mats";
        const text = row.text.replaceAll("透视比例真实，畸变", "透视比例真实，不畸变").replaceAll("若出出现", "若出现");
        const people = index === 3 ? "adult-half" : index === 6 || index === 7 ? "adult-partial" : undefined;
        categories.push({
            id,
            parentId,
            name: index === 8 ? "餐桌垫" : row.name,
            aliases: index === 8 ? ["餐桌", "餐垫"] : [],
            active: true,
            order: index,
            rules: [
                { id: `${id}-placement`, text, strength: "required", stages: ["scene", "usage-size"] },
                { id: `${id}-scene`, text: `拍摄环境为${scenes[index]}`, strength: "required", stages: ["scene", "usage-size"], key: "scene", value: scenes[index] },
                ...(people
                    ? [
                          {
                              id: `${id}-people`,
                              text: index === 3 ? "人物出现半身，自然进行厨房操作" : index === 6 ? "人物仅展示大腿以下，脚部比例自然" : "人物出现手部自然操作动作",
                              strength: "required" as const,
                              stages: ["scene", "usage-size"] as ("scene" | "usage-size")[],
                              key: "people" as const,
                              value: people,
                          },
                      ]
                    : []),
            ],
            referenceIds: [`category-example-${id}`],
            requirementIds: [],
            creativeBrief: { scene: scenes[index], ...(people ? { people } : {}) },
            source: { fileName: sourceFileName, sheet: "Sheet1", range: row.range, originalText: row.text },
        });
    });
    pack.references = [
        ...pack.references,
        ...sourceRows.map((row, index) => ({
            id: `category-example-${childIds[index]}`,
            name: `${index === 8 ? "餐桌垫" : row.name}示例`,
            url: `/commerce-categories/${row.image}`,
            source: "rule-reference" as const,
            sheet: "Sheet1",
            anchor: row.range,
            kind: "example" as const,
        })),
    ];
    pack.requirementPresets = [...pack.requirementPresets, ...presets];
    pack.categories = categories;
    pack.name = "奥维斯类目与独立细节素材规则";
    pack.sourceFileName = sourceFileName;
    pack.status = "draft";
    pack.publishedAt = undefined;
    return pack;
}

export const SMALL_GLASS_MOUSE_PAD_ID = "small-glass-mouse-pad";

/** Explicit draft addition only. Never rewrite published or historical category IDs. */
export function addSmallGlassMousePad(base: PolicyPack): PolicyPack {
    const pack = structuredClone(base);
    const parent = pack.categories?.find((node) => node.id === "table-mats");
    if (!parent || pack.categories?.some((node) => node.id === SMALL_GLASS_MOUSE_PAD_ID)) return pack;
    const example = pack.categories?.find((node) => node.id === "large-mouse-pad")?.referenceIds || [];
    const referenceIds = example.length ? example : parent.referenceIds;
    const recipes: CommerceRequirementPreset[] = [
        { id: "category-v1-small-glass-mouse-pad-hero", title: "玻璃鼠标垫桌面场景", stage: "scene", recipeRole: "hero", prompt: "在书桌桌面展示真实小型玻璃鼠标垫与鼠标的使用关系。保持商品轮廓、厚度、表面图案与反射特征，不夸大比例。示例仅借鉴桌面构图，不复制示例商品材质。" },
        { id: "category-v1-small-glass-mouse-pad-detail", title: "玻璃表面与边缘实拍", stage: "detail", recipeRole: "detail", detailPurpose: "front-texture", prompt: "仅依据绑定实拍展示玻璃表面、图案与真实边缘，保留实际结构与反射，不增加纺织纹理或缝线。" },
        { id: "category-v1-small-glass-mouse-pad-usage", title: "玻璃鼠标垫使用展示", stage: "usage-size", recipeRole: "usage", prompt: "在书桌桌面展示鼠标使用方式。尺寸仅采用商品资料或已确认事实，未提供时不标注数值，不猜测固定尺寸、厚度或性能。" },
    ].map((recipe, index) => ({ category: "小型玻璃鼠标垫", order: index + 1, enabledByDefault: index === 0, defaultCount: 1, layout: "single-hero", chineseCopy: "", translationSeeds: {}, requiredFacts: [], referenceIds: [], variantScope: "per-sku", needsReview: false, creativeBrief: { scene: "书桌桌面" }, ...recipe } as CommerceRequirementPreset));
    if (recipes.some((recipe) => pack.requirementPresets.some((item) => item.id === recipe.id))) throw new Error("玻璃鼠标垫方案 ID 已存在，请先检查草稿冲突");
    pack.categories!.push({ id: SMALL_GLASS_MOUSE_PAD_ID, parentId: parent.id, name: "小型玻璃鼠标垫", aliases: ["玻璃鼠标垫"], active: false, order: Math.max(0, ...pack.categories!.map((node) => node.order)) + 1, referenceIds: [...referenceIds], requirementIds: recipes.map((recipe) => recipe.id), creativeBrief: { scene: "书桌桌面" }, rules: [
        { id: "small-glass-mouse-pad-scene", text: "在书桌桌面展示商品，保持真实比例与玻璃材质特征。", strength: "required", stages: ["scene", "usage-size"] },
        { id: "small-glass-mouse-pad-material", text: "不使用布料、吸水、包边等不适用于玻璃的要求；不虚构性能、钢化工艺或安全认证。尺寸只从商品资料和已确认事实取得，缺失时不得猜测固定值。", strength: "required", stages: ["scene", "detail", "usage-size", "detail-white"] },
    ], source: { fileName: "用户需求：P1 第15项", sheet: "2026-10-25", range: "桌垫下新增细类", originalText: "小型玻璃鼠标垫；继承桌面场景，排除布料、吸水、包边规则；尺寸只从商品资料取。" } });
    pack.requirementPresets.push(...recipes);
    pack.status = "draft";
    pack.publishedAt = undefined;
    return pack;
}
