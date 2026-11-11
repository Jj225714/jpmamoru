import { describe, expect, it } from "vitest";

import { createBuiltInPolicyPack } from "@/lib/commerce/defaults";
import { createCreativeRequirementPresets } from "@/lib/commerce/creative-presets";
import { normalizeGenerationConfig } from "@/lib/commerce/generation-config";
import { clonePolicy, policyChanges, policyEntryMatches, preparePolicySave, requiresPolicyReview, synchronizePolicyTemplates, validatePolicyEdit } from "@/lib/commerce/policy-editor";
import type { PolicyPack } from "@/types/commerce";

function fixture(status: PolicyPack["status"] = "draft"): PolicyPack {
    const pack = clonePolicy(createBuiltInPolicyPack());
    pack.requirementPresets.forEach((preset) => { if (preset.stage === "marketing") preset.needsReview = true; });
    return { ...pack, id: "imported", version: 3, status,
        references: [{ id: "ref-1", name: "参考", url: "https://example.com/image.png", source: "rule-reference", sheet: "Sheet1", anchor: "A1", kind: "reference" }],
        siteReferences: [{ id: "site-1", product: "地毯", locale: "th-TH", url: "https://example.com", referenceIds: ["ref-1"] }] };
}
function save(base: PolicyPack, edited = clonePolicy(base), extras: Partial<Parameters<typeof preparePolicySave>[0]> = {}) {
    return preparePolicySave({ packs: [base], base, edited, publish: false, actor: "负责人", newId: "next-id", auditId: "audit-id", now: "2026-09-16T15:00:00.000Z", ...extras });
}

describe("policy editor versions", () => {
    it.each(["published", "retired"] as const)("clones %s packs with max version + 1 and stable entry IDs", (status) => {
        const base = fixture(status); const before = clonePolicy(base); const edited = clonePolicy(base);
        edited.rules[0].title = "修改后的规则";
        const result = save(base, edited, { packs: [base, { ...fixture(), id: "other-draft", version: 12 }] });
        expect(result.saved).toMatchObject({ id: "next-id", version: 13, status: "draft" });
        expect(result.saved.rules.map((r) => r.id)).toEqual(base.rules.map((r) => r.id));
        expect(result.policyPacks.find((p) => p.id === base.id)).toEqual(before);
        expect(base).toEqual(before);
        expect(result.audit.detail).toContain("规则：1 项变更");
    });
    it("always clones the built-in pack even if its status is draft", () => {
        const base = fixture(); base.id = "builtin-sea-home";
        expect(save(base).saved.id).toBe("next-id");
    });
    it("updates an unreferenced draft in place", () => {
        const base = fixture(); const result = save(base);
        expect(result.saved.id).toBe(base.id); expect(result.saved.version).toBe(3);
        expect(result.policyPacks).toHaveLength(1); expect(result.saved.createdAt).toBe(base.createdAt);
        expect(result.saved.publishedAt).toBeUndefined();
    });
    it("protects a draft already referenced by a job", () => {
        const base = fixture(); const result = save(base, clonePolicy(base), { referenced: true });
        expect(result.saved.id).toBe("next-id"); expect(result.policyPacks).toContain(base);
    });
    it("publishes, retires the previous active pack and creates one audit together", () => {
        const base = fixture("published"); const builtin = createBuiltInPolicyPack();
        const result = save(base, clonePolicy(base), { publish: true, packs: [base, builtin] });
        expect(result.saved.status).toBe("published");
        expect(result.saved.publishedAt).toBe(result.audit.createdAt);
        expect(result.policyPacks.find((p) => p.id === base.id)?.status).toBe("retired");
        expect(result.policyPacks.find((p) => p.id === builtin.id)?.status).toBe("published");
        expect(result.audit).toMatchObject({ action: "编辑并发布规则版本", actor: "负责人", policyPackId: result.saved.id });
        expect(base.status).toBe("published");
    });
    it("rejects stale or missing sources and conflicting generated IDs", () => {
        const base = fixture("published");
        expect(() => save(base, base, { packs: [{ ...base, name: "changed elsewhere" }] })).toThrow("其他操作");
        expect(() => save(base, base, { packs: [] })).toThrow("其他操作");
        expect(() => save(base, base, { newId: base.id })).toThrow("ID 冲突");
    });
});

describe("policy editor compatibility and validation", () => {
    it("synchronizes every compatibility field without adding entries or mutating inputs", () => {
        const base = fixture(); const draft = clonePolicy(base);
        const preset = draft.requirementPresets.find((p) => p.id === draft.templates[0].id)!;
        Object.assign(preset, { title: "新标题", category: "新类目", order: 8, stage: "detail-white", prompt: "新要求", chineseCopy: "新文案", translationSeeds: { "th-TH": "ไทย" }, requiredFacts: ["尺寸"], referenceIds: ["ref-1"] });
        const result = synchronizePolicyTemplates(draft);
        expect(result.templates[0]).toMatchObject({ id: base.templates[0].id, title: "新标题", category: "新类目", order: 8, slot: "detail", requirement: "新要求", chineseCopy: "新文案", translationSeeds: { "th-TH": "ไทย" }, requiredVariables: ["尺寸"], referenceIds: ["ref-1"] });
        expect(result.templates).toHaveLength(base.templates.length);
        expect(draft.templates[0]).toEqual(base.templates[0]);
        expect(validatePolicyEdit(base, result)).toEqual([]);
    });
    it("preserves standalone legacy templates", () => {
        const base = fixture(); base.templates.push({ ...base.templates[0], id: "legacy-only" });
        const draft = clonePolicy(base); draft.templates.at(-1)!.requirement = "独立要求";
        expect(synchronizePolicyTemplates(draft).templates.at(-1)!.requirement).toBe("独立要求");
    });
    it("summarizes all editable sections", () => {
        const base = fixture(); const edited = clonePolicy(base);
        edited.profiles[0].audience = "new"; edited.siteReferences[0].note = "new";
        edited.references[0].name = "new"; edited.globalStandards.push("新标准");
        edited.watermarkOpacityRange = [0.1, 0.2]; edited.generationDefaults = { marketingEnabled: false };
        expect(policyChanges(base, edited)).toEqual(expect.arrayContaining(["国家配置：1 项变更", "站点参考：1 项变更", "参考图：1 项变更", "全局标准已修改", "生成默认值已修改", "水印范围已修改"]));
    });
    it("rejects entry insertion, removal and ID changes", () => {
        const base = fixture(); const edited = clonePolicy(base);
        edited.rules.pop(); edited.profiles.push({ ...edited.profiles[0] }); edited.requirementPresets[0].id = "new-id";
        const errors = validatePolicyEdit(base, edited).join(";");
        expect(errors).toContain("规则不能删除、重排或更换已有 ID");
        expect(errors).toContain("国家配置不能删除、重排或更换已有 ID");
        expect(errors).toContain("需求方案不能删除、重排或更换已有 ID");
    });
    it("rejects invalid fields and dangling references before saving", () => {
        const base = fixture(); const edited = clonePolicy(base);
        edited.name = " "; edited.rules[0].priority = NaN; edited.requirementPresets[0].defaultCount = 5;
        edited.requirementPresets[0].referenceIds = ["missing"];
        edited.siteReferences[0].url = "javascript:alert(1)"; edited.watermarkOpacityRange = [0.8, 0.1];
        expect(validatePolicyEdit(base, edited).length).toBeGreaterThanOrEqual(6);
        expect(() => save(base, edited)).toThrow("不能为空");
    });
    it("validates numeric defaults without silently clamping user input", () => {
        const base = fixture(); const edited = clonePolicy(base);
        edited.generationDefaults = normalizeGenerationConfig();
        edited.generationDefaults.assetCounts!.scene = 1.5;
        edited.generationDefaults.overlay!.watermark.opacity = 0.8;
        expect(validatePolicyEdit(base, edited).join(";")).toContain("默认图片数量");
        expect(validatePolicyEdit(base, edited)).toContain("默认水印透明度超出规则范围");
        edited.generationDefaults.assetCounts!.scene = 2; edited.watermarkOpacityRange = [0.03, 0.3];
        edited.generationDefaults.overlay!.watermark.opacity = 0.03;
        expect(validatePolicyEdit(base, edited)).toEqual([]);
    });
    it("rejects replacing reference assets and changing version metadata", () => {
        const base = fixture(); const edited = clonePolicy(base);
        edited.references[0].url = "https://example.com/other.png"; edited.version = 99;
        expect(validatePolicyEdit(base, edited)).toContain("不能修改版本标识或状态");
        expect(validatePolicyEdit(base, edited)).toContain("参考图素材不可替换，只能修改关联和说明");
    });
});

describe("creative policy append compatibility", () => {
    it("allows appending optional advanced recipes with default off and preserves existing entries", () => {
        const base = fixture("published");
        const before = clonePolicy(base);
        const edited = clonePolicy(base);
        const advanced = createCreativeRequirementPresets().filter((preset) => !preset.enabledByDefault);
        expect(advanced).toHaveLength(16);
        edited.requirementPresets.push(...advanced);
        edited.generationDefaults = { creativeBrief: { scene: "书桌", lighting: "natural-window", people: "none", framing: "wide" } };
        expect(validatePolicyEdit(base, edited)).toEqual([]);
        const result = save(base, edited);
        expect(result.saved.requirementPresets.slice(0, base.requirementPresets.length)).toEqual(base.requirementPresets);
        expect(result.saved.requirementPresets.slice(base.requirementPresets.length)).toEqual(advanced);
        expect(result.saved.requirementPresets.slice(base.requirementPresets.length).every((preset) => !preset.enabledByDefault)).toBe(true);
        expect(result.saved.templates).toEqual(base.templates);
        expect(result.policyPacks.find((pack) => pack.id === base.id)).toEqual(before);
        expect(base).toEqual(before);
    });
    it.each(["remove", "reorder", "prepend", "duplicate"])("forbids %s of existing presets even when additions are permitted", (operation) => {
        const base = fixture(); const edited = clonePolicy(base);
        if (operation === "remove") edited.requirementPresets.pop();
        if (operation === "reorder") [edited.requirementPresets[0], edited.requirementPresets[1]] = [edited.requirementPresets[1], edited.requirementPresets[0]];
        if (operation === "prepend") edited.requirementPresets.unshift(createCreativeRequirementPresets()[4]);
        if (operation === "duplicate") edited.requirementPresets.push({ ...edited.requirementPresets[0] });
        expect(validatePolicyEdit(base, edited).join(";")).toContain(operation === "duplicate" ? "ID 重复" : "不能删除、重排或更换已有 ID");
        expect(() => save(base, edited)).toThrow();
    });
    it.each(["rules", "templates", "references", "siteReferences", "profiles"] as const)("still forbids appending to %s", (section) => {
        const base = fixture(); const edited = clonePolicy(base);
        Object.assign(edited, { [section]: [...edited[section], { ...edited[section][0], id: "new-entry" }] });
        expect(validatePolicyEdit(base, edited).join(";")).toContain("不能删除、重排或更换已有 ID");
    });
    it("validates the actual 32-recipe library without rewriting legacy templates", () => {
        const pack = fixture();
        pack.creativeLibraryVersion = 1;
        pack.requirementPresets = createCreativeRequirementPresets();
        expect(validatePolicyEdit(pack, clonePolicy(pack))).toEqual([]);
        expect(synchronizePolicyTemplates(pack).templates).toEqual(pack.templates);
    });
    it.each([
        { creativeBrief: { lighting: "invalid" } }, { creativeBrief: { people: "adult-half" } },
        { creativeBrief: { framing: "invalid" } }, { creativeBrief: { scene: "x".repeat(2001) } },
        { generationStrategy: "invalid" }, { recipeRole: "invalid" },
        { stage: "scene" }, { layout: "single-hero" }, { visualMode: "white-layout" },
    ])("rejects malformed appended paired recipe %#", (patch) => {
        const base = fixture(); const edited = clonePolicy(base);
        const pair = createCreativeRequirementPresets().find((preset) => preset.recipeRole === "before-after")!;
        Object.assign(pair, patch);
        edited.requirementPresets.push(pair);
        expect(validatePolicyEdit(base, edited).length).toBeGreaterThan(0);
        expect(() => save(base, edited)).toThrow();
    });
});

describe("policy editor review corrections", () => {
    it("explains automatic review marking separately from user edits without changing the source", () => {
        const base = fixture(); const preset = base.requirementPresets.find((item) => item.stage === "marketing")!;
        preset.needsReview = false;
        const next = synchronizePolicyTemplates(base, base);
        expect(policyChanges(base, next)).toContain("需求方案：1 项变更（含 1 项自动补充待校对标记，保存后生效）");
        expect(preset.needsReview).toBe(false);
    });
    it.each([[0, 0.3], [0.03, 1], [0.2, 0.1]])("rejects watermark bounds %j", (min, max) => {
        const base = fixture(); const edited = clonePolicy(base); edited.watermarkOpacityRange = [min, max];
        expect(validatePolicyEdit(base, edited)).toContain("水印范围须满足 3% ≤ 最小值 ≤ 最大值 ≤ 30%");
    });
    it("locks incomplete or mixed-language marketing copy to review", () => {
        const base = fixture(); const edited = clonePolicy(base); const preset = edited.requirementPresets.find((item) => item.stage === "marketing")!;
        preset.needsReview = false;
        expect(requiresPolicyReview(preset)).toBe(true);
        expect(validatePolicyEdit(base, edited).join(";")).toContain("必须保留待校对标记");
        expect(save(base, edited).saved.requirementPresets.find((item) => item.id === preset.id)?.needsReview).toBe(true);
        preset.translationSeeds = { "en-US": "English", "th-TH": "ไทย", "vi-VN": "Việt", "ms-MY": "Melayu", "fil-PH": "Filipino", "id-ID": "Indonesia" };
        preset.chineseCopy = "中文";
        expect(requiresPolicyReview(preset)).toBe(false);
        preset.translationSeeds["en-US"] = "TODO";
        expect(requiresPolicyReview(preset)).toBe(true);
        preset.translationSeeds["en-US"] = "English"; preset.chineseCopy = "中文 English";
        expect(requiresPolicyReview(preset)).toBe(true);
    });
    it.each(["chineseCopy", "translationSeeds"] as const)("automatically reopens review on %s edits, even if the caller clears the flag", (field) => {
        const base = fixture(); const original = base.requirementPresets[0]; original.needsReview = false;
        const edited = clonePolicy(base);
        if (field === "chineseCopy") edited.requirementPresets[0].chineseCopy = "新文案";
        else edited.requirementPresets[0].translationSeeds["en-US"] = "Changed copy";
        expect(synchronizePolicyTemplates(edited, base).requirementPresets[0].needsReview).toBe(true);
        expect(save(base, edited).saved.requirementPresets[0].needsReview).toBe(true);
        expect(original.needsReview).toBe(false);
    });
    it("permits clearing review only once complete copy is saved and unchanged", () => {
        const base = fixture(); const preset = base.requirementPresets.find((item) => item.stage === "marketing")!;
        preset.chineseCopy = "中文文案";
        preset.translationSeeds = { "en-US": "English", "th-TH": "ไทย", "vi-VN": "Việt", "ms-MY": "Melayu", "fil-PH": "Filipino", "id-ID": "Indonesia" };
        const edited = clonePolicy(base); edited.requirementPresets.find((item) => item.id === preset.id)!.needsReview = false;
        expect(save(base, edited).saved.requirementPresets.find((item) => item.id === preset.id)?.needsReview).toBe(false);
    });
    it("filters countries and categories while retaining generic rules and presets", () => {
        const pack = fixture();
        expect(policyEntryMatches("profiles", { countryCode: "TH" }, pack, "ID")).toBe(false);
        expect(policyEntryMatches("rules", { countries: ["TH"], categories: ["灯具"] }, pack, "TH", "灯具")).toBe(true);
        expect(policyEntryMatches("rules", { countries: ["TH"], categories: ["灯具"] }, pack, "TH", "地毯")).toBe(false);
        expect(policyEntryMatches("rules", { countries: [], categories: [] }, pack, "TH", "地毯")).toBe(true);
        expect(policyEntryMatches("requirementPresets", { category: "通用" }, pack, "TH", "地毯")).toBe(true);
        expect(policyEntryMatches("siteReferences", { locale: "id-ID" }, pack, "TH")).toBe(false);
        expect(policyEntryMatches("siteReferences", {}, pack, "TH")).toBe(true);
    });
    it("shows only unpaired marketing templates", () => {
        const pack = fixture();
        expect(policyEntryMatches("templates", { ...pack.templates[0] }, pack)).toBe(false);
        expect(policyEntryMatches("templates", { ...pack.templates[0], id: "legacy-only" }, pack)).toBe(true);
    });
    it.each([0, 20, 50, 90, 100])("accepts priority %i including all importer-assigned values", (priority) => {
        const base = fixture(); const edited = clonePolicy(base); edited.rules[0].priority = priority;
        expect(validatePolicyEdit(base, edited)).toEqual([]);
    });
});
