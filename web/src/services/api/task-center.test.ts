import { describe, expect, it, vi } from "vitest";
import { createTaskCenterClient, type TaskSession, type TaskTarget } from "./task-center";
import { createTaskIntentStore } from "./intent-store";

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const row = (status = "running", extra = {}) => ({
    job_id: "job-1",
    status,
    elapsed_ms: 1234,
    created_at: 100,
    started_at: 200,
    finished_at: null,
    progress: { stage: "generating", percent: null },
    actions: { cancel: { allowed: false }, retry: { allowed: false, mode: null } },
    ...extra,
});
function setup(target: TaskTarget = { provider: "gpt" }) {
    let session: TaskSession | null = { accountId: "alice", channelId: "personal", revision: 1, apiKey: "fake-private-key" };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const data = new Map<string, string>();
    const intentStore = createTaskIntentStore(
        {
            getItem: (k) => data.get(k) ?? null,
            setItem: (k, v) => {
                data.set(k, v);
            },
        },
        async (_name, operation) => operation(),
    );
    const client = createTaskCenterClient({ target, getSession: () => session, fetch, sleep, intentStore });
    return {
        client,
        fetch,
        sleep,
        switch: (value: TaskSession | null) => {
            session = value;
        },
    };
}
const input = { provider: "gpt" as const, operation: "generations" as const, body: { model: "gpt-image-2", prompt: "private-prompt" } };

describe("shared task center HTTP client", () => {
    it.each<TaskTarget>([{ provider: "gpt" }, { provider: "fal", model: "esrgan" }, { provider: "fal", model: "flux-fill" }, { provider: "fal", model: "qwen-layered" }])("paginates a fixed source using current channel credentials: %j", async (target) => {
        const h = setup(target);
        h.fetch
            .mockResolvedValueOnce(response({ items: [row("succeeded", { result: { secret: true }, result_job_id: "job-1", queue_mode: "encrypted_persistent" })], next_cursor: "opaque_cursor", retention_ms: 604800000 }))
            .mockResolvedValueOnce(response({ items: [], next_cursor: null, retention_ms: 604800000 }));
        const first = await h.client.list({ limit: 3 });
        expect(first.items[0]).toMatchObject({ result: null, resultJobId: "job-1", elapsedMs: 1234, progress: { stage: "generating", percent: null }, queueMode: "encrypted_persistent" });
        expect(await h.client.list({ cursor: first.nextCursor, limit: 3 })).toMatchObject({ items: [], nextCursor: null });
        const root = target.provider === "gpt" ? "/api/providers/gpt/jobs" : `/api/providers/fal/jobs/${target.model}`;
        expect(h.fetch.mock.calls.map((c) => c[0])).toEqual([`${root}?limit=3`, `${root}?limit=3&cursor=opaque_cursor`]);
        expect(h.fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store", headers: { Authorization: "Bearer fake-private-key" } });
    });
    it("reuses immutable intent/key after a lost create response and never creates again after acceptance", async () => {
        const h = setup(),
            body = { ...input, body: { ...input.body } };
        const intent = await h.client.prepareIntent("local-1", body);
        expect(await h.client.prepareIntent("local-1", input)).toBe(intent);
        body.body.prompt = "changed";
        await expect(h.client.prepareIntent("local-1", body)).rejects.toMatchObject({ code: "conflict" });
        h.fetch
            .mockRejectedValueOnce(new Error("secret upstream body"))
            .mockResolvedValueOnce(response(row("queued"), 202))
            .mockResolvedValueOnce(response(row("uncertain")));
        await expect(h.client.submit(intent)).rejects.toMatchObject({ code: "network_error", preventResubmit: true });
        await h.client.submit(intent);
        await h.client.submit(intent);
        expect(h.fetch.mock.calls.map((c) => c[1]?.method)).toEqual(["POST", "POST", "GET"]);
        expect(h.fetch.mock.calls[0][1]?.body).toBe(h.fetch.mock.calls[1][1]?.body);
        expect(h.fetch.mock.calls[0][1]?.headers).toEqual(h.fetch.mock.calls[1][1]?.headers);
        expect(h.fetch.mock.calls[0][1]?.body).not.toContain("changed");
    });
    it("poll retries only reads with bounded backoff and preserves backend elapsed/stage", async () => {
        const h = setup();
        h.fetch
            .mockResolvedValueOnce(response({}, 503))
            .mockResolvedValueOnce(response(row()))
            .mockResolvedValueOnce(response(row("succeeded", { elapsed_ms: 4000, finished_at: 4100, progress: { stage: "succeeded", percent: 100 } })));
        const update = vi.fn();
        const task = await h.client.poll("job-1", { initialDelayMs: 10, maxAttempts: 3, onUpdate: update });
        expect(task).toMatchObject({ elapsedMs: 4000, finishedAt: 4100, progress: { percent: 100 } });
        expect(h.sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
        expect(update).toHaveBeenCalledTimes(2);
        expect(h.fetch.mock.calls.every((c) => c[1]?.method === "GET")).toBe(true);
    });
    it.each(["unknown", "uncertain", "recoverable", "future_state"])("stops polling on %s without manufacturing failure or submission", async (status) => {
        const h = setup();
        h.fetch.mockResolvedValue(response(row(status)));
        expect((await h.client.poll("job-1")).status).toBe(status === "future_state" ? "unknown" : status);
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });
    it("uses capability-gated cancel and read-only retry, never submit routes", async () => {
        const h = setup({ provider: "fal", model: "esrgan" });
        h.fetch
            .mockResolvedValueOnce(response(row("recoverable", { actions: { cancel: { allowed: true }, retry: { allowed: true, mode: "resume_query" } } })))
            .mockResolvedValueOnce(response(row("running", { progress: { stage: "cancel_requested", percent: null } })))
            .mockResolvedValueOnce(response(row()));
        const task = await h.client.get("job-1");
        expect((await h.client.cancel(task)).status).toBe("running");
        await h.client.resumeQuery(task);
        expect(h.fetch.mock.calls.slice(1).map((c) => [c[0], c[1]?.headers])).toEqual([
            ["/api/providers/fal/jobs/esrgan/job-1", { "X-Job-Action": "cancel", Authorization: "Bearer fake-private-key" }],
            ["/api/providers/fal/jobs/esrgan/job-1", { "X-Job-Action": "retry", Authorization: "Bearer fake-private-key" }],
        ]);
    });
    it("blocks disabled/unknown actions and cross-client task handles", async () => {
        const h = setup();
        h.fetch.mockResolvedValue(response(row("unknown", { actions: { cancel: { allowed: true }, retry: { allowed: true, mode: "resume_query" } } })));
        const task = await h.client.get("job-1");
        await expect(h.client.cancel(task)).rejects.toMatchObject({ code: "action_disabled" });
        await expect(h.client.resumeQuery(task)).rejects.toMatchObject({ code: "action_disabled" });
        await expect(setup().client.cancel(task)).rejects.toMatchObject({ code: "action_disabled" });
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });
    it.each(["account", "channel", "key", "revision", "logout"])("discards delayed responses on %s switch", async (kind) => {
        const h = setup();
        let finish!: (r: Response) => void;
        h.fetch.mockImplementation(
            () =>
                new Promise((r) => {
                    finish = r;
                }),
        );
        const update = vi.fn(),
            pending = h.client.poll("job-1", { onUpdate: update });
        h.switch(kind === "logout" ? null : { accountId: kind === "account" ? "bob" : "alice", channelId: kind === "channel" ? "second" : "personal", revision: kind === "revision" ? 3 : 1, apiKey: kind === "key" ? "other-key" : "fake-private-key" });
        finish(response(row("succeeded")));
        await expect(pending).rejects.toMatchObject({ code: "session_changed" });
        expect(update).not.toHaveBeenCalled();
        await expect(h.client.list()).rejects.toMatchObject({ code: "session_changed" });
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });
    it("checks session again after decoding JSON and rejects aborted requests even if fetch ignores abort", async () => {
        const h = setup();
        let json!: (v: unknown) => void;
        h.fetch.mockResolvedValue({
            status: 200,
            json: () =>
                new Promise((r) => {
                    json = r;
                }),
        } as Response);
        const pending = h.client.get("job-1");
        await Promise.resolve();
        h.client.dispose();
        json(row());
        await expect(pending).rejects.toMatchObject({ code: "session_changed" });
        const g = setup(),
            controller = new AbortController();
        g.fetch.mockImplementation(async () => {
            controller.abort();
            return response(row());
        });
        await expect(g.client.get("job-1", controller.signal)).rejects.toMatchObject({ code: "aborted" });
        expect(g.fetch.mock.calls[0][1]?.method).toBe("GET");
    });
    it("never exposes raw HTTP/transport/task errors or response envelopes", async () => {
        const h = setup();
        h.fetch
            .mockResolvedValueOnce(response({ error: { message: "fake-private-key private-prompt https://secret", code: "private_key" } }, 500))
            .mockResolvedValueOnce(response(row("failed", { sealed: "secret", error: { message: "fake-private-key", code: "private_key" } })));
        await expect(h.client.list()).rejects.toMatchObject({ code: "service_unavailable", message: "任务服务暂不可用" });
        const task = await h.client.get("job-1");
        expect(JSON.stringify(task)).not.toMatch(/fake-private-key|sealed|private_key/);
        expect(task.error?.code).toBe("task_error");
    });
    it("rejects invalid pagination/IDs, malformed results and mismatched detail IDs", async () => {
        const h = setup();
        await expect(h.client.list({ limit: 51 })).rejects.toMatchObject({ code: "invalid_request" });
        await expect(h.client.get("../other")).rejects.toMatchObject({ code: "invalid_request" });
        expect(h.fetch).not.toHaveBeenCalled();
        h.fetch.mockResolvedValueOnce(response({ items: [], next_cursor: 42 })).mockResolvedValueOnce(response({ ...row(), job_id: "other" }));
        await expect(h.client.list()).rejects.toMatchObject({ code: "invalid_response" });
        await expect(h.client.get("job-1")).rejects.toMatchObject({ code: "invalid_response" });
    });
    it("Fal capacity rejection retains the same key/body and has no automatic submit retry", async () => {
        const h = setup({ provider: "fal", model: "qwen-layered" });
        const intent = await h.client.prepareIntent("commerce-intent", { provider: "fal", payload: { image_url: "private-image" } });
        h.fetch.mockResolvedValueOnce(response({}, 429)).mockResolvedValueOnce(response(row("queued"), 202));
        await expect(h.client.submit(intent)).rejects.toMatchObject({ code: "capacity" });
        expect(h.fetch).toHaveBeenCalledTimes(1);
        await h.client.submit(intent);
        expect(h.fetch.mock.calls.map((c) => c[0])).toEqual(["/api/providers/fal/jobs/qwen-layered", "/api/providers/fal/jobs/qwen-layered"]);
        expect(h.fetch.mock.calls[0][1]?.body).toBe(JSON.stringify({ image_url: "private-image" }));
        expect(h.fetch.mock.calls[0][1]?.headers).toEqual(h.fetch.mock.calls[1][1]?.headers);
    });
    it("does not replay expired or foreign intent handles", async () => {
        const h = setup();
        const time = vi.spyOn(Date, "now").mockReturnValue(100);
        try {
            const intent = await h.client.prepareIntent("old", input);
            time.mockReturnValue(100 + 7 * 86400000);
            await expect(h.client.submit(intent)).rejects.toMatchObject({ code: "intent_expired" });
            await expect(setup().client.submit(intent)).rejects.toMatchObject({ code: "invalid_request" });
            expect(h.fetch).not.toHaveBeenCalled();
        } finally {
            time.mockRestore();
        }
    });
    it("404 and exhausted read polling never POST", async () => {
        const h = setup();
        h.fetch.mockResolvedValue(response({}, 404));
        await expect(h.client.poll("job-1")).rejects.toMatchObject({ code: "not_found" });
        h.fetch.mockImplementation(async () => response(row()));
        await expect(h.client.poll("job-1", { maxAttempts: 2 })).rejects.toMatchObject({ code: "poll_timeout" });
        expect(h.fetch.mock.calls.every((c) => c[1]?.method === "GET")).toBe(true);
    });
});
