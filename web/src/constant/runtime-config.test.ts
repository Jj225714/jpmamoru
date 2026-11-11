import { afterEach, expect, it, vi } from "vitest";
import { getCommercePolicyCatalogUrl } from "./runtime-config";

afterEach(() => vi.unstubAllGlobals());
it("uses the v2 catalog only in compatible clients and preserves the legacy runtime field", () => {
    const config = { commercePolicyCatalogUrl: "/public-rules/catalog.json", commerceVisualPolicyCatalogUrl: "/public-rules/catalog-visual-v2.json" };
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: config });
    expect(getCommercePolicyCatalogUrl()).toBe(config.commerceVisualPolicyCatalogUrl);
    expect(config.commercePolicyCatalogUrl).toBe("/public-rules/catalog.json");
});
it("remains compatible with unconfigured local and legacy deployments", () => {
    vi.stubGlobal("window", { __RUNTIME_CONFIG__: { commercePolicyCatalogUrl: "/public-rules/catalog.json" } });
    expect(getCommercePolicyCatalogUrl()).toBe("/public-rules/catalog.json");
    vi.stubGlobal("window", {});
    expect(getCommercePolicyCatalogUrl()).toBeUndefined();
});
