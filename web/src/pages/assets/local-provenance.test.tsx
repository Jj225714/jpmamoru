import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalAssetProvenance } from "./local-provenance";
import type { AssetGenerationInfo } from "./generation-info";
const generation: AssetGenerationInfo = { version: 1, prompt: "<script>alert('x')</script>\nhttps://example.invalid/private", model: "_channel::image-v1", parameters: { size: "1.90:1", quality: "auto", count: "3", background: "" }, generatedAt: "2026-10-25T08:00:00+08:00", references: ["B", "C", "A"].map(id => ({ id, name: `${id}.png`, type: "image/png" })), source: { kind: "commerce", taskId: "task" } };
it("shows prompt/model/parameters/time and reference order as escaped text", () => {
    const html = renderToStaticMarkup(<LocalAssetProvenance generation={generation} />);
    expect(html).toContain("_channel::image-v1"); expect(html).toContain("1.90:1"); expect(html).toContain("2026-10-25T08:00:00+08:00"); expect(html).toContain("3 张（按生成请求顺序）");
    expect(html.indexOf("B.png")).toBeLessThan(html.indexOf("C.png")); expect(html.indexOf("C.png")).toBeLessThan(html.indexOf("A.png"));
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).not.toContain("href="); expect(html).toContain("未指定（空值）"); expect(html).toContain("客户端来源");
});
it("marks missing provenance and missing optional fields explicitly", () => {
    expect(renderToStaticMarkup(<LocalAssetProvenance />)).toContain("未记录生成来源");
    const html = renderToStaticMarkup(<LocalAssetProvenance generation={{ ...generation, generatedAt: undefined, parameters: {}, references: [] }} />);
    expect(html).toContain("未记录"); expect(html).toContain("已记录为无参考图"); expect(html).not.toContain("undefined");
});
