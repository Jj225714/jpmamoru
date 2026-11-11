import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parsePolicyCatalog } from "./commerce-policy-catalog";

// Optional cross-language release contract: set this to the Python publisher's catalog output.
const catalogPath = process.env.COMMERCE_POLICY_CATALOG_FIXTURE;
it.runIf(Boolean(catalogPath))("accepts the real Python-published category catalog and all image bindings", () => {
    const catalog = parsePolicyCatalog(JSON.parse(readFileSync(catalogPath!, "utf8")), "https://example.test");
    const pack = catalog.policyPacks[0];
    expect(pack.status).toBe("published");
    expect(pack.categories?.filter((node) => node.parentId)).toHaveLength(10);
    expect(pack.references.every((ref) => ref.url.startsWith(`/public-rules/releases/${catalog.revision}/images/`))).toBe(true);
    expect(pack.categories?.filter((node) => node.parentId).every((node) => node.referenceIds.length === 1 && pack.references.some((ref) => ref.id === node.referenceIds[0]))).toBe(true);
});
