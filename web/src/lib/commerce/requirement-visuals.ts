import type { CommerceRequirementPreset, GenerationAssetStage, MarketingLayoutPreset } from "@/types/commerce";

type Visual = readonly [GenerationAssetStage, MarketingLayoutPreset];
// Workbook order disambiguates terse instructions such as “参考布局排版”.
const auditedVisuals: Record<string, readonly Visual[]> = {
    地毯地垫类: [["scene", "single-hero"], ["scene", "single-hero"], ["scene", "single-hero"], ["detail", "feature-grid"], ["scene", "before-after"], ["usage-size", "size-comparison"], ["detail", "feature-grid"], ["usage-size", "feature-grid"], ["scene", "lighting-comparison"], ["detail", "single-hero"], ["scene", "color-options"]],
    桌垫类: [["scene", "color-options"], ["usage-size", "custom-reference"], ["scene", "single-hero"], ["usage-size", "single-hero"], ["detail", "single-hero"], ["detail", "feature-grid"], ["detail", "feature-grid"], ["detail", "layer-structure"], ["scene", "multi-scene"], ["detail", "competitor-comparison"], ["scene", "custom-reference"]],
    洞洞板类: [["scene", "single-hero"], ["scene", "single-hero"], ["scene", "single-hero"], ["scene", "multi-scene"], ["usage-size", "installation-methods"], ["usage-size", "size-comparison"], ["usage-size", "installation-steps"], ["usage-size", "faq"], ["scene", "single-hero"]],
    收纳筐类: [["scene", "single-hero"], ["scene", "single-hero"], ["usage-size", "feature-grid"], ["scene", "custom-reference"], ["detail", "feature-grid"], ["scene", "before-after"], ["detail", "competitor-comparison"], ["detail", "color-options"], ["usage-size", "size-comparison"]],
};

// Match source instructions, never category/order alone. Kept inline so Node can
// strip types without a JSON loader; new imports receive fresh IDs.
const auditedPrompts: Record<string, readonly string[]> = {
    地毯地垫类: ["客厅场景、不用放人和宠物，每个颜色来一张，注意家具和色彩搭配（4个sku都做一张）","卧室场景","餐厅场景","产品特性集合展示，参考图里的布局，左右两部分","使用地毯前后的对比图，通过搭配展示出使用了地毯后的氛围感，家居品质提升","3个尺寸的展示场景对比，标注尺寸.2*3的放上半部分，其他两个尺寸放下面各占一半。标注厚度","细节展示，用地毯作为背景，要看清编织纹理","清洁方式","不同光线下的颜色呈现差异。上半部分放场景图","体现编织纹理，有个人坐旁边，不用整个人出现，出现局部就可以了","四种颜色可选"],
    桌垫类: ["上下结构，不要做成餐桌垫，上把那部分不用放置餐盘或者食物，试试放一束花点缀。下半部分展示其他不同款式，按各站点的售卖的款式填充。看下是圆形图标还是六边形图标更合适。不用像参考图里的放12个。放10个或者8个就行","厨房洗手台场景。用多长时间合适需要测一下，并对应更改","台面上放置咖啡机的垫子，注意比例","体现耐热","不是要做脚垫场景，参考一下文案位置，在桌垫上放入这段文案。吸水时间需要测一下。文案放置的地方需要看花色图案空白处定，可能是最下边，也可能是中间","细节展示","参考布局排版","材料细节展示","场景展示，不要放宠物的场景。","对比图，别人的用久了底部会脱落黏在桌子台面上，而我们的不会","无"],
    洞洞板类: ["如右图一高一矮一黑一白的风格，白色桌子，类似图一的背景，不要道具。\n板子和配件按相同颜色搭配，不混搭。\n用夹式支架，配件参考右图数量和摆放。\n\n给一张无文字版本的。\n\n视角：如右图。","书桌，灯光的效果。\n2块白色30*45cm板子。\n立式支架。\n\n视角：如右图。","直接参考右图，要一样的背景和类似的道具摆件。\n换成2块白色30*45cm的板子。\n\n视角：如右图","多场景图","展示三种安装方式","注意事项","安装步骤","1.这款洞洞板适用于其他品牌吗？\n（配件仅适用于本店铺内的圆孔类型洞洞板）\n2.这款洞洞板需要打孔吗？\n（无需打孔，安装方式为桌面支架和无痕贴）\n3.什么情况下需要购买连接件？\n（多块洞洞板可选择连接件牢固安装，墙面安装无需使用连接件。）\n4.商品有缺陷、未收到完整物品或我不会安装怎么办？\n（如商品有缺陷或使用中遇到问题,请立即联系店铺，工作人员将尽快为您解决）","想要一个白色少女风格的主图，或者两张。这种看着比较洁白且比较少女或者比较实用的。\n桌子最好是白色的，墙壁也是白色。"],
    收纳筐类: ["客厅场景，融合绿色植物作为背景，呈现天然的感觉，放两个。一个盖子打开，另一个盖子合上","放置在衣橱使用","展示可以收纳什么东西","文案用里面的","细节展示，体现圆润不会割伤、坚固、编织线密集、手工织造","使用前后对比","同行对比","三种花色设计","照抄，尺寸用 M、L、XL、XXL"],
};

function semanticVisual(text: string): Visual | undefined {
    if (/FAQ|怎么办|适用于其他品牌/i.test(text)) return ["usage-size", "faq"];
    if (/安装步骤|安装指南/.test(text)) return ["usage-size", "installation-steps"];
    if (/安装方式|固定方式/.test(text)) return ["usage-size", "installation-methods"];
    if (/同行|别人的|竞品/.test(text)) return ["detail", "competitor-comparison"];
    if (/使用.*前后|使用前|使用后|前\/后/.test(text)) return ["scene", "before-after"];
    if (/不同光线|自然光.*暖光/s.test(text)) return ["scene", "lighting-comparison"];
    if (/三层|填充层/.test(text)) return ["detail", "layer-structure"];
    if (/尺寸.*对比|标注尺寸|M、L|孔距|孔径/.test(text)) return ["usage-size", "size-comparison"];
    if (/多场景|多种场景|多种场合/.test(text)) return ["scene", "multi-scene"];
    if (/种颜色可选|花色设计|其他不同款式/.test(text)) return ["scene", "color-options"];
    return undefined;
}

/** Explicit import/publication transform. Never call implicitly when reading stored policies.
 * Preserves IDs, references, translations and marketing intent; does not assert product facts.
 */
export function correctedPresetVisual(preset: CommerceRequirementPreset): CommerceRequirementPreset {
    const text = `${preset.prompt}\n${preset.chineseCopy}`;
    const knownPrompt = auditedPrompts[preset.category]?.[preset.order - 1];
    const audited = knownPrompt === preset.prompt.trim().replace(/\r\n/g, "\n")
        ? auditedVisuals[preset.category]?.[preset.order - 1] : undefined;
    const [visualKind, layout] = semanticVisual(text) || audited || (
        /细节|纹理|材质|编织|包边/.test(text) ? ["detail", "feature-grid"] :
        /尺寸|比例|使用|安装|耐热|吸水时间/.test(text) ? ["usage-size", "single-hero"] :
        ["scene", /参考布局|文案用里面|照抄/.test(text) ? "custom-reference" : "single-hero"]
    );
    const requiredFacts = new Set(preset.requiredFacts);
    const require = (pattern: RegExp, ...facts: string[]) => { if (pattern.test(text)) facts.forEach((fact) => requiredFacts.add(fact)); };
    require(/同行|别人的|竞品/, "竞品对比依据");
    require(/XX+\s*秒|吸水时间|[13]秒后/i, "吸水时间");
    require(/厚度|厚\s*xxx/i, "产品厚度");
    require(/耐热|100\s*[°度]/, "耐热温度");
    require(/尺寸|\d+\s*[*×]\s*\d+\s*cm/i, "产品尺寸");
    require(/孔距|孔间距/, "孔距");
    require(/孔径|孔位直径/, "孔径");
    require(/配件.*数量/, "配件数量");
    require(/安装方式|固定方式|安装指南|安装步骤/, "安装方式");
    require(/颜色可选|花色设计|其他不同款式/, "颜色");
    require(/盖子.*(?:打开|合上)|(?:打开|合上).*盖子/, "是否配盖");
    const craftOrSafetyClaim = /手工|不会割伤|避免被划伤|儿童友好/.test(text);
    if (craftOrSafetyClaim) requiredFacts.add("材质与工艺");
    require(/清洁方式|吸尘器|扫地机器人|布艺清洁剂/, "清洁方式");
    if (layout === "layer-structure") requiredFacts.add("材质层次");
    const missingCopy = /^\s*(?:无)?\s*$/.test(preset.prompt) || (/文案用里面|文案照抄/.test(text) && !preset.chineseCopy.trim());
    const stage = /无文字版本|不要文字|不加文字|无文案版本/.test(preset.prompt) ? visualKind : preset.stage;
    const variantScope = /每个颜色|每种颜色|每个花色/.test(preset.prompt) ? "per-color"
        : layout === "color-options" ? "per-sku" : preset.variantScope;
    return { ...preset, stage, variantScope, visualMode: preset.visualMode ?? "generate", visualKind, layout,
        requiredFacts: [...requiredFacts], needsReview: preset.needsReview || missingCopy || craftOrSafetyClaim || layout === "competitor-comparison" };
}
