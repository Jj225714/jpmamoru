import { describe, expect, it, vi } from "vitest";
import { createTaskIntentStore } from "./intent-store";
import { createTaskCenterClient, type TaskSession, type TaskTarget } from "./task-center";

const input = { provider: "gpt" as const, operation: "generations" as const, body: { model: "gpt-image-2", prompt: "SENSITIVE_PROMPT", images: ["data:image/png;base64,SENSITIVE_IMAGE"] } };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const job = (extra = {}) => ({ job_id: "job-1", status: "succeeded", ...extra });
const alice: TaskSession = { accountId: "alice", channelId: "channel-a", apiKey: "SENSITIVE_API_KEY", revision: 1 };
function fixture() {
    const data = new Map<string, string>();
    let failWrite = false,
        tail = Promise.resolve();
    const storage = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => {
            if (failWrite) throw new Error("disk unavailable");
            data.set(k, v);
        },
    };
    const store = createTaskIntentStore(storage, async (_name, operation) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    });
    const client = (session = alice, target: TaskTarget = { provider: "gpt" }) => {
        let current: TaskSession | null = session;
        const fetch = vi.fn<typeof globalThis.fetch>();
        return {
            api: createTaskCenterClient({ target, getSession: () => current, fetch, intentStore: store }),
            fetch,
            switch: (next: TaskSession | null) => {
                current = next;
            },
        };
    };
    return {
        data,
        store,
        client,
        failWrites: () => {
            failWrite = true;
        },
    };
}

describe("persistent task intents", () => {
    it("refresh restores the original key/known ID and only GETs even with expired results or 404", async () => {
        const f = fixture(),
            first = f.client();
        const intent = await first.api.prepareIntent("intent-1", input);
        first.fetch.mockResolvedValue(response(job(), 202));
        await first.api.submit(intent);
        first.api.dispose();
        const second = f.client();
        const [restored] = await second.api.restoreIntents("gpt-image-2");
        expect(restored).toMatchObject({ intent: { idempotencyKey: intent.idempotencyKey }, jobId: "job-1", needsInputReview: false });
        second.fetch.mockResolvedValueOnce(response(job({ result_expired: true, result: null }))).mockResolvedValueOnce(response({}, 404));
        expect((await second.api.submit(restored.intent)).resultExpired).toBe(true);
        await expect(second.api.submit(restored.intent)).rejects.toMatchObject({ code: "not_found" });
        expect(second.fetch.mock.calls.map((c) => c[1]?.method)).toEqual(["GET", "GET"]);
        const raw = [...f.data.keys(), ...f.data.values()].join("");
        for (const secret of ["SENSITIVE_API_KEY", "SENSITIVE_PROMPT", "SENSITIVE_IMAGE", "data:image"]) expect(raw).not.toContain(secret);
        expect(raw).toContain(intent.idempotencyKey);
        expect(raw).toContain("job-1");
    });
    it("disconnect then refresh requires explicit same-input review and retains key/body", async () => {
        const f = fixture(),
            first = f.client();
        const intent = await first.api.prepareIntent("intent-1", input);
        first.fetch.mockRejectedValue(new Error("connection lost"));
        await expect(first.api.submit(intent)).rejects.toMatchObject({ code: "network_error" });
        first.api.dispose();
        const second = f.client(),
            [restored] = await second.api.restoreIntents("gpt-image-2");
        expect(restored.needsInputReview).toBe(true);
        await expect(second.api.submit(restored.intent)).rejects.toMatchObject({ code: "intent_input_required" });
        await expect(second.api.prepareIntent("intent-1", input)).rejects.toMatchObject({ code: "intent_input_required" });
        await expect(second.api.prepareIntent("intent-1", { ...input, body: { ...input.body, prompt: "changed" } }, { confirmedSameInput: true })).rejects.toMatchObject({ code: "conflict" });
        expect(second.fetch).not.toHaveBeenCalled();
        const recovered = await second.api.prepareIntent("intent-1", input, { confirmedSameInput: true });
        expect(recovered.idempotencyKey).toBe(intent.idempotencyKey);
        second.fetch.mockResolvedValue(response(job({ status: "uncertain" }), 202));
        expect((await second.api.submit(recovered)).status).toBe("uncertain");
        expect(second.fetch.mock.calls[0][1]?.body).toBe(first.fetch.mock.calls[0][1]?.body);
        expect(second.fetch.mock.calls[0][1]?.headers).toEqual(first.fetch.mock.calls[0][1]?.headers);
    });
    it("isolates account/channel/provider/model and restores A after A -> B -> A without reviving old client", async () => {
        const f = fixture(),
            a = f.client();
        const original = await a.api.prepareIntent("same-id", input);
        a.switch({ ...alice, accountId: "bob", revision: 2 });
        await expect(a.api.restoreIntents("gpt-image-2")).rejects.toMatchObject({ code: "session_changed" });
        a.switch({ ...alice, revision: 3 });
        await expect(a.api.submit(original)).rejects.toMatchObject({ code: "session_changed" });
        for (const client of [f.client({ ...alice, accountId: "bob" }), f.client({ ...alice, channelId: "channel-b" })]) {
            expect(await client.api.restoreIntents("gpt-image-2")).toEqual([]);
            expect((await client.api.prepareIntent("same-id", input)).idempotencyKey).not.toBe(original.idempotencyKey);
        }
        expect(await f.client().api.restoreIntents("gpt-image-1")).toEqual([]);
        const fal = f.client(alice, { provider: "fal", model: "esrgan" });
        expect(await fal.api.restoreIntents("esrgan")).toEqual([]);
        const [restored] = await f.client({ ...alice, revision: 3 }).api.restoreIntents("gpt-image-2");
        expect(restored.intent.idempotencyKey).toBe(original.idempotencyKey);
    });
    it("never renews the replay window on refresh; known IDs remain queryable after window expiry", async () => {
        const f = fixture(),
            time = vi.spyOn(Date, "now").mockReturnValue(100);
        try {
            const a = f.client(),
                unknown = await a.api.prepareIntent("unknown", input),
                known = await a.api.prepareIntent("known", input);
            a.fetch.mockResolvedValue(response(job(), 202));
            await a.api.submit(known);
            time.mockReturnValue(100 + 7 * 86400000);
            const b = f.client(),
                restored = await b.api.restoreIntents("gpt-image-2");
            expect(restored.every((r) => r.expired)).toBe(true);
            const old = restored.find((r) => r.intent.intentId === "unknown")!;
            expect(old.intent.idempotencyKey).toBe(unknown.idempotencyKey);
            await expect(b.api.prepareIntent("unknown", input, { confirmedSameInput: true })).rejects.toMatchObject({ code: "intent_expired" });
            await expect(b.api.submit(old.intent)).rejects.toMatchObject({ code: "intent_expired" });
            b.fetch.mockResolvedValue(response(job({ result_expired: true })));
            await b.api.submit(restored.find((r) => r.intent.intentId === "known")!.intent);
            expect(b.fetch).toHaveBeenCalledTimes(1);
            expect(b.fetch.mock.calls[0][1]?.method).toBe("GET");
        } finally {
            time.mockRestore();
        }
    });
    it("storage failure before create makes zero network calls, corrupt records never produce replacement keys", async () => {
        const f = fixture(),
            a = f.client();
        f.failWrites();
        await expect(a.api.prepareIntent("id", input)).rejects.toMatchObject({ code: "intent_storage_unavailable" });
        expect(a.fetch).not.toHaveBeenCalled();
        const g = fixture(),
            b = g.client();
        await b.api.prepareIntent("id", input);
        const key = [...g.data.keys()][0];
        g.data.set(key, "broken-json");
        await expect(g.client().api.prepareIntent("id", input)).rejects.toMatchObject({ code: "intent_storage_unavailable" });
        await expect(g.client().api.restoreIntents("gpt-image-2")).rejects.toMatchObject({ code: "intent_storage_unavailable" });
        expect(g.data.get(key)).toBe("broken-json");
    });
    it("known ID stays read-only in memory if post-acceptance metadata write fails", async () => {
        const f = fixture(),
            a = f.client();
        const intent = await a.api.prepareIntent("id", input);
        a.fetch
            .mockImplementationOnce(async () => {
                f.failWrites();
                return response(job(), 202);
            })
            .mockResolvedValueOnce(response(job()));
        await expect(a.api.submit(intent)).rejects.toMatchObject({ code: "intent_storage_unavailable" });
        expect((await a.api.submit(intent)).jobId).toBe("job-1");
        expect(a.fetch.mock.calls.map((c) => c[1]?.method)).toEqual(["POST", "GET"]);
        const [restored] = await f.client().api.restoreIntents("gpt-image-2");
        expect(restored.intent.idempotencyKey).toBe(intent.idempotencyKey);
        expect(restored.needsInputReview).toBe(true);
    });
    it("serializes concurrent clients so only one stable key is stored", async () => {
        const f = fixture(),
            a = f.client(),
            b = f.client();
        const attempts = await Promise.allSettled([a.api.prepareIntent("id", input), b.api.prepareIntent("id", input)]);
        expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
        const restoredA = await a.api.restoreIntents("gpt-image-2"),
            restoredB = await b.api.restoreIntents("gpt-image-2");
        expect(restoredA[0].intent.idempotencyKey).toBe(restoredB[0].intent.idempotencyKey);
        expect(JSON.parse([...f.data.values()][0])).toHaveLength(1);
    });
    it("Fal refresh preserves raw JSON fingerprint semantics and original model scope", async () => {
        const f = fixture(),
            target = { provider: "fal" as const, model: "esrgan" as const };
        const a = f.client(alice, target);
        const intent = await a.api.prepareIntent("fal-id", { provider: "fal", payload: { image_url: "sensitive", scale: 2 } });
        const b = f.client(alice, target);
        await expect(b.api.prepareIntent("fal-id", { provider: "fal", payload: { scale: 2, image_url: "sensitive" } }, { confirmedSameInput: true })).rejects.toMatchObject({ code: "conflict" });
        const [restored] = await b.api.restoreIntents("esrgan");
        expect(restored.intent.idempotencyKey).toBe(intent.idempotencyKey);
        expect(await f.client(alice, { provider: "fal", model: "flux-fill" }).api.restoreIntents("flux-fill")).toEqual([]);
    });
});
