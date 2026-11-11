import { LibraryError } from "./membership-library";
import type { AssetGenerationInfo } from "@/pages/assets/generation-info";

export type AssetMetadata = {
    version: 1;
    kind: "original" | "white-background" | "generated" | "other";
    source?: { taskId?: string; nodeId?: string; localId?: string };
    generation?: { version: 1; prompt?: string; model?: string; parameters?: {
        width?: number; height?: number; seed?: number; steps?: number; guidance?: number; count?: number;
        quality?: "low" | "medium" | "high" | "standard" | "hd" | "auto";
        background?: "auto" | "white" | "transparent" | "unspecified"; format?: "png" | "jpeg" | "webp";
        requestedSize?: string;
    } };
    referenceIds?: string[];
};
function fail(): never { throw new LibraryError(400, "资产来源元数据不符合服务器契约；本地数据保留"); }
const unsafe = (value: string) => /(?:[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|ftp|data|javascript|file):|\/\/|www\.|[<>`]|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]|\bbearer\s+|\bsk-[a-z0-9_-]{8,}|-----BEGIN|\b(?:eval|Function|require|fetch|alert)\s*\(|\b(?:import|export)\s+|\bfunction\s*\(|=>)/i.test(value);
function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail();
    return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
    if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || unsafe(value)) fail();
    try { encodeURIComponent(value); } catch { fail(); }
    return value;
}
export function validMigrationLocalId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !unsafe(value);
}
/** Closed schema and deterministic order mirror the versioned server contract. Unknown fields fail. */
export function normalizeAssetMetadata(input?: unknown): AssetMetadata {
    if (input === undefined) return { version: 1, kind: "other" };
    const value = object(input, ["version", "kind", "source", "generation", "referenceIds"]);
    if (value.version !== 1 || !["original", "white-background", "generated", "other"].includes(value.kind as string)) fail();
    const out: AssetMetadata = { version: 1, kind: value.kind as AssetMetadata["kind"] };
    if (value.source !== undefined) {
        const source = object(value.source, ["taskId", "nodeId", "localId"]);
        out.source = {};
        for (const key of ["taskId", "nodeId", "localId"] as const) if (source[key] !== undefined) {
            if (!validMigrationLocalId(source[key])) fail();
            out.source[key] = source[key];
        }
    }
    if (value.generation !== undefined) {
        const g = object(value.generation, ["version", "prompt", "model", "parameters"]);
        if (g.version !== 1) fail();
        out.generation = { version: 1 };
        if (g.prompt !== undefined) out.generation.prompt = text(g.prompt, 4000);
        if (g.model !== undefined) {
            const model = text(g.model, 128);
            const parts = model.split("::");
            const modelPart = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
            const channelPart = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
            if (model.includes("//") || !(parts.length === 1 ? modelPart.test(parts[0]) : parts.length === 2 && channelPart.test(parts[0]) && modelPart.test(parts[1]))) fail();
            out.generation.model = model;
        }
        if (g.parameters !== undefined) {
            const ranges = { width: [1, 16384], height: [1, 16384], seed: [0, Number.MAX_SAFE_INTEGER], steps: [1, 1000], guidance: [0, 100], count: [1, 16] };
            const enums = { quality: ["low", "medium", "high", "standard", "hd", "auto"], background: ["auto", "white", "transparent", "unspecified"], format: ["png", "jpeg", "webp"] };
            const parameters = object(g.parameters, [...Object.keys(ranges), ...Object.keys(enums), "requestedSize"]);
            const p: Record<string, number | string> = {};
            for (const [key, [min, max]] of Object.entries(ranges)) if (parameters[key] !== undefined) {
                const n = parameters[key];
                if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (key !== "guidance" && !Number.isSafeInteger(n))) fail();
                p[key] = n;
            }
            for (const [key, values] of Object.entries(enums)) if (parameters[key] !== undefined) {
                if (!values.includes(parameters[key] as string)) fail();
                p[key] = parameters[key] as string;
            }
            // Append only when present: existing canonical bytes and fingerprints stay unchanged.
            if (parameters.requestedSize !== undefined) {
                const size = parameters.requestedSize;
                if (typeof size !== "string" || size.length > 19) fail();
                if (size.includes(".")) {
                    const decimal = size.match(/^((?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?):((?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?)$/);
                    if (!decimal) fail();
                    const units = (part: string) => { const [whole, fraction = ""] = part.split("."); return Number(whole) * 1000 + Number(fraction.padEnd(3, "0")); };
                    const a = units(decimal[1]); const b = units(decimal[2]);
                    if (a <= 0 || b <= 0 || a > 10000000 || b > 10000000 || a * 3 < b || a > b * 3) fail();
                } else if (size !== "auto") {
                    const match = size.match(/^([1-9][0-9]{0,4})(:|x)([1-9][0-9]{0,4})$/);
                    const bound = match?.[2] === ":" ? 10000 : 16384;
                    if (!match || Number(match[1]) > bound || Number(match[3]) > bound) fail();
                }
                p.requestedSize = size;
            }
            out.generation.parameters = p;
        }
    }
    if (value.referenceIds !== undefined) {
        const ids = value.referenceIds;
        if (!Array.isArray(ids) || ids.length > 16 || !ids.every(v => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) || new Set(ids).size !== ids.length) fail();
        out.referenceIds = [...ids].sort();
    }
    if (new TextEncoder().encode(JSON.stringify(out)).length > 8192) fail();
    return out;
}
/** Whitelist adapter: never sends asset.metadata, provider config or local reference URLs. */
export function mapLegacyAssetMetadata(input: { kind: AssetMetadata["kind"]; generation?: AssetGenerationInfo; referenceIds?: string[] }): AssetMetadata {
    const out: AssetMetadata = { version: 1, kind: input.kind };
    const g = input.generation;
    if (g) {
        if (g.version !== 1) fail();
        const parameters: Record<string, unknown> = {};
        if (g.parameters.size !== undefined) {
            const dimensions = /^(\d+)x(\d+)$/.exec(g.parameters.size);
            // Preserve the pre-extension mapping for already migratable pixel sizes.
            // Adding requestedSize to those records would change a bound migration fingerprint.
            if (dimensions) { parameters.width = Number(dimensions[1]); parameters.height = Number(dimensions[2]); }
            else parameters.requestedSize = g.parameters.size;
        }
        if (g.parameters.count !== undefined) {
            if (!/^\d+$/.test(g.parameters.count)) fail();
            parameters.count = Number(g.parameters.count);
        }
        if (g.parameters.quality !== undefined) parameters.quality = g.parameters.quality;
        if (g.parameters.background !== undefined) parameters.background = g.parameters.background === "" ? "unspecified" : g.parameters.background;
        out.source = {};
        if (g.source.taskId !== undefined) out.source.taskId = g.source.taskId;
        if (g.source.nodeId !== undefined) out.source.nodeId = g.source.nodeId;
        out.generation = { version: 1, prompt: g.prompt, model: g.model, parameters: parameters as NonNullable<AssetMetadata["generation"]>["parameters"] };
        // A caller must resolve every local reference before constructing provenance.
        if (g.references.length && (!input.referenceIds || input.referenceIds.length !== g.references.length)) fail();
    }
    // One resolved ID is required per local reference, but content dedup may map
    // several local references to the same server asset. Provenance is a set.
    if (input.referenceIds !== undefined) out.referenceIds = [...new Set(input.referenceIds)];
    return normalizeAssetMetadata(out);
}
