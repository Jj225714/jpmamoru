import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltInPolicyPack } from "@/lib/commerce/defaults";
import { createCreativeRequirementPresets } from "@/lib/commerce/creative-presets";
import { createCategorySeedPack } from "@/lib/commerce/category-seed";
import type { PolicyPack } from "@/types/commerce";
import { catalogBlocksNewJob, fetchPolicyCatalog, mergePolicyCatalog, parsePolicyCatalog, publicRulesUrl } from "./commerce-policy-catalog";

const origin = "https://example.test";
describe("British English published catalog schema", () => {
    it("preserves both locales through publication JSON, fetch, merge and reread", async () => {
        const input = fixture();
        const pack = input.policyPacks[0];
        pack.id = "server-aoweisi-team-v3-abcdef012345";
        const seeds = { "en-US": "Organize by color", "en-GB": "Organise by colour" };
        pack.templates[0].translationSeeds = { ...seeds };
        pack.requirementPresets[0].translationSeeds = { ...seeds };
        pack.profiles[0].locale = "en-GB";
        pack.rules[0].locales = ["en-US", "en-GB"];
        const original = structuredClone(input);
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(input)) })));
        const fetched = await fetchPolicyCatalog("/public-rules/catalog.json", origin);
        const merged = mergePolicyCatalog([], fetched.policyPacks);
        const reread = parsePolicyCatalog(JSON.parse(JSON.stringify({ ...fetched, policyPacks: merged })), origin);
        expect(reread.policyPacks[0].templates[0].translationSeeds).toEqual(seeds);
        expect(reread.policyPacks[0].requirementPresets[0].translationSeeds).toEqual(seeds);
        expect(reread.policyPacks[0].profiles[0].locale).toBe("en-GB");
        expect(reread.policyPacks[0].rules[0].locales).toEqual(["en-US", "en-GB"]);
        expect(input).toEqual(original);
    });
    it.each(["templates", "requirementPresets"] as const)("rejects unsupported translation locale in %s rather than silently dropping it", (field) => {
        for (const locale of ["xx-XX", "en-UK", "en-gb"]) {
            const input = fixture();
            Object.assign(input.policyPacks[0][field][0].translationSeeds, { [locale]: "invalid" });
            expect(() => parsePolicyCatalog(input, origin)).toThrow("不支持的 locale");
        }
    });
    it("rejects non-string British seeds and illegal profile/rule locales", () => {
        const input = fixture();
        Object.assign(input.policyPacks[0].templates[0].translationSeeds, { "en-GB": 42 });
        expect(() => parsePolicyCatalog(input, origin)).toThrow("字段类型无效");
        const profile = fixture();
        Object.assign(profile.policyPacks[0].profiles[0], { locale: "en-UK" });
        expect(() => parsePolicyCatalog(profile, origin)).toThrow();
        const rule = fixture();
        Object.assign(rule.policyPacks[0].rules[0], { locales: ["xx-XX"] });
        expect(() => parsePolicyCatalog(rule, origin)).toThrow();
    });
    it("keeps old US-only publications unchanged", () => {
        const input = fixture();
        input.policyPacks[0].templates[0].translationSeeds = { "en-US": "Color" };
        expect(parsePolicyCatalog(JSON.parse(JSON.stringify(input)), origin)).toEqual(input);
    });
});
describe("category catalog fields", () => {
    it("round trips the category tree, sources and detail purposes without arbitrary fields", () => {
        const input = fixture();
        const pack = createCategorySeedPack(input.policyPacks[0]);
        pack.status = "published"; pack.publishedAt = input.publishedAt;
        for (const ref of pack.references) ref.url = `/public-rules/releases/${input.revision}/images/${"a".repeat(64)}.jpg`;
        for (const node of pack.categories!.filter((item) => !item.parentId)) node.referenceIds = ["ref"];
        Object.assign(pack.categories![0], { secret: "DO_NOT_IMPORT" });
        Object.assign(pack.categories![5].rules[0], { secret: "DO_NOT_IMPORT" });
        const result = parsePolicyCatalog({ ...input, policyPacks: [pack] }, origin).policyPacks[0];
        expect(result.categories).toHaveLength(15);
        expect(result.requirementPresets.some((item) => item.detailPurpose === "back")).toBe(true);
        expect(JSON.stringify(result)).not.toContain("DO_NOT_IMPORT");
    });
    it("rejects a child whose parent does not exist", () => {
        const input = fixture();
        Object.assign(input.policyPacks[0], { categories: [{ id: "child", parentId: "missing", name: "子类", aliases: [], active: true, order: 0, rules: [], referenceIds: [], requirementIds: [] }] });
        expect(() => parsePolicyCatalog(input, origin)).toThrow("有效大类");
    });
});
function fixture(version = 3) {
    return { schemaVersion: 1 as const, revision: "aoweisi-v3-abcdef012345", publishedAt: "2026-09-17T00:00:00Z", policyPacks: [{ ...structuredClone(createBuiltInPolicyPack()), id: `server-aoweisi-original-v${version}-abcdef012345`, version, status: "published" as const, publishedAt: "2026-09-17T00:00:00Z", references: [{ id: "ref", name: "reference", source: "rule-reference" as const, sheet: "sheet", anchor: "A1", kind: "reference" as const, url: `/public-rules/releases/aoweisi-v3-abcdef012345/images/${"a".repeat(64)}.png` }] }] };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function creativeFixture() {
    const input = fixture(5);
    const pack: PolicyPack = input.policyPacks[0];
    pack.creativeLibraryVersion = 1;
    pack.requirementPresets = createCreativeRequirementPresets();
    pack.generationDefaults = { creativeBrief: { scene: "书房", audience: "居家办公用户", lighting: "soft-studio", people: "none", framing: "wide" } };
    return input;
}

describe("creative public policy catalog", () => {
    it("round trips all 32 actual helper recipes and keeps optional recipes disabled", () => {
        const input = creativeFixture();
        const before = structuredClone(input);
        const result = parsePolicyCatalog(JSON.parse(JSON.stringify(input)), origin);
        expect(result).toEqual(input);
        const pack = result.policyPacks[0];
        expect(pack.creativeLibraryVersion).toBe(1);
        expect(pack.requirementPresets).toHaveLength(32);
        expect(new Set(pack.requirementPresets.map((preset) => preset.id)).size).toBe(32);
        expect(pack.requirementPresets.filter((preset) => preset.generationStrategy === "paired-before-after")).toHaveLength(4);
        for (const category of new Set(pack.requirementPresets.map((preset) => preset.category))) {
            const presets = pack.requirementPresets.filter((preset) => preset.category === category);
            expect(presets).toHaveLength(8);
            expect(presets.map((preset) => preset.enabledByDefault)).toEqual([true, true, true, true, false, false, false, false]);
        }
        expect(input).toEqual(before);
    });
    it("discards secret and arbitrary fields at each new object boundary", () => {
        const input = creativeFixture();
        const expected = structuredClone(input);
        const pack = input.policyPacks[0];
        Object.assign(pack, { apiKey: "PRIVATE_SECRET" });
        Object.assign(pack.generationDefaults!, { credentials: { apiKey: "PRIVATE_SECRET" } });
        Object.assign(pack.generationDefaults!.creativeBrief!, { apiKey: "PRIVATE_SECRET", custom: { token: "PRIVATE_SECRET" } });
        for (const preset of pack.requirementPresets) {
            Object.assign(preset, { privatePrompt: "PRIVATE_SECRET" });
            Object.assign(preset.creativeBrief!, { apiKey: "PRIVATE_SECRET", arbitrary: ["PRIVATE_SECRET"] });
        }
        const parsed = parsePolicyCatalog(input, origin);
        expect(parsed).toEqual(expected);
        expect(JSON.stringify(parsed)).not.toContain("PRIVATE_SECRET");
    });
    it.each([
        { creativeBrief: null }, { creativeBrief: [] }, { creativeBrief: { lighting: "neon" } },
        { creativeBrief: { people: "child" } }, { creativeBrief: { framing: "macro" } },
        { creativeBrief: { scene: 1 } }, { creativeBrief: { audience: "x".repeat(2001) } },
        { recipeRole: "unknown" }, { generationStrategy: "parallel" },
        { stage: "scene" }, { layout: "single-hero" }, { visualMode: "white-layout" },
        { creativeBrief: { people: "adult-partial" } },
    ])("rejects invalid creative brief or paired recipe %#", (patch) => {
        const input = creativeFixture();
        const pair = input.policyPacks[0].requirementPresets.find((preset) => preset.generationStrategy === "paired-before-after")!;
        Object.assign(pair, patch);
        expect(() => parsePolicyCatalog(input, origin)).toThrow();
    });
    it("rejects invalid default briefs, library versions, and detail people", () => {
        const input = creativeFixture();
        Object.assign(input.policyPacks[0].generationDefaults!, { creativeBrief: { people: "child" } });
        expect(() => parsePolicyCatalog(input, origin)).toThrow();
        const badVersion = creativeFixture();
        Object.assign(badVersion.policyPacks[0], { creativeLibraryVersion: 2 });
        expect(() => parsePolicyCatalog(badVersion, origin)).toThrow();
        const detail = creativeFixture();
        detail.policyPacks[0].requirementPresets.find((preset) => preset.recipeRole === "detail")!.creativeBrief!.people = "adult-full";
        expect(() => parsePolicyCatalog(detail, origin)).toThrow();
    });
    it("does not migrate legacy catalogs or add creative defaults", () => {
        const legacy = fixture();
        const parsed = parsePolicyCatalog(legacy, origin);
        expect(parsed).toEqual(legacy);
        expect(parsed.policyPacks[0]).not.toHaveProperty("creativeLibraryVersion");
        for (const preset of parsed.policyPacks[0].requirementPresets) {
            expect(preset).not.toHaveProperty("creativeBrief");
            expect(preset).not.toHaveProperty("recipeRole");
            expect(preset).not.toHaveProperty("generationStrategy");
        }
    });
});

describe("public policy catalog", () => {
    it("round trips optional visual fields without reclassifying legacy requirements", () => {
        const input = fixture();
        const preset = input.policyPacks[0].requirementPresets[0];
        preset.visualMode = "white-layout";
        preset.visualKind = "detail";
        expect(parsePolicyCatalog(input, origin)).toEqual(input);
        delete preset.visualMode;
        delete preset.visualKind;
        expect(parsePolicyCatalog(input, origin).policyPacks[0].requirementPresets[0]).toEqual(preset);
    });
    it.each([["visualMode", "automatic"], ["visualKind", "marketing"], ["visualMode", null], ["visualKind", 1]])("rejects invalid %s=%s", (key, value) => {
        const input = fixture();
        Object.assign(input.policyPacks[0].requirementPresets[0], { [key]: value });
        expect(() => parsePolicyCatalog(input, origin)).toThrow();
    });
    it("loads a fresh catalog, keeps inner IDs and excludes unrelated envelope state", () => {
        const input = fixture();
        const result = parsePolicyCatalog({ ...input, owner: { pinHash: "never" }, jobs: [], modelRoles: {} }, origin);
        expect(result).toEqual(input);
        expect(result.policyPacks[0].rules[0].id).toBe(input.policyPacks[0].rules[0].id);
    });
    it("appends once, never overwrites a cached ID, and only retires obsolete server packs", () => {
        const old = fixture(2).policyPacks[0]; const incoming = fixture().policyPacks;
        const privatePack = { ...createBuiltInPolicyPack(), id: "private", version: 10 };
        const before = [old, privatePack, createBuiltInPolicyPack()];
        const merged = mergePolicyCatalog(before, incoming);
        expect(merged[0]).toEqual({ ...old, status: "retired" });
        expect(merged[0].rules).toBe(old.rules);
        expect(merged[1]).toBe(privatePack);
        expect(mergePolicyCatalog(merged, [{ ...incoming[0], name: "unexpected replacement" }])).toEqual(merged);
        expect(merged.filter((p) => p.status === "published").sort((a, b) => b.version - a.version)[0]).toBe(privatePack);
    });
    it.each(["https://evil.test/public-rules/catalog.json", "https://user:pass@example.test/public-rules/catalog.json", "javascript:alert(1)", "//evil.test/public-rules/a", "/private/a", "/public-rules/../private/a", "/public-rules/%2e%2e/private/a", "/public-rules/a?token=secret"])('rejects unsafe catalog URL %s', (url) => {
        expect(() => publicRulesUrl(url, origin)).toThrow();
    });
    it.each(["https://evil.test/a.png", "data:image/png;base64,AA", "blob:https://example.test/a", "/public-rules/other.png", "/public-rules/releases/old/images/" + "a".repeat(64) + ".png"])('rejects unsafe reference %s', (url) => {
        const input = fixture(); input.policyPacks[0].references[0].url = url;
        expect(() => parsePolicyCatalog(input, origin)).toThrow();
    });
    it("rejects private namespaces, drafts, storage keys, malformed arrays, enums and counts", () => {
        for (const mutate of [
            (p: any) => { p.id = "private"; }, (p: any) => { p.status = "draft"; },
            (p: any) => { p.references[0].storageKey = "private-key"; },
            (p: any) => { p.rules = {}; }, (p: any) => { p.rules[0].severity = "UNKNOWN"; },
            (p: any) => { p.requirementPresets[0].defaultCount = 100; },
        ]) { const input = fixture(); mutate(input.policyPacks[0]); expect(() => parsePolicyCatalog(input, origin)).toThrow(); }
    });
    it("reactivates a cached server version on catalog rollback without replacing its contents", () => {
        const original = fixture(2).policyPacks[0];
        const newer = fixture(3).policyPacks[0];
        const privatePack = { ...createBuiltInPolicyPack(), id: "private-retired", status: "retired" as const };
        const advanced = mergePolicyCatalog([original, privatePack, createBuiltInPolicyPack()], [newer]);
        expect(advanced[0].status).toBe("retired");
        const rolledBack = mergePolicyCatalog(advanced, [{ ...original, name: "must not replace cached content", rules: [] }]);
        expect(rolledBack[0]).toEqual(original);
        expect(rolledBack[0].rules).toBe(original.rules);
        expect(rolledBack[1]).toBe(privatePack);
        expect(rolledBack.find((pack) => pack.id === newer.id)?.status).toBe("retired");
        expect(rolledBack.filter((pack) => pack.status === "published").sort((a, b) => b.version - a.version)[0].id).toBe(original.id);
        expect(mergePolicyCatalog(rolledBack, [original])).toEqual(rolledBack);
    });
    it("requires retry after first-load failure but permits cached offline catalogs", () => {
        expect(catalogBlocksNewJob({ phase: "error" }, [createBuiltInPolicyPack()])).toBe(true);
        expect(catalogBlocksNewJob({ phase: "error" }, fixture().policyPacks)).toBe(false);
        expect(catalogBlocksNewJob({ phase: "loading" }, fixture().policyPacks)).toBe(true);
        expect(catalogBlocksNewJob({ phase: "disabled" }, [])).toBe(false);
    });
    it("uses only anonymous GET with no redirects and reports load failures", async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => fixture() }); vi.stubGlobal("fetch", fetcher);
        await expect(fetchPolicyCatalog("/public-rules/catalog.json", origin)).resolves.toMatchObject({ schemaVersion: 1 });
        expect(fetcher).toHaveBeenCalledWith(origin + "/public-rules/catalog.json", expect.objectContaining({ method: "GET", credentials: "omit", redirect: "error" }));
        fetcher.mockResolvedValue({ ok: false, status: 503 });
        await expect(fetchPolicyCatalog("/public-rules/catalog.json", origin)).rejects.toThrow("503");
    });
    it("aborts slow browser requests with an actionable timeout", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))))));
        const result = expect(fetchPolicyCatalog("/public-rules/catalog.json", origin, 100)).rejects.toThrow("超时");
        await vi.advanceTimersByTimeAsync(100); await result;
    });
});
