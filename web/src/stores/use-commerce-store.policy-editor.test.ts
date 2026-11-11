import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) } }));

import { createBuiltInPolicyPack } from "@/lib/commerce/defaults";
import { clonePolicy } from "@/lib/commerce/policy-editor";
import { localForageStorage } from "@/lib/localforage-storage";
import { hashCommercePin, useCommerceStore } from "@/stores/use-commerce-store";

describe("PIN-verified policy save transaction", () => {
    beforeEach(async () => {
        vi.mocked(localForageStorage.setItem).mockReset().mockResolvedValue(undefined);
        await useCommerceStore.setState({ policyPacks: [{ ...clonePolicy(createBuiltInPolicyPack()), creativeLibraryVersion: 1 }], jobs: [], audit: [], owner: { name: "Owner", pinHash: await hashCommercePin("1234") } });
    });
    it("rejects missing owner and wrong PIN without writes", async () => {
        const state = useCommerceStore.getState(); const base = state.policyPacks[0];
        await expect(state.savePolicyEdit({ base, edited: base, publish: true, pin: "wrong" })).rejects.toThrow("PIN 不正确");
        expect(useCommerceStore.getState().policyPacks).toBe(state.policyPacks);
        expect(useCommerceStore.getState().audit).toHaveLength(0);
        useCommerceStore.setState({ owner: undefined });
        await expect(state.savePolicyEdit({ base, edited: base, publish: false, pin: "1234" })).rejects.toThrow("设置负责人");
    });
    it("keeps old jobs pinned and emits one atomic update for save + publish + audit", async () => {
        const store = useCommerceStore.getState(); const jobId = store.createJob({ name: "Old job", products: [] });
        const before = useCommerceStore.getState(); const base = before.policyPacks[0]; const edited = clonePolicy(base);
        edited.rules[0].description = "新规则";
        const updates: Array<{ packs: number; audits: number }> = [];
        const unsubscribe = useCommerceStore.subscribe((state) => updates.push({ packs: state.policyPacks.length, audits: state.audit.length }));
        const saved = await store.savePolicyEdit({ base, edited, publish: true, pin: "1234" });
        unsubscribe();
        const after = useCommerceStore.getState();
        expect(updates).toEqual([{ packs: 2, audits: 1 }]);
        expect(after.jobs).toBe(before.jobs);
        expect(after.jobs.find((j) => j.id === jobId)).toMatchObject({ policyPackId: base.id, policyVersion: base.version });
        expect(after.policyPacks.find((p) => p.id === base.id)).toEqual(base);
        expect(saved).toMatchObject({ status: "published", version: 2 });
        const newJobId = after.createJob({ name: "New job", products: [] });
        expect(useCommerceStore.getState().jobs.find((j) => j.id === newJobId)?.policyPackId).toBe(saved.id);
    });
    it("does not save or audit validation failures", async () => {
        const state = useCommerceStore.getState(); const base = state.policyPacks[0]; const edited = clonePolicy(base); edited.name = "";
        await expect(state.savePolicyEdit({ base, edited, publish: true, pin: "1234" })).rejects.toThrow("不能为空");
        expect(useCommerceStore.getState().policyPacks).toBe(state.policyPacks);
        expect(useCommerceStore.getState().audit).toHaveLength(0);
    });
    it("rejects a source changed while PIN hashing is pending", async () => {
        const state = useCommerceStore.getState(); const base = state.policyPacks[0];
        const pending = state.savePolicyEdit({ base, edited: base, publish: false, pin: "1234" });
        useCommerceStore.setState({ policyPacks: [{ ...base, name: "Concurrent change" }] });
        await expect(pending).rejects.toThrow("其他操作");
        expect(useCommerceStore.getState().audit).toHaveLength(0);
    });
    it("rejects an owner changed while PIN hashing is pending", async () => {
        const state = useCommerceStore.getState(); const base = state.policyPacks[0];
        const pending = state.savePolicyEdit({ base, edited: base, publish: false, pin: "1234" });
        useCommerceStore.setState({ owner: undefined });
        await expect(pending).rejects.toThrow("负责人已变更");
        expect(useCommerceStore.getState().audit).toHaveLength(0);
    });
    it("does not signal success until delayed policy and audit persistence completes", async () => {
        const storage = deferred(); const started = deferred();
        vi.mocked(localForageStorage.setItem).mockImplementationOnce(() => { started.resolve(); return storage.promise; });
        const state = useCommerceStore.getState(); const base = state.policyPacks[0];
        const success = vi.fn();
        const pending = state.savePolicyEdit({ base, edited: base, publish: true, pin: "1234" }).then(success);
        await started.promise;
        expect(useCommerceStore.getState().audit).toHaveLength(1);
        await Promise.resolve();
        expect(success).not.toHaveBeenCalled();
        storage.resolve(); await pending;
        expect(success).toHaveBeenCalledOnce();
    });
    it("rejects failed persistence without success, rolls back policy and audit, and allows retry", async () => {
        const storage = deferred(); const started = deferred();
        vi.mocked(localForageStorage.setItem).mockImplementationOnce(() => { started.resolve(); return storage.promise; });
        const before = useCommerceStore.getState(); const base = before.policyPacks[0];
        const edited = clonePolicy(base); edited.name = "保留的编辑内容";
        const success = vi.fn();
        const pending = before.savePolicyEdit({ base, edited, publish: true, pin: "1234" }).then(success);
        const rejected = expect(pending).rejects.toThrow("规则保存失败：disk full");
        await started.promise; storage.reject(new Error("disk full")); await rejected;
        expect(success).not.toHaveBeenCalled();
        expect(useCommerceStore.getState().policyPacks).toBe(before.policyPacks);
        expect(useCommerceStore.getState().audit).toBe(before.audit);
        expect(useCommerceStore.getState().jobs).toBe(before.jobs);
        const saved = await before.savePolicyEdit({ base, edited, publish: true, pin: "1234" });
        expect(saved.name).toBe("保留的编辑内容");
        expect(useCommerceStore.getState().audit).toHaveLength(1);
    });
    it("keeps the editor in error and permits retry even if rollback persistence also fails", async () => {
        const before = useCommerceStore.getState(); const base = before.policyPacks[0];
        vi.mocked(localForageStorage.setItem).mockRejectedValueOnce(new Error("disk full")).mockRejectedValueOnce(new Error("still full"));
        const success = vi.fn();
        await expect(before.savePolicyEdit({ base, edited: base, publish: false, pin: "1234" }).then(success)).rejects.toThrow("存储仍不可用");
        expect(success).not.toHaveBeenCalled();
        expect(useCommerceStore.getState().policyPacks).toBe(before.policyPacks);
        expect(useCommerceStore.getState().audit).toBe(before.audit);
        await expect(before.savePolicyEdit({ base, edited: base, publish: false, pin: "1234" })).resolves.toMatchObject({ status: "draft" });
    });
    it("does not roll back concurrent writes or remove a policy referenced by a newly created job", async () => {
        const storage = deferred(); const started = deferred();
        vi.mocked(localForageStorage.setItem).mockImplementationOnce(() => { started.resolve(); return storage.promise; });
        const before = useCommerceStore.getState(); const base = before.policyPacks[0]; const success = vi.fn();
        const pending = before.savePolicyEdit({ base, edited: base, publish: true, pin: "1234" }).then(success);
        const rejected = expect(pending).rejects.toThrow("检测到并发修改");
        await started.promise;
        const jobId = useCommerceStore.getState().createJob({ name: "Concurrent job", products: [] });
        const concurrent = useCommerceStore.getState();
        storage.reject(new Error("write failed")); await rejected;
        expect(success).not.toHaveBeenCalled();
        expect(useCommerceStore.getState()).toBe(concurrent);
        const job = concurrent.jobs.find((item) => item.id === jobId)!;
        expect(concurrent.policyPacks.some((item) => item.id === job.policyPackId && item.version === job.policyVersion)).toBe(true);
    });
    it("also rolls back and rejects synchronous storage errors", async () => {
        const before = useCommerceStore.getState(); const base = before.policyPacks[0];
        vi.mocked(localForageStorage.setItem).mockImplementationOnce(() => { throw new Error("storage unavailable"); });
        await expect(before.savePolicyEdit({ base, edited: base, publish: true, pin: "1234" })).rejects.toThrow("storage unavailable");
        expect(useCommerceStore.getState().policyPacks).toBe(before.policyPacks);
        expect(useCommerceStore.getState().audit).toBe(before.audit);
    });
});

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
