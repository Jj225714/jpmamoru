/** Prepare an offline draft only. Does not publish or contact the production server.
 * From web/: npx tsx ../deploy/prepare-category-catalog.mts --base <catalog.json> --output <draft.json> [--workbook <xlsx>]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCategorySeedPack } from "../web/src/lib/commerce/category-seed.ts";
import { validateCategories } from "../web/src/lib/commerce/category-rules.ts";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes("--base") || !args.includes("--output")) throw new Error("Required: --base <catalog or policy pack JSON> --output <draft JSON>; optional --workbook <source XLSX>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(await readFile(resolve(option("--base")), "utf8"));
const pack = createCategorySeedPack(base.policyPacks?.[0] || base);
const mediaDirectory = resolve(root, "web/public/commerce-categories");
if (args.includes("--workbook")) {
    const require = createRequire(resolve(root, "web/package.json"));
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(resolve(option("--workbook")));
    const sheet = workbook.getWorksheet("Sheet1");
    if (!sheet) throw new Error("Source workbook is missing Sheet1");
    const children = pack.categories!.filter((node) => node.parentId);
    const prepared: { path: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < children.length; i++) {
        const node = children[i]; const row = Number(node.source!.range.match(/\d+/)![0]);
        if (String(sheet.getCell(`B${row}`).text) !== node.source!.originalText) throw new Error(`Workbook requirements changed at B${row}; review and update seed before importing`);
        const anchored = sheet.getImages().filter((image: any) => Math.floor(image.range.tl.nativeRow ?? image.range.tl.row) + 1 === row);
        if (anchored.length !== 1) throw new Error(`Expected exactly one source image at row ${row}`);
        const image = workbook.getImage(anchored[0].imageId);
        if (!image.buffer) throw new Error(`Missing original image at row ${row}`);
        // The workbook calls some PNG payloads .jpeg. Trust decoded file signatures.
        const bytes = new Uint8Array(image.buffer);
        const extension = bytes[0] === 0x89 && bytes[1] === 0x50 ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : undefined;
        if (!extension) throw new Error(`Unsupported original image at row ${row}`);
        const ref = pack.references.find((item) => item.id === node.referenceIds[0])!;
        if (!ref.url.endsWith(`image${i + 1}.${extension}`)) throw new Error(`Image format changed at row ${row}; review seed before importing`);
        prepared.push({ path: resolve(mediaDirectory, `image${i + 1}.${extension}`), bytes });
    }
    await mkdir(mediaDirectory, { recursive: true });
    for (const image of prepared) await writeFile(image.path, image.bytes);
}
const hashes: Record<string, string> = {};
for (const ref of pack.references.filter((item) => item.url.startsWith("/commerce-categories/"))) {
    const bytes = await readFile(resolve(root, `web/public${ref.url}`));
    const valid = ref.url.endsWith(".png") ? bytes[0] === 0x89 && bytes[1] === 0x50 : bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!valid) throw new Error(`Invalid source image ${ref.url}`);
    hashes[ref.id] = createHash("sha256").update(bytes).digest("hex");
}
const validationErrors = validateCategories(pack);
const output = resolve(option("--output"));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(pack, null, 2));
await writeFile(output + ".manifest.json", JSON.stringify({ sourceImages: hashes, validationErrors, publishable: validationErrors.length === 0 }, null, 2));
console.log(JSON.stringify({ output, categories: pack.categories!.length, images: Object.keys(hashes).length, validationErrors }));
