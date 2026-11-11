import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRoleConfig, StoredImageRef } from "@/types/commerce";
const mocks = vi.hoisted(() => ({ upload: vi.fn(), data: vi.fn(), remover: vi.fn(), pipeline: vi.fn(), bitmap: vi.fn(), draw: vi.fn(), fill: vi.fn(), convert: vi.fn(), close: vi.fn() }));
vi.mock("@/services/image-storage", () => ({ uploadImage: mocks.upload, imageToDataUrl: mocks.data }));
vi.mock("@huggingface/transformers", () => ({ pipeline: mocks.pipeline }));
import { extractProductBackground, extractProductBackgroundWithApi, removeProductBackground, removeProductBackgroundWithApi } from "./background-removal";

const source: StoredImageRef = { id: "source", name: "product.png", url: "source", source: "upload" };
const transparent = new Blob(["transparent"], { type: "image/png" });
const white = new Blob(["white"], { type: "image/jpeg" });
const roles = { removalApiUrl: "/remove", removalApiKey: "" } as ModelRoleConfig;
beforeEach(() => {
    vi.clearAllMocks();
    mocks.data.mockResolvedValue("data:image/png;base64,AAAA");
    mocks.pipeline.mockResolvedValue(mocks.remover);
    mocks.remover.mockResolvedValue([{ toBlob: async () => transparent }]);
    mocks.upload.mockResolvedValue({ url: "white-result" });
    mocks.bitmap.mockResolvedValue({ width: 800, height: 400, close: mocks.close });
    mocks.convert.mockResolvedValue(white);
    vi.stubGlobal("createImageBitmap", mocks.bitmap);
    vi.stubGlobal(
        "OffscreenCanvas",
        class {
            getContext() {
                return { fillStyle: "", fillRect: mocks.fill, drawImage: mocks.draw };
            }
            convertToBlob = mocks.convert;
        },
    );
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValueOnce(new Response(transparent))
            .mockResolvedValueOnce(new Response(transparent, { headers: { "content-type": "image/png" } })),
    );
});
afterEach(() => vi.unstubAllGlobals());
describe("transparent extraction and legacy white output", () => {
    it("returns local transparent pixels without flattening or storing them", async () => {
        expect(await extractProductBackground(source)).toBe(transparent);
        expect(mocks.upload).not.toHaveBeenCalled();
        expect(mocks.bitmap).not.toHaveBeenCalled();
    });
    it("keeps the existing local API composited on white at 1024", async () => {
        expect(await removeProductBackground(source)).toEqual({ url: "white-result" });
        expect(mocks.fill).toHaveBeenCalledWith(0, 0, 1024, 1024);
        expect(mocks.draw).toHaveBeenCalledWith(expect.anything(), 62, 287, 900, 450);
        expect(mocks.upload).toHaveBeenCalledWith(white);
        expect(mocks.close).toHaveBeenCalled();
    });
    it("returns API transparent bytes for the editor", async () => {
        expect(await (await extractProductBackgroundWithApi(source, roles)).text()).toBe("transparent");
        expect(mocks.upload).not.toHaveBeenCalled();
        expect(mocks.draw).not.toHaveBeenCalled();
    });
    it("keeps API-based downstream generation flattened", async () => {
        await removeProductBackgroundWithApi(source, roles);
        expect(mocks.upload).toHaveBeenCalledWith(white);
        expect(mocks.fill).toHaveBeenCalled();
    });
    it("reports API failure without producing a replacement image", async () => {
        vi.mocked(fetch)
            .mockReset()
            .mockResolvedValueOnce(new Response(transparent))
            .mockResolvedValueOnce(new Response("failed", { status: 503 }));
        await expect(removeProductBackgroundWithApi(source, roles)).rejects.toThrow("HTTP 503");
        expect(mocks.upload).not.toHaveBeenCalled();
    });
});
