import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import { nanoid } from "nanoid";

import { uploadImage } from "@/services/image-storage";
import { correctedPresetVisual } from "./requirement-visuals";
import type { CategoryTemplate, CommerceLocale, CommerceRequirementPreset, CommerceSiteReference, CountryProfile, MarketingLayoutPreset, PolicyPack, PolicyRule, ProductRecord, RequirementVariantScope, StoredImageRef, TemplateReference, TemplateSlot } from "@/types/commerce";

const PRODUCT_HEADERS = {
    sku: "SKU 编号", productType: "商品类型(必填)", name: "产品名称(必填)", brandName: "品牌名称", category: "产品类目", audience: "目标受众",
    description: "产品描述/卖点", legacyDescription: "产品描述/卖点(必填)", material: "材质描述", usage: "使用方式", categoryPath: "英文类目路径", size: "产品尺寸", sizeImageUrl: "尺码图片地址", imageUrls: "商品主图地址(多个用逗号分隔)",
} as const;
const OPTIONAL_PRODUCT_HEADERS = {
    materialDescription: [PRODUCT_HEADERS.material, "产品材质", "materialDescription"],
    usageInstructions: [PRODUCT_HEADERS.usage, "使用说明", "usageInstructions"],
    categoryPath: [PRODUCT_HEADERS.categoryPath, "产品类目路径", "categoryPath"],
} as const;

const COUNTRY_META: Record<string, { code: string; locale: CommerceLocale }> = {
    印尼: { code: "ID", locale: "id-ID" }, 菲律宾: { code: "PH", locale: "fil-PH" }, 马来西亚: { code: "MY", locale: "ms-MY" }, 泰国: { code: "TH", locale: "th-TH" }, 越南: { code: "VN", locale: "vi-VN" },
};

function cellText(cell: ExcelJS.Cell) {
    const value = cell.value;
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "object" && "formula" in value) {
        const result = (value as ExcelJS.CellFormulaValue).result;
        return typeof result === "string" || typeof result === "number" || typeof result === "boolean" ? String(result).trim() : "";
    }
    if (typeof value === "object" && "richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("").trim();
    if (typeof value === "object" && "text" in value) return String((value as ExcelJS.CellHyperlinkValue).text || "").trim();
    return "";
}

function splitList(value: string) {
    return value.split(/[，,；;\n\r]+/).map((item) => item.replace(/^[✅❌•\-\s]+/, "").trim()).filter(Boolean);
}

export async function parseProductWorkbook(file: File, options: { allowDuplicateSku?: boolean } = {}): Promise<ProductRecord[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.getWorksheet("商品导入") || workbook.worksheets[0];
    if (!sheet) throw new Error("Excel 中没有可读取的工作表");
    const headers = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, column) => headers.set(cellText(cell), column));
    const missingHeaders = [PRODUCT_HEADERS.sku, PRODUCT_HEADERS.productType, PRODUCT_HEADERS.name].filter((name) => !headers.has(name));
    if (missingHeaders.length) throw new Error("商品模板缺少字段：" + missingHeaders.join("、"));
    const products: ProductRecord[] = [];
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const read = (header: string) => headers.has(header) ? cellText(row.getCell(headers.get(header)!)) : "";
        const sku = read(PRODUCT_HEADERS.sku);
        const name = read(PRODUCT_HEADERS.name);
        const productType = read(PRODUCT_HEADERS.productType);
        const description = read(PRODUCT_HEADERS.description) || read(PRODUCT_HEADERS.legacyDescription);
        if (!sku && !name && !productType && !description) return;
        if (!sku || !name || !productType) throw new Error("第 " + rowNumber + " 行缺少 SKU、商品类型或产品名称");
        const known = new Set<string>([...Object.values(PRODUCT_HEADERS), ...Object.values(OPTIONAL_PRODUCT_HEADERS).flat()]);
        const extraFields: Record<string, string> = {};
        headers.forEach((column, header) => { if (header && !known.has(header as never)) extraFields[header] = cellText(row.getCell(column)); });
        const imageUrls = splitList(read(PRODUCT_HEADERS.imageUrls));
        const sizeUrl = read(PRODUCT_HEADERS.sizeImageUrl);
        products.push({ id: nanoid(), sku, productType, name, brandName: read(PRODUCT_HEADERS.brandName), category: read(PRODUCT_HEADERS.category) || productType, audience: read(PRODUCT_HEADERS.audience), description, size: read(PRODUCT_HEADERS.size), images: [], imageUrls, extraFields, verifiedFacts: {}, factsConfirmed: false, imageStatus: imageUrls.length ? "loading" : "missing", ...(sizeUrl ? { sizeImage: { id: nanoid(), name: "size-url", url: sizeUrl, source: "url" } as StoredImageRef } : {}) });
        const product = products[products.length - 1];
        for (const field of Object.keys(OPTIONAL_PRODUCT_HEADERS) as Array<keyof typeof OPTIONAL_PRODUCT_HEADERS>) {
            const value = OPTIONAL_PRODUCT_HEADERS[field].map(read).find(Boolean);
            if (value) product[field] = value;
        }
    });
    if (!products.length) throw new Error("Excel 中没有商品数据");
    if (products.length > 20) throw new Error("单批最多导入 20 个 SKU，请拆分后重试");
    const duplicate = products.find((item, index) => products.findIndex((other) => other.sku === item.sku) !== index);
    if (duplicate && !options.allowDuplicateSku) throw new Error("SKU 重复：" + duplicate.sku);
    return products;
}

export async function extractProductWorkbookFromZip(zipFile: File): Promise<File | undefined> {
    const entries = unzipSync(new Uint8Array(await zipFile.arrayBuffer()), {
        filter: ({ name }) => {
            const leaf = normalizeEntry(name).split("/").pop() || "";
            return /\.xlsx$/i.test(leaf) && !leaf.startsWith("~$");
        },
    });
    const workbooks = Object.entries(entries).filter(([name]) => /\.xlsx$/i.test(name));
    if (workbooks.length > 1) throw new Error("ZIP 中有多个 Excel，请在左侧单独选择要导入的商品 Excel");
    if (!workbooks.length) return undefined;
    const [name, bytes] = workbooks[0];
    return new File([bytes], name.split(/[\\/]/).pop() || "商品导入.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function attachProductZip(products: ProductRecord[], zipFile: File) {
    const entries = unzipSync(new Uint8Array(await zipFile.arrayBuffer()));
    const result = await Promise.all(products.map(async (product) => {
        const files = Object.entries(entries).filter(([name]) => {
            const segments = normalizeEntry(name).split("/");
            return segments[segments.length - 2] === normalizeEntry(product.sku);
        });
        const images: StoredImageRef[] = [];
        let sizeImage = product.sizeImage;
        for (const [name, data] of files) {
            const leaf = name.split(/[\\/]/).pop() || name;
            if (!/\.(png|jpe?g|webp)$/i.test(leaf)) continue;
            const mimeType = mimeFromName(leaf);
            const stored = await uploadImage(new Blob([data], { type: mimeType }));
            const ref: StoredImageRef = { id: nanoid(), name: leaf, url: stored.url, storageKey: stored.storageKey, source: "zip" };
            if (/^size\./i.test(leaf)) sizeImage = ref;
            else if (/^(0[1-6]|[1-6])\./i.test(leaf)) images.push(ref);
        }
        images.sort((a, b) => a.name.localeCompare(b.name));
        return { ...product, images, sizeImage, imageStatus: images.length ? "ready" as const : product.imageStatus };
    }));
    return result;
}

export async function hydrateProductUrls(products: ProductRecord[]) {
    return Promise.all(products.map(async (product) => {
        const images = [...product.images];
        for (const url of product.imageUrls) {
            if (images.length >= 6) break;
            try {
                const stored = await uploadRemoteProductImage(url);
                images.push({ id: nanoid(), name: "url-" + (images.length + 1), url: stored.url, storageKey: stored.storageKey, source: "url" });
            } catch {
                // Missing URLs remain visible in imageStatus and block generation.
            }
        }
        let sizeImage = product.sizeImage;
        if (sizeImage?.source === "url" && !sizeImage.storageKey) {
            try {
                const stored = await uploadRemoteProductImage(sizeImage.url);
                sizeImage = { ...sizeImage, url: stored.url, storageKey: stored.storageKey };
            } catch { /* Keep the unresolved source URL. */ }
        }
        return { ...product, images, sizeImage, imageStatus: images.length ? "ready" as const : "missing" as const };
    }));
}

async function uploadRemoteProductImage(url: string) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("HTTP " + response.status);
        return await uploadImage(await response.blob());
    } catch {
        return uploadImage(url);
    }
}

export async function parsePolicyWorkbook(file: File, nextVersion: number): Promise<PolicyPack> {
    const buffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const profiles: CountryProfile[] = [];
    const rules: PolicyRule[] = [];
    const templates: CategoryTemplate[] = [];
    const globalStandards: string[] = [];
    const templateRows = new Map<number, CategoryTemplate>();
    const siteSheet = workbook.getWorksheet("站点图片差异化");
    siteSheet?.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const countryName = cellText(row.getCell(1));
        const meta = COUNTRY_META[countryName];
        if (!meta) return;
        const audience = cellText(row.getCell(3));
        const visualKeywords = cellText(row.getCell(5));
        const mainImageStyle = cellText(row.getCell(7));
        const preferredColors = splitList(cellText(row.getCell(9)));
        const avoidedColors = splitList(cellText(row.getCell(11)));
        const redline = splitList(cellText(row.getCell(13)));
        const modelPreference = cellText(row.getCell(15));
        profiles.push({ countryCode: meta.code, countryName, locale: meta.locale, audience, visualKeywords, mainImageStyle, preferredColors, avoidedColors, modelPreference });
        if (redline.length) rules.push(makeCountryRule(file.name, countryName, meta.code, rowNumber, "当地宗教与文化红线", redline, "BLOCK", "vision"));
        if (avoidedColors.length) rules.push(makeCountryRule(file.name, countryName, meta.code, rowNumber, "避免的色彩与风格", avoidedColors, "WARN", "vision"));
        const guide = [visualKeywords, mainImageStyle, preferredColors.join("、"), modelPreference].filter(Boolean).join("；");
        if (guide) rules.push(makeCountryRule(file.name, countryName, meta.code, rowNumber, "站点视觉指导", [guide], "GUIDE", "manual"));
    });

    const categorySheet = workbook.getWorksheet("各类目图片需求");
    if (categorySheet) {
        let category = "未分类";
        const maxRow = Math.min(categorySheet.rowCount, 500);
        for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
            const row = categorySheet.getRow(rowNumber);
            const a = cellText(row.getCell(1));
            const requirement = cellText(row.getCell(2));
            if (a && !/^\d+$/.test(a) && a !== "排序") { category = a.trim(); continue; }
            const chineseCopy = cellText(row.getCell(8));
            if (!/^\d+$/.test(a) || (!requirement && !chineseCopy)) continue;
            const translationSeeds = { "en-US": cellText(row.getCell(10)), "id-ID": cellText(row.getCell(12)), "vi-VN": cellText(row.getCell(14)), "th-TH": cellText(row.getCell(16)) };
            const templateRequirement = requirement || chineseCopy || Object.values(translationSeeds).find(Boolean) || "待补充作图要求";
            const template: CategoryTemplate = {
                id: nanoid(), category, order: Number(a), title: summarizeRequirement(templateRequirement), requirement: templateRequirement, slot: inferSlot(requirement, chineseCopy, Object.values(translationSeeds)),
                chineseCopy: chineseCopy === "无" ? "" : chineseCopy,
                translationSeeds,
                requiredVariables: inferVariables(chineseCopy + "\n" + requirement), referenceIds: [],
            };
            templates.push(template); templateRows.set(rowNumber, template);
        }
    }

    const specSheet = workbook.getWorksheet("作图规范");
    specSheet?.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const moduleName = cellText(row.getCell(1));
        const detail = cellText(row.getCell(2)) || (rowNumber === 17 ? moduleName : "");
        if (detail) globalStandards.push(moduleName && detail !== moduleName ? moduleName + "：" + detail : detail);
    });

    const rawImages = extractWorkbookImages(new Uint8Array(buffer));
    const references: TemplateReference[] = [];
    for (const image of rawImages) {
        const stored = await uploadImage(image.blob);
        const reference: TemplateReference = { id: nanoid(), name: image.name, url: stored.url, storageKey: stored.storageKey, source: "rule-reference", sheet: image.sheet, anchor: image.anchor, kind: image.column === 6 ? "example" : "reference" };
        references.push(reference);
        if (image.sheet === "各类目图片需求") nearestTemplate(templateRows, image.row)?.referenceIds.push(reference.id);
    }

    const requirementPresets = templates.map(templateToRequirement).map(correctedPresetVisual);
    const referenceSheetImages = rawImages.filter((image) => image.sheet === "参考链接");
    const siteReferences: CommerceSiteReference[] = referenceSheetImages.map((image, index) => {
        const reference = references.find((item) => item.sheet === image.sheet && item.anchor === image.anchor);
        return { id: nanoid(), product: "参考产品 " + (index + 1), referenceIds: reference ? [reference.id] : [], note: "来源于参考链接工作表 " + image.anchor };
    });

    const isAowei = /奥维斯/.test(file.name);
    const generationDefaults = isAowei ? {
        outputSpec: { size: 1024 as const, format: "jpeg" as const, maxBytes: 2 * 1024 * 1024, colorSpace: "sRGB" as const, dpi: 96 as const },
        siteImageMode: "shared" as const, delivery: "editableCanvas" as const,
        overlay: { logo: { placement: "top-right" as const, applyTo: "marketing" as const, customStages: [] }, watermark: { mode: "single" as const, position: "center" as const, opacity: 0.05, applyTo: "marketing" as const, customStages: [] } },
    } : undefined;

    return { id: nanoid(), name: file.name.replace(/\.xlsx$/i, "") + "规则", version: nextVersion, status: "draft", sourceFileName: file.name, profiles, rules, templates, requirementPresets, references, siteReferences, globalStandards, generationDefaults, watermarkOpacityRange: isAowei ? [0.03, 0.07] : [0.03, 0.3], createdAt: new Date().toISOString() };
}

function makeCountryRule(fileName: string, countryName: string, countryCode: string, row: number, title: string, descriptions: string[], severity: PolicyRule["severity"], checker: PolicyRule["checker"]): PolicyRule {
    return { id: nanoid(), title: countryName + " · " + title, description: descriptions.join("；"), severity, priority: severity === "BLOCK" ? 90 : severity === "WARN" ? 50 : 20, countries: [countryCode], platforms: ["shopee", "tiktok"], categories: [], locales: [], assetStages: ["scene", "detail", "usage-size", "detail-white", "marketing"], phase: severity === "GUIDE" ? "prompt" : "post-render", checker, source: { fileName, sheet: "站点图片差异化", range: "A" + row + ":O" + row } };
}

function inferSlot(requirement: string, copy: string, translations: string[] = []): TemplateSlot {
    if ((!copy || copy === "无") && !translations.some((item) => item && item !== "无")) {
        if (/细节|纹理|材质|编织|包边/.test(requirement)) return "detail";
        if (/尺寸|比例|使用|安装/.test(requirement)) return "usage-size";
        return "scene";
    }
    return "marketing";
}

function templateToRequirement(template: CategoryTemplate): CommerceRequirementPreset {
    const stage = template.slot === "marketing" ? "marketing" : template.slot;
    return {
        id: template.id, category: template.category, order: template.order, title: template.title, stage, enabledByDefault: true, defaultCount: 1,
        prompt: template.requirement, layout: inferLayout(template.requirement + "\n" + template.chineseCopy), chineseCopy: template.chineseCopy,
        translationSeeds: template.translationSeeds, requiredFacts: template.requiredVariables, referenceIds: [...template.referenceIds],
        variantScope: inferVariantScope(template.requirement), needsReview: stage === "marketing" && (!template.chineseCopy || hasMixedLanguage(template.chineseCopy) || !template.translationSeeds["en-US"] || !template.translationSeeds["id-ID"] || !template.translationSeeds["vi-VN"] || !template.translationSeeds["th-TH"] || !template.translationSeeds["ms-MY"] || !template.translationSeeds["fil-PH"]),
    };
}

function inferLayout(value: string): MarketingLayoutPreset {
    if (/FAQ|问题|怎么办|适用于其他品牌/.test(value)) return "faq";
    if (/安装步骤|安装指南|\d[\.、].*\d[\.、]/s.test(value)) return "installation-steps";
    if (/安装方式|固定方式/.test(value)) return "installation-methods";
    if (/同行|别人的|我们的|竞品|对比图/.test(value) && !/使用前|使用后|前\/后/.test(value)) return "competitor-comparison";
    if (/使用前|使用后|前\/后/.test(value)) return "before-after";
    if (/不同光线|自然光|暖光|冷光/.test(value)) return "lighting-comparison";
    if (/三层|结构|表层|填充层/.test(value)) return "layer-structure";
    if (/尺寸|M、L|XL|XXL|厚度/.test(value)) return "size-comparison";
    if (/颜色可选|花色|款式/.test(value)) return "color-options";
    if (/多场景|多种场合|厨房.*餐桌|书桌.*玄关/s.test(value)) return "multi-scene";
    if (/特性|细节|卖点|清洁方式/.test(value)) return "feature-grid";
    return /参考图|参考布局|照抄|右图/.test(value) ? "custom-reference" : "single-hero";
}

function inferVariantScope(value: string): RequirementVariantScope {
    if (/每个颜色|每种颜色|花色/.test(value)) return "per-color";
    if (/每个尺寸|尺寸.*各|M、L|XL|XXL/.test(value)) return "per-size";
    if (/各站点|站点.*款式/.test(value)) return "per-site";
    return "per-sku";
}

function hasMixedLanguage(value: string) { return /[\u4e00-\u9fff]/.test(value) && /[A-Za-z]/.test(value); }

function inferVariables(value: string) {
    const variables: string[] = [];
    if (/XX+\s*秒|吸水时间|1秒后|3秒后/i.test(value)) variables.push("吸水时间");
    if (/XXX+\s*mm|厚度/i.test(value)) variables.push("产品厚度");
    if (/100\s*[°度]|耐热/i.test(value)) variables.push("耐热温度");
    if (/尺寸/.test(value)) variables.push("尺寸列表");
    if (/孔距/.test(value)) variables.push("孔距");
    if (/孔径/.test(value)) variables.push("孔径");
    if (/颜色|花色/.test(value)) variables.push("颜色");
    if (/配件数量|数量和摆放/.test(value)) variables.push("配件数量");
    if (/安装方式|固定方式/.test(value)) variables.push("安装方式");
    return Array.from(new Set(variables));
}

function summarizeRequirement(value: string) {
    const first = value.split(/[。\n]/).find(Boolean)?.trim() || "类目模板";
    return first.length > 24 ? first.slice(0, 24) + "…" : first;
}

function nearestTemplate(rows: Map<number, CategoryTemplate>, target: number) {
    return Array.from(rows.entries()).filter(([row]) => row <= target).sort((a, b) => b[0] - a[0])[0]?.[1];
}

function normalizeEntry(value: string) { return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(); }
function mimeFromName(name: string) { return /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg"; }

type RawWorkbookImage = { sheet: string; row: number; column: number; anchor: string; name: string; blob: Blob };

function extractWorkbookImages(bytes: Uint8Array): RawWorkbookImage[] {
    const zip = unzipSync(bytes);
    const text = (path: string) => zip[path] ? new TextDecoder().decode(zip[path]) : "";
    const workbook = parseXml(text("xl/workbook.xml"));
    const workbookRels = relationships(text("xl/_rels/workbook.xml.rels"));
    const result: RawWorkbookImage[] = [];
    for (const sheet of localElements(workbook, "sheet")) {
        const name = sheet.getAttribute("name") || "";
        const relId = Array.from(sheet.attributes).find((attr) => attr.localName === "id")?.value || "";
        const sheetPath = resolvePath("xl/workbook.xml", workbookRels.get(relId) || "");
        if (!sheetPath || !zip[sheetPath]) continue;
        const relPath = relationPath(sheetPath);
        const sheetRels = relationships(text(relPath));
        const sheetXml = parseXml(text(sheetPath));
        const drawingNode = localElements(sheetXml, "drawing")[0];
        const drawingId = drawingNode ? Array.from(drawingNode.attributes).find((attr) => attr.localName === "id")?.value : "";
        const drawingPath = resolvePath(sheetPath, sheetRels.get(drawingId || "") || "");
        if (!drawingPath || !zip[drawingPath]) continue;
        const drawingRels = relationships(text(relationPath(drawingPath)));
        const drawingXml = parseXml(text(drawingPath));
        for (const anchor of [...localElements(drawingXml, "oneCellAnchor"), ...localElements(drawingXml, "twoCellAnchor")]) {
            const from = localElements(anchor, "from")[0];
            const column = Number(localElements(from, "col")[0]?.textContent || 0) + 1;
            const row = Number(localElements(from, "row")[0]?.textContent || 0) + 1;
            const blip = localElements(anchor, "blip")[0];
            const embed = blip ? Array.from(blip.attributes).find((attr) => attr.localName === "embed")?.value : "";
            const mediaPath = resolvePath(drawingPath, drawingRels.get(embed || "") || "");
            const data = mediaPath ? zip[mediaPath] : undefined;
            if (!data) continue;
            const fileName = mediaPath.split("/").pop() || "reference.png";
            result.push({ sheet: name, row, column, anchor: columnName(column) + row, name: fileName, blob: new Blob([data], { type: mimeFromName(fileName) }) });
        }
    }
    return result;
}

function parseXml(value: string) { return new DOMParser().parseFromString(value, "application/xml"); }
function localElements(root: Document | Element, name: string) { return Array.from(root.getElementsByTagName("*")).filter((node) => node.localName === name); }
function relationships(value: string) { const map = new Map<string, string>(); if (!value) return map; for (const rel of localElements(parseXml(value), "Relationship")) map.set(rel.getAttribute("Id") || "", rel.getAttribute("Target") || ""); return map; }
function resolvePath(base: string, target: string) { if (!target) return ""; const parts = base.split("/"); parts.pop(); for (const part of target.replace(/\\/g, "/").split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); } return parts.join("/"); }
function relationPath(path: string) { const parts = path.split("/"); const file = parts.pop(); return [...parts, "_rels", file + ".rels"].join("/"); }
function columnName(column: number) { let value = column; let out = ""; while (value > 0) { value -= 1; out = String.fromCharCode(65 + (value % 26)) + out; value = Math.floor(value / 26); } return out; }
