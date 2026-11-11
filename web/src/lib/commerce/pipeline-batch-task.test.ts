import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { Task } from "@/services/api/task-center";
import { batchImageRunner, readBatchJournal, taskImageResult, writeBatchJournal, type BatchTaskOptions } from "./pipeline-batch-task";

vi.mock("@/stores/use-config-store", () => ({ resolveModelRequestConfig: (config: AiConfig) => config }));
vi.mock("@/constant/runtime-config", () => ({ getGptImageJobsEnabled: () => enabled }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: vi.fn(async (ref: ReferenceImage) => ref.dataUrl) }));
let enabled = true;
const config = { model: "gpt-image-2", imageModel: "gpt-image-2", baseUrl: "https://llm.zhitouzhuan.com/v1", apiKey: "test-channel-key" } as AiConfig;
const refs: ReferenceImage[] = [{ id: "ref", name: "product", type: "image/png", dataUrl: "data:image/png;base64,YQ==" }];
const row = (status = "succeeded", jobId = "job-1", extra = {}) => ({ job_id: jobId, status, progress: { stage: status, percent: status === "succeeded" ? 100 : null }, result: { data: [{ b64_json: "YQ==", mime_type: "image/png" }] }, ...extra });
const response = (value: unknown, status = 202) => new Response(JSON.stringify(value), { status });
let data: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
function setup(overrides: Partial<BatchTaskOptions> = {}) {
    const journal = overrides.journal ?? readBatchJournal("batch-1", "account-1");
    const options: BatchTaskOptions = { journal, skuId: "sku-a", revision: 1, assertCurrent: vi.fn(), changed: () => writeBatchJournal(journal), signal: new AbortController().signal, clients: new Set(), active: new Map(), ...overrides };
    return { options, run: (nextConfig = config, prompt = "product prompt", nextRefs = refs) => batchImageRunner(options)("main", nextConfig, prompt, nextRefs) };
}
const record = (h: ReturnType<typeof setup>) => h.options.journal.operations[JSON.stringify([h.options.skuId, 1, "main"])];
const intentRows = () => [...data.entries()].filter(([key]) => key.startsWith("sanhe-task-intents-v1:")).flatMap(([, value]) => JSON.parse(value));
const methods = () => fetchMock.mock.calls.map(([, init]) => init?.method);

beforeEach(() => {
    enabled = true;
    data = new Map();
    storage = {
        getItem: vi.fn((key: string) => data.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
            data.set(key, value);
        }),
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("navigator", { locks: { request: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()) } });
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => response(row(), init?.method === "POST" ? 202 : 200));
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("commerce batch task persistence using the real task-center client", () => {
    it.each(["https://foreign.example/v1", "https://llm.zhitouzhuan.com/v1?key=foreign", "https://foreign.example/api/model-gateway/sub2api"])("rejects an ineligible channel without sending credentials: %s", async (baseUrl) => {
        await expect(setup().run({ ...config, baseUrl, apiKey: "foreign-credential" })).rejects.toThrow("渠道");
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("blocks disabled jobs and non-GPT image models", async () => {
        enabled = false;
        await expect(setup().run()).rejects.toThrow("渠道");
        enabled = true;
        await expect(setup().run({ ...config, model: "flux-2" })).rejects.toThrow("渠道");
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([config.baseUrl, "/api/model-gateway/sub2api/v1"])("persists immutable metadata before its first POST for %s", async (baseUrl) => {
        const h = setup();
        fetchMock.mockImplementation(async (url, init) => {
            expect(url).toBe("/api/providers/gpt/jobs");
            expect(init?.method).toBe("POST");
            const persisted = readBatchJournal("batch-1", "account-1");
            expect(Object.values(persisted.operations)[0]).toMatchObject({ intentId: record(h).intentId, attempt: 1, status: "prepared" });
            expect(intentRows()).toHaveLength(1);
            expect(intentRows()[0]).toMatchObject({ intentId: record(h).intentId, idempotencyKey: (init?.headers as Record<string, string>)["Idempotency-Key"] });
            expect(init?.headers).toMatchObject({ Authorization: "Bearer test-channel-key" });
            expect(JSON.stringify([...data.values()])).not.toMatch(/test-channel-key|product prompt|data:image/);
            return response(row());
        });
        expect(await h.run({ ...config, baseUrl })).toEqual([{ id: "job-1-0", dataUrl: "data:image/png;base64,YQ==" }]);
        expect(h.options.clients.size).toBe(0);
        expect(h.options.active.size).toBe(0);
    });
    it("after refresh only GETs a known job and reuses a successful operation", async () => {
        const first = setup();
        await first.run();
        const intent = { ...record(first) };
        await setup().run();
        expect(methods()).toEqual(["POST", "GET"]);
        expect(fetchMock.mock.calls[1][0]).toBe("/api/providers/gpt/jobs/job-1");
        expect(record(setup())).toEqual(intent);
        expect(intentRows()).toHaveLength(1);
    });
    it("blocks missing IDs after a lost accepted response until explicit same-input confirmation, then reuses the key", async () => {
        fetchMock.mockRejectedValueOnce(new Error("response lost"));
        await expect(setup().run()).rejects.toMatchObject({ code: "network_error" });
        const original = fetchMock.mock.calls[0][1];
        await expect(setup().run()).rejects.toMatchObject({ code: "intent_input_required" });
        expect(methods()).toEqual(["POST"]);
        await setup({ confirmSameInput: true }).run();
        expect(methods()).toEqual(["POST", "POST"]);
        expect(fetchMock.mock.calls[1][1]?.headers).toEqual(original?.headers);
        expect(fetchMock.mock.calls[1][1]?.body).toBe(original?.body);
        expect(intentRows()).toHaveLength(1);
    });
    it("requires explicit retry for failed work and gives only that retry a new attempt/key", async () => {
        fetchMock.mockResolvedValueOnce(response(row("failed")));
        await expect(setup().run()).rejects.toThrow("failed");
        await expect(setup().run()).rejects.toThrow("仅重试失败项");
        expect(methods()).toEqual(["POST"]);
        const retried = setup({ retryFailed: true });
        await retried.run();
        expect(record(retried).attempt).toBe(2);
        const keys = fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["Idempotency-Key"]);
        expect(new Set(keys).size).toBe(2);
        expect(intentRows()).toHaveLength(2);
    });
    it.each(["uncertain", "unknown", "recoverable", "canceled"])("never retries %s, even with retry and confirmation flags", async (status) => {
        fetchMock.mockResolvedValueOnce(response(row(status)));
        await expect(setup().run()).rejects.toThrow();
        await expect(setup({ retryFailed: true, confirmSameInput: true }).run()).rejects.toThrow();
        expect(methods()).toEqual(["POST"]);
    });
    it.each(["prompt", "model", "image", "credential"])("blocks changed %s before any restore request", async (kind) => {
        await setup().run();
        const nextConfig = { ...config, ...(kind === "model" ? { model: "gpt-image-1" } : {}), ...(kind === "credential" ? { apiKey: "different-key" } : {}) };
        await expect(setup().run(nextConfig, kind === "prompt" ? "changed" : "product prompt", kind === "image" ? [{ ...refs[0], dataUrl: "data:image/png;base64,Yg==" }] : refs)).rejects.toThrow();
        expect(methods()).toEqual(["POST"]);
    });
    it.each(["journal", "intent"])("fails closed when %s persistence fails", async (kind) => {
        storage.setItem.mockImplementation((key: string, value: string) => {
            if (key.startsWith(kind === "journal" ? "commerce-batch-v1:" : "sanhe-task-intents-v1:")) throw new Error("quota");
            data.set(key, value);
        });
        await expect(setup().run()).rejects.toThrow();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("does not POST again when journal has a known ID but intent metadata was removed", async () => {
        await setup().run();
        for (const key of data.keys()) if (key.startsWith("sanhe-task-intents-v1:")) data.delete(key);
        await setup()
            .run()
            .catch(() => undefined);
        expect(methods().filter((method) => method === "POST")).toHaveLength(1);
    });
    it("keeps three SKU operations independent and retries only the failed SKU", async () => {
        fetchMock
            .mockResolvedValueOnce(response(row("succeeded", "job-a")))
            .mockResolvedValueOnce(response(row("failed", "job-b")))
            .mockResolvedValueOnce(response(row("uncertain", "job-c")));
        await setup({ skuId: "sku-a" }).run();
        await expect(setup({ skuId: "sku-b" }).run()).rejects.toThrow();
        await expect(setup({ skuId: "sku-c" }).run()).rejects.toThrow();
        fetchMock.mockResolvedValueOnce(response(row("succeeded", "job-b-retry")));
        await setup({ skuId: "sku-b", retryFailed: true }).run();
        const ops = Object.values(readBatchJournal("batch-1", "account-1").operations);
        expect(ops.map((op) => [op.status, op.attempt, op.jobId])).toEqual([
            ["succeeded", 1, "job-a"],
            ["succeeded", 2, "job-b-retry"],
            ["uncertain", 1, "job-c"],
        ]);
        expect(new Set(intentRows().map((intent) => intent.idempotencyKey)).size).toBe(4);
    });
});

describe("narrowed batch image result", () => {
    const task = (extra: Partial<Task> = {}): Task => ({
        jobId: "job-1",
        target: { provider: "gpt" },
        model: "gpt-image-2",
        status: "succeeded",
        createdAt: null,
        updatedAt: null,
        startedAt: null,
        finishedAt: null,
        elapsedMs: null,
        progress: { stage: "succeeded", percent: 100 },
        queueMode: "unknown",
        actions: { cancel: { allowed: false }, retry: { allowed: false, mode: null } },
        resultJobId: "job-1",
        resultExpired: false,
        expiresAt: null,
        error: null,
        result: { data: [{ b64_json: "YQ==" }] },
        ...extra,
    });
    it("returns only local image ID/data URL fields", () => {
        expect(taskImageResult(task({ result: { secret: "hidden", data: [{ b64_json: "YQ==", mime_type: "image/webp", url: "https://foreign.example/image", secret: "hidden" }] } }))).toEqual([{ id: "job-1-0", dataUrl: "data:image/webp;base64,YQ==" }]);
    });
    it.each<Partial<Task>>([
        { status: "failed" },
        { resultExpired: true },
        { result: null },
        { result: { data: [] } },
        { result: { data: [{ url: "https://example.com/image" }] } },
        { result: { data: [{ b64_json: "<html>" }] } },
        { result: { data: [{ b64_json: "YQ==", mime_type: "image/svg+xml" }] } },
    ])("rejects unusable or unsafe result %j", (extra) => {
        expect(() => taskImageResult(task(extra))).toThrow();
    });
});
