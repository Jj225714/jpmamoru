vi.mock("@/services/server-config", () => ({ useServerConfigStore: { subscribe: () => () => {} } }));
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CreativeBriefFields } from "./creative-brief-fields";
import { ProductSuggestionEditor } from "./product-suggestion-editor";
import { RequirementRecipeCard } from "./requirement-recipe-card";
import { productSuggestionFingerprint } from "@/lib/commerce/product-suggestions";
import { DEFAULT_COMMERCE_GENERATION_CONFIG } from "@/lib/commerce/generation-config";
import type { CommerceJob, CommerceRequirementPreset, CommerceSku, ProductRecord, RequirementSelection } from "@/types/commerce";

const { analyze } = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock("@/services/product-base-prompt", () => ({ generateCommerceProductSuggestion: analyze }));
vi.mock("@/stores/use-config-store", () => ({ useConfigStore: { getState: () => ({ config: {} }) } }));
const product: ProductRecord = {
    id: "product",
    sku: "sku",
    productType: "rug",
    name: "Known name",
    brandName: "",
    category: "地毯地垫类",
    audience: "",
    description: "",
    size: "",
    images: [],
    imageUrls: [],
    extraFields: {},
    verifiedFacts: {},
    factsConfirmed: false,
    imageStatus: "missing",
};

describe("creative UI", () => {
    it("renders upload guidance without starting product analysis", () => {
        const html = renderToStaticMarkup(<ProductSuggestionEditor product={product} onSave={vi.fn()} onApply={vi.fn()} />);
        expect(html).toContain("请先上传商品实拍图");
        expect(html).toContain("AI识别商品并建议卖点");
        expect(analyze).not.toHaveBeenCalled();
    });
    it("keeps uncertainty separate and defaults existing fields to unselected", () => {
        const draft = {
            information: { name: "Suggested name", audience: "Adults", sellingPoints: "", material: "", usage: "", category: "Home > Rugs" },
            uncertainties: ["材料待确认"],
            sourceFingerprint: productSuggestionFingerprint(product),
            createdAt: new Date().toISOString(),
        };
        const html = renderToStaticMarkup(<ProductSuggestionEditor product={{ ...product, informationSuggestion: draft }} onSave={vi.fn()} onApply={vi.fn()} />);
        expect(html).toContain("待确认信息（确认后才会写入产品事实）");
        expect(html).toContain("材料待确认");
        expect(html).toContain("确认并写入事实");
        expect(html).toContain("忽略");
        expect(html).toContain("填写核实后的准确内容");
        expect(html).toContain("允许替换所选字段的已有内容");
        expect(html).toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"/);
        expect(html).not.toContain("商品输入已变化");
        expect(analyze).not.toHaveBeenCalled();
    });
    it("exposes inheritance and keeps people choices available for every recipe", () => {
        const inherited = renderToStaticMarkup(<CreativeBriefFields onChange={vi.fn()} />);
        expect(inherited).toContain("自动 / 继承");
        const detail = renderToStaticMarkup(<CreativeBriefFields value={{ people: "adult-full" }} onChange={vi.fn()} />);
        expect(detail).toContain("成人全身");
        expect(detail).toContain("人物不得遮挡商品关键结构");
        expect(detail).not.toContain("ant-select-disabled");
    });
    it("counts two calls for each count, site and custom variant in a pair", () => {
        const selection: RequirementSelection = { requirementId: "pair", enabled: true, count: 2, referenceIds: [], variantScope: "custom", variantValues: ["A", "B", "C"] };
        const requirement = { id: "pair", title: "前后对比", recipeRole: "before-after", generationStrategy: "paired-before-after", stage: "marketing", prompt: "Show before and after" } as CommerceRequirementPreset;
        const job = { generationConfig: { ...DEFAULT_COMMERCE_GENERATION_CONFIG, siteImageMode: "per-site" }, locales: ["en-US", "th-TH"] } as CommerceJob;
        const sku = { product } as CommerceSku;
        const html = renderToStaticMarkup(<RequirementRecipeCard requirement={requirement} selection={selection} job={job} sku={sku} onChange={vi.fn()} />);
        expect(html).toContain("= 24 次");
        expect(html).toContain("中间图不计入成品");
        expect(html).toContain("高级：编辑画面提示词");
        expect(html).not.toContain("Show before and after");
    });
});
