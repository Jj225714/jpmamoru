import ExcelJS from "exceljs";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn() }));
import { uploadImage } from "@/services/image-storage";
import { attachProductZip, extractProductWorkbookFromZip, parseProductWorkbook } from "./importers";

// Regression: ISSUE-001 — a product ZIP containing the required Excel was rejected as "请选择商品 Excel".
// Found by /qa on 2026-09-21.
// Report: .gstack/qa-reports/qa-report-103-79-187-126-2026-09-21.md
async function workbookBytes() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("商品导入");
    sheet.addRow(["SKU 编号", "商品类型(必填)", "产品名称(必填)"]);
    sheet.addRow(["SKU-1", "桌垫", "测试桌垫"]);
    return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function packageFile(entries: Record<string, Uint8Array>) {
    return new File([zipSync(entries)], "商品资料.zip", { type: "application/zip" });
}

describe("product workbook inside image ZIP", () => {
    it("uses its embedded product workbook without a separately selected Excel", async () => {
        const zip = packageFile({ "商品资料/商品导入.xlsx": await workbookBytes(), "商品资料/SKU-1/01.jpg": new Uint8Array([255, 216, 255, 217]) });
        const excel = await extractProductWorkbookFromZip(zip);
        expect(excel?.name).toBe("商品导入.xlsx");
        expect((await parseProductWorkbook(excel!))[0]).toMatchObject({ sku: "SKU-1", name: "测试桌垫" });
    });

    it("returns no workbook for an images-only ZIP so the UI can request a separate Excel", async () => {
        expect(await extractProductWorkbookFromZip(packageFile({ "SKU-1/01.jpg": new Uint8Array([255, 216, 255, 217]) }))).toBeUndefined();
    });

    it("rejects ambiguous packages with more than one workbook", async () => {
        const bytes = await workbookBytes();
        await expect(extractProductWorkbookFromZip(packageFile({ "a.xlsx": bytes, "b.xlsx": bytes }))).rejects.toThrow("多个 Excel");
    });

    it("ignores Office lock files when looking for the product workbook", async () => {
        const bytes = await workbookBytes();
        const excel = await extractProductWorkbookFromZip(packageFile({ "商品导入.xlsx": bytes, "~$商品导入.xlsx": bytes }));
        expect(excel?.name).toBe("商品导入.xlsx");
    });

    it("matches SKU images beneath a wrapping ZIP folder", async () => {
        vi.mocked(uploadImage).mockResolvedValue({ url: "blob:qa", storageKey: "qa-key" } as never);
        const zip = packageFile({ "商品资料/商品导入.xlsx": await workbookBytes(), "商品资料/SKU-1/01.jpg": new Uint8Array([255, 216, 255, 217]) });
        const products = await parseProductWorkbook((await extractProductWorkbookFromZip(zip))!);
        const [product] = await attachProductZip(products, zip);
        expect(product.images).toMatchObject([{ name: "01.jpg", source: "zip" }]);
        expect(product.imageStatus).toBe("ready");
    });
});
