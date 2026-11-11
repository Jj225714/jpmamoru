import { expect, it } from "vitest";
import { COMMERCE_LOCALES } from "@/types/commerce";
import { normalizeLocales, LOCALE_LABELS, DEFAULT_BRAND_GENERATION_DEFAULTS } from "./generation-config";
import { BRITISH_ENGLISH_TERMS } from "./british-english";

it("offers British English while preserving stored selections and historical defaults", () => {
    expect(COMMERCE_LOCALES).toContain("en-GB");
    expect(LOCALE_LABELS["en-GB"]).toBe("英语（英国）");
    const saved = JSON.parse(JSON.stringify({ locales: ["en-US", "en-GB"], selections: [{ siteLocales: ["en-GB"] }], localizedCopy: { "en-GB": { m: "colour" } } }));
    expect(normalizeLocales(saved.locales)).toEqual(["en-US", "en-GB"]);
    expect(normalizeLocales(saved.selections[0].siteLocales)).toEqual(["en-GB"]);
    expect(saved.localizedCopy["en-GB"].m).toBe("colour");
    expect(normalizeLocales(["en-US"])).toEqual(["en-US"]);
    expect(DEFAULT_BRAND_GENERATION_DEFAULTS.locales).not.toContain("en-GB");
    expect(BRITISH_ENGLISH_TERMS).toMatchObject({ color: "colour", organize: "organise" });
});
