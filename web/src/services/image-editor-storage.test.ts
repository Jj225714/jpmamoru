import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ values: new Map<string, unknown>(), fail: false, upload: vi.fn() }));
vi.mock("localforage", () => ({
    default: {
        createInstance: () => ({
            getItem: async (key: string) => fake.values.get(key),
            setItem: async (key: string, value: unknown) => {
                if (fake.fail) throw new Error("disk full");
                fake.values.set(key, structuredClone(value));
                return value;
            },
            iterate: async (fn: (v: unknown) => void) => {
                fake.values.forEach(fn);
            },
        }),
    },
}));
vi.mock("./image-storage", () => ({ imageToDataUrl: async () => "copied pixels", uploadImage: fake.upload, resolveImageUrl: async (key: string) => `blob:resolved-${key}` }));
import { loadEditDocument, saveEditDocument } from "./image-editor-storage";

describe("editable draft storage", () => {
    beforeEach(() => {
        fake.values.clear();
        fake.fail = false;
        fake.upload.mockReset().mockResolvedValue({ url: "blob:copy", storageKey: "independent-copy", width: 300, height: 200 });
    });
    it("owns an independent source and hydrates URLs again after refresh", async () => {
        const first = await loadEditDocument("source", { url: "blob:original", storageKey: "history-key", width: 300, height: 200 });
        expect(first.original.storageKey).toBe("independent-copy");
        first.layers[0].rotation = 42;
        await saveEditDocument(first);
        const loaded = await loadEditDocument("source");
        expect(loaded.layers[0].rotation).toBe(42);
        expect(loaded.original.url).toBe("blob:resolved-independent-copy");
        expect(fake.upload).toHaveBeenCalledTimes(1);
    });
    it("serializes writes, snapshots input and recovers after failed saves", async () => {
        const doc = await loadEditDocument("source", { url: "initial", width: 300, height: 200 });
        const first = saveEditDocument({ ...doc, title: "old" });
        const second = saveEditDocument({ ...doc, title: "new" });
        await Promise.all([first, second]);
        expect((await loadEditDocument("source")).title).toBe("new");
        fake.fail = true;
        await expect(saveEditDocument(doc)).rejects.toThrow("disk full");
        fake.fail = false;
        await saveEditDocument({ ...doc, title: "recovered" });
        expect((await loadEditDocument("source")).title).toBe("recovered");
    });
});
