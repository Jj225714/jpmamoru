import { beforeEach, expect, it, vi } from "vitest";
import { create } from "zustand";
const storage = vi.hoisted(() => ({ values: new Map<string, unknown>(), setItem: vi.fn(), getItem: vi.fn() }));
vi.mock("localforage", () => ({ default: { createInstance: () => storage } }));
vi.mock("./server-config", () => ({ useServerConfigStore: create(() => ({ user: { id: 1 }, phase: "ready" })) }));
import { useServerConfigStore } from "./server-config";
import { migrateLibraryAsset, namespaceLibraryLocalId, normalizeAssetMetadata, mapLegacyAssetMetadata, type AssetMetadata, type AssetMigrationResponse, type AssetScope } from "./asset-library";
const assetId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const input = () => ({ libraryId: "browser-installation-1", localId: "image:local-1", name: "fixture.txt", blob: new Blob(["fixture"], { type: "text/plain" }), metadata: { version: 1, kind: "generated", generation: { version: 1, prompt: "studio", parameters: { width: 512 } } } as AssetMetadata });
const hash = async (value: string | Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value)), n => n.toString(16).padStart(2, "0")).join("");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let remote: AssetMigrationResponse | undefined;
async function responseFor(body: Record<string, any>, target: AssetScope = { scope: "personal" }): Promise<AssetMigrationResponse> {
    const sha256 = await hash(new Uint8Array(Buffer.from(body.data, "base64")));
    return { asset: { id: assetId, ownerId: "1", ...target, name: body.name, mimeType: body.mimeType, bytes: Buffer.from(body.data, "base64").length, sha256, createdAt: "2026-10-25", updatedAt: "2026-10-25", deletedAt: null, thumbnailId: null, metadataEntries: [body.metadata] }, mapping: { actorId: "1", localId: body.localId, assetId, fingerprint: await hash(JSON.stringify({ sha256, name: body.name, mimeType: body.mimeType, metadata: body.metadata })), createdAt: "2026-10-25" } };
}
beforeEach(() => {
    remote = undefined;
    storage.values.clear();
    storage.setItem.mockReset().mockImplementation(async (key, value) => { storage.values.set(key, structuredClone(value)); return value; });
    storage.getItem.mockReset().mockImplementation(async key => storage.values.get(key));
    vi.stubGlobal("window", { location: { origin: "https://local.test" } });
    useServerConfigStore.setState({ user: { id: 1, email: "test@example.test" }, phase: "ready" });
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
        if (url.endsWith("/memberships")) return json({ teams: [] });
        if (options.method === "POST") { remote = await responseFor(JSON.parse(options.body as string)); return json(remote); }
        return remote ? json(remote) : json({}, 404);
    }));
});
it("verifies canonical migration and persists a namespaced account/container receipt before success", async () => {
    const result = await migrateLibraryAsset({ scope: "personal" }, input());
    expect(result.verified).toBe(true);
    expect(result.mapping.localId).toMatch(/^local-[a-f0-9]{64}$/);
    expect(storage.setItem).toHaveBeenCalledOnce(); expect(storage.getItem).toHaveBeenCalledOnce();
    expect(JSON.parse(result.receiptKey).slice(0, 3)).toEqual(["https://local.test", "1", { scope: "personal" }]);
    expect(JSON.parse(vi.mocked(fetch).mock.calls.find(([, o]) => o?.method === "POST")![1]!.body as string).metadata.source.localId).toBe(result.mapping.localId);
    const resumed = await migrateLibraryAsset({ scope: "personal" }, input());
    expect(resumed.resumed).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
});
it("namespaces ambiguous local identifiers without collisions or syntax violations", async () => {
    expect(await namespaceLibraryLocalId("one", "image:1")).not.toBe(await namespaceLibraryLocalId("two", "image:1"));
    expect(await namespaceLibraryLocalId("a:b", "c")).not.toBe(await namespaceLibraryLocalId("a", "b:c"));
});
it("isolates durable receipts for identical old IDs by account and concrete container", async () => {
    const mappings = new Map<string, AssetMigrationResponse>();
    vi.mocked(fetch).mockImplementation(async (raw, options) => {
        if (String(raw).endsWith("/memberships")) return json({ teams: [] });
        const url = new URL(String(raw), "https://local.test");
        const actor = (options!.headers as Record<string, string>)["X-Config-User"];
        const bucket = actor + url.search;
        if (options?.method === "POST") {
            const r = await responseFor(JSON.parse(options.body as string), url.search ? { scope: "team", teamId } : { scope: "personal" });
            r.mapping.actorId = actor; r.asset.ownerId = actor;
            mappings.set(bucket, r); return json(r);
        }
        return mappings.has(bucket) ? json(mappings.get(bucket)) : json({}, 404);
    });
    const personal = await migrateLibraryAsset({ scope: "personal" }, input());
    const shared = await migrateLibraryAsset({ scope: "team", teamId }, input());
    useServerConfigStore.setState({ user: { id: 2, email: "other@example.test" } });
    const other = await migrateLibraryAsset({ scope: "personal" }, input());
    expect(new Set([personal.receiptKey, shared.receiptKey, other.receiptKey]).size).toBe(3);
    expect(storage.values.size).toBe(3);
    expect(personal.mapping.localId).toBe(other.mapping.localId);
});
it("rejects changed retry bytes, name or metadata instead of overwriting the binding", async () => {
    await migrateLibraryAsset({ scope: "personal" }, input());
    for (const changed of [{ ...input(), name: "changed" }, { ...input(), blob: new Blob(["new"]) }, { ...input(), metadata: { version: 1, kind: "other" } as AssetMetadata }]) await expect(migrateLibraryAsset({ scope: "personal" }, changed)).rejects.toMatchObject({ status: 409 });
    expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
});
it("GET confirms a committed POST with lost response without repeating POST", async () => {
    vi.mocked(fetch).mockImplementation(async (url, options) => {
        if (String(url).endsWith("/memberships")) return json({ teams: [] });
        if (options?.method === "POST") { remote = await responseFor(JSON.parse(options.body as string)); throw new TypeError("offline after commit"); }
        return remote ? json(remote) : json({}, 404);
    });
    expect((await migrateLibraryAsset({ scope: "personal" }, input())).confirmedAfterError).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
});
it.each([403, 409, 413, 503])("retains local data and no receipt on unsuccessful migration %s", async status => {
    vi.mocked(fetch).mockImplementation(async (url, options) => String(url).endsWith("/memberships") ? json({ teams: [] }) : options?.method === "POST" ? json({}, status) : json({}, 404));
    await expect(migrateLibraryAsset({ scope: "personal" }, input())).rejects.toBeTruthy();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(1);
});
it("fails closed when offline or local mapping persistence fails", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));
    await expect(migrateLibraryAsset({ scope: "personal" }, input())).rejects.toThrow("offline");
    expect(storage.setItem).not.toHaveBeenCalled();
    storage.setItem.mockRejectedValueOnce(new Error("disk full"));
    await expect(migrateLibraryAsset({ scope: "personal" }, input())).rejects.toThrow("disk full");
    expect((await migrateLibraryAsset({ scope: "personal" }, input())).resumed).toBe(true);
});
it("does not trust a saved receipt after trash or permission revocation", async () => {
    await migrateLibraryAsset({ scope: "personal" }, input());
    remote!.asset.deletedAt = "2026-10-25";
    await expect(migrateLibraryAsset({ scope: "personal" }, input())).rejects.toMatchObject({ status: 409 });
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith("/memberships") ? json({ teams: [] }) : json({}, 403));
    await expect(migrateLibraryAsset({ scope: "personal" }, input())).rejects.toMatchObject({ status: 403 });
    expect(storage.setItem).toHaveBeenCalledOnce();
});
it.each(["id", "hash", "metadata", "actor", "container", "fingerprint"])("rejects corrupt response %s", async field => {
    vi.mocked(fetch).mockImplementation(async (url, options) => {
        if (String(url).endsWith("/memberships")) return json({ teams: [] });
        if (options?.method !== "POST") return json({}, 404);
        const r = await responseFor(JSON.parse(options.body as string));
        if (field === "id") r.asset.id = "invalid";
        if (field === "hash") r.asset.sha256 = "wrong";
        if (field === "metadata") r.asset.metadataEntries = [];
        if (field === "actor") r.mapping.actorId = "2";
        if (field === "container") r.asset.teamId = teamId;
        if (field === "fingerprint") r.mapping.fingerprint = "wrong";
        return json(r);
    });
    await expect(migrateLibraryAsset({ scope: "personal" }, input())).rejects.toMatchObject({ status: 409 });
    expect(storage.setItem).not.toHaveBeenCalled();
});
it("dedup verifies request fingerprint and metadata inclusion without demanding canonical first-owner name/MIME", async () => {
    vi.mocked(fetch).mockImplementation(async (url, options) => {
        if (String(url).endsWith("/memberships")) return json({ teams: [] });
        if (options?.method !== "POST") return json({}, 404);
        const r = await responseFor(JSON.parse(options.body as string), { scope: "team", teamId });
        r.asset.name = "first owner"; r.asset.mimeType = "application/octet-stream"; r.asset.ownerId = "99";
        r.asset.metadataEntries!.unshift({ version: 1, kind: "original" });
        return json(r);
    });
    expect((await migrateLibraryAsset({ scope: "team", teamId }, input())).verified).toBe(true);
});
it("snapshots caller metadata before hashing and aborts on account switch during file read", async () => {
    const data = input();
    let finish!: (bytes: ArrayBuffer) => void;
    vi.spyOn(data.blob, "arrayBuffer").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const migration = migrateLibraryAsset({ scope: "personal" }, data);
    data.metadata.generation!.prompt = "changed later";
    await vi.waitFor(() => expect(finish).toBeDefined());
    useServerConfigStore.setState({ user: { id: 2, email: "other@example.test" } });
    finish(new TextEncoder().encode("fixture").buffer);
    await expect(migration).rejects.toThrow("账号已切换");
    expect(fetch).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
});
it("does not return success if identity changes during durable write or readback is absent", async () => {
    storage.setItem.mockImplementationOnce(async () => { useServerConfigStore.setState({ user: { id: 2, email: "other@example.test" } }); });
    await expect(migrateLibraryAsset({ scope: "personal" }, input())).rejects.toThrow("账号已切换");
    useServerConfigStore.setState({ user: { id: 1, email: "test@example.test" } });
    storage.getItem.mockResolvedValueOnce(null);
    await expect(migrateLibraryAsset({ scope: "personal" }, input())).rejects.toThrow("未确认持久保存");
});
it("uses the original metadata snapshot when callers edit objects during asynchronous file reading", async () => {
    const data = input();
    let finish!: (bytes: ArrayBuffer) => void;
    vi.spyOn(data.blob, "arrayBuffer").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const migration = migrateLibraryAsset({ scope: "personal" }, data);
    await vi.waitFor(() => expect(finish).toBeDefined());
    data.metadata.generation!.prompt = "later edit";
    data.name = "later name";
    finish(new TextEncoder().encode("fixture").buffer);
    const result = await migration;
    expect(result.asset.metadataEntries![0].generation!.prompt).toBe("studio");
    expect(result.asset.name).toBe("fixture.txt");
});
it("canonicalizes only closed metadata fields, sorts references, rejects unsafe values and limits", () => {
    expect(normalizeAssetMetadata({ kind: "other", version: 1, generation: { parameters: { count: 1, width: 2 }, version: 1 }, referenceIds: [teamId, assetId] })).toEqual({ version: 1, kind: "other", generation: { version: 1, parameters: { width: 2, count: 1 } }, referenceIds: [assetId, teamId] });
    for (const invalid of [ { version: 1, kind: "other", apiKey: "x" }, { version: 1, kind: "other", generation: { version: 1, prompt: "fetch(secret)" } }, { version: 1, kind: "other", generation: { version: 1, parameters: { count: 100 } } }, { version: 1, kind: "other", referenceIds: [assetId, assetId] } ]) expect(() => normalizeAssetMetadata(invalid)).toThrow();
});
it("maps legacy known fields and requires resolved references without leaking arbitrary metadata", () => {
    const generation = { version: 1 as const, prompt: "studio", model: "image-model", parameters: { size: "1024x512", count: "2", quality: "high" }, references: [{ id: "local", name: "ref", type: "image", dataUrl: "data:image/png;base64,private" }], source: { kind: "image" as const, taskId: "task1", projectId: "local-project" }, apiKey: "never copied" };
    expect(() => mapLegacyAssetMetadata({ kind: "generated", generation })).toThrow();
    const mapped = mapLegacyAssetMetadata({ kind: "generated", generation, referenceIds: [assetId] });
    expect(mapped.generation?.parameters).toEqual({ width: 1024, height: 512, count: 2, quality: "high" });
    expect(JSON.stringify(mapped)).not.toMatch(/private|never copied|projectId|dataUrl/);
});
it.each(["1:1", "auto", "16:9"])("maps default selector/quality/background and requested size %s without guessing pixels", async size => {
    const generation = { version: 1 as const, prompt: "studio", model: "default::gpt-image-2", parameters: { size, quality: "auto", background: "", count: "1" }, references: [], generatedAt: "2026-10-25", source: { kind: "canvas" as const, nodeId: "node", projectId: "local-project" } };
    const original = structuredClone(generation);
    const metadata = mapLegacyAssetMetadata({ kind: "generated", generation });
    expect(metadata.generation).toEqual({ version: 1, prompt: "studio", model: generation.model, parameters: { count: 1, quality: "auto", background: "unspecified", requestedSize: size } });
    expect(generation).toEqual(original);
    expect(metadata.source).toEqual({ nodeId: "node" });
    const result = await migrateLibraryAsset({ scope: "personal" }, { ...input(), metadata });
    expect(result.verified).toBe(true);
    expect((await migrateLibraryAsset({ scope: "personal" }, { ...input(), metadata })).mapping.fingerprint).toBe(result.mapping.fingerprint);
    expect(generation.generatedAt).toBe("2026-10-25");
    expect(generation.source.projectId).toBe("local-project");
});
it("keeps pre-extension pixel mapping and canonical JSON byte-for-byte for existing bindings", () => {
    const generation = { version: 1 as const, prompt: "studio", model: "image-model", parameters: { size: "1024x512", count: "2", quality: "high", background: "white" }, references: [], source: { kind: "image" as const, taskId: "task1" } };
    const metadata = mapLegacyAssetMetadata({ kind: "generated", generation });
    expect(JSON.stringify(metadata)).toBe('{"version":1,"kind":"generated","source":{"taskId":"task1"},"generation":{"version":1,"prompt":"studio","model":"image-model","parameters":{"width":1024,"height":512,"count":2,"quality":"high","background":"white"}}}');
    expect(normalizeAssetMetadata({ version: 1, kind: "other" })).toEqual({ version: 1, kind: "other" });
});
it("matches the backend fixed pre-extension fingerprint", async () => {
    const metadata = normalizeAssetMetadata({ version: 1, kind: "generated", generation: { version: 1, model: "legacy/model-v1", parameters: { format: "png", quality: "high", width: 1024, height: 1024, background: "white" } } });
    const fingerprint = await hash(JSON.stringify({ sha256: await hash("bytes"), name: "image.png", mimeType: "image/png", metadata }));
    expect(fingerprint).toBe("c5e51a9e8c7e792be87e9b5cb8d0ec0176bf9033c91ecf0afb2af2ef5d2904d7");
});
it.each(["auto", "1:1", "10000:10000", "16384x16384", "10:1", "1.9:1", "2.5:1", "1:2.5", "0.1:0.3", "0.3:0.1", "1.90:1", "10000.000:10000.000"])("accepts exact requestedSize bounds %s without conversion", requestedSize => {
    expect(normalizeAssetMetadata({ version: 1, kind: "generated", generation: { version: 1, parameters: { requestedSize } } }).generation?.parameters).toEqual({ requestedSize });
});
it.each(["3.001:1", "1:3.001", "0.099:0.3", "10000.001:10000", "1.9000:1", ".9:1", "1.:1", "1e0:1", "0.0:1", "01.1:1", "1.5x2", "10001:1", "16385x1", "01:1", "1X1", "1×1", " 1:1", "1:1 ", "0:1", "-1:1", "1k", ""])("rejects uncontracted requestedSize %j and preserves source", size => {
    const generation = { version: 1 as const, prompt: "studio", model: "default::image", parameters: { size }, references: [], source: { kind: "image" as const } };
    const original = structuredClone(generation);
    expect(() => mapLegacyAssetMetadata({ kind: "generated", generation })).toThrow();
    expect(generation).toEqual(original);
    expect(fetch).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
});
it.each(["::model", "channel::", "channel:::model", "a::b::c", "https://example/model", "a::b//c", ".channel::model", "a::_model", "a::b\n", "a".repeat(129)])("rejects uncontracted model %j", model => {
    expect(() => normalizeAssetMetadata({ version: 1, kind: "generated", generation: { version: 1, model } })).toThrow();
});
it.each(["_channel::model", "-channel::model"])("migrates nanoid channel %s with decimal spelling intact", async model => {
    const generation = { version: 1 as const, prompt: "studio", model, parameters: { size: "1.90:1", quality: "auto", background: "" }, references: [], source: { kind: "image" as const } };
    const original = structuredClone(generation);
    const metadata = mapLegacyAssetMetadata({ kind: "generated", generation });
    const result = await migrateLibraryAsset({ scope: "personal" }, { ...input(), metadata });
    expect(result.asset.metadataEntries![0].generation).toEqual({ version: 1, prompt: "studio", model, parameters: { quality: "auto", background: "unspecified", requestedSize: "1.90:1" } });
    expect(generation).toEqual(original);
    expect((await migrateLibraryAsset({ scope: "personal" }, { ...input(), metadata })).resumed).toBe(true);
    const changed = mapLegacyAssetMetadata({ kind: "generated", generation: { ...generation, parameters: { ...generation.parameters, size: "1.9:1" } } });
    await expect(migrateLibraryAsset({ scope: "personal" }, { ...input(), metadata: changed })).rejects.toMatchObject({ status: 409 });
});
it("keeps exact selector length and rejects raw/unknown parameter fields", () => {
    const model = "a::" + "b".repeat(125);
    expect(normalizeAssetMetadata({ version: 1, kind: "generated", generation: { version: 1, model } }).generation?.model).toBe(model);
    for (const parameters of [{ size: "1:1" }, { background: "" }, { requestedSize: "1:1", channelId: "x" }]) expect(() => normalizeAssetMetadata({ version: 1, kind: "generated", generation: { version: 1, parameters } })).toThrow();
});
it("maps deduplicated legacy references after requiring one resolution per local reference", () => {
    const generation = { version: 1 as const, prompt: "studio", model: "image-model", parameters: {}, references: [{ id: "local1", name: "first", type: "image" }, { id: "local2", name: "second", type: "image" }], source: { kind: "image" as const } };
    expect(() => mapLegacyAssetMetadata({ kind: "generated", generation, referenceIds: [assetId] })).toThrow();
    expect(mapLegacyAssetMetadata({ kind: "generated", generation, referenceIds: [assetId, assetId] }).referenceIds).toEqual([assetId]);
    expect(() => mapLegacyAssetMetadata({ kind: "generated", generation, referenceIds: [assetId, "invalid"] })).toThrow();
});
