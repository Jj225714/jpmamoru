import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllGlobals());
vi.mock("@/services/image-storage", () => ({}));
vi.mock("./template-renderer", () => ({}));
import { drawWhiteImage, type PreparedWhiteLayer } from "./white-image-renderer";
import { DEFAULT_WHITE_ADJUSTMENTS as defaults, updateWhiteAdjustments, type WhiteEditorData } from "./white-image-edit";

describe("perspective preview and export rendering", () => {
    it.each([1024, 1600])("renders scaled perspective at output size %s", (size) => {
        const context = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn() };
        const canvas = { width: size, height: size, getContext: () => context } as unknown as HTMLCanvasElement;
        const editor = { base: { width: 0.8, height: 0.4, bounds: { x: 0, y: 0, width: 1, height: 1 } } } as WhiteEditorData;
        const projectedContext = { putImageData: vi.fn() };
        const projected = { getContext: () => projectedContext };
        vi.stubGlobal("document", { createElement: () => projected });
        vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        const prepared = { source: {}, pixels: { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) } } as PreparedWhiteLayer;
        const enabled = updateWhiteAdjustments(editor.base, defaults, { perspectiveEnabled: true });
        const scaled = updateWhiteAdjustments(editor.base, enabled, { scale: 150 });
        drawWhiteImage(canvas, prepared, editor, scaled, size);
        expect(context.setTransform.mock.calls.at(-1)).toEqual([1,0,0,1,0,0]);
        expect(context.drawImage).toHaveBeenCalledWith(projected, 0, 0);
        const pixels = projectedContext.putImageData.mock.calls[0][0].data;
        expect(pixels[(Math.floor(size*0.5)*size+Math.floor(size*0.5))*4+3]).toBe(255);
        expect(pixels[(Math.floor(size*0.1)*size+Math.floor(size*0.5))*4+3]).toBe(0);
    });
});
