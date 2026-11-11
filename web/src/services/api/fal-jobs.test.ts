import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelFalJob, createFalJobClient, falJobResultUrl, getFalJob, pollFalJob, submitFalJob } from "./fal-jobs";

const config = { apiKey: "test-key", sessionGuard: () => ({ accountId: "101", channelId: "shared", revision: 1 }) };
const job = (status: string, extra: Record<string, unknown> = {}) => ({ job_id: "job-1", status, ...extra });

beforeEach(() => vi.restoreAllMocks());

it("extracts the first Fal image URL or base64 while preserving legacy URL precedence", () => {
    const completed = { jobId: "job-1", status: "succeeded" as const };
    expect(falJobResultUrl({ ...completed, result: { images: [{ url: "https://example/first.png" }, { url: "https://example/second.png" }] } })).toBe("https://example/first.png");
    expect(falJobResultUrl({ ...completed, result: { images: [{ b64_json: "AA==" }] } })).toBe("data:image/png;base64,AA==");
    expect(falJobResultUrl({ ...completed, result: { url: "https://example/legacy.png", images: [{ url: "https://example/first.png" }] } })).toBe("https://example/legacy.png");
    expect(falJobResultUrl({ ...completed, result: { images: [] } })).toBeUndefined();
});

it("submits with the required idempotency header and normalizes the job", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(job("queued")), { status: 202 }));
    const result = await submitFalJob(config, "flux-fill", { image_url: "https://example/image.png" }, { fetch });
    expect(result).toMatchObject({ jobId: "job-1", status: "queued" });
    const [, init] = fetch.mock.calls[0];
    expect(fetch.mock.calls[0][0]).toBe("/api/providers/fal/jobs/flux-fill");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toEqual(expect.any(String));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
});

it("queries and cancels a job through the gateway contract", async () => {
    const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(job("running")), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(job("canceled")), { status: 200 }));
    await getFalJob(config, "esrgan", "job-1", { fetch });
    await cancelFalJob(config, "esrgan", "job-1", { fetch });
    expect(fetch.mock.calls[0][0]).toBe("/api/providers/fal/jobs/esrgan/job-1");
    expect((fetch.mock.calls[1][1].headers as Record<string, string>)["X-Job-Action"]).toBe("cancel");
});

it("polls with exponential backoff until a terminal status", async () => {
    const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(job("queued")), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(job("running")), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(job("succeeded", { result: { url: "https://example/result.png" } })), { status: 200 }));
    const waits: number[] = [];
    const result = await pollFalJob(config, "qwen-layered", "job-1", { fetch, initialDelayMs: 10, maxDelayMs: 40, maxAttempts: 5, sleep: async (ms) => void waits.push(ms) });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([10, 20]);
    expect(result.status).toBe("succeeded");
    expect(falJobResultUrl(result)).toBe("https://example/result.png");
});

it("supports recoverable and uncertain statuses and reports gateway errors", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(job("recoverable")), { status: 200 }));
    const result = await getFalJob(config, "flux-fill", "job-1", { fetch });
    expect(result.status).toBe("recoverable");

    const uncertainFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(job("uncertain")), { status: 200 }));
    expect((await pollFalJob(config, "flux-fill", "job-1", { fetch: uncertainFetch, maxAttempts: 1 })).status).toBe("uncertain");

    const failed = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "bad_request", message: "invalid payload" } }), { status: 400 }));
    await expect(getFalJob(config, "flux-fill", "job-1", { fetch: failed })).rejects.toMatchObject({ name: "FalJobApiError", status: 400, code: "bad_request", message: "invalid payload" });
});

it("exposes the same operations from the client factory", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(job("failed")), { status: 200 }));
    const client = createFalJobClient(config);
    await client.get("flux-fill", "job-1", { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
});

it("enables cookies only on exact same-origin Fal jobs and disables all redirect following", async () => {
    vi.stubGlobal("window", { location: { origin: "https://app.test" } });
    try {
        for (const baseUrl of ["", "https://app.test"]) {
            const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(job("running"))));
            await getFalJob({ ...config, baseUrl }, "esrgan", "job-1", { fetch });
            expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: baseUrl === "" || baseUrl === "https://app.test" ? "same-origin" : "omit", redirect: "error", cache: "no-store" });
        }
        for (const baseUrl of ["https://other.test", "//other.test"]) {
            const fetch = vi.fn();
            await expect(getFalJob({ ...config, baseUrl }, "esrgan", "job-1", { fetch })).rejects.toMatchObject({ code: "invalid_job_origin" });
            expect(fetch).not.toHaveBeenCalled();
        }
        for (const url of [ "/api/model-gateway/sub2api/v1", "/api/providers/fal/submit/esrgan", "/api/providers/fal/jobs/esrgan/../../other"]) {
            const fetch = vi.fn().mockResolvedValue(new Response("{}"));
            await createFalJobClient(config).request(url, { fetch, credentials: "include", redirect: "follow", headers: { Cookie: "__Secure-provider_tasks=PRIVATE", cookie2: "PRIVATE", Authorization: "override" } });
            const init = fetch.mock.calls[0][1];
            expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error");
            expect(new Headers(init.headers).has("cookie")).toBe(false); expect(new Headers(init.headers).has("cookie2")).toBe(false);
            expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
        }
    } finally { vi.unstubAllGlobals(); }
});

it.each([401, 403, 404, 409])("preserves account/migration refusal %s without another paid call", async status => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { message: "denied" } }), { status }));
    await expect(submitFalJob(config, "esrgan", {}, { fetch, idempotencyKey: "stable" })).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(pollFalJob(config, "esrgan", "job-1", { fetch })).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1][1].method).toBe("GET");
});
