import { afterEach, expect, it, vi } from "vitest";
import { fitExportImage } from "./export-image";

afterEach(() => vi.unstubAllGlobals());
it.each(["image/png", "image/jpeg", "image/webp"])("preserves %s at or below the exact limit", async (type) => {
    for (const size of [9, 10]) {
        const blob = new Blob([new Uint8Array(size)], { type });
        expect(await fitExportImage(blob, 10)).toBe(blob);
    }
});
function encoder(sizes: number[]) {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1600, height: 1200, close })));
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob: vi.fn((cb: (blob: Blob) => void, type: string) => cb(new Blob([new Uint8Array(sizes.shift() ?? 11)], { type }))) };
    vi.stubGlobal("document", { createElement: () => canvas });
    return { canvas, context, close };
}
it.each(["jpeg", "webp"] as const)("compresses to %s without shrinking dimensions", async (format) => {
    const { canvas, context, close } = encoder([15, 10]);
    const blob = await fitExportImage(new Blob([new Uint8Array(20)], { type: "image/png" }), 10, format);
    expect(blob.size).toBe(10);
    expect(blob.type).toBe("image/" + format);
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(canvas.toBlob).toHaveBeenCalledTimes(2);
    expect(context.fillRect).toHaveBeenCalledTimes(format === "jpeg" ? 1 : 0);
    expect(close).toHaveBeenCalledOnce();
});
it("rejects incompressible images and releases decoded memory", async () => {
    const { close } = encoder([]);
    await expect(fitExportImage(new Blob([new Uint8Array(20)]), 10)).rejects.toThrow("未生成交付包");
    expect(close).toHaveBeenCalledOnce();
});
it.each([
    ["high", [0.92, 0.85, 0.75, 0.65, 0.5, 0.35, 0.2]],
    ["balanced", [0.75, 0.65, 0.5, 0.35, 0.2]],
    ["small", [0.5, 0.35, 0.2]],
] as const)("starts at the %s preference and falls back to the minimum", async (quality, steps) => {
    const { canvas } = encoder([...steps.map(() => 11).slice(1), 10]);
    const source = new Blob([new Uint8Array(20)], { type: "image/png" });
    expect((await fitExportImage(source, 10, "webp", quality)).size).toBe(10);
    expect(canvas.toBlob.mock.calls.map((call) => (call as unknown[])[2])).toEqual(steps);
    expect(source.size).toBe(20);
});
it("rejects invalid limits and empty inputs", async () => {
    for (const limit of [0, -1, NaN, 1.5]) await expect(fitExportImage(new Blob(["x"]), limit)).rejects.toThrow("上限");
    await expect(fitExportImage(new Blob(), 10)).rejects.toThrow("为空");
});
