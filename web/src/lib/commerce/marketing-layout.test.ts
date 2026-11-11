import { describe, expect, it } from "vitest";
import type { CompositionLayer, LayeredComposition, MarketingLayout } from "@/types/commerce";
import { applyLayoutPreset, layoutGeometryErrors, layoutText, moveLayoutLayer, prepareEditableComposition, resizeComposition, saveLayoutPreset } from "./marketing-layout";

const layer = (patch: Partial<CompositionLayer> = {}): CompositionLayer => ({ id: "text", type: "text", name: "营销文案", x: 64, y: 680, width: 896, height: 300, zIndex: 30, opacity: 1, rotation: 0, visible: true, locked: false, content: "Made for your home", fontSize: 42, fontFamily: "Arial", lineHeight: 1.25, ...patch });
const composition = (layers: CompositionLayer[] = [layer({ id: "image", type: "background", name: "需求场景底图（含商品）", x: 0, y: 0, width: 1024, height: 1024, content: "data:original", sourceAssetId: "original-source", zIndex: 10 }), layer()]): LayeredComposition => ({ id: "comp", jobId: "job", skuId: "sku", revision: 1, requirementId: "req", width: 1024, height: 1024, layout: "single-hero", layers, backgroundColor: "#fff", createdAt: "now", updatedAt: "now" });
const measure = (text: string, size: number) => Array.from(text).reduce((sum, char) => sum + (char === "W" ? 0.95 : char === "i" ? 0.25 : 0.55) * size, 0);

describe("measured marketing text", () => {
    it.each([
        "Organise your favourite colours with style.",
        "Organize your favorite colors with style.",
        "Thoughtfully designed for comfortable everyday use. Organise your favourite accessories and bring colour to your home. ".repeat(8),
        "Thoughtfully designed for comfortable everyday use. Organize your favorite accessories and bring color to your home. ".repeat(8),
    ])("keeps all US/GB copy while fitting: %s", (content) => {
        const input = layer({ content, width: 700, height: 520, fontSize: 48, minFontSize: 12 });
        const result = layoutText(input, measure);
        expect(result.overflow).toBe(false);
        expect(result.lines.join("").replace(/\s/g, "")).toBe(content.replace(/\s/g, ""));
        expect(result.lines.every((line) => measure(line, result.fontSize) <= input.width + 0.01)).toBe(true);
        expect(result.lines.length * result.lineHeight).toBeLessThanOrEqual(input.height + 0.01);
        expect(result.fontSize).toBeLessThanOrEqual(48);
    });
    it("uses actual word width rather than a fixed character count", () => {
        expect(layoutText(layer({ content: "WWWW WWWW", width: 150, fontSize: 40, autoFit: false }), measure).lines.length).toBeGreaterThan(layoutText(layer({ content: "iiii iiii", width: 150, fontSize: 40, autoFit: false }), measure).lines.length);
    });
    it("preserves explicit newlines and splits long unbreakable words without loss", () => {
        const content = "Colour\n\n" + "Supercalifragilisticexpialidocious".repeat(2);
        const result = layoutText(layer({ content, width: 170, height: 800, fontSize: 30, autoFit: false }), measure);
        expect(result.lines[0]).toBe("Colour");
        expect(result.lines[1]).toBe("");
        expect(result.lines.join("")).toBe(content.replace(/\n/g, ""));
        expect(result.overflow).toBe(false);
    });
    it("does not split emoji grapheme clusters", () => {
        const result = layoutText(layer({ content: "👨‍👩‍👧‍👦👨‍👩‍👧‍👦", width: 35, height: 400, fontSize: 20, autoFit: false }), (s) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length * 30);
        expect(result.lines).toEqual(["👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦"]);
    });
    it("includes letter spacing in wrapping and reports impossible boxes without truncation", () => {
        const input = layer({ content: "AAAA", width: 60, height: 10, fontSize: 20, minFontSize: 18, letterSpacing: 10 });
        const result = layoutText(input, measure);
        expect(result.fontSize).toBe(18);
        expect(result.lines).toEqual(["AAA", "A"]);
        expect(result.overflow).toBe(true);
        expect(result.lines.join("")).toBe(input.content);
    });
    it("honours manual sizing and never reports a hidden truncation as success", () => {
        const result = layoutText(layer({ content: "Long content ".repeat(100), width: 100, height: 60, fontSize: 36, autoFit: false }), measure);
        expect(result.fontSize).toBe(36);
        expect(result.overflow).toBe(true);
        expect(result.lines.join("").replace(/ /g, "")).toBe("Longcontent".repeat(100));
    });
    it("handles empty content and invalid boxes without throwing or an unbounded loop", () => {
        expect(layoutText(layer({ content: "", height: 0 }), measure).overflow).toBe(false);
        expect(layoutText(layer({ content: "X", width: 0 }), measure).overflow).toBe(true);
        expect(layoutText(layer({ content: "X", width: Number.NaN }), measure).overflow).toBe(true);
    });
});

describe("safe layout compatibility and geometry", () => {
    it("only upgrades a clone, preserving legacy source identity and content", () => {
        const source = composition(), original = structuredClone(source);
        const draft = prepareEditableComposition(source);
        expect(source).toEqual(original);
        expect(source.layoutVersion).toBeUndefined();
        expect(draft.layoutVersion).toBe(2);
        expect(draft.layers[0]).toMatchObject({ id: "image", sourceAssetId: "original-source", content: "data:original" });
        expect(layoutGeometryErrors(draft)).toEqual([]);
        expect(draft.layers[0].y + draft.layers[0].height).toBeLessThan(draft.layers[1].y);
        expect(prepareEditableComposition(draft)).toEqual(draft);
        expect(prepareEditableComposition(draft).layers[0]).not.toBe(draft.layers[0]);
    });
    it.each([[1024, 1024], [768, 1024], [1366, 768]])("adapts to %s×%s with safe text", (width, height) => {
        const draft = resizeComposition(prepareEditableComposition(composition()), width, height);
        expect(layoutGeometryErrors(draft)).toEqual([]);
        expect(draft.layers[0].sourceAssetId).toBe("original-source");
        expect(draft.width).toBe(width);
        expect(draft.height).toBe(height);
    });
    it.each(["faq", "installation-steps"] as const)("reserves a separate right text region for %s", (layout) => {
        const draft = prepareEditableComposition({ ...composition(), layout });
        expect(draft.layers[0].x + draft.layers[0].width).toBeLessThan(draft.layers[1].x);
        expect(layoutGeometryErrors(draft)).toEqual([]);
    });
    it("preserves independent comparison sources and puts labels above them", () => {
        const input = composition([
            layer({ id: "b", type: "background", name: "BEFORE 场景", content: "data:b", comparisonRole: "before", sourceAssetId: "source-b" }),
            layer({ id: "a", type: "background", name: "AFTER 场景", content: "data:a", comparisonRole: "after", sourceAssetId: "source-a" }),
            layer({ id: "lb", name: "comparison-label-before", content: "Before" }),
            layer({ id: "la", name: "comparison-label-after", content: "After" }), layer(),
        ]);
        const draft = prepareEditableComposition(input);
        expect(layoutGeometryErrors(draft)).toEqual([]);
        expect(draft.layers.slice(0, 2).map((l) => [l.content, l.sourceAssetId, l.comparisonRole])).toEqual([["data:b", "source-b", "before"], ["data:a", "source-a", "after"]]);
        expect(draft.layers[2].y + draft.layers[2].height).toBeLessThan(draft.layers[0].y);
    });
    it("blocks subject collisions, unsafe edges, invalid typography and rotation", () => {
        const draft = prepareEditableComposition(composition());
        const moved = moveLayoutLayer(draft, "text", 0, 0);
        expect(layoutGeometryErrors(moved).join(" ")).toMatch(/主体保护区/);
        expect(layoutGeometryErrors(moved).join(" ")).toMatch(/安全区/);
        moved.layers[1].rotation = 45;
        moved.layers[1].letterSpacing = -2;
        expect(layoutGeometryErrors(moved).join(" ")).toMatch(/旋转/);
        expect(layoutGeometryErrors(moved).join(" ")).toMatch(/字距/);
        expect(layoutGeometryErrors(composition())).toEqual([]);
    });
    it("does not allow a logo to cover the whole protected subject bitmap", () => {
        const draft = prepareEditableComposition(composition());
        draft.layers.push(layer({ id: "logo", type: "logo", name: "品牌", x: 100, y: 100, width: 100, height: 100 }));
        expect(layoutGeometryErrors(draft).join(" ")).toMatch(/品牌：覆盖/);
        draft.layers.at(-1)!.visible = false;
        expect(layoutGeometryErrors(draft)).toEqual([]);
    });
    it.each(["single-hero", "faq", "before-after"] as const)("moves legacy brand overlays to a reserved header for %s", (layout) => {
        const input = composition();
        input.layout = layout;
        input.layers.push(layer({ id: "logo", type: "logo", name: "品牌 Logo", x: 700, y: 40, width: 140, height: 76, content: "data:logo" }));
        input.layers.push(layer({ id: "wm", type: "watermark", name: "平铺水印", x: 300, y: 300, width: 230, height: 120, rotation: -18, content: "data:watermark" }));
        if (layout === "before-after") input.layers.push(layer({ id: "label", name: "comparison-label-before", content: "Before" }));
        const draft = prepareEditableComposition(input);
        expect(layoutGeometryErrors(draft)).toEqual([]);
        const logos = draft.layers.filter((l) => ["logo", "watermark"].includes(l.type));
        expect(logos.every((l) => l.rotation === 0 && l.y + l.height < draft.layers[0].y)).toBe(true);
        expect(logos.map((l) => l.content)).toEqual(["data:logo", "data:watermark"]);
        expect(logos[0].x + logos[0].width).toBeLessThan(logos[1].x);
        const compareLabel = draft.layers.find((l) => l.name.startsWith("comparison-label-"));
        if (compareLabel) expect(logos.every((l) => l.y + l.height < compareLabel.y)).toBe(true);
        expect(input.layers.find((l) => l.id === "wm")!.rotation).toBe(-18);
    });
    it("rejects excessive raster sizes and typography before raster allocation", () => {
        const draft = prepareEditableComposition(composition());
        for (const [width, height] of [[0, 1024], [63, 1024], [4097, 1024], [4096, 4096], [100.5, 1024]]) {
            expect(layoutGeometryErrors({ ...draft, width, height }).join(" ")).toMatch(/画板尺寸/);
            expect(() => resizeComposition(draft, width, height)).toThrow();
        }
        expect(layoutGeometryErrors({ ...draft, width: 4000, height: 4000 })).not.toContain("画板尺寸无效");
        for (const patch of [{ fontSize: 7 }, { fontSize: 301 }, { lineHeight: 3.1 }, { letterSpacing: 31 }, { minFontSize: 7 }, { minFontSize: 50 }]) {
            const invalid = structuredClone(draft);
            Object.assign(invalid.layers[1], patch);
            expect(layoutGeometryErrors(invalid).join(" ")).toMatch(/字号需为/);
        }
        expect(resizeComposition(draft, 64, 64).layers[1].fontSize).toBe(8);
    });
    it("clamps coordinates, respects locked layers, and rejects non-finite moves", () => {
        const draft = prepareEditableComposition(composition());
        const moved = moveLayoutLayer(draft, "text", 10000, -100);
        expect(moved.layers[1].x).toBe(draft.width - draft.layers[1].width);
        expect(moved.layers[1].y).toBe(0);
        expect(draft.layers[1].y).not.toBe(0);
        draft.layers[1].locked = true;
        expect(moveLayoutLayer(draft, "text", 0, 0)).toEqual(draft);
        expect(() => moveLayoutLayer(draft, "text", NaN, 0)).toThrow();
        expect(() => resizeComposition(draft, 0, 1000)).toThrow();
    });
});

describe("named custom layouts", () => {
    it("stores only geometry and applies it without copying another product or copy", () => {
        const original = prepareEditableComposition(composition());
        const preset = saveLayoutPreset(original, "  Portrait copy  ");
        expect(preset.name).toBe("Portrait copy");
        expect(preset.layers[0]).not.toHaveProperty("content");
        expect(preset.layers[0]).not.toHaveProperty("sourceAssetId");
        const other = composition();
        other.layers[0].content = "data:different-product";
        other.layers[0].sourceAssetId = "different-source";
        other.layers[1].content = "Different US color copy";
        const applied = applyLayoutPreset(other, preset);
        expect(applied.layers[0]).toMatchObject({ content: "data:different-product", sourceAssetId: "different-source" });
        expect(applied.layers[1].content).toBe("Different US color copy");
        expect(layoutGeometryErrors(applied)).toEqual([]);
    });
    it("ignores untrusted extra preset properties and rejects mismatched or ambiguous source structure", () => {
        const preset = saveLayoutPreset(prepareEditableComposition(composition()), "Safe");
        Object.assign(preset.layers[0], { content: "data:foreign", id: "foreign", sourceAssetId: "foreign", comparisonRole: "before" });
        expect(applyLayoutPreset(composition(), preset).layers[0]).toMatchObject({ id: "image", content: "data:original", sourceAssetId: "original-source" });
        const mismatch = structuredClone(preset);
        mismatch.layers[0].name = "AFTER 场景";
        expect(() => applyLayoutPreset(composition(), mismatch)).toThrow(/不匹配/);
        const duplicate = { ...preset, layers: [...preset.layers, preset.layers[1]] };
        expect(() => applyLayoutPreset(composition(), duplicate)).toThrow(/重复/);
    });
    it("does not save or apply unsafe geometry", () => {
        const draft = prepareEditableComposition(composition());
        expect(() => saveLayoutPreset(draft, " ")).toThrow(/名称/);
        const preset = saveLayoutPreset(draft, "Safe");
        preset.layers[1].y = 0;
        expect(() => applyLayoutPreset(composition(), preset)).toThrow(/主体保护区/);
        expect(() => applyLayoutPreset(composition(), { ...preset, width: NaN } as MarketingLayout)).toThrow(/尺寸/);
        expect(() => saveLayoutPreset(moveLayoutLayer(draft, "text", 100, 100), "Unsafe")).toThrow(/主体保护区/);
    });
});
