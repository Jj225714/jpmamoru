import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage", () => ({ uploadImage: vi.fn() }));
import { parseProductWorkbook } from "./importers";

const workbookPath = "D:/xwechat_files/wxid_qypys2305j522_2961/msg/file/2026-09/奥维斯美工需求.xlsx";

async function productFile(headers: string[], values: string[]) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("商品导入");
    sheet.addRow(headers); sheet.addRow(values);
    const bytes = await workbook.xlsx.writeBuffer();
    return { name: "products.xlsx", arrayBuffer: async () => bytes } as File;
}

describe("optional product descriptions", () => {
    const headers = ["SKU 编号", "商品类型(必填)", "产品名称(必填)"];
    it("imports with no selling point column and never approves facts", async () => {
        const [product] = await parseProductWorkbook(await productFile(headers, ["sku", "垫", "桌垫"]));
        expect(product).toMatchObject({ description: "", factsConfirmed: false, verifiedFacts: {} });
    });
    it.each(["产品描述/卖点", "产品描述/卖点(必填)"])("supports blank and filled alias %s", async (header) => {
        for (const value of ["", "条纹外观"]) {
            const [product] = await parseProductWorkbook(await productFile([...headers, header], ["sku", "垫", "桌垫", value]));
            expect(product.description).toBe(value);
        }
    });
    it("imports optional known attributes and preserves custom fields", async () => {
        const [product] = await parseProductWorkbook(await productFile([...headers, "材质描述", "使用方式", "英文类目路径", "定制要求"], ["sku", "垫", "桌垫", "棉", "平铺", "Home & Kitchen > Mats", "保留"]));
        expect(product).toMatchObject({ materialDescription: "棉", usageInstructions: "平铺", categoryPath: "Home & Kitchen > Mats", category: "垫", extraFields: { 定制要求: "保留" } });
    });
    it.each([0, 1, 2])("still requires column and value %s", async (index) => {
        await expect(parseProductWorkbook(await productFile(headers.filter((_, i) => i !== index), ["x", "y"]))).rejects.toThrow("缺少字段");
        const values = ["sku", "垫", "桌垫"]; values[index] = "";
        await expect(parseProductWorkbook(await productFile(headers, values))).rejects.toThrow("缺少 SKU");
    });
});

describe("奥维斯需求工作簿", () => {
    it.runIf(existsSync(workbookPath))("包含 40 个编号方案并关联 82 张类目参考图", async () => {
        const bytes = readFileSync(workbookPath); const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
        const sheet = workbook.getWorksheet("各类目图片需求")!; const counts: Record<string, number> = {}; let category = "";
        for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
            const row = sheet.getRow(rowNumber); const order = row.getCell(1).text.trim(); const requirement = row.getCell(2).text.trim(); const copy = row.getCell(8).text.trim();
            if (order && !/^\d+$/.test(order) && order !== "排序") { category = order; continue; }
            if (/^\d+$/.test(order) && (requirement || copy)) counts[category] = (counts[category] || 0) + 1;
        }
        expect(counts).toEqual({ 地毯地垫类: 11, 桌垫类: 11, 洞洞板类: 9, 收纳筐类: 9 });
        expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(40);
        expect(sheet.getImages()).toHaveLength(82);
    });
});
