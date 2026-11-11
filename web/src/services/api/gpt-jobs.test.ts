import { describe, expect, it, vi } from "vitest";

import { GptJobApiError, isGptImageJobEligible, pollGptImageJob, submitGptImageJob } from "./gpt-jobs";

const sessionGuard = () => ({ accountId: "101", channelId: "shared", revision: 1 });
const config = { sessionGuard, apiKey: "key", baseUrl: "https://llm.zhitouzhuan.com/v1" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("GPT image jobs", () => {
    it("routes only enabled gpt-image models to the supported gateway", () => {
        expect(isGptImageJobEligible({ ...config, model: "gpt-image-1" }, true)).toBe(true);
        expect(isGptImageJobEligible({ ...config, model: "dall-e-3" }, true)).toBe(false);
        expect(isGptImageJobEligible({ ...config, model: "gpt-image-1" }, false)).toBe(false);
        expect(isGptImageJobEligible({ ...config, baseUrl: "https://api.openai.com/v1", model: "gpt-image-1" }, true)).toBe(false);
    });

    it("submits the operation body with a stable idempotency key", async () => {
        const fetch = vi.fn().mockResolvedValue(response({ job_id: "job-1", status: "queued" }, 202));
        const result = await submitGptImageJob({ sessionGuard, apiKey: "key", fetch }, "edits", { model: "gpt-image-1", images: ["data:image/png;base64,AA=="] }, "idem-1");
        expect(result.job).toMatchObject({ jobId: "job-1", status: "queued" });
        expect(fetch).toHaveBeenCalledWith("/api/providers/gpt/jobs", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Idempotency-Key": "idem-1" }) }));
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ operation: "edits" });
    });

    it("retries transient GET failures on the same job and never resubmits", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(response({ error: { message: "busy" } }, 503)).mockResolvedValueOnce(response({ job_id: "job-1", status: "succeeded", result: { data: [{ b64_json: "AA==" }] } }));
        const waits: number[] = [];
        const job = await pollGptImageJob({ sessionGuard, apiKey: "key", fetch }, "job-1", { maxAttempts: 3, initialDelayMs: 10, sleep: async (ms) => void waits.push(ms) });
        expect(job.status).toBe("succeeded");
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls.every(([url]) => url === "/api/providers/gpt/jobs/job-1")).toBe(true);
        expect(waits).toEqual([10]);
    });

    it("returns uncertain without retrying or submitting again", async () => {
        const fetch = vi.fn().mockResolvedValue(response({ job_id: "job-1", status: "uncertain", error: { message: "acceptance unknown" } }));
        const job = await pollGptImageJob({ sessionGuard, apiKey: "key", fetch }, "job-1", { maxAttempts: 3, sleep: async () => undefined });
        expect(job.status).toBe("uncertain");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(job.error?.message).toBe("acceptance unknown");
        expect(new GptJobApiError("x")).toBeInstanceOf(Error);
    });
});

it("uses same-origin session cookies for fixed GPT jobs and blocks redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ job_id: "job-1", status: "queued" }, 202));
    await submitGptImageJob({ sessionGuard, apiKey: "shared", fetch }, "generations", { model: "gpt-image-2", prompt: "test" }, "stable");
    expect(fetch.mock.calls[0][0]).toBe("/api/providers/gpt/jobs");
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(new Headers(fetch.mock.calls[0][1].headers).has("cookie")).toBe(false);
});

it.each([401, 403, 404, 409])("does not resubmit on account/migration rejection %s", async status => {
    const fetch = vi.fn().mockImplementation(async () => response({ error: { message: "denied" } }, status));
    await expect(submitGptImageJob({ sessionGuard, apiKey: "shared", fetch, sleep: async () => {} }, "generations", { model: "gpt-image-2", prompt: "test" }, "stable")).rejects.toMatchObject({ status, preventResubmit: true });
    expect(fetch).toHaveBeenCalledTimes(1);
});

it("polls canceled to a terminal state and refuses malformed IDs before fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ job_id: "job-1", status: "canceled" }));
    expect((await pollGptImageJob({ sessionGuard, apiKey: "shared", fetch }, "job-1")).status).toBe("canceled");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(pollGptImageJob({ sessionGuard, apiKey: "shared", fetch }, "../elsewhere")).rejects.toThrow("任务 ID");
    expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps legacy same-key bounded admission retry semantics", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({}, 429)).mockResolvedValueOnce(response({ job_id: "job-1", status: "queued" }, 202));
    await submitGptImageJob({ sessionGuard, apiKey: "shared", fetch, sleep: async () => {} }, "edits", { model: "gpt-image-2", images: ["image"] }, "original-key");
    expect(fetch.mock.calls.map(c => c[1].headers["Idempotency-Key"])).toEqual(["original-key", "original-key"]);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
});
