import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ManagedModelAccess, scrubManagedCredentialQuery } from "./managed-model-access";
import { getManagedModelGatewayEnabled } from "@/constant/runtime-config";
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])("opens the workspace regardless of obsolete runtime flag %s", (enabled) => {
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: { managedModelGatewayEnabled: enabled } });
    expect(getManagedModelGatewayEnabled()).toBe(false);
    const html = renderToStaticMarkup(createElement(ManagedModelAccess, null, createElement("div", null, "WORKSPACE")));
    expect(html).toContain("WORKSPACE");
    expect(html).not.toContain("访问码");
});
it("removes obsolete codes while preserving personal channel import and navigation", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://site/image?code=old&baseUrl=https://api.example&apiKey=mine&mode=advanced#item" }, history: { replaceState } });
    scrubManagedCredentialQuery();
    const url = replaceState.mock.calls[0][2];
    expect(url).not.toContain("code=");
    expect(url).toContain("apiKey=mine");
    expect(url).toContain("mode=advanced");
});
