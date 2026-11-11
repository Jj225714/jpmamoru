import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) } }));
vi.mock("@/services/commerce-policy-catalog", async (original) => ({ ...await original<typeof import("@/services/commerce-policy-catalog")>(), fetchPolicyCatalog: vi.fn() }));
import { createBuiltInPolicyPack } from "@/lib/commerce/defaults";
import { localForageStorage } from "@/lib/localforage-storage";
import { fetchPolicyCatalog } from "@/services/commerce-policy-catalog";
import { useCommerceStore } from "./use-commerce-store";

const serverPack = { ...createBuiltInPolicyPack(), id: "server-aoweisi-original-v5-abcdef012345", version: 5, creativeLibraryVersion: 1 as const };
const catalog = { schemaVersion: 1 as const, revision: "release", publishedAt: "2026-09-17T00:00:00Z", policyPacks: [serverPack] };
beforeEach(async () => {
    vi.stubGlobal("window", { location: { origin: "https://example.test" }, __RUNTIME_CONFIG__: { commercePolicyCatalogUrl: "/public-rules/catalog.json" } });
    vi.mocked(localForageStorage.setItem).mockReset().mockResolvedValue(undefined);
    vi.mocked(localForageStorage.getItem).mockReset().mockResolvedValue(null);
    vi.mocked(fetchPolicyCatalog).mockReset().mockResolvedValue(catalog);
    await useCommerceStore.setState({ hydrated: true, catalogStatus: { phase: "idle" }, policyPacks: [createBuiltInPolicyPack()], jobs: [] });
});
afterEach(() => vi.unstubAllGlobals());
describe("commerce catalog bootstrap", () => {
    it.each(["corrupt JSON", "read rejection", "normalization failure"])("does not fetch or write after %s, and safely rehydrates preserved data on retry", async (failure) => {
        const privatePack = { ...createBuiltInPolicyPack(), id: "private-history", version: 8, creativeLibraryVersion: 1 as const };
        useCommerceStore.setState({ policyPacks: [privatePack], catalogStatus: { phase: "disabled" } });
        const jobId = useCommerceStore.getState().createJob({ name: "saved historical job", products: [] });
        const state = useCommerceStore.getState();
        const saved = {
            jobs: state.jobs, brands: state.brands, policyPacks: state.policyPacks,
            owner: { name: "Local owner", pinHash: "local-hash" }, modelRoles: { ...state.modelRoles, sceneModel: "private-model" },
            operatorName: "Local operator", audit: state.audit,
        };
        await useCommerceStore.setState({ jobs: [], policyPacks: [createBuiltInPolicyPack()], owner: undefined });
        vi.mocked(localForageStorage.setItem).mockClear();
        if (failure === "read rejection") vi.mocked(localForageStorage.getItem).mockRejectedValueOnce(new Error("read unavailable"));
        else vi.mocked(localForageStorage.getItem).mockResolvedValueOnce(failure === "corrupt JSON" ? "{broken" : JSON.stringify({ version: 3, state: { jobs: {}, policyPacks: [] } }));
        await useCommerceStore.persist.rehydrate();
        expect(useCommerceStore.getState()).toMatchObject({ hydrated: false, catalogStatus: { phase: "error", error: expect.stringContaining("重试") } });
        expect(fetchPolicyCatalog).not.toHaveBeenCalled();
        expect(localForageStorage.setItem).not.toHaveBeenCalled();
        expect(() => useCommerceStore.getState().createJob({ name: "blocked", products: [] })).toThrow("本地任务尚未就绪");
        await useCommerceStore.getState().loadServerCatalog();
        expect(fetchPolicyCatalog).not.toHaveBeenCalled();
        expect(localForageStorage.setItem).not.toHaveBeenCalled();

        vi.mocked(localForageStorage.getItem).mockResolvedValue(JSON.stringify({ version: 3, state: saved }));
        await useCommerceStore.getState().loadServerCatalog(true);
        await vi.waitFor(() => expect(useCommerceStore.getState().catalogStatus.phase).toBe("success"));
        const restored = useCommerceStore.getState();
        expect(restored.hydrated).toBe(true);
        for (const key of ["jobs", "brands", "owner", "modelRoles", "operatorName", "audit"] as const) expect(restored[key]).toEqual(saved[key]);
        expect(restored.jobs[0]).toMatchObject({ id: jobId, policyPackId: privatePack.id });
        expect(restored.policyPacks).toContainEqual(privatePack);
        expect(fetchPolicyCatalog).toHaveBeenCalledOnce();
        // One write upgrades storage v3 -> v4, then the public catalog is committed.
        expect(localForageStorage.setItem).toHaveBeenCalledTimes(2);
        const persisted = JSON.parse(vi.mocked(localForageStorage.setItem).mock.calls.at(-1)![1]).state;
        expect(persisted.jobs).toEqual(saved.jobs);
        expect(persisted.owner).toEqual(saved.owner);
        expect(persisted.policyPacks.map((pack: { id: string }) => pack.id)).toEqual([privatePack.id, serverPack.id]);
    });
    it("does not fetch before hydration or without runtime configuration", async () => {
        useCommerceStore.setState({ hydrated: false });
        await useCommerceStore.getState().loadServerCatalog();
        expect(fetchPolicyCatalog).not.toHaveBeenCalled();
        useCommerceStore.setState({ hydrated: true });
        window.__RUNTIME_CONFIG__ = {};
        await useCommerceStore.getState().loadServerCatalog();
        expect(fetchPolicyCatalog).not.toHaveBeenCalled();
        expect(useCommerceStore.getState().catalogStatus.phase).toBe("disabled");
    });
    it("automatically fetches after rehydration and waits for persistence while guarding new jobs", async () => {
        let release!: () => void;
        vi.mocked(localForageStorage.setItem).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
        await useCommerceStore.persist.rehydrate();
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        expect(useCommerceStore.getState().catalogStatus.phase).toBe("loading");
        expect(() => useCommerceStore.getState().createJob({ name: "too early", products: [] })).toThrow("尚未就绪");
        await useCommerceStore.getState().loadServerCatalog();
        expect(fetchPolicyCatalog).toHaveBeenCalledTimes(1);
        release();
        await vi.waitFor(() => expect(useCommerceStore.getState().catalogStatus.phase).toBe("success"));
        const id = useCommerceStore.getState().createJob({ name: "ready", products: [] });
        expect(useCommerceStore.getState().jobs.find((job) => job.id === id)?.policyPackId).toBe(serverPack.id);
    });
    it("preserves historical jobs, brands, owner, models and private newer selection", async () => {
        const privatePack = { ...createBuiltInPolicyPack(), id: "local", version: 8, creativeLibraryVersion: 1 as const };
        useCommerceStore.setState({ policyPacks: [privatePack], catalogStatus: { phase: "disabled" } });
        useCommerceStore.getState().createJob({ name: "history", products: [] });
        useCommerceStore.setState({ catalogStatus: { phase: "idle" } });
        const before = useCommerceStore.getState();
        await before.loadServerCatalog();
        const after = useCommerceStore.getState();
        for (const key of ["jobs", "brands", "owner", "modelRoles", "audit"] as const) expect(after[key]).toBe(before[key]);
        expect(after.policyPacks[0]).toBe(privatePack);
        const id = after.createJob({ name: "new", products: [] });
        expect(useCommerceStore.getState().jobs.find((job) => job.id === id)?.policyPackId).toBe(privatePack.id);
        await after.loadServerCatalog(); expect(fetchPolicyCatalog).toHaveBeenCalledTimes(1);
    });
    it("handles failure and retry, with no builtin fallback on a failed fresh load", async () => {
        vi.mocked(fetchPolicyCatalog).mockRejectedValueOnce(new Error("offline"));
        await useCommerceStore.getState().loadServerCatalog();
        expect(useCommerceStore.getState().catalogStatus).toMatchObject({ phase: "error", error: expect.stringContaining("重试") });
        expect(() => useCommerceStore.getState().createJob({ name: "blocked", products: [] })).toThrow();
        await useCommerceStore.getState().loadServerCatalog(true);
        expect(useCommerceStore.getState().catalogStatus.phase).toBe("success");
        expect(useCommerceStore.getState().policyPacks).toHaveLength(2);
    });
    it("reports persistence failure, then retries without duplicating imports", async () => {
        vi.mocked(localForageStorage.setItem).mockRejectedValueOnce(new Error("disk full"));
        await useCommerceStore.getState().loadServerCatalog();
        expect(useCommerceStore.getState().catalogStatus).toMatchObject({ phase: "error", error: expect.stringContaining("disk full") });
        await useCommerceStore.getState().loadServerCatalog(true);
        expect(useCommerceStore.getState().catalogStatus.phase).toBe("success");
        expect(useCommerceStore.getState().policyPacks.filter((pack) => pack.id === serverPack.id)).toHaveLength(1);
    });
});
