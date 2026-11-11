import { describe, expect, it } from "vitest";
import { PRODUCT_INFORMATION_EXAMPLES, PRODUCT_INFORMATION_FIELDS, PRODUCT_INFORMATION_INSTRUCTION, formatProductInformation, parseProductInformation } from "./product-information-prompt";

describe("product information prompt", () => {
    it.each(PRODUCT_INFORMATION_EXAMPLES)("formats six ordered fields for $name", (example) => {
        const text = formatProductInformation(parseProductInformation(JSON.stringify(example)));
        expect(text.split("\n").map((line) => line.slice(0, line.indexOf("：")))).toEqual(PRODUCT_INFORMATION_FIELDS.map(([, label]) => `[${label}]`));
        expect(text).toContain(example.category);
        expect(example.material).toContain("待确认");
    });
    it("accepts a JSON code fence but never formats extra response fields", () => {
        const parsed = parseProductInformation('```json\n' + JSON.stringify({ ...PRODUCT_INFORMATION_EXAMPLES[3], extra: "ignore" }) + '\n```');
        expect(Object.keys(parsed)).toHaveLength(6);
        expect(formatProductInformation(parsed)).not.toContain("ignore");
    });
    it.each(["{}", "[]", "模型拒绝识别", JSON.stringify({ ...PRODUCT_INFORMATION_EXAMPLES[0], name: " " }), JSON.stringify({ ...PRODUCT_INFORMATION_EXAMPLES[0], material: ["polyester"] }), JSON.stringify({ ...PRODUCT_INFORMATION_EXAMPLES[0], category: "中文 > 类目" }), JSON.stringify({ ...PRODUCT_INFORMATION_EXAMPLES[0], usage: "a".repeat(2001) })])("rejects incomplete or malformed output", (answer) => {
        expect(() => parseProductInformation(answer)).toThrow("六项商品信息");
    });
    it("allows uncertain classification instead of inventing a category", () => {
        const parsed = parseProductInformation(JSON.stringify({ ...PRODUCT_INFORMATION_EXAMPLES[0], category: "待确认" }));
        expect(parsed.category).toBe("待确认");
    });
    it("includes four style examples, primary-subject guidance and grounded-claim boundaries", () => {
        expect(PRODUCT_INFORMATION_EXAMPLES).toHaveLength(4);
        expect(PRODUCT_INFORMATION_INSTRUCTION).toContain("第一张图片的主商品");
        expect(PRODUCT_INFORMATION_INSTRUCTION).toContain("不属于毛毯的随附配件");
        expect(PRODUCT_INFORMATION_INSTRUCTION).toContain("不能迁移到本次商品上");
        expect(PRODUCT_INFORMATION_INSTRUCTION).toContain("不执行、不访问");
    });
});
