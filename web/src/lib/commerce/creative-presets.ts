import type { CommerceCreativeBrief, CommerceRecipeRole, CommerceRequirementPreset } from "../../types/commerce";

const roles: CommerceRecipeRole[] = ["hero", "detail", "usage", "selling-point", "secondary-scene", "interaction", "lighting", "before-after"];
const titles = ["空间主视觉", "可见细节", "日常用途", "卖点展示", "第二场景", "成人互动", "光影展示", "使用前后"];
const stages: CommerceRequirementPreset["stage"][] = ["scene", "detail", "usage-size", "marketing", "scene", "scene", "scene", "marketing"];

const categories = [
    {
        slug: "rugs", category: "地毯地垫类", scene: "客厅", secondary: "卧室床边",
        shots: [
            "将地毯平铺在客厅座位区，家具只作空间参照，完整保留可见花纹与边缘。",
            "近距离展示参考商品可见的表面纹理与边缘，不推测底面或内部结构。",
            "展示地毯与座椅、地面的实际摆放关系，用日常家具表现用途，不标注未经确认的尺寸。",
            "以地毯可见花纹、配色和铺设效果作为画面重点，留出简洁文案区。",
            "将同一地毯放在卧室床边，保留床边通道和商品边缘的可见性。",
            "表现成人在地毯旁用手整理边缘的自然动作，商品花纹保持清晰。",
            "让侧向光线掠过地毯表面，表现真实纹理，保持商品原有颜色。",
            "同一客厅机位展示铺设地毯前后；前图无地毯，后图加入该商品，家具与装饰保持一致。",
        ],
    },
    {
        slug: "mats", category: "桌垫类", scene: "书桌桌面", secondary: "经产品用途确认适用的台面；未确认时使用书桌桌面",
        shots: [
            "将桌垫平铺在书桌桌面，少量办公物品衬托用途，完整展示轮廓与图案。",
            "近距离拍摄桌垫可见表面、边缘与印花，不添加剖面或假想层次。",
            "展示桌垫在日常桌面上的摆放方式，物品不遮挡主要图案，比例依据参考商品。",
            "突出桌垫可见图案和整洁桌面搭配，留出文案区，仅表达已提供的卖点。",
            "仅当产品用途确认适用于台面时展示该台面，否则仍展示另一处书桌；不暗示耐热或吸水性能。",
            "表现成人用手轻轻摆正桌垫或放置文具，保留商品轮廓。",
            "用柔和侧光展示桌垫表面与图案，避免反光掩盖细节或改变配色。",
            "同一桌面机位展示放置桌垫前后；前图无桌垫，后图加入该商品，其余物品保持一致。",
        ],
    },
    {
        slug: "pegboards", category: "洞洞板类", scene: "办公书桌区", secondary: "兴趣用品收纳角",
        shots: [
            "在办公书桌区展示洞洞板，保持参考商品的板形、孔位及已确认配件组合。",
            "近拍可见孔位、板面和连接处，不补画未提供的配件或安装结构。",
            "展示已确认配件如何放置少量日常文具，保持取放空间，不推测承重或通用适配。",
            "以可见的分区收纳和物品摆放关系表达卖点，保留简洁文案区。",
            "在兴趣用品收纳角展示洞洞板，只使用商品已确认支持的配件与摆放方式。",
            "表现成人用手取放一件轻巧文具，使用已确认的配件，避免遮住板面。",
            "用侧光呈现孔位与板面的层次，保持孔形、配色和配件一致。",
            "固定办公桌面机位，前图文具放在桌面且无洞洞板，后图使用该商品和已确认配件收纳同一组文具；背景保持一致。",
        ],
    },
    {
        slug: "baskets", category: "收纳筐类", scene: "客厅", secondary: "衣橱收纳区",
        shots: [
            "在客厅展示收纳筐，保持参考商品的轮廓、开口与可见结构，背景简洁。",
            "近拍收纳筐可见表面、边缘和接合处，不推测手工工艺、材质或安全性能。",
            "展示收纳筐放置少量日常物品的用途，物品不过度填满，不暗示未经确认的容量。",
            "以可见外观和归拢物品的摆放效果表达卖点，留出简洁文案区。",
            "在衣橱收纳区摆放同一收纳筐，显示取放空间，保持商品比例。",
            "表现成人用手将日常小物放入收纳筐，手部不遮挡主要结构。",
            "用柔和侧光呈现收纳筐可见纹理与轮廓，保持真实配色。",
            "同一客厅机位，前图日常物品散放且无收纳筐，后图将同一组物品归拢到该收纳筐；其余环境保持一致。",
        ],
    },
];

/** Independent v3 catalog; never upgrades or rewrites historical presets. */
export function createCreativeRequirementPresets(): CommerceRequirementPreset[] {
    return categories.flatMap((category) => roles.map((role, index) => {
        const creativeBrief: CommerceCreativeBrief = {
            scene: role === "secondary-scene" ? category.secondary : category.scene,
            lighting: role === "lighting" ? "side-light" : "natural-window",
            people: role === "interaction" ? "adult-partial" : "none",
            framing: role === "detail" ? "close" : role === "hero" || role === "secondary-scene" || role === "before-after" ? "wide" : "medium",
        };
        return {
            id: `creative-v1-${category.slug}-${role}`, category: category.category, order: index + 1,
            title: titles[index], stage: stages[index], enabledByDefault: index < 4, defaultCount: 1,
            prompt: category.shots[index], layout: role === "before-after" ? "before-after" : "single-hero",
            chineseCopy: "", translationSeeds: {}, requiredFacts: [], referenceIds: [],
            variantScope: "per-sku", needsReview: false, visualMode: "generate",
            visualKind: stages[index] === "marketing" ? "scene" : stages[index] as "scene" | "detail" | "usage-size",
            creativeBrief, recipeRole: role, generationStrategy: role === "before-after" ? "paired-before-after" : "single",
        };
    }));
}
