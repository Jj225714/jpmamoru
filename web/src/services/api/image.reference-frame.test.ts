import axios from "axios";
import { beforeEach, expect, it, vi } from "vitest";
import { defaultConfig } from "@/stores/use-config-store";
import { imageToDataUrl } from "@/services/image-storage";
import { frameReferenceToSize } from "@/lib/reference-frame";

vi.mock("@/i18n", () => ({ default: { t: (key: string, options?: { prompt?: string }) => options?.prompt ? options.prompt : key } }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn() }));
vi.mock("@/lib/reference-frame", () => ({ frameReferenceToSize: vi.fn() }));
import { requestEdit, requestGeneration } from "./image";
import { computeMediaSize } from "@/lib/media-size";

const reference = { id: "r1", name: "photo.png", type: "image/png", dataUrl: "blob:photo" };
const original = "data:image/jpeg;base64,/9j/AA==";
const framed = "data:image/jpeg;base64,/9j/AQ==";
const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", size: "1:1", quality: "low" };

beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(imageToDataUrl).mockImplementation(async (image) => image.dataUrl?.startsWith("data:") ? image.dataUrl : original);
    vi.mocked(frameReferenceToSize).mockResolvedValue(framed);
});

it("frames a workbench reference and prioritizes the selected output size", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: [{ b64_json: "AA==" }] } });
    await requestEdit(config, "draw a scene", [reference], { fitReferencesToSize: true });
    const body = post.mock.calls[0][1] as FormData;
    expect(body.get("size")).toBe("1024x1024");
    expect(String(body.get("prompt"))).toContain("1024x1024");
    expect(String(body.get("prompt"))).toContain("draw a scene");
    expect(frameReferenceToSize).toHaveBeenCalledWith(original, "1024x1024");
    expect((body.get("image") as File).name).toBe("reference-1.jpg");
    expect((body.get("image") as File).type).toBe("image/jpeg");
    expect((body.get("image") as File).size).toBe(4);
});

it("leaves other edits and auto-size edits untouched", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({ data: { data: [{ b64_json: "AA==" }] } });
    await requestEdit(config, "edit", [reference]);
    await requestEdit({ ...config, size: "auto" }, "edit", [reference], { fitReferencesToSize: true });
    expect(frameReferenceToSize).not.toHaveBeenCalled();
});

it("uses ASCII upload filenames for Chinese-named canvas and commerce references", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: [{ b64_json: "AA==" }] } });
    const references = [
        { ...reference, id: "white", name: "已审核白底商品.png" },
        { ...reference, id: "scene", name: "场景参考图.png" },
    ];
    await requestEdit(config, "scene", references);
    const form = post.mock.calls[0][1] as FormData;
    const files = form.getAll("image[]") as File[];
    expect(files.map((file) => file.name)).toEqual(["reference-1.jpg", "reference-2.jpg"]);
    expect(files.map((file) => file.type)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(references.map((image) => image.name)).toEqual(["已审核白底商品.png", "场景参考图.png"]);
});

it("falls back to generation when a reference has not produced image data", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: [{ b64_json: "AA==" }] } });
    vi.mocked(imageToDataUrl).mockResolvedValue("");

    await requestEdit(config, "draw a scene", [reference]);

    expect(post).toHaveBeenCalledWith(
        expect.stringContaining("/images/generations"),
        expect.objectContaining({ prompt: "draw a scene" }),
        expect.anything(),
    );
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/images/edits"), expect.anything(), expect.anything());
});

it("uses the same custom rounded pixels in generation, edit, and resolution preview", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: [{ b64_json: "AA==" }] } });
    const custom = { ...config, size: "1.9:1", quality: "low" };
    await requestGeneration(custom, "draw");
    expect(post.mock.calls[0][1]).toMatchObject({ size: computeMediaSize("1k", "1.9:1") });
    await requestEdit(custom, "edit", [reference]);
    expect((post.mock.calls[1][1] as FormData).get("size")).toBe(computeMediaSize("1k", "1.9:1"));
});
it("rejects a fixed-size model custom ratio before HTTP submission", async () => {
    const post = vi.spyOn(axios, "post");
    await expect(requestGeneration({ ...config, model: "gpt-image-1", imageModel: "gpt-image-1", size: "2.5:1" }, "draw")).rejects.toThrow("固定尺寸");
    expect(post).not.toHaveBeenCalled();
});
