import { describe, expect, it } from "vitest";
import { expandDocument, imageLayer, matchesRevision, newDocument, revise, splitLayers, validUpscale } from "./document";

const image = { url: "image:test", width: 1000, height: 600 };
describe("advanced image document", () => {
    it("expands the board by shifting independent objects without stretching them", () => {
        const original = newDocument("source", image);
        original.layers[0].role = "product";
        original.layers.push({ ...imageLayer(image, "background"), role: "background" });
        const result = expandDocument(original, 100, 50, 200, 70, { ...image, width: 1300, height: 720 });
        expect([result.width, result.height]).toEqual([1300, 720]);
        expect(result.layers[1]).toMatchObject({ x: 100, y: 50, width: 1000, height: 600, visible: true });
        expect(result.layers[2].visible).toBe(false);
        expect(original.layers[0].x).toBe(0);
    });
    it("keeps the original backup and places split layers at the exact transformed position", () => {
        const original = newDocument("source", image);
        Object.assign(original.layers[0], { x: 53, y: -12, rotation: 37, opacity: 0.7 });
        const split = splitLayers(original, original.layers[0], [image, image]);
        expect(split.layers[0].visible).toBe(false);
        expect(split.layers[1]).toMatchObject({ x: 53, y: -12, rotation: 37, opacity: 0.7 });
        expect(split.layers[1].groupId).toBe(split.layers[2].groupId);
        expect(original.layers[0].visible).toBe(true);
    });
    it("invalidates late AI candidates even when undo restores the previous content", () => {
        const original = newDocument("source", image);
        const next = revise(original, { ...original, title: "changed" });
        const restored = revise(next, original);
        expect(matchesRevision(restored, { documentId: original.id, revision: original.revision })).toBe(false);
        expect(restored.revision).toBe(2);
    });
    it("enforces supported scale and longest output edge", () => {
        expect(validUpscale(1024, 600, 4)).toBe(true);
        expect(validUpscale(1200, 600, 4)).toBe(false);
        expect(validUpscale(200, 200, 3)).toBe(false);
    });
});
