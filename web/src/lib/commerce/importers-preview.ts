import { unzipSync } from "fflate";
import { nanoid } from "nanoid";
import { uploadImage } from "@/services/image-storage";
import type { ProductRecord, StoredImageRef } from "@/types/commerce";
import { extractProductWorkbookFromZip, hydrateProductUrls, parseProductWorkbook } from "./importers";

export type ImportPreviewRow = { product: ProductRecord; issues: string[]; mappingConfirmed: boolean };
export type ImportPreviewState = { rows: ImportPreviewRow[]; candidates: StoredImageRef[]; unassignedConfirmed: boolean };
const normalized = (value: string) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
const directory = (image: StoredImageRef) => image.name.replace(/\\/g, "/").replace(/^\.\//, "").split("/").slice(0, -1).join("/");
const leaf = (image: StoredImageRef) => normalized(image.name).split("/").pop() || "";

/** Keeps every image visible; only unambiguous numbered slots are assigned automatically. */
export function createImportPreview(products: ProductRecord[], candidates: StoredImageRef[]): ImportPreviewState {
    const rows = products.map((product): ImportPreviewRow => {
        const sku = normalized(product.sku);
        const matching = candidates.filter((image) => normalized(directory(image).split("/").pop() || "") === sku);
        const folders = new Set(matching.map(directory));
        const issues: string[] = [];
        const images = [...product.images];
        let sizeImage = product.sizeImage;
        if (products.filter((item) => normalized(item.sku) === sku).length > 1) issues.push("SKU 重复，图片未自动分配，请修改 SKU 后手动选择图片");
        else if (folders.size > 1) issues.push("多个文件夹匹配同一 SKU，请手动选择图片");
        else {
            for (let slot = 1; slot <= 6; slot += 1) {
                const matches = matching.filter((image) => new RegExp(`^0?${slot}\\.`).test(leaf(image)));
                if (matches.length > 1) issues.push(`图片位置 ${slot} 重复，请手动选择`);
                else if (matches.length === 1 && images.length < 6) images.push(matches[0]);
            }
            const sizes = matching.filter((image) => /^size\./.test(leaf(image)));
            if (sizes.length > 1) issues.push("尺码图重复，请手动选择尺码图或确认忽略");
            else if (sizes.length === 1) sizeImage = sizes[0];
        }
        return { product: { ...product, images, sizeImage, imageStatus: images.length ? "ready" : "missing" }, issues, mappingConfirmed: false };
    });
    return { rows, candidates, unassignedConfirmed: false };
}

export function unassignedImportImages(value: ImportPreviewState) {
    const assigned = new Set(value.rows.flatMap(({ product }) => [...product.images.map((image) => image.id), ...(product.sizeImage ? [product.sizeImage.id] : [])]));
    return value.candidates.filter((image) => !assigned.has(image.id));
}

export function validateImportPreview(value: ImportPreviewState) {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!value.rows.length || value.rows.length > 20) errors.push("单批须有 1–20 个 SKU");
    const seen = new Set<string>();
    for (const { product, mappingConfirmed } of value.rows) {
        const sku = normalized(product.sku);
        if (!sku) errors.push("SKU 不能为空");
        if (seen.has(sku)) errors.push(`SKU 重复：${product.sku}`);
        seen.add(sku);
        if (!mappingConfirmed) errors.push(`${product.sku || "未命名 SKU"}：请核对并确认图片映射`);
        if (product.images.length > 6) errors.push(`${product.sku}：最多选择 6 张商品图片`);
        if (new Set(product.images.map((image) => image.id)).size !== product.images.length) errors.push(`${product.sku}：不能重复选择同一张图片`);
        if (!product.images.length) warnings.push(`${product.sku}：缺少商品图片，可创建但补图前不能生成`);
    }
    if (unassignedImportImages(value).length && !value.unassignedConfirmed) errors.push("请分配剩余候选图片，或确认保留为未使用图片");
    return { errors, warnings };
}

export function buildImportProducts(value: ImportPreviewState): ProductRecord[] {
    const { errors } = validateImportPreview(value);
    if (errors.length) throw new Error(errors.join("；"));
    return value.rows.map(({ product }) => ({ ...product, sku: product.sku.trim(), images: [...product.images], imageUrls: [], imageStatus: product.images.length ? "ready" : "missing" }));
}

export async function loadImportPreview({ workbook, zip }: { workbook?: File; zip?: File }): Promise<ImportPreviewState> {
    const source = workbook || (zip ? await extractProductWorkbookFromZip(zip) : undefined);
    if (!source) throw new Error("请选择商品 Excel，或包含商品 Excel 的 ZIP");
    const products = await hydrateProductUrls(await parseProductWorkbook(source, { allowDuplicateSku: true }));
    const candidates: StoredImageRef[] = products.flatMap((product) => [...product.images, ...(product.sizeImage ? [product.sizeImage] : [])]);
    if (zip) {
        const entries = unzipSync(new Uint8Array(await zip.arrayBuffer()), { filter: ({ name }) => /\.(png|jpe?g|webp)$/i.test(name) });
        for (const [name, bytes] of Object.entries(entries)) {
            const mime = /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg";
            const stored = await uploadImage(new Blob([bytes], { type: mime }));
            candidates.push({ id: nanoid(), name: name.replace(/\\/g, "/"), url: stored.url, storageKey: stored.storageKey, source: "zip" });
        }
    }
    return createImportPreview(products, candidates);
}
