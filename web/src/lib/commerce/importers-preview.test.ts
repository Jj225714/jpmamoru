import ExcelJS from "exceljs";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn(async () => ({ url: "blob:test", storageKey: "image:persistent" })) }));
import { parseProductWorkbook } from "./importers";
import { buildImportProducts, createImportPreview, loadImportPreview, validateImportPreview } from "./importers-preview";
import type { StoredImageRef } from "@/types/commerce";
async function workbook(skus = ["A", "B", "C"]) {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("商品导入");
    sheet.addRow(["SKU 编号", "商品类型(必填)", "产品名称(必填)"]);
    skus.forEach((sku) => sheet.addRow([sku, "mat", sku]));
    const bytes = await book.xlsx.writeBuffer();
    return { name: "test.xlsx", arrayBuffer: async () => bytes } as File;
}
const images = (...names: string[]): StoredImageRef[] => names.map((name) => ({ id: name, name, url: "blob:test", storageKey: name, source: "zip" }));
describe("import preview", () => {
    it("orders multiple images for three SKUs and accepts confirmed missing images", async () => {
        const preview = createImportPreview(await parseProductWorkbook(await workbook()), images("A/02.png", "A/1.jpg", "B/1.png"));
        expect(preview.rows.map((row) => row.product.images.length)).toEqual([2, 1, 0]);
        expect(preview.rows[0].product.images.map((image) => image.name)).toEqual(["A/1.jpg", "A/02.png"]);
        expect(() => buildImportProducts(preview)).toThrow("确认");
        preview.rows.forEach((row) => {
            row.mappingConfirmed = true;
        });
        expect(buildImportProducts(preview)[2].imageStatus).toBe("missing");
    });
    it("retains strict parsing and blocks duplicate SKUs until corrected", async () => {
        const file = await workbook(["A", "A", "C"]);
        await expect(parseProductWorkbook(file)).rejects.toThrow("SKU 重复");
        const preview = createImportPreview(await parseProductWorkbook(file, { allowDuplicateSku: true }), images("A/1.png"));
        expect(preview.rows[0].product.images).toEqual([]);
        preview.rows.forEach((row) => {
            row.mappingConfirmed = true;
        });
        preview.unassignedConfirmed = true;
        expect(validateImportPreview(preview).errors.join()).toContain("SKU 重复");
        preview.rows[1].product.sku = "B";
        preview.rows[0].product.images = [preview.candidates[0]];
        expect(buildImportProducts(preview).map((product) => product.sku)).toEqual(["A", "B", "C"]);
    });
    it("keeps ambiguous folders, duplicate slots and root files available for correction", async () => {
        const candidates = images("one/A/1.png", "two/A/1.png", "B/1.png", "B/01.jpg", "root.jpg", "C/custom.png");
        const preview = createImportPreview(await parseProductWorkbook(await workbook()), candidates);
        expect(preview.rows.every((row) => row.product.images.length === 0)).toBe(true);
        expect(preview.rows[0].issues.join()).toContain("多个文件夹");
        expect(preview.rows[1].issues.join()).toContain("位置 1 重复");
        preview.rows[0].product.images = [candidates[1], candidates[0]];
        preview.rows[0].product.images = preview.rows[0].product.images.slice(1);
        preview.rows.forEach((row) => {
            row.mappingConfirmed = true;
        });
        expect(() => buildImportProducts(preview)).toThrow("剩余候选");
        preview.unassignedConfirmed = true;
        expect(buildImportProducts(preview)[0].images).toEqual([candidates[0]]);
    });
    it("persists every ZIP candidate with its full path", async () => {
        const bytes = zipSync({ "folder/A/1.png": new Uint8Array([1]), "other.png": new Uint8Array([2]) });
        const preview = await loadImportPreview({ workbook: await workbook(), zip: { arrayBuffer: async () => bytes.buffer } as File });
        expect(preview.candidates.map((image) => image.name)).toEqual(["folder/A/1.png", "other.png"]);
        expect(preview.candidates.every((image) => image.storageKey === "image:persistent")).toBe(true);
    });
    it("rejects more than six images and duplicate selections", async () => {
        const preview = createImportPreview(await parseProductWorkbook(await workbook()), []);
        preview.rows.forEach((row) => {
            row.mappingConfirmed = true;
        });
        preview.rows[0].product.images = Array.from({ length: 7 }, () => images("x.png")[0]);
        expect(validateImportPreview(preview).errors).toHaveLength(2);
    });
});
