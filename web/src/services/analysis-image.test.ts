import { afterEach, describe, expect, it, vi } from "vitest";
import { compressAnalysisImage } from "./analysis-image";
afterEach(() => vi.unstubAllGlobals());
describe("shared recognition image compression", () => {
    it("keeps already small images unchanged", async () => {
        const image = "data:image/png;base64,AA";
        expect(await compressAnalysisImage(image, new AbortController().signal)).toBe(image);
    });
    it("reduces large images to a 1600px edge before JPEG encoding", async () => {
        const drawImage = vi.fn(); const toDataURL = vi.fn(() => "data:image/jpeg;base64,small");
        const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL };
        vi.stubGlobal("Image", class { src = ""; naturalWidth = 3200; naturalHeight = 2400; decode = async () => {}; });
        vi.stubGlobal("document", { createElement: () => canvas });
        expect(await compressAnalysisImage("data:image/png;base64," + "A".repeat(2_100_000), new AbortController().signal)).toBe("data:image/jpeg;base64,small");
        expect(canvas.width).toBe(1600); expect(canvas.height).toBe(1200);
        expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.82);
    });
});
