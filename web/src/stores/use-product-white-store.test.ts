import { expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
vi.mock("@/lib/localforage-storage", () => ({ localForageStorage: storage }));

it("restores persisted records and selection after a slow read without writing empty history", async () => {
    vi.resetModules();
    let resolve!: (value: string) => void;
    storage.getItem.mockReturnValue(new Promise<string>((yes) => { resolve = yes; }));
    storage.setItem.mockClear();
    const { useProductWhiteStore } = await import("./use-product-white-store");
    expect(useProductWhiteStore.persist.hasHydrated()).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    const persisted = { records: [{ id: "saved", editor: { applied: { scale: 170, perspectiveEnabled: true, backgroundColor: "#123456", backgroundOpacity: 25 } } }], selectedId: "saved" };
    resolve(JSON.stringify({ state: persisted, version: 0 }));
    await vi.waitFor(() => expect(useProductWhiteStore.persist.hasHydrated()).toBe(true));
    expect(useProductWhiteStore.getState()).toMatchObject(persisted);
    expect(storage.setItem).not.toHaveBeenCalled();
    useProductWhiteStore.getState().select("saved");
    const last = JSON.parse(storage.setItem.mock.calls.at(-1)![1]);
    expect(last.state).toMatchObject(persisted);
});

it("does not overwrite saved history on read failure and supports a later retry", async () => {
    vi.resetModules();
    storage.setItem.mockClear();
    storage.getItem.mockRejectedValueOnce(new Error("IndexedDB temporarily unavailable"));
    const { useProductWhiteStore } = await import("./use-product-white-store");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useProductWhiteStore.persist.hasHydrated()).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    storage.getItem.mockResolvedValueOnce(JSON.stringify({ state: { records: [{ id: "kept" }], selectedId: "kept" }, version: 0 }));
    await useProductWhiteStore.persist.rehydrate();
    expect(useProductWhiteStore.persist.hasHydrated()).toBe(true);
    expect(useProductWhiteStore.getState().selectedId).toBe("kept");
    expect(storage.setItem).not.toHaveBeenCalled();
});
