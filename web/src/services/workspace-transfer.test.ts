import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createBuiltInPolicyPack, createDefaultBrand, defaultModelRoles } from "@/lib/commerce/defaults";
import { DEFAULT_PROMPT_SOURCES } from "./api/prompt-source-presets";
import { decodeArchive, destinationStatus, encodeArchive, isWorkspaceKey, validatePayload, type Snapshot } from "./workspace-transfer";

const snapshot = (value: unknown): Snapshot => ({ stores: [{ name: "app_state", keyPath: null, autoIncrement: false, records: [{ key: "test", value }] }], local: [["infinite-canvas:locale", "zh-CN"]] });
describe("workspace transfer archive", () => {
    it("roundtrips raw records, binary types and special scalar values", async () => {
        const source = {
            blob: new Blob(["图片"], { type: "image/png" }),
            file: new File([new Uint8Array([0, 255])], "照片.png", { type: "image/png", lastModified: 123 }),
            buffer: new Uint8Array([1, 2, 3]).buffer,
            typed: new Uint16Array([256, 65535]),
            view: new DataView(new Uint8Array([4, 5]).buffer),
            date: new Date("2026-01-01"),
            missing: undefined,
            nan: NaN,
            negativeZero: -0,
            big: BigInt(123),
        };
        const archive = await encodeArchive(snapshot(source));
        const decoded = await decodeArchive(archive);
        const value = decoded.stores[0].records[0].value as typeof source;
        expect(await value.blob.text()).toBe("图片");
        expect(value.blob.type).toBe("image/png");
        expect(value.file.name).toBe("照片.png");
        expect(value.file.lastModified).toBe(123);
        expect(Array.from(new Uint8Array(await value.file.arrayBuffer()))).toEqual([0, 255]);
        expect(value.buffer).toEqual(source.buffer);
        expect(value.typed).toEqual(source.typed);
        expect(value.view.getUint8(1)).toBe(5);
        expect(value.date).toEqual(source.date);
        expect(Object.hasOwn(value, "missing")).toBe(true);
        expect(value.nan).toBeNaN();
        expect(Object.is(value.negativeZero, -0)).toBe(true);
        expect(value.big).toBe(BigInt(123));
        expect(decoded.local).toEqual(snapshot(null).local);
    });
    it("rejects tampered, missing and unreferenced binaries", async () => {
        const bytes = await encodeArchive(snapshot(new Blob(["test"])));
        for (const mode of ["tamper", "missing", "extra"]) {
            const files = unzipSync(bytes);
            if (mode === "tamper") files["binary/0"][0] ^= 1;
            if (mode === "missing") delete files["binary/0"];
            if (mode === "extra") files["binary/9"] = new Uint8Array([1]);
            await expect(decodeArchive(zipSync(files))).rejects.toThrow();
        }
    });
    it("rejects unknown versions, paths, duplicate stores and credential storage", async () => {
        const original = unzipSync(await encodeArchive(snapshot(null)));
        for (const mutate of [
            (m: any) => {
                m.version = 2;
            },
            (m: any) => {
                m.stores.push(m.stores[0]);
            },
            (m: any) => {
                m.local.push(["workspace-transfer-pending", "secret"]);
            },
            (m: any) => {
                m.stores[0].records[0].value = { t: "eval", v: "evil" };
            },
        ]) {
            const m = JSON.parse(strFromU8(original["manifest.json"]));
            mutate(m);
            await expect(decodeArchive(zipSync({ "manifest.json": strToU8(JSON.stringify(m)) }))).rejects.toThrow();
        }
        await expect(decodeArchive(zipSync({ ...original, "../evil": new Uint8Array() }))).rejects.toThrow();
    });
    it("rejects unsupported values rather than dropping them", async () => {
        for (const value of [new Map(), new Set(), /test/, { fn: () => 1 }, { sym: Symbol() }]) await expect(encodeArchive(snapshot(value))).rejects.toThrow();
        const cyclic: any = {};
        cyclic.self = cyclic;
        await expect(encodeArchive(snapshot(cyclic))).rejects.toThrow();
        const shared = { x: 1 };
        await expect(encodeArchive(snapshot({ a: shared, b: shared }))).resolves.toBeInstanceOf(Uint8Array);
    });
    it("safely preserves prototype-named own properties", async () => {
        const value = JSON.parse('{"__proto__":{"polluted":true}}');
        const result = await decodeArchive(await encodeArchive(snapshot(value)));
        expect(Object.getPrototypeOf(result.stores[0].records[0].value)).toBe(Object.prototype);
        expect(({} as any).polluted).toBeUndefined();
    });
    it("never treats customized brand/policy/config or tasks as defaults", () => {
        const state = { jobs: [], brands: [createDefaultBrand()], policyPacks: [createBuiltInPolicyPack()], modelRoles: defaultModelRoles, operatorName: "操作员", audit: [] };
        const make = () => {
            const s = snapshot(JSON.stringify({ state, version: 3 }));
            s.stores[0].records[0].key = "infinite-canvas:commerce_store";
            return s;
        };
        expect(destinationStatus(make())).toBe("defaults");
        state.brands[0].name = "我的品牌";
        expect(destinationStatus(make())).toBe("occupied");
        expect(destinationStatus(snapshot("unknown"))).toBe("occupied");
        expect(destinationStatus({ stores: [], local: [] })).toBe("empty");
    });
    it("validates remote payloads and excludes migration credentials", () => {
        expect(isWorkspaceKey("infinite-canvas:workspace-migration:migration-1")).toBe(false);
        expect(isWorkspaceKey("infinite-canvas:workspace-transfer-token")).toBe(false);
        expect(isWorkspaceKey("canvas-agent-token")).toBe(true);
        expect(() => validatePayload({ server: "http://example.com", name: "snapshot-a.zip", token: "a".repeat(32) })).toThrow();
        expect(() => validatePayload({ server: "https://example.com", name: "../a.zip", token: "a".repeat(32) })).toThrow();
    });
    it("allows only an empty localForage blob probe as an initialization record", () => {
        const s: Snapshot = { stores: [{ name: "local-forage-detect-blob-support", keyPath: null, autoIncrement: false, records: [{ key: "key", value: new Blob([]) }] }], local: [] };
        expect(destinationStatus(s)).toBe("defaults");
        s.stores[0].records[0].value = new Blob(["data"]);
        expect(destinationStatus(s)).toBe("occupied");
    });
    it("ignores only valid prompt fetch metadata with otherwise exact pristine defaults", () => {
        const pristine = () => ({ sources: structuredClone(DEFAULT_PROMPT_SOURCES), schedule: { intervalMinutes: 30, lastFetchedAt: "2026-09-17T00:12:34.567Z" } });
        const status = (state: unknown) => destinationStatus({ stores: [], local: [["infinite-canvas:prompt_source_store_v2", JSON.stringify({ state, version: 0 })]] });
        expect(status(pristine())).toBe("defaults");
        expect(status({ ...pristine(), schedule: { intervalMinutes: 30, lastFetchedAt: "" } })).toBe("defaults");
        for (const lastFetchedAt of ["bad", "2026-02-30T00:12:34.567Z", "2026-09-17", 123, null]) {
            expect(status({ ...pristine(), schedule: { intervalMinutes: 30, lastFetchedAt } })).toBe("occupied");
        }
        expect(status({ ...pristine(), schedule: { intervalMinutes: 30 } })).toBe("occupied");
        expect(status({ ...pristine(), schedule: { ...pristine().schedule, intervalMinutes: 60 } })).toBe("occupied");
        expect(status({ ...pristine(), schedule: { ...pristine().schedule, extra: true } })).toBe("occupied");
        expect(status({ ...pristine(), extra: true })).toBe("occupied");
        const changed = pristine();
        changed.sources[0].enabled = !changed.sources[0].enabled;
        expect(status(changed)).toBe("occupied");
        const custom = pristine();
        custom.sources.push({ ...custom.sources[0], id: "custom", builtIn: false });
        expect(status(custom)).toBe("occupied");
        expect(status({ ...pristine(), sources: [] })).toBe("occupied");
    });
    it("accepts combined pristine app, plugin, prompt and sentinel defaults without accepting customized settings", () => {
        const states = {
            "infinite-canvas:commerce_store": { jobs: [], brands: [createDefaultBrand()], policyPacks: [createBuiltInPolicyPack()], modelRoles: defaultModelRoles, operatorName: "操作员", audit: [] },
            "infinite-canvas:canvas_store": { projects: [], deletedProjects: [] },
            "infinite-canvas:asset_store": { assets: [] },
            "infinite-canvas:plugin_store": { plugins: [] },
        };
        const sourceState = { sources: structuredClone(DEFAULT_PROMPT_SOURCES), schedule: { intervalMinutes: 30, lastFetchedAt: "" } };
        const s: Snapshot = {
            stores: [
                { name: "app_state", keyPath: null, autoIncrement: false, records: Object.entries(states).map(([key, state]) => ({ key, value: JSON.stringify({ state, version: 0 }) })) },
                { name: "local-forage-detect-blob-support", keyPath: null, autoIncrement: false, records: [{ key: "key", value: new Blob([""]) }] },
            ],
            local: [
                ["infinite-canvas:prompt_source_store_v2", JSON.stringify({ state: sourceState, version: 0 })],
                ["infinite-canvas:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })],
            ],
        };
        expect(destinationStatus(s)).toBe("defaults");
        sourceState.sources[0].enabled = !sourceState.sources[0].enabled;
        s.local[0][1] = JSON.stringify({ state: sourceState, version: 0 });
        expect(destinationStatus(s)).toBe("occupied");
        s.local = [];
        s.stores[0].records.find((r) => r.key === "infinite-canvas:plugin_store")!.value = JSON.stringify({ state: { plugins: [{ id: "custom", enabled: false }] }, version: 0 });
        expect(destinationStatus(s)).toBe("occupied");
    });
});
