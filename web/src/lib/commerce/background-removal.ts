import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { ensureSettingsReady } from "@/services/settings-readiness";
import { getServerConfigEnabled } from "@/constant/runtime-config";
import type { ModelRoleConfig, StoredImageRef } from "@/types/commerce";

let localRemover: Promise<any> | null = null;

export async function removeProductBackground(source: StoredImageRef) {
    return uploadImage(await compositeOnWhite(await extractProductBackground(source)));
}

// Keep the original transparent pixels for non-destructive workbench editing.
export async function extractProductBackground(source: StoredImageRef): Promise<Blob> {
    const dataUrl = await imageToDataUrl({ url: source.url, storageKey: source.storageKey });
    try {
        if (!localRemover) {
            localRemover = import("@huggingface/transformers")
                .then(({ pipeline }) => pipeline("background-removal", "studioludens/birefnet-lite-512", { device: "webgpu" as any }))
                .catch(async () => {
                    const { pipeline } = await import("@huggingface/transformers");
                    return pipeline("background-removal", "studioludens/birefnet-lite-512", { device: "wasm" as any });
                });
        }
        const remover = await localRemover;
        const output = await remover(dataUrl);
        const raw = Array.isArray(output) ? output[0] : output;
        const cutout = raw?.toBlob ? await raw.toBlob() : raw?.blob instanceof Blob ? raw.blob : null;
        if (!cutout) throw new Error("本地抠图模型未返回图片");
        return cutout;
    } catch (error) {
        localRemover = null;
        throw new Error("本地抠图失败，可使用配置的抠图 API 或在画布中蒙版修复。" + (error instanceof Error ? " " + error.message : ""));
    }
}

// AI white-background results do not need the heavyweight local segmentation model.
// Turn near-white pixels transparent in the browser so the editor can open without ORT.
export async function extractProductFromWhiteBackground(source: StoredImageRef): Promise<Blob> {
    const dataUrl = await imageToDataUrl({ url: source.url, storageKey: source.storageKey });
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建商品图层画布");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    let visible = 0;
    for (let i = 0; i < pixels.data.length; i += 4) {
        const r = pixels.data[i],
            g = pixels.data[i + 1],
            b = pixels.data[i + 2];
        const nearWhite = r >= 244 && g >= 244 && b >= 244;
        if (nearWhite) pixels.data[i + 3] = 0;
        else visible++;
    }
    if (!visible) throw new Error("白底图中未识别到商品");
    context.putImageData(pixels, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("商品图层编码失败"))), "image/png"));
}

export async function removeProductBackgroundWithApi(source: StoredImageRef, roles: ModelRoleConfig) {
    return uploadImage(await compositeOnWhite(await extractProductBackgroundWithApi(source, roles)));
}

export async function extractProductBackgroundWithApi(source: StoredImageRef, roles: ModelRoleConfig): Promise<Blob> {
    const assertCurrent = ensureSettingsReady();
    let assertRoles = () => {};
    if (getServerConfigEnabled()) {
        const { useCommerceStore } = await import("@/stores/use-commerce-store");
        assertRoles = () => {
            assertCurrent();
            const active = useCommerceStore.getState().modelRoles;
            if (active.removalApiUrl !== roles.removalApiUrl || active.removalApiKey !== roles.removalApiKey) throw new Error("抠图配置已变化，请重新开始操作");
        };
        assertRoles();
    }
    if (!roles.removalApiUrl.trim()) throw new Error("尚未配置抠图 API");
    const dataUrl = await imageToDataUrl({ url: source.url, storageKey: source.storageKey });
    const sourceBlob = await fetch(dataUrl).then((response) => response.blob());
    const form = new FormData();
    form.set("image", sourceBlob, source.name || "product.png");
    assertCurrent();
    assertRoles();
    const response = await fetch(roles.removalApiUrl, { method: "POST", headers: roles.removalApiKey ? { Authorization: "Bearer " + roles.removalApiKey } : undefined, body: form });
    assertCurrent();
    if (!response.ok) throw new Error("抠图 API 请求失败：HTTP " + response.status);
    const contentType = response.headers.get("content-type") || "";
    let blob: Blob;
    if (contentType.includes("application/json")) {
        const payload = (await response.json()) as { url?: string; dataUrl?: string; image?: string };
        const value = payload.dataUrl || payload.url || payload.image;
        if (!value) throw new Error("抠图 API 未返回图片字段");
        blob = await fetch(value).then((item) => item.blob());
    } else blob = await response.blob();
    assertCurrent();
    return blob;
}

async function compositeOnWhite(blob: Blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(1024, 1024);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建白底画布");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 1024, 1024);
    const scale = Math.min(900 / bitmap.width, 900 / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (1024 - width) / 2, (1024 - height) / 2, width, height);
    try {
        return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.94 });
    } finally {
        bitmap.close();
    }
}
