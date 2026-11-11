// Local deterministic pixels only; no AI requests or production services.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(process.env.WHITE_TEST_URL || "http://127.0.0.1:3018");
    const results = await page.evaluate(async () => {
        const edit = await import("/src/lib/commerce/white-image-edit.ts");
        const renderer = await import("/src/lib/commerce/white-image-renderer.ts");
        const storage = await import("/src/services/image-storage.ts");
        const result = await import("/src/lib/commerce/white-image-result.ts");
        const source = document.createElement("canvas"); source.width = source.height = 4;
        const ctx = source.getContext("2d");
        ctx.fillStyle = "rgba(255,0,0,0.5)"; ctx.fillRect(0, 0, 4, 4);
        const layer = { url: source.toDataURL(), width: 4, height: 4, bytes: 100, mimeType: "image/png" };
        const editor = { version: 1, layer, base: { width: 0.5, height: 0.5, bounds: { x: 0, y: 0, width: 1, height: 1 } }, applied: edit.DEFAULT_WHITE_ADJUSTMENTS };
        const prepared = await renderer.loadWhiteLayer(layer);
        const canvas = document.createElement("canvas");
        const pixel = (x, y) => Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data);
        const transparent = { ...edit.DEFAULT_WHITE_ADJUSTMENTS, backgroundColor: "#0000ff", backgroundOpacity: 0 };
        renderer.drawWhiteImage(canvas, prepared, editor, transparent, 800);
        const clear = pixel(0, 0), edge = pixel(400, 400);
        const blue = { ...transparent, backgroundOpacity: 100 };
        renderer.drawWhiteImage(canvas, prepared, editor, blue, 800);
        const blueEdge = pixel(400, 400);
        renderer.drawWhiteImage(canvas, prepared, editor, transparent, 800);
        const clearedAgain = pixel(0, 0), edgeAgain = pixel(400, 400);
        renderer.drawWhiteImage(canvas, prepared, editor, { ...transparent, backgroundOpacity: 50 }, 800);
        const halfBackground = pixel(0, 0);
        const pixelsFrom = async (image) => {
            const bitmap = await createImageBitmap(await fetch(await storage.imageToDataUrl(image)).then(r => r.blob()));
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
            return { background: pixel(0, 0), edge: pixel(400, 400) };
        };
        const png = await renderer.renderWhiteImage(editor, transparent, { size: 800, format: "png" });
        const pngPixels = await pixelsFrom(png);
        const bluePngPixels = await pixelsFrom(await renderer.renderWhiteImage(editor, blue, { size: 800, format: "png" }));
        const halfPngPixels = await pixelsFrom(await renderer.renderWhiteImage(editor, { ...transparent, backgroundOpacity: 50 }, { size: 800, format: "png" }));
        const jpg = await renderer.renderWhiteImage(editor, { ...transparent, backgroundOpacity: 50 }, { size: 800, format: "jpeg" });
        const jpgPixels = await pixelsFrom(jpg);
        const record = { id: "test", source: { id: "source", name: "fixture", url: layer.url, source: "upload" }, image: png, editor, createdAt: "2026-10-25" };
        const draft = { adjustments: transparent, output: { size: 800, format: "png" } };
        const saved = await result.materializeWhiteResult(record, draft, []);
        const reopened = JSON.parse(JSON.stringify(saved));
        const savedPixels = await pixelsFrom(reopened.image);
        // Recheck backgrounds through the new four-corner renderer, not just the ordinary path.
        const perspectiveExports = [];
        for (const opacity of [0, 50, 100]) {
            const settings = edit.updateWhiteAdjustments(editor.base, { ...transparent, backgroundOpacity: opacity }, { perspectiveEnabled: true });
            settings.perspective.bottomRight.x -= 0.08;
            renderer.drawWhiteImage(canvas, prepared, editor, settings, 800);
            const preview = Array.from(canvas.getContext("2d").getImageData(0, 0, 800, 800).data);
            const image = await renderer.renderWhiteImage(editor, settings, { size: 800, format: "png" });
            await pixelsFrom(image);
            const exported = canvas.getContext("2d").getImageData(0, 0, 800, 800).data;
            perspectiveExports.push(preview.every((value, index) => value === exported[index]));
        }
        // Mount the real editor for an interactive smoke test without the application stores.
        const ReactModule = await import("/node_modules/.vite/deps/react.js");
        const React = ReactModule.default || ReactModule;
        const client = await import("/node_modules/.vite/deps/react-dom_client.js");
        const createRoot = client.createRoot || client.default.createRoot;
        const { ProductWhiteEditor } = await import("/src/pages/image/product-white-editor.tsx");
        document.body.innerHTML = '<div id="white-test"></div>';
        document.documentElement.classList.remove("dark");
        document.body.style.backgroundColor = "#fff";
        document.body.style.color = "#111";
        function Harness() {
            const [value, setValue] = React.useState(transparent);
            return React.createElement(ProductWhiteEditor, { editor, value, disabled: false, onChange: setValue, outputFormat: "png" });
        }
        createRoot(document.getElementById("white-test")).render(React.createElement(Harness));
        return { clear, edge, blueEdge, clearedAgain, edgeAgain, halfBackground, pngPixels, bluePngPixels, halfPngPixels, jpgPixels, savedPixels, perspectiveExports, restored: result.whiteDraftForResult(reopened), draft };
    });
    assert.deepEqual(results.clear, [0, 0, 0, 0]);
    assert.deepEqual(results.edge, [255, 0, 0, 128]);
    assert.deepEqual(results.blueEdge, [128, 0, 127, 255]);
    assert.deepEqual(results.clearedAgain, results.clear); assert.deepEqual(results.edgeAgain, results.edge);
    assert.deepEqual(results.halfBackground, [0, 0, 255, 128]);
    assert.deepEqual(results.pngPixels, { background: results.clear, edge: results.edge });
    assert.deepEqual(results.bluePngPixels, { background: [0, 0, 255, 255], edge: results.blueEdge });
    assert.deepEqual(results.halfPngPixels.background, results.halfBackground);
    assert.deepEqual(results.savedPixels, results.pngPixels); assert.deepEqual(results.restored, results.draft);
    assert.deepEqual(results.perspectiveExports, [true, true, true]);
    assert.equal(results.jpgPixels.background[3], 255);
    for (const [index, expected] of [127, 127, 255].entries()) assert.ok(Math.abs(results.jpgPixels.background[index] - expected) <= 3);
    await page.getByRole("button", { name: "画布取色", exact: true }).click();
    const canvas = page.getByLabel("商品编辑画布");
    await canvas.click({ position: { x: (await canvas.boundingBox()).width / 2, y: (await canvas.boundingBox()).height / 2 } });
    await page.waitForFunction(() => document.querySelector('input[type="color"]').value === "#ff0000");
    await page.getByRole("button", { name: /撤\s*销/ }).click();
    assert.equal(await page.getByLabel("背景颜色", { exact: true }).inputValue(), "#0000ff");
    await page.getByRole("button", { name: /重\s*做/ }).click();
    assert.equal(await page.getByLabel("背景颜色", { exact: true }).inputValue(), "#ff0000");
    await page.getByLabel("背景透明度", { exact: true }).fill("50");
    await page.waitForFunction(() => {
        const rgba = document.querySelector('canvas[aria-label="商品编辑画布"]').getContext("2d").getImageData(0, 0, 1, 1).data;
        return rgba[0] === 255 && rgba[1] === 0 && rgba[2] === 0 && rgba[3] === 128;
    });
    await page.getByRole("button", { name: /撤\s*销/ }).click();
    assert.equal(await page.getByLabel("背景透明度", { exact: true }).inputValue(), "100");
    await page.getByRole("button", { name: /重\s*做/ }).click();
    assert.equal(await page.getByLabel("背景透明度", { exact: true }).inputValue(), "50");
    await page.screenshot({ path: "test-results/white-background.png", fullPage: true });
    console.log("PASS: PNG alpha, half-transparent edges, background alpha, JPEG matte, save/reopen, color picking, undo/redo");
} finally { await browser.close(); }
