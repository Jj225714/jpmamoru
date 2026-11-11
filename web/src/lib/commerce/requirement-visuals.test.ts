import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommerceRequirementPreset } from "@/types/commerce";
import fixture from "./fixtures/aowei-visual-audit.json";
import { correctedPresetVisual } from "./requirement-visuals";

vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

const actual = fixture.map((preset) => ({ ...preset, translationSeeds: { "en-US": "Existing translation" } })) as CommerceRequirementPreset[];
const layouts: Record<string, string[]> = {
    地毯地垫类: ["single-hero", "single-hero", "single-hero", "feature-grid", "before-after", "size-comparison", "feature-grid", "feature-grid", "lighting-comparison", "single-hero", "color-options"],
    桌垫类: ["color-options", "custom-reference", "single-hero", "single-hero", "single-hero", "feature-grid", "feature-grid", "layer-structure", "multi-scene", "competitor-comparison", "custom-reference"],
    洞洞板类: ["single-hero", "single-hero", "single-hero", "multi-scene", "installation-methods", "size-comparison", "installation-steps", "faq", "single-hero"],
    收纳筐类: ["single-hero", "single-hero", "feature-grid", "custom-reference", "feature-grid", "before-after", "competitor-comparison", "color-options", "size-comparison"],
};

describe("corrected requirement visuals", () => {
    it("classifies the actual 40 requirements with meaningful layouts and preserves their identities", () => {
        const before = structuredClone(actual);
        expect(actual).toHaveLength(40);
        expect(Object.fromEntries(Object.keys(layouts).map((category) => [category, actual.filter((p) => p.category === category).length])))
            .toEqual({ 地毯地垫类: 11, 桌垫类: 11, 洞洞板类: 9, 收纳筐类: 9 });
        for (const preset of actual) {
            const corrected = correctedPresetVisual(preset);
            expect(corrected.layout, `${preset.category} #${preset.order}`).toBe(layouts[preset.category][preset.order - 1]);
            expect(corrected.visualMode).toBe("generate");
            expect(["scene", "detail", "usage-size", "detail-white"]).toContain(corrected.visualKind);
            expect(corrected).toMatchObject({ id: preset.id, stage: /无文字版本/.test(preset.prompt) ? corrected.visualKind : preset.stage, referenceIds: preset.referenceIds, translationSeeds: preset.translationSeeds, prompt: preset.prompt, chineseCopy: preset.chineseCopy });
            expect(correctedPresetVisual(corrected)).toEqual(corrected);
        }
        expect(actual).toEqual(before);
    });
    it("separates scene generation from marketing intent and preserves explicit white layouts", () => {
        const preset = actual.find((p) => p.category === "洞洞板类" && p.order === 4)!;
        expect(correctedPresetVisual(preset)).toMatchObject({ stage: "marketing", visualKind: "scene", visualMode: "generate", layout: "multi-scene" });
        expect(correctedPresetVisual({ ...preset, visualMode: "white-layout" }).visualMode).toBe("white-layout");
    });
    it("uses per-color only when each color is explicitly requested", () => {
        expect(correctedPresetVisual(actual[0]).variantScope).toBe("per-color");
        const colors = actual.find((p) => p.category === "收纳筐类" && p.order === 8)!;
        expect(correctedPresetVisual({ ...colors, variantScope: "per-color" }).variantScope).toBe("per-sku");
    });
    it("uses the full prompt/copy for unknown categories rather than the old stage/layout or truncated title", () => {
        expect(correctedPresetVisual({ ...actual[0], category: "新类目", title: "细节", stage: "marketing", prompt: "不同光线下的颜色呈现差异", chineseCopy: "自然光、暖光、冷光" }))
            .toMatchObject({ visualKind: "scene", layout: "lighting-comparison", stage: "marketing" });
    });
    it("flags missing instructions and requires evidence rather than treating requested claims as verified facts", () => {
        const corrected = actual.map(correctedPresetVisual);
        expect(corrected.find((p) => p.prompt === "无")?.needsReview).toBe(true);
        expect(corrected.find((p) => p.prompt === "文案用里面的")?.needsReview).toBe(true);
        for (const preset of corrected.filter((p) => p.layout === "competitor-comparison")) {
            expect(preset.requiredFacts).toContain("竞品对比依据");
            expect(preset.needsReview).toBe(true);
        }
        expect(corrected.find((p) => p.category === "桌垫类" && p.order === 6)?.requiredFacts).toEqual(expect.arrayContaining(["吸水时间", "产品厚度"]));
        expect(corrected.find((p) => p.category === "桌垫类" && p.order === 4)?.requiredFacts).toContain("耐热温度");
    });
    it("requires confirmation of lids, craftsmanship, cleaning instructions and internal layers", () => {
        const get = (category: string, order: number) => correctedPresetVisual(actual.find((p) => p.category === category && p.order === order)!);
        expect(get("收纳筐类", 1).requiredFacts).toContain("是否配盖");
        expect(get("收纳筐类", 5)).toMatchObject({ requiredFacts: expect.arrayContaining(["材质与工艺"]), needsReview: true });
        expect(get("地毯地垫类", 8).requiredFacts).toContain("清洁方式");
        expect(get("桌垫类", 8).requiredFacts).toContain("材质层次");
        for (const fact of ["是否配盖", "材质与工艺", "清洁方式", "材质层次"]) expect(get("地毯地垫类", 2).requiredFacts).not.toContain(fact);
    });
    it("does not apply audited row meanings to unrelated prompts even with an old ID", () => {
        for (const preset of actual) {
            const corrected = correctedPresetVisual({ ...preset, prompt: "客厅场景", chineseCopy: "", requiredFacts: [], needsReview: false });
            expect(corrected, `${preset.category} #${preset.order}`).toMatchObject({ visualKind: "scene", layout: "single-hero", requiredFacts: [], needsReview: false });
        }
        const preset = actual.find((p) => p.category === "桌垫类" && p.order === 7)!;
        expect(correctedPresetVisual({ ...preset, id: "fresh-import", referenceIds: [], chineseCopy: "" }).layout).toBe("feature-grid");
    });
    it("applies the correction to new workbook imports", async () => {
        // This workbook has no images; browser XML image extraction is outside this test.
        vi.stubGlobal("DOMParser", class { parseFromString() { return { getElementsByTagName: () => [] }; } });
        const { parsePolicyWorkbook } = await import("./importers");
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("各类目图片需求");
        for (const category of Object.keys(layouts)) {
            sheet.addRow([category]);
            for (const preset of actual.filter((p) => p.category === category)) {
                const row = sheet.addRow([preset.order, preset.prompt]);
                row.getCell(8).value = preset.chineseCopy;
            }
        }
        const buffer = await workbook.xlsx.writeBuffer();
        const pack = await parsePolicyWorkbook({ name: "奥维斯测试.xlsx", arrayBuffer: async () => buffer } as File, 4);
        expect(pack.requirementPresets).toHaveLength(40);
        for (const preset of pack.requirementPresets) {
            expect(preset.visualMode).toBe("generate");
            expect(preset.layout).toBe(layouts[preset.category][preset.order - 1]);
        }
    });
});
