import axios, { type AxiosError, type AxiosRequestConfig } from "axios";

export type DiagnosticEvent = {
    ts: number;
    kind: "operation" | "network" | "error";
    operation?: string;
    phase?: "start" | "success" | "failure" | "headers";
    route?: string;
    status?: number;
    elapsedMs?: number;
    errorCategory?: "canceled" | "timeout" | "network" | "overloaded" | "http" | "unknown";
    requestId?: string;
};

const STORAGE_KEY = "sanheai.diagnostics.v1";
const MAX_EVENTS = 200;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

let events: DiagnosticEvent[] = [];
let initialized = false;

function safeRoute(input?: string): string | undefined {
    if (!input) return undefined;
    try {
        const u = new URL(input, location.origin);
        const path = u.pathname;
        if (path.includes("/images/")) return "image-api";
        if (path.includes("/responses") || path.includes("/chat/completions") || path.includes(":generateContent")) return "model-api";
        if (path.startsWith("/api/providers/")) return "provider-api";
        if (path.startsWith("/api/config-vault/")) return "config-api";
        if (path.includes("/videos")) return "video-api";
        if (path.includes("/audio")) return "audio-api";
        return "other";
    } catch { return "unknown"; }
}
function persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(events)); } catch {} }
function load() { try { const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); if (Array.isArray(p)) events = p.filter((e) => e && typeof e.ts === "number" && Date.now() - e.ts <= MAX_AGE_MS).slice(-MAX_EVENTS); } catch { events = []; } }
function record(e: Omit<DiagnosticEvent, "ts">) { const clean: DiagnosticEvent = { ts: Date.now(), kind: e.kind }; for (const k of ["operation","phase","route","status","elapsedMs","errorCategory","requestId"] as const) if (e[k] !== undefined) (clean as any)[k] = e[k]; events = [...events, clean].slice(-MAX_EVENTS); persist(); }

export function listDiagnostics(): DiagnosticEvent[] { load(); return events.slice(); }
export function clearDiagnostics() { events = []; try { localStorage.removeItem(STORAGE_KEY); } catch {} }
export function exportDiagnostics(): string { return JSON.stringify({ version: 1, events: listDiagnostics() }); }

function category(err: any): DiagnosticEvent["errorCategory"] { if (err?.name === "AbortError" || axios.isCancel(err)) return "canceled"; if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") return "timeout"; const s = err?.response?.status; if (s === 408 || s === 429 || (s >= 500 && s <= 599)) return s === 429 || s === 503 ? "overloaded" : "http"; if (err?.request && !err?.response) return "network"; if (s) return "http"; return "unknown"; }
export async function diagnose<T>(operation: string, work: () => Promise<T>): Promise<T> { const op = operation.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80) || "unknown"; const started = performance.now(); record({ kind: "operation", operation: op, phase: "start" }); try { const v = await work(); record({ kind: "operation", operation: op, phase: "success", elapsedMs: Math.round(performance.now() - started) }); return v; } catch (err) { record({ kind: "operation", operation: op, phase: "failure", elapsedMs: Math.round(performance.now() - started), errorCategory: category(err) }); throw err; } }

export function initDiagnostics() { if (initialized || typeof window === "undefined") return; initialized = true; load(); window.addEventListener("error", () => record({ kind: "error", errorCategory: "unknown" })); window.addEventListener("unhandledrejection", (e) => record({ kind: "error", errorCategory: category(e.reason) }));
    const origFetch = window.fetch; window.fetch = async function(input: RequestInfo | URL, init?: RequestInit) { const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url; const route = safeRoute(url); const started = performance.now(); record({ kind: "network", phase: "start", route }); try { const res = await origFetch.call(this, input, init); const rawId = res.headers.get("x-diagnostics-request-id") || res.headers.get("x-request-id") || ""; const rid = /^[a-f0-9-]{32,36}$/i.test(rawId) ? rawId : undefined; record({ kind: "network", phase: "headers", route, status: res.status, elapsedMs: Math.round(performance.now() - started), requestId: rid }); if (!res.ok) record({ kind: "network", phase: "failure", route, status: res.status, errorCategory: res.status === 429 || res.status >= 500 ? "overloaded" : "http" }); return res; } catch (err) { record({ kind: "network", phase: "failure", route, elapsedMs: Math.round(performance.now() - started), errorCategory: category(err) }); throw err; } };
    axios.interceptors.request.use((config) => { (config as any).__diagStart = performance.now(); record({ kind: "network", phase: "start", route: safeRoute(config.url) }); return config; }); axios.interceptors.response.use((res) => { const c = res.config as AxiosRequestConfig & { __diagStart?: number }; record({ kind: "network", phase: "headers", route: safeRoute(c.url), status: res.status, elapsedMs: c.__diagStart ? Math.round(performance.now() - c.__diagStart) : undefined, requestId: /^[a-f0-9-]{32,36}$/i.test(String(res.headers?.["x-diagnostics-request-id"] || res.headers?.["x-request-id"] || "")) ? String(res.headers?.["x-diagnostics-request-id"] || res.headers?.["x-request-id"]) : undefined }); return res; }, (err: AxiosError) => { const c: any = err.config; record({ kind: "network", phase: "failure", route: safeRoute(c?.url), status: err.response?.status, elapsedMs: c?.__diagStart ? Math.round(performance.now() - c.__diagStart) : undefined, errorCategory: category(err) }); return Promise.reject(err); }); }
