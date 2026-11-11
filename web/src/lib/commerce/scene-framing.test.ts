import { describe, expect, it, vi } from "vitest";
import { ensureSquareScene, isSquareImage } from "./scene-framing";

const image = { url: "source", width: 1200, height: 900, bytes: 1, mimeType: "image/jpeg" };
describe("scene aspect repair", () => {
    it.each(["main-white", "detail-white"] as const)("keeps product whitespace for %s without a model call", async (stage) => {
        const repair = vi.fn();
        expect(await ensureSquareScene(image, stage, repair)).toBe(image);
        expect(repair).not.toHaveBeenCalled();
    });
    it("does not request repair for a square scene", async () => {
        const repair = vi.fn();
        const square = { ...image, height: 1200 };
        expect(await ensureSquareScene(square, "scene", repair)).toBe(square);
        expect(repair).not.toHaveBeenCalled();
    });
    it.each(["scene", "detail", "usage-size", "marketing-base", "comparison-source"] as const)("repairs a non-square %s once", async (stage) => {
        const square = { ...image, height: 1200 };
        const repair = vi.fn().mockResolvedValue(square);
        expect(await ensureSquareScene(image, stage, repair)).toBe(square);
        expect(repair).toHaveBeenCalledExactlyOnceWith(image);
    });
    it("fails closed instead of padding, cropping or looping", async () => {
        const repair = vi.fn().mockResolvedValue(image);
        await expect(ensureSquareScene(image, "scene", repair)).rejects.toThrow("仍未返回");
        expect(repair).toHaveBeenCalledTimes(1);
    });
    it("ignores stale repair results", async () => {
        let changed = false;
        await expect(ensureSquareScene(image, "scene", async () => { changed = true; return { ...image, height: 1200 }; }, () => { if (changed) throw new Error("stale"); })).rejects.toThrow("stale");
    });
    it.each([[0, 0], [NaN, NaN], [1200, 900], [900, 1200]])("rejects invalid or non-square dimensions %s x %s", (w, h) => {
        expect(isSquareImage(w, h)).toBe(false);
    });
});
