import { nanoid } from "nanoid";
import { categoryRequirements } from "@/lib/commerce/category-rules";
import { invalidateCategoryInputs, mapProductCategory } from "@/lib/commerce/category-input-state";
import { getCommercePolicyCatalogUrl } from "@/constant/runtime-config";
import { catalogBlocksNewJob, fetchPolicyCatalog, mergePolicyCatalog, SERVER_POLICY_PREFIX, type CatalogStatus } from "@/services/commerce-policy-catalog";
import { create, type StateCreator } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { createBuiltInPolicyPack, createDefaultBrand, defaultModelRoles } from "@/lib/commerce/defaults";
import { cloneGenerationConfig, createRequirementSelections, DEFAULT_BRAND_GENERATION_DEFAULTS, DEFAULT_COMMERCE_GENERATION_CONFIG, GENERATION_ASSET_STAGES, normalizeGenerationConfig, normalizeLocales } from "@/lib/commerce/generation-config";
import { localForageStorage } from "@/lib/localforage-storage";
import { clonePolicy, preparePolicySave } from "@/lib/commerce/policy-editor";
import { correctedPresetVisual } from "@/lib/commerce/requirement-visuals";
import { createCreativeRequirementPresets } from "@/lib/commerce/creative-presets";
import { adoptProductSuggestion, productSuggestionFingerprint, resolveProductUncertainty } from "@/lib/commerce/product-suggestions";
import type { AuditEvent, BrandProfile, CommerceGenerationConfig, CommerceJob, CommerceLocale, CommerceProductInformation, CommerceProductSuggestion, CommerceRequirementPreset, CommerceSku, GeneratedAsset, ModelRoleConfig, OwnerProfile, PolicyPack, ProductRecord, RequirementSelection } from "@/types/commerce";

type CommerceStore = {
    teamPolicyPackId?: string;
    teamRevision?: number;
    teamBrandIds: string[];
    hydrated: boolean;
    catalogStatus: CatalogStatus;
    loadServerCatalog: (retry?: boolean) => Promise<void>;
    jobs: CommerceJob[];
    brands: BrandProfile[];
    policyPacks: PolicyPack[];
    modelRoles: ModelRoleConfig;
    owner?: OwnerProfile;
    operatorName: string;
    audit: AuditEvent[];
    createJob: (input: { name: string; products: ProductRecord[]; platform?: CommerceJob["platform"]; brandProfileId?: string; locales?: CommerceLocale[]; generationConfig?: CommerceGenerationConfig }) => string;
    updateJob: (jobId: string, patch: Partial<Omit<CommerceJob, "id" | "createdAt">>) => void;
    updateJobGenerationConfig: (jobId: string, input: { locales: CommerceLocale[]; generationConfig: CommerceGenerationConfig }) => void;
    upgradeJobVisualPipeline: (jobId: string) => void;
    createCreativeJobCopy: (jobId: string) => string;
    saveProductSuggestion: (jobId: string, skuId: string, draft: CommerceProductSuggestion) => void;
    resolveProductUncertainty: (jobId: string, skuId: string, draft: CommerceProductSuggestion, item: string, resolution?: import("@/types/commerce").CommerceUncertaintyResolution) => void;
    applyProductSuggestion: (jobId: string, skuId: string, draft: CommerceProductSuggestion, fields: Array<keyof CommerceProductInformation>, replaceExisting: boolean) => void;
    updateRequirementSelection: (jobId: string, skuId: string, requirementId: string, patch: Partial<RequirementSelection>) => void;
    updateSkuFacts: (jobId: string, skuId: string, patch: Pick<Partial<ProductRecord>, "verifiedFacts" | "factsConfirmed">) => void;
    updateSku: (jobId: string, skuId: string, updater: Partial<CommerceSku> | ((sku: CommerceSku) => CommerceSku)) => void;
    removeJob: (jobId: string) => void;
    addPolicyPack: (pack: PolicyPack) => void;
    savePolicyEdit: (input: { base: PolicyPack; edited: PolicyPack; publish: boolean; pin: string }) => Promise<PolicyPack>;
    publishPolicyPack: (id: string) => void;
    retirePolicyPack: (id: string) => void;
    addBrand: (brand: BrandProfile) => void;
    updateBrand: (id: string, patch: Partial<BrandProfile>) => void;
    updateModelRoles: (patch: Partial<ModelRoleConfig>) => void;
    setOwner: (owner: OwnerProfile) => void;
    setOperatorName: (name: string) => void;
    addAudit: (event: Omit<AuditEvent, "id" | "createdAt">) => void;
};

const STORE_KEY = "infinite-canvas:commerce_store";
const builtInPack = createBuiltInPolicyPack();
const defaultBrand = createDefaultBrand();

const storage: PersistStorage<CommerceStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        return value ? (JSON.parse(value) as StorageValue<CommerceStore>) : null;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCommerceStore = create<CommerceStore>()(
    ((rawSet, get, api) => persist<CommerceStore>(
        (set) => ({
            hydrated: false,
            teamBrandIds: [],
            catalogStatus: { phase: "idle" },
            loadServerCatalog: async (retry = false) => {
                const state = useCommerceStore.getState();
                if (!state.hydrated) {
                    if (retry && state.catalogStatus.phase === "error") await useCommerceStore.persist.rehydrate();
                    return;
                }
                if (state.catalogStatus.phase === "loading" || (!retry && state.catalogStatus.phase !== "idle")) return;
                const url = getCommercePolicyCatalogUrl();
                // Transient status never needs a storage write (including storage failure reports).
                const status = (catalogStatus: CatalogStatus) => {
                    rawSet({ catalogStatus });
                };
                if (!url) { status({ phase: "disabled" }); return; }
                status({ phase: "loading" });
                try {
                    const catalog = await fetchPolicyCatalog(url, window.location.origin);
                    const persistSet = set as (updater: (state: CommerceStore) => Partial<CommerceStore>) => unknown;
                    await persistSet((current) => ({ policyPacks: mergePolicyCatalog(current.policyPacks, catalog.policyPacks) }));
                    status({ phase: "success", count: catalog.policyPacks.reduce((sum, pack) => sum + pack.requirementPresets.length, 0), revision: catalog.revision });
                } catch (error) {
                    const cached = useCommerceStore.getState().policyPacks.some((pack) => pack.id.startsWith(SERVER_POLICY_PREFIX));
                    status({ phase: "error", error: `${error instanceof Error ? error.message : "公共规则加载失败"}；${cached ? "可使用已缓存规则创建任务，也可重试。" : "请重试加载后再创建任务，历史任务仍可查看。"}` });
                }
            },
            jobs: [],
            brands: [defaultBrand],
            policyPacks: [builtInPack],
            modelRoles: defaultModelRoles,
            operatorName: "操作员",
            audit: [],
            createJob: ({ name, products, platform = "shopee", brandProfileId, locales, generationConfig }) => {
                const id = nanoid();
                const createdAt = new Date().toISOString();
                const state = useCommerceStore.getState();
                if (!state.hydrated) throw new Error("本地任务尚未就绪，请到规则与品牌重试读取后创建任务");
                if (!state.teamPolicyPackId && getCommercePolicyCatalogUrl() && (!state.hydrated || catalogBlocksNewJob(state.catalogStatus, state.policyPacks))) throw new Error("公共规则尚未就绪，请到规则与品牌重试加载后创建任务");
                const { activePack, policyPacks } = selectCreativePolicy(state.policyPacks);
                const brandChoices = state.teamPolicyPackId ? state.brands.filter((item) => state.teamBrandIds.includes(item.id)) : state.brands.filter((item) => !item.id.startsWith("server-brand-") && !item.id.startsWith("team-brand-"));
                const brand = brandChoices.find((item) => item.id === brandProfileId) || brandChoices[0] || createDefaultBrand();
                const selectedConfig = normalizeGenerationConfig(mergeConfig(activePack?.generationDefaults, brand?.generationDefaults, generationConfig), activePack?.watermarkOpacityRange);
                const selectedLocales = normalizeLocales(locales || brand?.generationDefaults.locales);
                const skus: CommerceSku[] = products.map((inputProduct) => {
                    const product = mapProductCategory(activePack, inputProduct);
                    const presets = activePack.categories?.length ? categoryRequirements(activePack, product) : recommendedRequirements(activePack, product.category);
                    if (!presets.length && !activePack.categories?.length) throw new Error("“" + product.category + "”没有可用推荐方案，请确认内部类目映射或先添加该类目的方案");
                    const requirementSelections = createRequirementSelections(presets, currentBrandRequirementDefaults(brand?.requirementDefaultsByCategory?.[product.category], activePack, state.policyPacks));
                    const selectedTemplateIds = selectedConfig.marketingEnabled ? requirementSelections.filter((item) => item.enabled && presets.find((preset) => preset.id === item.requirementId)?.stage === "marketing").map((item) => item.requirementId) : [];
                    return { id: nanoid(), product: structuredClone(product), stage: "draft", assets: [], selectedTemplateIds, requirementSelections, compositions: [], copyZh: {}, localizedCopy: {}, approvals: [], checks: [], activeRevision: 1 };
                });
                const job: CommerceJob = { id, visualPipelineVersion: 3, name: name.trim() || "未命名跨境任务", brandProfileId: brand.id, platform, locales: selectedLocales, generationConfig: cloneGenerationConfig(selectedConfig), policyPackId: activePack?.id, policyVersion: activePack?.version, skus, status: "draft", createdAt, updatedAt: createdAt };
                set((state) => ({ jobs: [job, ...state.jobs], policyPacks, brands: state.brands.some((item) => item.id === brand.id) ? state.brands : [brand, ...state.brands] }));
                return id;
            },
            updateJob: (jobId, patch) => set((state) => ({ jobs: state.jobs.map((job) => (job.id === jobId ? { ...job, ...patch, updatedAt: new Date().toISOString() } : job)) })),
            updateJobGenerationConfig: (jobId, input) => set((state) => ({ jobs: state.jobs.map((job) => job.id !== jobId ? job : applyGenerationConfig(job, input, state.policyPacks)) })),
            upgradeJobVisualPipeline: (jobId) => set((state) => {
                if (!state.jobs.some((job) => job.id === jobId && !job.visualPipelineVersion)) return state;
                const { policyPacks } = selectVisualPolicy(state.policyPacks);
                return { policyPacks, jobs: state.jobs.map((job) => job.id !== jobId || job.visualPipelineVersion ? job : upgradeVisualPipeline(job, policyPacks)) };
            }),
            createCreativeJobCopy: (jobId) => {
                const state = get();
                const original = state.jobs.find((job) => job.id === jobId);
                if (!original) throw new Error("原任务不存在");
                const id = state.createJob({ name: original.name + " · 新推荐方案", products: original.skus.map((sku) => structuredClone(sku.product)), platform: original.platform, brandProfileId: original.brandProfileId, locales: [...original.locales], generationConfig: cloneGenerationConfig(original.generationConfig) });
                set((current) => ({ jobs: current.jobs.map((job) => {
                    if (job.id !== id) return job;
                    const spec = job.generationConfig.outputSpec;
                    const skus = job.skus.map((sku, index): CommerceSku => {
                        const source = original.skus[index];
                        const white = source.assets.find((asset) => asset.stage === "main-white" && asset.revision === source.activeRevision && asset.width === spec.size && asset.height === spec.size && asset.mimeType === (spec.format === "png" ? "image/png" : "image/jpeg") && asset.bytes <= spec.maxBytes);
                        return white ? { ...sku, stage: "white-review", assets: [{ ...white, id: nanoid(), jobId: id, skuId: sku.id, revision: 1, sourceAssetIds: [white.id], visualKey: undefined, visualFingerprint: undefined, createdAt: new Date().toISOString() }], stageMessage: "已复用原任务白底图，请重新审核；原任务未修改" } : sku;
                    });
                    return { ...job, skus, status: deriveJobStatus(skus) };
                }) }));
                get().addAudit({ action: "使用新版方案创建副本", actor: state.operatorName, jobId: id, detail: "原任务 " + jobId });
                return id;
            },
            saveProductSuggestion: (jobId, skuId, draft) => set((state) => ({ jobs: state.jobs.map((job) => job.id !== jobId ? job : { ...job, updatedAt: new Date().toISOString(), skus: job.skus.map((sku) => {
                if (sku.id !== skuId) return sku;
                if (productSuggestionFingerprint(sku.product) !== draft.sourceFingerprint) throw new Error("商品图片或资料已变化，请重新识别");
                return { ...sku, product: { ...sku.product, informationSuggestion: structuredClone(draft) } };
            }) }) })),
            resolveProductUncertainty: (jobId, skuId, draft, item, resolution) => set((state) => ({ jobs: state.jobs.map((job) => {
                if (job.id !== jobId) return job;
                const skus = job.skus.map((sku): CommerceSku => {
                    if (sku.id !== skuId) return sku;
                    const product = resolveProductUncertainty(sku.product, draft, item, resolution);
                    if (JSON.stringify(product.verifiedFacts) === JSON.stringify(sku.product.verifiedFacts)) return { ...sku, product };
                    const whiteApproved = sku.approvals.some((entry) => entry.gate === "white-background" && entry.approved && entry.assetRevision === sku.activeRevision);
                    return { ...sku, product, approvals: sku.approvals.filter((entry) => entry.assetRevision !== sku.activeRevision || entry.gate !== "content"), checks: [], stage: whiteApproved ? "content-generation" : sku.stage, stageMessage: "已确认商品事实，请重新生成并审核受影响图片" };
                });
                return { ...job, skus, status: deriveJobStatus(skus), updatedAt: new Date().toISOString() };
            }) })),
            applyProductSuggestion: (jobId, skuId, draft, fields, replaceExisting) => set((state) => ({ jobs: state.jobs.map((job) => {
                if (job.id !== jobId) return job;
                const skus = job.skus.map((sku): CommerceSku => {
                    if (sku.id !== skuId) return sku;
                    const product = adoptProductSuggestion(sku.product, draft, fields, replaceExisting);
                    const content = (value: ProductRecord) => JSON.stringify([value.name, value.description, value.audience, value.materialDescription, value.usageInstructions]);
                    if (content(product) === content(sku.product)) return { ...sku, product };
                    const approved = sku.approvals.some((item) => item.gate === "white-background" && item.approved && item.assetRevision === sku.activeRevision);
                    return { ...sku, product, assets: sku.assets.filter((asset) => asset.revision !== sku.activeRevision || asset.stage === "main-white"), compositions: sku.compositions.filter((item) => item.revision !== sku.activeRevision), copyZh: {}, localizedCopy: {}, approvals: sku.approvals.filter((item) => item.gate !== "content"), checks: [], stage: approved ? "content-generation" : sku.stage, stageMessage: "已采用商品信息建议，请重新生成受影响画面；未自动确认产品参数" };
                });
                return { ...job, skus, status: deriveJobStatus(skus), updatedAt: new Date().toISOString() };
            }) })),
            updateRequirementSelection: (jobId, skuId, requirementId, patch) => set((state) => ({ jobs: state.jobs.map((job) => {
                if (job.id !== jobId) return job;
                const presets = state.policyPacks.find((pack) => pack.id === job.policyPackId && pack.version === job.policyVersion)?.requirementPresets || [];
                const skus = job.skus.map((sku) => sku.id === skuId ? editRequirementSelection(job, sku, presets, requirementId, patch) : sku);
                return { ...job, skus, status: deriveJobStatus(skus), updatedAt: new Date().toISOString() };
            }) })),
            updateSkuFacts: (jobId, skuId, patch) => set((state) => ({ jobs: state.jobs.map((job) => {
                if (job.id !== jobId) return job;
                const skus = job.skus.map((sku): CommerceSku => {
                    if (sku.id !== skuId) return sku;
                    const product = { ...sku.product, ...patch };
                    if (JSON.stringify(product) === JSON.stringify(sku.product)) return sku;
                    const whiteApproved = sku.approvals.some((item) => item.gate === "white-background" && item.approved && item.assetRevision === sku.activeRevision);
                    return { ...sku, product, approvals: sku.approvals.filter((item) => item.assetRevision !== sku.activeRevision || item.gate !== "content"), checks: [],
                        stage: whiteApproved ? "content-generation" : sku.stage, stageMessage: "产品事实已变更，请重新生成并审核受影响图片" };
                });
                return { ...job, skus, status: deriveJobStatus(skus), updatedAt: new Date().toISOString() };
            }) })),
            updateSku: (jobId, skuId, updater) => set((state) => ({ jobs: state.jobs.map((job) => {
                if (job.id !== jobId) return job;
                const pack = state.policyPacks.find((item) => item.id === job.policyPackId && item.version === job.policyVersion);
                const skus = job.skus.map((sku) => sku.id !== skuId ? sku : invalidateCategoryInputs(job, sku, typeof updater === "function" ? updater(sku) : { ...sku, ...updater }, pack));
                return { ...job, updatedAt: new Date().toISOString(), skus, status: deriveJobStatus(skus) };
            }) })),
            removeJob: (jobId) => set((state) => ({ jobs: state.jobs.filter((job) => job.id !== jobId) })),
            addPolicyPack: (pack) => set((state) => ({ policyPacks: [pack, ...state.policyPacks] })),
            savePolicyEdit: async (input) => {
                const base = clonePolicy(input.base);
                const edited = clonePolicy(input.edited);
                const owner = useCommerceStore.getState().owner;
                if (!owner) throw new Error("请先设置负责人");
                if (await hashCommercePin(input.pin) !== owner.pinHash) throw new Error("负责人 PIN 不正确");
                let saved: PolicyPack | undefined;
                const transaction: { previous?: CommerceStore; committed?: CommerceStore } = {};
                // persist returns the storage promise at runtime, despite set's void type.
                const persistSet = set as (updater: (state: CommerceStore) => Partial<CommerceStore>) => unknown;
                try {
                    await persistSet((state) => {
                        if (state.owner?.pinHash !== owner.pinHash || state.owner?.name !== owner.name) throw new Error("负责人已变更，请重新验证");
                        const result = preparePolicySave({ packs: state.policyPacks, base, edited, publish: input.publish, actor: owner.name,
                            newId: nanoid(), auditId: nanoid(), now: new Date().toISOString(),
                            referenced: state.jobs.some((job) => job.policyPackId === base.id && job.policyVersion === base.version) });
                        saved = result.saved;
                        transaction.previous = state;
                        transaction.committed = { ...state, policyPacks: result.policyPacks, audit: [result.audit, ...state.audit].slice(0, 2000) };
                        return transaction.committed;
                    });
                } catch (error) {
                    const { previous, committed } = transaction;
                    if (!previous || !committed) throw error;
                    const current = useCommerceStore.getState();
                    const unchanged = (Object.keys(committed) as Array<keyof CommerceStore>).every((key) => Object.is(current[key], committed[key]));
                    const reason = error instanceof Error ? error.message : String(error);
                    if (!unchanged) throw new Error(`规则保存未确认成功：${reason}。检测到并发修改，已保留当前内存内容，请重新打开规则核对后重试。`);
                    try {
                        const rollback = { policyPacks: previous.policyPacks, audit: previous.audit };
                        await persistSet(() => rollback);
                    } catch {
                        throw new Error(`规则保存失败：${reason}。已撤回本次内存修改，但存储仍不可用；编辑内容已保留，请恢复存储后重试。`);
                    }
                    throw new Error(`规则保存失败：${reason}。已撤回本次修改，编辑内容已保留，可重试。`);
                }
                return saved!;
            },
            publishPolicyPack: (id) => set((state) => ({ policyPacks: state.policyPacks.map((pack) => pack.id === id ? { ...pack, status: "published", publishedAt: new Date().toISOString() } : pack.status === "published" && pack.id !== builtInPack.id ? { ...pack, status: "retired" } : pack) })),
            retirePolicyPack: (id) => set((state) => ({ policyPacks: state.policyPacks.map((pack) => pack.id === id ? { ...pack, status: "retired" } : pack) })),
            addBrand: (brand) => set((state) => ({ brands: [brand, ...state.brands] })),
            updateBrand: (id, patch) => set((state) => ({ brands: state.brands.map((brand) => brand.id === id ? { ...brand, ...patch, updatedAt: new Date().toISOString() } : brand) })),
            updateModelRoles: (patch) => set((state) => ({ modelRoles: { ...state.modelRoles, ...patch } })),
            setOwner: (owner) => set({ owner }),
            setOperatorName: (operatorName) => set({ operatorName: operatorName.trim() || "操作员" }),
            addAudit: (event) => set((state) => ({ audit: [{ ...event, id: nanoid(), createdAt: new Date().toISOString() }, ...state.audit].slice(0, 2000) })),
        }),
        {
            name: STORE_KEY,
            storage,
            version: 4,
            partialize: (state) => ({ jobs: state.jobs, brands: state.brands, policyPacks: state.policyPacks, modelRoles: state.modelRoles, owner: state.owner, operatorName: state.operatorName, audit: state.audit }) as StorageValue<CommerceStore>["state"],
            migrate: (persisted) => normalizePersistedState((persisted || {}) as Partial<CommerceStore>) as CommerceStore,
            merge: (persisted, current) => {
                const saved = normalizePersistedState((persisted || {}) as Partial<CommerceStore>);
                return {
                    ...current,
                    ...saved,
                    jobs: Array.isArray(saved.jobs) ? saved.jobs : [],
                    brands: saved.brands?.length ? saved.brands : [defaultBrand],
                    policyPacks: saved.policyPacks?.length ? saved.policyPacks : [builtInPack],
                    modelRoles: { ...defaultModelRoles, ...saved.modelRoles },
                    operatorName: saved.operatorName || current.operatorName,
                    audit: Array.isArray(saved.audit) ? saved.audit : [],
                };
            },
            onRehydrateStorage: () => {
                rawSet({ hydrated: false, catalogStatus: { phase: "loading" } });
                return (_state, error) => {
                    if (!_state || error !== undefined) {
                        rawSet({ hydrated: false, catalogStatus: { phase: "error", error: "本地任务读取失败，已暂停共享规则加载。请重试读取；若仍失败，请恢复浏览器存储后刷新页面。" } });
                        return;
                    }
                    rawSet({ hydrated: true, catalogStatus: { phase: "idle" } });
                    void useCommerceStore.getState().loadServerCatalog();
                };
            },
        },
    )(rawSet, get, api)) as StateCreator<CommerceStore, [], [["zustand/persist", CommerceStore]]>,
);

function selectCreativePolicy(packs: PolicyPack[]): { activePack: PolicyPack; policyPacks: PolicyPack[] } {
    const published = packs.filter((pack) => pack.status === "published").sort((a, b) => b.version - a.version);
    const team = published.find((pack) => pack.id.startsWith("server-aoweisi-team-"));
    if (team) return { activePack: team, policyPacks: packs };
    const sharedCategories = published.find((pack) => pack.id.startsWith(SERVER_POLICY_PREFIX) && pack.categories?.length);
    if (sharedCategories) return { activePack: sharedCategories, policyPacks: packs };
    if (published[0]?.categories?.length) return { activePack: published[0], policyPacks: packs };
    if (published[0]?.creativeLibraryVersion === 1) return { activePack: published[0], policyPacks: packs };
    const base = published[0] || createBuiltInPolicyPack();
    const now = new Date().toISOString();
    const presets = createCreativeRequirementPresets();
    const next: PolicyPack = { ...clonePolicy(base), id: "creative-local-" + nanoid(), name: "奥维斯平台商品推荐方案", version: Math.max(5, ...packs.map((pack) => pack.version + 1)), status: "published", creativeLibraryVersion: 1,
        sourceFileName: "奥维斯平台推荐方案", createdAt: now, publishedAt: now, requirementPresets: presets,
        templates: presets.filter((preset) => preset.stage === "marketing").map((preset) => ({ id: preset.id, category: preset.category, order: preset.order, title: preset.title, requirement: preset.prompt, slot: "marketing", chineseCopy: preset.chineseCopy, translationSeeds: { ...preset.translationSeeds }, requiredVariables: [...preset.requiredFacts], referenceIds: [...preset.referenceIds] })) };
    return { activePack: next, policyPacks: [next, ...packs] };
}

function selectVisualPolicy(packs: PolicyPack[]): { activePack?: PolicyPack; policyPacks: PolicyPack[] } {
    const activePack = packs.filter((pack) => pack.status === "published").sort((a, b) => b.version - a.version)[0];
    const expectedCounts: Record<string, number> = { 地毯地垫类: 11, 桌垫类: 11, 洞洞板类: 9, 收纳筐类: 9 };
    const presets = activePack?.requirementPresets || [];
    const original40 = activePack?.sourceFileName === "奥维斯美工需求.xlsx" && presets.length === 40
        && presets.every((preset) => preset.visualKind === undefined)
        && Object.entries(expectedCounts).every(([category, count]) => {
            const rows = presets.filter((preset) => preset.category === category);
            return rows.length === count && new Set(rows.map((preset) => preset.order)).size === count && rows.every((preset) => Number.isInteger(preset.order) && preset.order >= 1 && preset.order <= count);
        });
    if (!activePack || !original40) return { activePack, policyPacks: packs };
    const now = new Date().toISOString();
    const corrected: PolicyPack = { ...clonePolicy(activePack), id: nanoid(), version: activePack.version + 1, createdAt: now, publishedAt: now,
        requirementPresets: clonePolicy(activePack).requirementPresets.map(correctedPresetVisual) };
    return { activePack: corrected, policyPacks: [corrected, ...packs.map((pack) => pack === activePack ? { ...pack, status: "retired" as const } : pack)] };
}

function currentBrandRequirementDefaults(defaults: RequirementSelection[] | undefined, activePack: PolicyPack | undefined, packs: PolicyPack[]): RequirementSelection[] | undefined {
    if (!defaults || !activePack) return defaults;
    const olderPacks = packs.filter((pack) => pack.version < activePack.version).sort((a, b) => b.version - a.version);
    return defaults.map((selection) => {
        const previous = olderPacks.flatMap((pack) => pack.requirementPresets.filter((preset) => preset.id === selection.requirementId))[0];
        if (!previous) return selection;
        const inherited = createRequirementSelections([previous])[0];
        const next = { ...selection };
        // Brand snapshots may contain inherited values from an older published preset.
        // Only drop matching inherited fields; never mutate the stored brand defaults.
        for (const key of ["layout", "visualKind", "variantScope"] as const) {
            if (selection[key] !== undefined && selection[key] === inherited[key]) {
                const corrected = activePack.requirementPresets.find((preset) => preset.id === selection.requirementId);
                if (corrected) Object.assign(next, { [key]: createRequirementSelections([corrected])[0][key] });
            }
        }
        return next;
    });
}

function upgradeVisualPipeline(job: CommerceJob, packs: PolicyPack[]): CommerceJob {
    const pack = packs.filter((item) => item.status === "published").sort((a, b) => b.version - a.version)[0];
    if (!pack) throw new Error("请先发布新版规则，再升级历史任务");
    const previous = packs.find((item) => item.id === job.policyPackId && item.version === job.policyVersion);
    const skus = job.skus.map((sku): CommerceSku => {
        const product = mapProductCategory(pack, sku.product);
        const presets = pack.categories?.length ? categoryRequirements(pack, product) : recommendedRequirements(pack, product.category);
        const selections = createRequirementSelections(presets).map((fresh) => {
            const old = sku.requirementSelections.find((item) => item.requirementId === fresh.requirementId);
            if (!old) return fresh;
            const oldPreset = previous?.requirementPresets.find((item) => item.id === old.requirementId);
            const inherited = oldPreset ? createRequirementSelections([oldPreset])[0] : undefined;
            const merged = { ...fresh, ...old };
            // Snapshot fields equal to the old preset were inherited, not operator overrides.
            for (const key of ["layout", "referenceIds", "variantScope", "visualMode", "visualKind"] as const) {
                if (old[key] === undefined || (inherited && JSON.stringify(old[key]) === JSON.stringify(inherited[key]))) {
                    Object.assign(merged, { [key]: fresh[key] });
                }
            }
            return { ...merged, reviewed: fresh.reviewed === false ? false : old.reviewed };
        });
        const activeRevision = Math.max(sku.activeRevision, ...sku.assets.map((asset) => asset.revision)) + 1;
        const white = sku.assets.filter((asset) => asset.revision === sku.activeRevision && asset.stage === "main-white").slice(-1);
        return { ...sku, product, activeRevision, requirementSelections: selections,
            selectedTemplateIds: job.generationConfig.marketingEnabled ? selections.filter((item) => item.enabled && item.count > 0 && presets.find((preset) => preset.id === item.requirementId)?.stage === "marketing").map((item) => item.requirementId) : [],
            assets: [...sku.assets, ...white.map((asset) => ({ ...asset, id: nanoid(), revision: activeRevision, sourceAssetIds: [asset.id], createdAt: new Date().toISOString() }))],
            canvasProjectId: undefined, copyZh: {}, localizedCopy: {}, approvals: [], checks: [], stage: "white-review", stageMessage: "已升级视觉流程 v2；请重新确认白底图后生成。历史图片仍保留在旧版本。" };
    });
    return { ...job, visualPipelineVersion: 2, policyPackId: pack.id, policyVersion: pack.version, skus, status: "waiting-review", updatedAt: new Date().toISOString() };
}

function editRequirementSelection(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[], requirementId: string, patch: Partial<RequirementSelection>): CommerceSku {
    const old = sku.requirementSelections.find((item) => item.requirementId === requirementId);
    if (!old) return sku;
    const next = { ...old, ...patch, requirementId };
    if (JSON.stringify(old) === JSON.stringify(next)) return sku;
    const requirementSelections = sku.requirementSelections.map((item) => item === old ? next : item);
    const changedKeys = (Object.keys(next) as Array<keyof RequirementSelection>).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(old[key]));
    if (changedKeys.every((key) => key === "reviewed")) return { ...sku, requirementSelections,
        approvals: sku.approvals.filter((item) => item.assetRevision !== sku.activeRevision || item.gate !== "content"), checks: [],
        stage: ["ready", "localization", "compliance"].includes(sku.stage) ? "content-review" : sku.stage,
        stageMessage: "校对状态已更新，请重新审核内容" };
    const removed = new Set(sku.assets.filter((asset) => asset.revision === sku.activeRevision && asset.stage !== "main-white" && (asset.requirementId === requirementId || asset.templateId === requirementId)).map((asset) => asset.id));
    // Follow provenance to invalidate dependent renders while keeping unrelated requirements.
    let expanded = true;
    while (expanded) {
        expanded = false;
        for (const asset of sku.assets) if (asset.revision === sku.activeRevision && asset.stage !== "main-white" && !removed.has(asset.id) && asset.sourceAssetIds?.some((id) => removed.has(id))) { removed.add(asset.id); expanded = true; }
    }
    const affected = new Set([requirementId, ...sku.assets.filter((asset) => removed.has(asset.id)).map((asset) => asset.requirementId || asset.templateId || "")]);
    const retainCopy = (copy: Record<string, string>) => Object.fromEntries(Object.entries(copy).filter(([id]) => !affected.has(id)));
    const whiteApproved = sku.approvals.some((item) => item.gate === "white-background" && item.approved && item.assetRevision === sku.activeRevision);
    return { ...sku, requirementSelections,
        selectedTemplateIds: job.generationConfig.marketingEnabled ? requirementSelections.filter((item) => item.enabled && item.count > 0 && presets.find((preset) => preset.id === item.requirementId)?.stage === "marketing").map((item) => item.requirementId) : [],
        assets: sku.assets.filter((asset) => !removed.has(asset.id)),
        compositions: sku.compositions.filter((item) => item.revision !== sku.activeRevision || (!affected.has(item.requirementId) && !removed.has(item.assetId || ""))),
        copyZh: retainCopy(sku.copyZh), localizedCopy: Object.fromEntries(Object.entries(sku.localizedCopy).map(([locale, copy]) => [locale, retainCopy(copy)])),
        approvals: sku.approvals.filter((item) => item.assetRevision !== sku.activeRevision || item.gate !== "content"), checks: [],
        stage: whiteApproved ? "content-generation" : sku.stage, stageMessage: "需求方案已变更，请重新生成受影响图片" };
}

function applyGenerationConfig(job: CommerceJob, input: { locales: CommerceLocale[]; generationConfig: CommerceGenerationConfig }, policyPacks: PolicyPack[]): CommerceJob {
    const pack = policyPacks.find((item) => item.id === job.policyPackId && item.version === job.policyVersion) || policyPacks.find((item) => item.status === "published");
    const generationConfig = normalizeGenerationConfig(input.generationConfig, pack?.watermarkOpacityRange);
    const locales = normalizeLocales(input.locales);
    const countsChanged = GENERATION_ASSET_STAGES.some((stage) => generationConfig.assetCounts[stage] !== job.generationConfig.assetCounts[stage]);
    const marketingChanged = generationConfig.marketingEnabled !== job.generationConfig.marketingEnabled;
    const brandingChanged = JSON.stringify(generationConfig.overlay) !== JSON.stringify(job.generationConfig.overlay);
    const outputSpecChanged = JSON.stringify(generationConfig.outputSpec) !== JSON.stringify(job.generationConfig.outputSpec);
    const outputChanged = outputSpecChanged || generationConfig.delivery !== job.generationConfig.delivery;
    const siteModeChanged = generationConfig.siteImageMode !== job.generationConfig.siteImageMode;
    const briefChanged = JSON.stringify(generationConfig.creativeBrief || {}) !== JSON.stringify(job.generationConfig.creativeBrief || {});
    const localesChanged = locales.join("|") !== job.locales.join("|");
    const skus = job.skus.map((sku) => {
        if (outputSpecChanged) return { ...sku,
            activeRevision: Math.max(sku.activeRevision, ...sku.assets.map((asset) => asset.revision), ...sku.compositions.map((item) => item.revision)) + 1,
            canvasProjectId: undefined, approvals: [], checks: [], copyZh: {}, localizedCopy: {},
            selectedTemplateIds: generationConfig.marketingEnabled ? sku.selectedTemplateIds : [],
            stage: "draft" as const, stageMessage: "输出规格变化，请重新生成/采用对应规格白底图" };
        const whiteApproved = sku.approvals.some((item) => item.gate === "white-background" && item.approved && item.assetRevision === sku.activeRevision);
        const contentApproved = sku.approvals.some((item) => item.gate === "content" && item.approved && item.assetRevision === sku.activeRevision);
        if ((job.visualPipelineVersion || 1) >= 2) {
            if (!countsChanged && !marketingChanged && !brandingChanged && !outputChanged && !siteModeChanged && !localesChanged && !briefChanged) return sku;
            const sceneInputsChanged = countsChanged || siteModeChanged || localesChanged || briefChanged;
            const assets = sku.assets.filter((asset) => {
                if (asset.revision !== sku.activeRevision || asset.stage === "main-white") return true;
                if (sceneInputsChanged) return false;
                if (["marketing-base", "comparison-source"].includes(asset.stage)) return !marketingChanged;
                return !(outputChanged || (marketingChanged && ["marketing", "marketing-preview"].includes(asset.stage)) || (brandingChanged && overlayAffected(asset.stage, generationConfig, job.generationConfig)));
            });
            const keptIds = new Set(assets.map((asset) => asset.id));
            const needsGeneration = sku.assets.some((asset) => GENERATION_ASSET_STAGES.includes(asset.stage as typeof GENERATION_ASSET_STAGES[number]) && !keptIds.has(asset.id)) || sceneInputsChanged || (marketingChanged && generationConfig.marketingEnabled);
            return { ...sku, assets,
                selectedTemplateIds: generationConfig.marketingEnabled ? sku.requirementSelections.filter((item) => item.enabled && item.count > 0 && pack?.requirementPresets.find((preset) => preset.id === item.requirementId)?.stage === "marketing").map((item) => item.requirementId) : [],
                compositions: sku.compositions.filter((item) => item.revision !== sku.activeRevision || keptIds.has(item.assetId || "") || assets.some((asset) => asset.compositionId === item.id)),
                copyZh: sceneInputsChanged || marketingChanged ? {} : sku.copyZh, localizedCopy: {},
                approvals: sku.approvals.filter((item) => item.assetRevision !== sku.activeRevision || item.gate === "white-background"), checks: [],
                stage: whiteApproved ? (needsGeneration ? "content-generation" as const : "content-review" as const) : sku.stage,
                stageMessage: "生成方案已变更，请重新生成或渲染受影响图片并审核" };
        }
        if (countsChanged || siteModeChanged) {
            const selectedTemplateIds = generationConfig.marketingEnabled ? sku.selectedTemplateIds : [];
            return { ...sku, assets: sku.assets.filter((asset) => asset.revision !== sku.activeRevision || asset.stage === "main-white"), selectedTemplateIds, copyZh: {}, localizedCopy: {}, approvals: sku.approvals.filter((item) => item.gate !== "content"), checks: [], stage: whiteApproved ? "content-generation" as const : sku.stage, stageMessage: whiteApproved ? "图片类型或数量已变更，请重新生成内容" : sku.stageMessage };
        }
        if (marketingChanged) {
            const selectedTemplateIds = generationConfig.marketingEnabled ? (sku.selectedTemplateIds.length ? sku.selectedTemplateIds : recommendedTemplates(pack, sku.product.category).slice(0, 3).map((item) => item.id)) : [];
            const hasContent = sku.assets.some((asset) => asset.revision === sku.activeRevision && GENERATION_ASSET_STAGES.includes(asset.stage as typeof GENERATION_ASSET_STAGES[number]));
            return { ...sku, assets: sku.assets.filter((asset) => asset.revision !== sku.activeRevision || !["marketing-preview", "marketing"].includes(asset.stage)), selectedTemplateIds, copyZh: {}, localizedCopy: {}, approvals: sku.approvals.filter((item) => item.gate !== "content"), checks: [], stage: whiteApproved ? (hasContent || generationConfig.marketingEnabled ? "content-review" as const : "compliance" as const) : sku.stage, stageMessage: whiteApproved ? (generationConfig.marketingEnabled ? "营销图已开启，请生成预览并重新审核" : hasContent ? "营销图已关闭，请重新确认场景图片" : "营销图已关闭，请重新运行合规检查") : sku.stageMessage };
        }
        if (outputChanged) return { ...sku, assets: sku.assets.filter((asset) => asset.revision !== sku.activeRevision || asset.stage === "main-white"), compositions: sku.compositions.filter((item) => item.revision !== sku.activeRevision), approvals: sku.approvals.filter((item) => item.gate === "white-background"), checks: [], stage: whiteApproved ? "content-generation" as const : sku.stage, stageMessage: whiteApproved ? "输出规格已变更，请重新渲染全部最终文件" : sku.stageMessage };
        if (brandingChanged) {
            const assets = sku.assets.filter((asset) => asset.revision !== sku.activeRevision || !overlayAffected(asset.stage, generationConfig, job.generationConfig));
            return { ...sku, assets, compositions: sku.compositions.filter((item) => item.revision !== sku.activeRevision || assets.some((asset) => asset.id === item.assetId || asset.compositionId === item.id)), approvals: sku.approvals.filter((item) => item.gate !== "content"), checks: [], stage: whiteApproved ? "content-review" as const : sku.stage, stageMessage: whiteApproved ? "品牌覆盖设置已变更，请重新渲染受影响图片并审核" : sku.stageMessage };
        }
        if (localesChanged) return { ...sku, assets: sku.assets.filter((asset) => asset.revision !== sku.activeRevision || asset.stage !== "marketing"), localizedCopy: {}, checks: [], stage: whiteApproved && contentApproved ? (generationConfig.marketingEnabled ? "localization" as const : "compliance" as const) : sku.stage, stageMessage: whiteApproved && contentApproved ? (generationConfig.marketingEnabled ? "目标语言已变更，请重新翻译和渲染" : "目标市场已变更，请重新运行合规检查") : sku.stageMessage };
        return sku;
    });
    return { ...job, locales, generationConfig, skus, status: deriveJobStatus(skus), updatedAt: new Date().toISOString() };
}

function normalizePersistedState(saved: Partial<CommerceStore>): Partial<CommerceStore> {
    const policyPacks = saved.policyPacks?.map(normalizePolicyPack);
    return { ...saved, policyPacks, brands: saved.brands?.map(normalizeBrand), jobs: saved.jobs?.map((job) => normalizeJob(job, policyPacks || [])) };
}

function normalizeBrand(brand: BrandProfile) {
    const legacy = brand as BrandProfile & { watermarkEnabled?: boolean; watermarkOpacity?: number };
    const generationDefaults = legacy.generationDefaults ? { ...normalizeGenerationConfig({ ...legacy.generationDefaults, watermark: legacy.generationDefaults.overlay ? undefined : { mode: legacy.watermarkEnabled === false ? "off" : "single", position: "center", opacity: legacy.watermarkOpacity || 0.05 } }), locales: normalizeLocales(legacy.generationDefaults.locales) } : { ...DEFAULT_BRAND_GENERATION_DEFAULTS, locales: [...DEFAULT_BRAND_GENERATION_DEFAULTS.locales] };
    const { watermarkEnabled: _watermarkEnabled, watermarkOpacity: _watermarkOpacity, ...current } = legacy;
    return { ...current, generationDefaults, requirementDefaultsByCategory: legacy.requirementDefaultsByCategory || {} } as BrandProfile;
}

function normalizeJob(job: CommerceJob, packs: PolicyPack[]) {
    const pack = packs.find((item) => item.id === job.policyPackId && item.version === job.policyVersion) || packs.find((item) => item.status === "published");
    const generationConfig = normalizeGenerationConfig(job.generationConfig, pack?.watermarkOpacityRange);
    const counters = new Map<string, number>();
    return { ...job, locales: normalizeLocales(job.locales), generationConfig, skus: (job.skus || []).map((sku) => {
        const requirementSelections = Array.isArray(sku.requirementSelections) ? sku.requirementSelections : [];
        return { ...sku, requirementSelections, compositions: sku.compositions || [], assets: (sku.assets || []).map((asset) => normalizeAsset(asset, counters)), approvals: sku.approvals || [], checks: sku.checks || [], selectedTemplateIds: sku.selectedTemplateIds || [], copyZh: sku.copyZh || {}, localizedCopy: sku.localizedCopy || {}, activeRevision: sku.activeRevision || 1 };
    }) };
}

function normalizePolicyPack(pack: PolicyPack): PolicyPack {
    const requirementPresets = pack.requirementPresets?.length ? pack.requirementPresets : (pack.templates || []).map(templateRequirement);
    return { ...pack, requirementPresets, siteReferences: pack.siteReferences || [], watermarkOpacityRange: pack.watermarkOpacityRange || [0.03, 0.3] };
}

function normalizeAsset(asset: GeneratedAsset, counters: Map<string, number>) {
    if (asset.sequence) return asset;
    const key = [asset.jobId, asset.skuId, asset.revision, asset.stage, asset.locale || "", asset.templateId || ""].join("|");
    const sequence = (counters.get(key) || 0) + 1;
    counters.set(key, sequence);
    return { ...asset, sequence };
}

function recommendedTemplates(pack: PolicyPack | undefined, category: string) {
    return (pack?.templates || []).filter((item) => item.slot === "marketing" && (item.category === category || item.category.includes(category) || category.includes(item.category.replace(/类$/, "")))).sort((a, b) => a.order - b.order);
}

function recommendedRequirements(pack: PolicyPack | undefined, category: string) {
    if (!category.trim()) return [];
    return (pack?.requirementPresets || []).filter((item) => item.category === "通用" || item.category === category || item.category.includes(category) || category.includes(item.category.replace(/类$/, ""))).sort((a, b) => a.order - b.order);
}

function templateRequirement(item: PolicyPack["templates"][number]): CommerceRequirementPreset {
    return { id: item.id, category: item.category, order: item.order, title: item.title, stage: item.slot === "marketing" ? "marketing" : item.slot, enabledByDefault: true, defaultCount: 1, prompt: item.requirement, layout: "feature-grid", chineseCopy: item.chineseCopy, translationSeeds: item.translationSeeds, requiredFacts: item.requiredVariables, referenceIds: item.referenceIds, variantScope: "per-sku", needsReview: false };
}

function mergeConfig(...values: Array<Partial<CommerceGenerationConfig> | undefined>): CommerceGenerationConfig {
    let result = cloneGenerationConfig(DEFAULT_COMMERCE_GENERATION_CONFIG);
    for (const value of values) {
        if (!value) continue;
        result = {
            ...result,
            ...value,
            assetCounts: { ...result.assetCounts, ...value.assetCounts },
            outputSpec: { ...result.outputSpec, ...value.outputSpec },
            creativeBrief: { ...result.creativeBrief, ...value.creativeBrief },
            overlay: {
                logo: { ...result.overlay.logo, ...value.overlay?.logo },
                watermark: { ...result.overlay.watermark, ...value.overlay?.watermark },
            },
        };
    }
    return result;
}

function overlayAffected(stage: GeneratedAsset["stage"], next: CommerceGenerationConfig, previous: CommerceGenerationConfig) {
    if (stage === "marketing-base" || stage === "comparison-source") return false;
    const applies = (config: CommerceGenerationConfig) => [config.overlay.logo, config.overlay.watermark].some((item) => item.applyTo === "all" || (item.applyTo === "marketing" && ["marketing", "marketing-preview"].includes(stage)) || (item.applyTo === "custom" && item.customStages.includes(stage)));
    return applies(next) || applies(previous);
}

function deriveJobStatus(skus: CommerceSku[]): CommerceJob["status"] {
    if (skus.every((sku) => sku.stage === "draft")) return "draft";
    if (skus.every((sku) => sku.stage === "ready")) return "ready";
    if (skus.some((sku) => ["white-review", "content-review", "compliance"].includes(sku.stage))) return "waiting-review";
    if (skus.some((sku) => sku.stage === "failed")) return "failed";
    return "running";
}

export async function hashCommercePin(pin: string) {
    const bytes = new TextEncoder().encode("infinite-canvas-commerce:" + pin);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}
