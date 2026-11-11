import { expect, it, vi } from "vitest";
import type { PolicyPack } from "@/types/commerce";
const teamState = vi.hoisted(() => ({ policyPacks: [] as PolicyPack[], brands: [], jobs: [{ id: "historical-job", policyPackId: "old" }], teamPolicyPackId: "", teamRevision: 0 }));
vi.mock("@/i18n", () => ({ default: {}, changeAppLocale: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({ defaultConfig: {}, defaultWebdavSyncConfig: {}, normalizePersonalConfig: (value: unknown) => value, useConfigStore: {} }));
vi.mock("@/stores/use-commerce-store", () => ({ useCommerceStore: { persist: { hasHydrated: () => true }, setState: (update: (state: typeof teamState) => Partial<typeof teamState>) => Object.assign(teamState, update(teamState)) } }));
vi.mock("@/stores/use-prompt-source-store", () => ({ usePromptSourceStore: {} }));
vi.mock("@/stores/use-theme-store", () => ({ useThemeStore: {} }));
vi.mock("@/services/image-storage", () => ({ getImageBlob: vi.fn() }));
import { applyTeamSettings } from "@/services/settings-data";
import { createBuiltInPolicyPack } from "./defaults";
import { addSmallGlassMousePad, createCategorySeedPack, SMALL_GLASS_MOUSE_PAD_ID } from "./category-seed";
import { categoryPreflightErrors, categoryRequirements, resolveCategory, validateCategories } from "./category-rules";
import { parsePolicyCatalog } from "@/services/commerce-policy-catalog";

const product = { category: "桌垫类", categoryId: "table-mats", subcategoryId: SMALL_GLASS_MOUSE_PAD_ID };
const base = () => createCategorySeedPack(createBuiltInPolicyPack());

it("reads the new category from a locally simulated team publication while retaining old task rules", async () => {
    const original = base(); original.id = "old";
    teamState.policyPacks = [original];
    const published = addSmallGlassMousePad(original);
    published.categories!.find((node) => node.id === SMALL_GLASS_MOUSE_PAD_ID)!.active = true; // Simulate a future explicit administrator action only.
    published.id = "server-aoweisi-team-v16-local";
    published.status = "published"; published.version = 16;
    await applyTeamSettings(JSON.parse(JSON.stringify({ policyPack: published, brands: [] })), 16);
    expect(teamState.teamPolicyPackId).toBe(published.id);
    expect(categoryRequirements(teamState.policyPacks[0], product)).toHaveLength(3);
    expect(teamState.policyPacks.find((pack) => pack.id === "old")).toEqual(original);
    expect(teamState.jobs[0].policyPackId).toBe("old");
});

it("adds an editable child with independent glass recipes while preserving existing IDs and history", () => {
    const original = base(), snapshot = JSON.stringify(original);
    const draft = addSmallGlassMousePad(original);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(draft.categories!.slice(0, original.categories!.length)).toEqual(original.categories);
    expect(draft.requirementPresets.slice(0, original.requirementPresets.length)).toEqual(original.requirementPresets);
    expect(resolveCategory(original, product)).toBeUndefined();
    expect(resolveCategory(draft, product)?.node).toMatchObject({ id: SMALL_GLASS_MOUSE_PAD_ID, parentId: "table-mats", active: false });
    expect(categoryPreflightErrors(draft, product)).toContain("所选类目已停用，请重新选择");
    expect(categoryRequirements(draft, product)).toHaveLength(3);
    expect(validateCategories(draft)).toEqual([]);
});

it("inherits desktop constraints but excludes textile-only parent requirements and does not invent dimensions", () => {
    const original = base();
    original.categories!.find((node) => node.id === "table-mats")!.rules.push(
        { id: "desktop", text: "桌面场景保持真实比例", strength: "required", stages: ["scene"] },
        { id: "fabric", text: "展示布料吸水及包边", strength: "required", stages: ["scene", "detail"] },
    );
    const draft = addSmallGlassMousePad(original);
    const resolved = resolveCategory(draft, product)!;
    expect(resolved.rules.map((rule) => rule.id)).toContain("desktop");
    expect(resolved.rules.map((rule) => rule.id)).not.toContain("fabric");
    expect(resolveCategory(draft, { ...product, subcategoryId: "large-mouse-pad" })!.rules.map((rule) => rule.id)).toContain("fabric");
    const text = categoryRequirements(draft, product).map((recipe) => recipe.prompt).join();
    expect(text).toContain("尺寸仅采用商品资料");
    expect(text).not.toMatch(/\d+\s*(cm|mm|厘米|毫米)/i);
    expect(text).not.toMatch(/展示布料|展示吸水|展示包边/);
});

it("retains administrator edits through save/reopen and repeated additions", () => {
    const draft = addSmallGlassMousePad(base());
    categoryRequirements(draft, product)[0].prompt = "管理员自定义桌面场景";
    const reopened = createCategorySeedPack(JSON.parse(JSON.stringify(draft)));
    expect(categoryRequirements(reopened, product)[0].prompt).toBe("管理员自定义桌面场景");
    expect(addSmallGlassMousePad(reopened)).toEqual(reopened);
});

it("round trips a simulated published catalog through the client reader", () => {
    const draft = addSmallGlassMousePad(base());
    const revision = "aoweisi-v3-abcdef012345";
    const publishedAt = "2026-10-25T00:00:00Z";
    draft.categories!.find((node) => node.id === SMALL_GLASS_MOUSE_PAD_ID)!.active = true; // Explicit activation for this simulated publication.
    draft.id = "server-aoweisi-original-v3-abcdef012345";
    draft.version = 3; draft.status = "published"; draft.publishedAt = publishedAt;
    draft.references.forEach((ref) => { ref.url = `/public-rules/releases/${revision}/images/${"a".repeat(64)}.png`; });
    const result = parsePolicyCatalog(JSON.parse(JSON.stringify({ schemaVersion: 1, revision, publishedAt, policyPacks: [draft] })), "https://example.test").policyPacks[0];
    expect(categoryPreflightErrors(result, product)).toEqual([]);
    expect(categoryRequirements(result, product)).toEqual(categoryRequirements(draft, product));
    expect(resolveCategory(result, product)?.node.source?.fileName).toContain("用户需求");
});
