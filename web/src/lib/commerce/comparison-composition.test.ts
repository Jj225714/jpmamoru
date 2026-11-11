import { describe, expect, it } from "vitest";
import { comparisonCompositionErrors } from "./comparison-composition";
import type { CompositionLayer, GeneratedAsset, LayeredComposition } from "@/types/commerce";

function fixture() {
    const sources: GeneratedAsset[] = (["before", "after"] as const).map((role) => ({
        id: role, jobId: "job", skuId: "sku", stage: "comparison-source", comparisonRole: role,
        sequence: 1, revision: 1, title: role, url: role + ".jpg", width: 1000, height: 1000,
        bytes: 100, mimeType: "image/jpeg", createdAt: "now",
    }));
    const layers = sources.map((source, index) => ({
        id: source.id + "-layer", type: "background" as const, name: source.title,
        sourceAssetId: source.id, comparisonRole: source.comparisonRole,
        content: source.url, x: index * 500, y: 100, width: 500, height: 500,
        zIndex: 10 + index, visible: true, opacity: 1, rotation: 0, locked: false,
    }));
    const composition: LayeredComposition = {
        id: "composition", jobId: "job", skuId: "sku", requirementId: "pair", revision: 1,
        width: 1000, height: 1000, backgroundColor: "#fff", layout: "before-after", layers,
        createdAt: "now", updatedAt: "now",
    };
    return { composition, sources, layers };
}

describe("comparison composition integrity", () => {
    it("accepts a valid pair without mutating inputs, regardless of source/layer order", () => {
        const { composition, sources } = fixture();
        const snapshot = structuredClone({ composition, sources });
        expect(comparisonCompositionErrors(composition, sources)).toEqual([]);
        expect({ composition, sources }).toEqual(snapshot);
        expect(comparisonCompositionErrors({ ...composition, layers: [...composition.layers].reverse() }, [...sources].reverse())).toEqual([]);
    });

    it.each([
        ["hidden", { visible: false }], ["transparent", { opacity: 0 }], ["faded", { opacity: 0.949 }],
        ["invalid opacity", { opacity: NaN }], ["off left", { x: -1.01 }], ["off top", { y: -1.01 }],
        ["off right", { x: 501.01 }], ["off bottom", { y: 501.01 }],
        ["overlap", { x: 2 }], ["rotated", { rotation: 1 }],
        ["tiny width", { width: 199.99 }], ["tiny height", { height: 199.99 }],
        ["zero width", { width: 0 }], ["negative height", { height: -1 }],
        ["invalid position", { x: Infinity }], ["invalid size", { height: NaN }],
    ] satisfies Array<[string, Partial<CompositionLayer>]>)("rejects %s source layers", (_name, patch) => {
        const { composition, sources, layers } = fixture();
        Object.assign(layers[0], patch);
        expect(comparisonCompositionErrors(composition, sources).length).toBeGreaterThan(0);
    });

    it("accepts the next canvas revision before source IDs and revisions are remapped", () => {
        const { composition, sources } = fixture();
        composition.revision = 2;
        expect(comparisonCompositionErrors(composition, sources)).toEqual([]);
    });

    it("accepts exact opacity/size boundaries and one-pixel containment/overlap tolerance", () => {
        const { composition, sources, layers } = fixture();
        Object.assign(layers[0], { x: -1, y: -1, opacity: 0.95 });
        layers[1].x = 498; // One pixel overlaps the first panel.
        expect(comparisonCompositionErrors(composition, sources)).toEqual([]);
        Object.assign(layers[1], { x: 801, y: 801, width: 200, height: 200 });
        expect(comparisonCompositionErrors(composition, sources)).toEqual([]);
    });

    it.each(["wrong ID", "wrong role", "missing ID", "missing role"])("rejects %s binding", (change) => {
        const { composition, sources, layers } = fixture();
        if (change === "wrong ID") layers[0].sourceAssetId = sources[1].id;
        if (change === "wrong role") layers[0].comparisonRole = "after";
        if (change === "missing ID") delete (layers[0] as Partial<typeof layers[0]>).sourceAssetId;
        if (change === "missing role") layers[0].comparisonRole = undefined;
        expect(comparisonCompositionErrors(composition, sources).join()).toContain("绑定");
    });

    it("rejects missing composition, missing/extra panels and invalid source sets", () => {
        const { composition, sources, layers } = fixture();
        expect(comparisonCompositionErrors(undefined, sources).length).toBeGreaterThan(0);
        expect(comparisonCompositionErrors({ ...composition, layers: layers.slice(0, 1) }, sources).join()).toContain("两个");
        expect(comparisonCompositionErrors({ ...composition, layers: [...layers, { ...layers[0], id: "extra", type: "decoration" }] }, sources).join()).toContain("两个");
        for (const invalid of [[], [sources[0]], [sources[0], sources[0]], [sources[0], { ...sources[1], comparisonRole: undefined }]]) {
            expect(comparisonCompositionErrors(composition, invalid).length).toBeGreaterThan(0);
        }
    });

    it.each([0, -1, NaN, Infinity])("rejects invalid canvas dimension %s", (width) => {
        const { composition, sources } = fixture();
        expect(comparisonCompositionErrors({ ...composition, width }, sources).join()).toContain("画板尺寸");
    });

    it("allows independent edits to labels, text, logo, watermark and canvas background shape", () => {
        const { composition, sources, layers } = fixture();
        for (const type of ["text", "logo", "watermark", "shape"] as const) {
            composition.layers.push({ ...layers[0], id: type, type, name: type, visible: false, opacity: 0, rotation: 20, x: -100, width: 1 });
        }
        expect(comparisonCompositionErrors(composition, sources)).toEqual([]);
    });
});
