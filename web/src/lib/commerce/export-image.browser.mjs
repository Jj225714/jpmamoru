// Real Chromium codecs; no network, model calls or persisted user images.
import { chromium } from "playwright";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile(new URL("./export-image.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText.replace(/export /g, "");
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: compiled + "\nwindow.fitExportImage = fitExportImage;" });
    const result = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1024; canvas.height = 1024;
        const ctx = canvas.getContext("2d");
        const pixels = ctx.createImageData(1024, 1024);
        let seed = 17;
        for (let i = 0; i < pixels.data.length; i += 4) {
            for (let c = 0; c < 3; c++) { seed = (seed * 1664525 + 1013904223) >>> 0; pixels.data[i + c] = seed >>> 24; }
            pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        const original = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const outputs = [];
        for (const format of ["jpeg", "webp"]) {
            const blob = await window.fitExportImage(original, 512 * 1024, format);
            const decoded = await createImageBitmap(blob);
            outputs.push({ format, bytes: blob.size, mime: blob.type, width: decoded.width, height: decoded.height });
            decoded.close();
        }
        let failure = "";
        try { await window.fitExportImage(original, 1, "jpeg"); } catch (error) { failure = error.message; }
        return { originalBytes: original.size, limit: 512 * 1024, outputs, failure };
    });
    assert.ok(result.originalBytes > result.limit);
    for (const output of result.outputs) {
        assert.ok(output.bytes > 0 && output.bytes <= result.limit);
        assert.equal(output.mime, "image/" + output.format);
        assert.equal(output.width, 1024); assert.equal(output.height, 1024);
    }
    assert.match(result.failure, /未生成交付包/);
    console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
