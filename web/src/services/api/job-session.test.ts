import { describe, it, expect, vi } from "vitest";
import { submitGptImageJob, pollGptImageJob } from "./gpt-jobs";
import { submitFalJob, pollFalJob, cancelFalJob } from "./fal-jobs";

const response = (status = 200, state = "running") => new Response(JSON.stringify({ job_id: "job-1", status: state }), { status });
const live = () => {
    let state = { accountId: "101", channelId: "shared", revision: 1 };
    return { config: { apiKey: "shared-key", sessionGuard: () => state }, change: (aba = false) => { state = { ...state, accountId: aba ? "101" : "202", revision: state.revision + (aba ? 2 : 1) }; } };
};
describe("legacy job session barriers", () => {
    it("fails closed without a guard before any network request", async () => {
        const fetch = vi.fn();
        await expect(submitGptImageJob({ apiKey: "key", fetch }, "generations", {})).rejects.toMatchObject({ code: "session_guard_required", preventResubmit: true });
        await expect(submitFalJob({ apiKey: "key" }, "esrgan", {}, { fetch })).rejects.toMatchObject({ code: "session_guard_required" });
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each([false, true])("blocks lost-response and 429 retries after switch (ABA=%s)", async aba => {
        for (const lost of [false, true]) {
            const h = live();
            const fetch = vi.fn(async () => { if (lost) throw new TypeError("lost response"); return response(429); });
            await expect(submitGptImageJob({ ...h.config, fetch, sleep: async () => h.change(aba) }, "generations", {}, "fixed-intent")).rejects.toMatchObject({ code: "session_changed", retryable: false });
            expect(fetch).toHaveBeenCalledTimes(1);
        }
    });
    it.each(["gpt", "fal"])("%s rejects stale responses without publishing updates", async kind => {
        const h = live(), onUpdate = vi.fn();
        const fetch = vi.fn(async () => { h.change(); return response(); });
        const result = kind === "gpt" ? pollGptImageJob({ ...h.config, fetch }, "job-1", { onUpdate }) : pollFalJob(h.config, "esrgan", "job-1", { fetch, onUpdate });
        await expect(result).rejects.toMatchObject({ code: "session_changed" });
        expect(onUpdate).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
    });
    it.each(["gpt", "fal"])("%s checks callbacks and poll sleeps against the original revision", async kind => {
        for (const duringCallback of [false, true]) {
            const h = live(), fetch = vi.fn(async () => response());
            const opts = { fetch, onUpdate: async () => { await Promise.resolve(); if (duringCallback) h.change(true); }, sleep: async () => h.change(true) };
            const result = kind === "gpt" ? pollGptImageJob({ ...h.config, fetch }, "job-1", opts) : pollFalJob(h.config, "esrgan", "job-1", opts);
            await expect(result).rejects.toMatchObject({ code: "session_changed" }); expect(fetch).toHaveBeenCalledTimes(1);
        }
    });
    it("discards a Fal cancel response after switching", async () => {
        const h = live(), fetch = vi.fn(async () => { h.change(true); return response(200, "canceled"); });
        await expect(cancelFalJob(h.config, "esrgan", "job-1", { fetch })).rejects.toMatchObject({ code: "session_changed" });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it.each(["gpt", "fal"])("%s converts verified-cookie precondition conflict into a nonretryable session error", async kind => {
        const h = live(), fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: { code: "account_changed", message: "account_changed" } }), { status: 409 }));
        const result = kind === "gpt" ? submitGptImageJob({ ...h.config, fetch }, "generations", {}) : submitFalJob(h.config, "esrgan", {}, { fetch });
        await expect(result).rejects.toMatchObject({ code: "session_changed", preventResubmit: true });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("X-Task-User")).toBe("101");
    });
});
