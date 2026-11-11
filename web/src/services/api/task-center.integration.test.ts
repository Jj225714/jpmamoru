import { expect, it, onTestFinished } from "vitest";
import http, { type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskCenterClient, type TaskSession, type TaskTarget } from "./task-center";
import { createTaskIntentStore } from "./intent-store";

const alice: TaskSession = { accountId: "alice", channelId: "private-channel-a", revision: 1, apiKey: "TEST_PRIVATE_KEY_A" };
const input = (prompt: string) => ({ provider: "gpt" as const, operation: "generations" as const, body: { model: "gpt-image-2", prompt } });
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown | Promise<unknown>) {
    const end = Date.now() + 15000;
    while (!(await check())) {
        if (Date.now() > end) throw new Error("Integration condition timed out");
        await wait();
    }
}
const reply = (res: ServerResponse, body: unknown, status = 200) => {
    if (!res.destroyed && !res.writableEnded) res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
};
type Snapshot = { type: string; gpt: Array<{ id: string; status: string; queue: string }>; fal: Array<{ id: string; status: string; queue: string; providerId?: string }> };
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "task-contract-http-")),
        path = join(directory, "jobs.json");
    const calls: Array<{ provider: string; name: string }> = [],
        reads: string[] = [],
        held: ServerResponse[] = [];
    const records = new Map<string, string>();
    let hold = true,
        queryFailure = true,
        child: ChildProcess | undefined,
        origin = "";
    const upstream = http.createServer(async (req, res) => {
        if (req.url === "/api/config-vault/session") {
            const cookie = req.headers.cookie;
            if (cookie === "__Secure-provider_tasks=" + "A".repeat(43)) return reply(res, { user: { id: "101" } });
            if (cookie === "__Secure-provider_tasks=" + "B".repeat(43)) return reply(res, { user: { id: "202" } });
            return reply(res, {}, 401);
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (req.url === "/v1/images/generations") {
            calls.push({ provider: "gpt", name: body.prompt });
            if (body.prompt === "gpt-fail") return reply(res, { error: "mock rejection" }, 400);
            if (body.prompt.startsWith("gpt-hold") && hold) {
                held.push(res);
                return;
            }
            return reply(res, { data: [{ b64_json: "aGVsbG8=", mime_type: "image/png" }] });
        }
        const action = req.url?.split("/").at(-1),
            value = body.value;
        if (action === "submit") {
            const name = value.prompt;
            calls.push({ provider: "fal", name });
            if (name === "fal-noid" && hold) {
                held.push(res);
                return;
            }
            const id = "provider-" + name;
            records.set(id, name);
            return reply(res, { request_id: id });
        }
        const name = records.get(value);
        if (action === "status") {
            reads.push(value);
            if (name === "fal-read" && hold) {
                held.push(res);
                return;
            }
            if (name === "fal-recover" && queryFailure) return reply(res, {}, 503);
            return reply(res, { status: name === "fal-fail" ? "FAILED" : "COMPLETED" });
        }
        if (action === "result") return reply(res, { images: [{ url: "https://fal.media/test-only.png" }] });
        if (action === "cancel") return reply(res, {});
        reply(res, {}, 404);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    const kill = async () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const end = once(child, "exit");
        child.kill("SIGKILL");
        await end;
    };
    onTestFinished(async () => {
        await kill();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    });
    const start = async () => {
        child = spawn(process.execPath, [fileURLToPath(new URL("./task-center.integration-relay.mjs", import.meta.url))], {
            // Public authority is part of verified ownership; preserve it across process restart.
            env: { ...process.env, TASK_TEST_STORE: path, TASK_TEST_UPSTREAM: `http://127.0.0.1:${address.port}/`, TASK_TEST_PORT: origin ? new URL(origin).port : "0" },
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let ready = false,
            error = "";
        child.stderr?.on("data", (chunk) => {
            error += chunk.toString();
        });
        child.on("message", (message: { type: string; origin: string }) => {
            if (message.type === "ready") {
                origin = message.origin;
                ready = true;
            }
        });
        await until(() => {
            if (child?.exitCode !== null) throw new Error("Relay child failed: " + error);
            return ready;
        });
    };
    const snapshot = async () => {
        const result = once(child!, "message");
        child!.send("snapshot");
        return (await result)[0] as Snapshot;
    };
    const metadata = new Map<string, string>();
    let tail = Promise.resolve();
    const store = () =>
        createTaskIntentStore(
            {
                getItem: (k) => metadata.get(k) ?? null,
                setItem: (k, value) => {
                    metadata.set(k, value);
                },
            },
            async (_key, operation) => {
                const previous = tail;
                let release!: () => void;
                tail = new Promise<void>((r) => {
                    release = r;
                });
                await previous;
                try {
                    return await operation();
                } finally {
                    release();
                }
            },
        );
    // This is a Node browser-origin adapter, NOT a mock fetch: every request crosses real HTTP.
    const client = (target: TaskTarget = { provider: "gpt" }, initial = alice, afterResponse?: (response: Response) => Promise<void>) => {
        let session: TaskSession | null = initial;
        const requests: Array<{ url: string; method: string }> = [];
        const fetchHTTP: typeof fetch = async (url, init) => {
            requests.push({ url: String(url), method: init?.method || "GET" });
            const headers = new Headers(init?.headers);
            headers.set("Origin", origin);
            headers.set("Cookie", "__Secure-provider_tasks=" + (session?.accountId === "alice" ? "A" : "B").repeat(43));
            headers.set("Sec-Fetch-Site", "same-origin");
            const response = await fetch(new URL(String(url), origin), { ...init, headers });
            await afterResponse?.(response);
            return response;
        };
        return {
            api: createTaskCenterClient({ target, getSession: () => session, fetch: fetchHTTP, intentStore: store() }),
            requests,
            switch: (next: TaskSession | null) => {
                session = next;
            },
        };
    };
    await start();
    return {
        path,
        calls,
        reads,
        metadata,
        client,
        async probe(path: string, action: string, credential = alice.apiKey, requestOrigin?: string) {
            const response = await fetch(new URL(path, origin), {
                method: "POST",
                headers: { Origin: requestOrigin ?? origin, Cookie: "__Secure-provider_tasks=" + (credential === alice.apiKey ? "A" : "B").repeat(43), Authorization: `Bearer ${credential}`, "X-Job-Action": action },
            });
            await response.arrayBuffer();
            return response.status;
        },
        snapshot,
        restart: async () => {
            await kill();
            hold = false;
            held.forEach((res) => res.destroy());
            await start();
        },
        enableQueries: () => {
            queryFailure = false;
        },
    };
}

it("real GPT routes: five-task queue, pagination, cancel, refresh, lost response, owner switch and process kill", async () => {
    const h = await fixture(),
        a = h.client();
    const completedIntent = await a.api.prepareIntent("complete", input("gpt-complete"));
    const completed = await a.api.submit(completedIntent);
    const completeTask = await a.api.poll(completed.jobId, { initialDelayMs: 5, maxDelayMs: 20 });
    expect(completeTask.status).toBe("succeeded");
    const batch = [];
    for (let i = 0; i < 5; i++) batch.push(await a.api.submit(await a.api.prepareIntent(`batch-${i}`, input(`gpt-hold-${i}`))));
    await until(() => h.calls.filter((c) => c.name.startsWith("gpt-hold")).length === 2);
    const before = await h.snapshot();
    expect(before.gpt.filter((j) => j.queue === "waiting")).toHaveLength(3);
    const pages = [],
        ids = new Set<string>();
    let cursor: string | null = null;
    do {
        const page = await a.api.list({ limit: 2, cursor });
        pages.push(page);
        page.items.forEach((item) => ids.add(item.jobId));
        cursor = page.nextCursor;
    } while (cursor);
    expect(ids.size).toBe(6);
    expect(pages).toHaveLength(3);
    expect((await a.api.cancel(await a.api.get(batch[4].jobId))).status).toBe("canceled");
    await expect(a.api.cancel(await a.api.get(batch[0].jobId))).rejects.toMatchObject({ code: "action_disabled" });
    const bob = h.client({ provider: "gpt" }, { ...alice, accountId: "bob", apiKey: "TEST_PRIVATE_KEY_B" });
    expect((await bob.api.list()).items).toHaveLength(0);
    await expect(bob.api.get(completed.jobId)).rejects.toMatchObject({ code: "not_found" });
    expect(await h.probe(`/api/providers/gpt/jobs/${batch[0].jobId}`, "cancel")).toBe(409);
    expect(await h.probe(`/api/providers/gpt/jobs/${completed.jobId}`, "retry")).toBe(409);
    expect(await h.probe(`/api/providers/gpt/jobs/${completed.jobId}`, "cancel", "TEST_PRIVATE_KEY_B")).toBe(404);
    expect(await h.probe(`/api/providers/gpt/jobs/${completed.jobId}`, "cancel", alice.apiKey, "https://foreign.invalid")).toBe(403);
    let release!: () => void,
        arrived = false;
    const delayed = h.client({ provider: "gpt" }, alice, async () => {
        arrived = true;
        await new Promise<void>((r) => {
            release = r;
        });
    });
    const pending = delayed.api.get(completed.jobId);
    await until(() => arrived);
    delayed.switch({ ...alice, accountId: "bob", revision: 2 });
    delayed.switch({ ...alice, revision: 3 });
    release();
    await expect(pending).rejects.toMatchObject({ code: "session_changed" });
    await h.snapshot();
    await h.restart();
    const refreshed = h.client(),
        restored = await refreshed.api.restoreIntents("gpt-image-2");
    expect(restored.find((r) => r.intent.intentId === "complete")?.intent.idempotencyKey).toBe(completedIntent.idempotencyKey);
    expect((await refreshed.api.submit(restored.find((r) => r.intent.intentId === "complete")!.intent)).result).toEqual(completeTask.result);
    for (const task of batch.slice(0, 2)) expect((await refreshed.api.get(task.jobId)).status).toBe("uncertain");
    for (const task of batch.slice(2, 4)) expect((await refreshed.api.poll(task.jobId, { initialDelayMs: 5, maxDelayMs: 20 })).status).toBe("succeeded");
    expect((await refreshed.api.get(batch[4].jobId)).status).toBe("canceled");
    expect(h.calls.filter((c) => c.name.startsWith("gpt-hold"))).toHaveLength(4);
    const failure = await refreshed.api.submit(await refreshed.api.prepareIntent("fail", input("gpt-fail")));
    expect((await refreshed.api.poll(failure.jobId, { initialDelayMs: 5, maxDelayMs: 20 })).status).toBe("failed");
    const lost = h.client({ provider: "gpt" }, alice, async (response) => {
        await response.text();
        throw new Error("simulated response loss AFTER real server acceptance");
    });
    const lostIntent = await lost.api.prepareIntent("lost", input("gpt-lost"));
    await expect(lost.api.submit(lostIntent)).rejects.toMatchObject({ code: "network_error" });
    const recovery = h.client(),
        lostRestored = (await recovery.api.restoreIntents("gpt-image-2")).find((r) => r.intent.intentId === "lost")!;
    expect(lostRestored.intent.idempotencyKey).toBe(lostIntent.idempotencyKey);
    await expect(recovery.api.submit(lostRestored.intent)).rejects.toMatchObject({ code: "intent_input_required" });
    const same = await recovery.api.prepareIntent("lost", input("gpt-lost"), { confirmedSameInput: true });
    const recovered = await recovery.api.submit(same);
    expect((await recovery.api.poll(recovered.jobId, { initialDelayMs: 5, maxDelayMs: 20 })).status).toBe("succeeded");
    expect(h.calls.filter((c) => c.name === "gpt-lost")).toHaveLength(1);
    expect(new Set(h.calls.map((c) => c.name)).size).toBe(h.calls.length);
    const raw = await readFile(h.path + ".gpt", "utf8");
    expect(raw).not.toContain(alice.apiKey);
    expect([...h.metadata.values()].join()).not.toContain("gpt-lost");
    console.info("GPT evidence: 5 batch intents => 2 uncertain, 2 succeeded, 1 locally canceled; lost-response intent => 1 upstream call; completed result survives kill.");
}, 40000);

it("real Fal routes: five-task queue, no-ID uncertainty, query-only restart, recovery actions and no resubmits", async () => {
    const h = await fixture(),
        a = h.client({ provider: "fal", model: "esrgan" });
    const names = ["fal-read", "fal-noid", "fal-wait-2", "fal-wait-3", "fal-wait-4"],
        batch = [];
    for (const name of names) batch.push(await a.api.submit(await a.api.prepareIntent(name, { provider: "fal", payload: { prompt: name } })));
    await until(async () => {
        const s = await h.snapshot();
        return s.fal.some((j) => j.providerId) && s.fal.filter((j) => j.queue === "waiting").length === 3;
    });
    const first = await a.api.list({ limit: 2 }),
        second = await a.api.list({ limit: 2, cursor: first.nextCursor });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((t) => t.jobId)).size).toBe(4);
    expect((await a.api.cancel(await a.api.get(batch[4].jobId))).status).toBe("canceled");
    await expect(a.api.cancel(await a.api.get(batch[1].jobId))).rejects.toMatchObject({ code: "action_disabled" });
    expect(await h.probe(`/api/providers/fal/jobs/esrgan/${batch[1].jobId}`, "cancel")).toBe(409);
    expect(await h.probe(`/api/providers/fal/jobs/esrgan/${batch[0].jobId}`, "retry", "TEST_PRIVATE_KEY_B")).toBe(404);
    const foreign = h.client({ provider: "fal", model: "esrgan" }, { ...alice, accountId: "bob", apiKey: "TEST_PRIVATE_KEY_B" });
    expect((await foreign.api.list()).items).toHaveLength(0);
    const pending = await a.api.cancel(await a.api.get(batch[0].jobId));
    expect(pending.status).not.toBe("canceled");
    expect(pending.progress.stage).toBe("cancel_requested");
    await h.snapshot();
    await h.restart();
    const b = h.client({ provider: "fal", model: "esrgan" });
    for (const i of [0, 2, 3]) expect((await b.api.poll(batch[i].jobId, { initialDelayMs: 5, maxDelayMs: 20 })).status).toBe("succeeded");
    expect((await b.api.get(batch[1].jobId)).status).toBe("uncertain");
    expect(await h.probe(`/api/providers/fal/jobs/esrgan/${batch[1].jobId}`, "retry")).toBe(409);
    expect(h.reads.filter((id) => id === "provider-fal-read").length).toBeGreaterThanOrEqual(2);
    expect(h.calls).toHaveLength(4);
    expect(new Set(h.calls.map((c) => c.name)).size).toBe(4);
    const recover = await b.api.submit(await b.api.prepareIntent("recover", { provider: "fal", payload: { prompt: "fal-recover" } }));
    await until(async () => (await h.snapshot()).fal.find((j) => j.id === recover.jobId)?.status === "recoverable");
    // List is side-effect free, unlike legacy Fal GET which may start query recovery.
    const recoverable = (await b.api.list()).items.find((t) => t.jobId === recover.jobId)!;
    expect(recoverable.actions.retry.allowed).toBe(true);
    h.enableQueries();
    await b.api.resumeQuery(recoverable);
    expect((await b.api.poll(recover.jobId, { initialDelayMs: 5, maxDelayMs: 20 })).status).toBe("succeeded");
    expect(h.calls.filter((c) => c.name === "fal-recover")).toHaveLength(1);
    const failure = await b.api.submit(await b.api.prepareIntent("failure", { provider: "fal", payload: { prompt: "fal-fail" } }));
    expect((await b.api.poll(failure.jobId, { initialDelayMs: 5, maxDelayMs: 20 })).status).toBe("failed");
    const saved = await b.api.get(batch[0].jobId);
    await h.snapshot();
    await h.restart();
    const final = h.client({ provider: "fal", model: "esrgan" });
    expect((await final.api.get(batch[0].jobId)).result).toEqual(saved.result);
    const restored = (await final.api.restoreIntents("esrgan")).find((r) => r.intent.intentId === "fal-read")!;
    expect((await final.api.submit(restored.intent)).jobId).toBe(batch[0].jobId);
    expect(h.calls).toHaveLength(6);
    expect(new Set(h.calls.map((c) => c.name)).size).toBe(6);
    console.info("Fal evidence: 5 batch intents => 3 succeeded, 1 uncertain, 1 locally canceled; existing ID resumes reads; explicit recovery => 1 submit; two process restarts => 0 duplicate submits.");
}, 40000);
