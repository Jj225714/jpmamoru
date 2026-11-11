import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/services/api/task-center";
import { TaskBoard, type TaskReader } from "./board";
import { CompletionLedger, notificationPermission, requestTaskNotificationPermission } from "./notifications-core";
import { elapsedLabel, stageLabel, taskResultLinks, taskStatusLabels } from "./presentation";
const task = (status: Task["status"] = "queued", jobId = "one"): Task => ({ jobId, status, target: { provider: "gpt" }, model: "gpt-image-2", createdAt: 10, updatedAt: 20, startedAt: null, finishedAt: null, elapsedMs: 1000, progress: { stage: status, percent: null }, queueMode: "admission_only", actions: { cancel: { allowed: false }, retry: { allowed: false, mode: null } }, result: null, resultJobId: null, resultExpired: false, expiresAt: null, error: null });
const page = (items = [task()], nextCursor: string | null = null) => ({ items, nextCursor, retentionMs: 1000 });
const client = () => ({ list: vi.fn().mockResolvedValue(page()), get: vi.fn().mockResolvedValue(task()), cancel: vi.fn().mockResolvedValue(task("canceled")), resumeQuery: vi.fn().mockResolvedValue(task("running")), dispose: vi.fn() }) satisfies TaskReader;
afterEach(() => vi.unstubAllGlobals());

describe("task list and safe actions", () => {
    it("pages independently, goes back and refreshes the first page", async () => {
        const api = client(); api.list.mockResolvedValueOnce(page([task()], "opaque"));
        const board = new TaskBoard(api); await board.load(); await board.next();
        expect(api.list.mock.calls[1][0].cursor).toBe("opaque"); expect(board.getSnapshot().history).toEqual([null]);
        await board.back(); expect(board.getSnapshot().cursor).toBeNull();
        await board.first(); expect(board.getSnapshot().history).toEqual([]); board.dispose();
    });
    it("discards a response after account/page disposal", async () => {
        const api = client(); let release!: (value: ReturnType<typeof page>) => void;
        api.list.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
        const board = new TaskBoard(api), request = board.load(); board.dispose(); release(page([task("succeeded", "old-account")])); await request;
        expect(board.getSnapshot().page.items).toEqual([]); expect(api.dispose).toHaveBeenCalledOnce();
    });
    it("retains known task state on read failure and only re-queries", async () => {
        const api = client(), board = new TaskBoard(api); await board.load();
        api.list.mockRejectedValueOnce(new Error("read failed")); await board.load();
        expect(board.getSnapshot().page.items[0].status).toBe("queued"); expect(board.getSnapshot().error).toBe("read failed");
        expect(api.cancel).not.toHaveBeenCalled(); expect(api.resumeQuery).not.toHaveBeenCalled(); board.dispose();
    });
    it("rejects uncertain and disabled actions even when called directly", async () => {
        const api = client(), board = new TaskBoard(api), uncertain = task("uncertain");
        uncertain.actions = { cancel: { allowed: true }, retry: { allowed: true, mode: "resume_query" } };
        await board.action(uncertain, "cancel"); await board.action(uncertain, "resume"); await board.action(task(), "cancel");
        expect(api.cancel).not.toHaveBeenCalled(); expect(api.resumeQuery).not.toHaveBeenCalled(); board.dispose();
    });
    it("uses backend actions for cancellation and Fal read recovery", async () => {
        const api = client(), board = new TaskBoard(api), recoverable = task("recoverable");
        recoverable.target = { provider: "fal", model: "esrgan" }; recoverable.actions.retry = { allowed: true, mode: "resume_query" };
        await board.action(recoverable, "resume"); expect(api.resumeQuery).toHaveBeenCalledOnce();
        const queued = task(); queued.actions.cancel.allowed = true; await board.action(queued, "cancel"); expect(api.cancel).toHaveBeenCalledOnce(); board.dispose();
    });
    it("loads a persisted deep link using GET, without any generation call", async () => {
        const api = client(), board = new TaskBoard(api, "saved-job"); await board.load();
        expect(api.get.mock.calls[0][0]).toBe("saved-job"); expect(board.getSnapshot().detail?.jobId).toBe("one"); board.dispose();
    });
});
describe("completion notifications", () => {
    const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value); } }; };
    it("does not notify historical results; notifies a transition once across refresh", () => {
        const storage = memory(), notify = vi.fn(), ledger = new CompletionLedger(storage, "A");
        ledger.observe([task("succeeded", "history"), task("running")], notify); expect(notify).not.toHaveBeenCalled();
        new CompletionLedger(storage, "A").observe([task("succeeded")], notify);
        new CompletionLedger(storage, "A").observe([task("succeeded")], notify);
        expect(notify).toHaveBeenCalledOnce();
    });
    it("separates accounts and never treats uncertain/recoverable as completion", () => {
        const storage = memory(), notify = vi.fn();
        new CompletionLedger(storage, "A").observe([task("running")], notify);
        new CompletionLedger(storage, "B").observe([task("succeeded")], notify);
        new CompletionLedger(storage, "A").observe([task("uncertain"), task("recoverable", "two")], notify);
        expect(notify).not.toHaveBeenCalled();
    });
    it.each(["failed", "canceled"] as const)("notifies confirmed %s once", status => {
        const notify = vi.fn(), ledger = new CompletionLedger(memory(), "A");
        ledger.observe([task("queued")], notify); ledger.observe([task(status)], notify); ledger.observe([task(status)], notify); expect(notify).toHaveBeenCalledOnce();
    });
    it("does not emit when dedup cannot be persisted", () => {
        const notify = vi.fn(), storage = memory(), ledger = new CompletionLedger(storage, "A"); ledger.observe([task("running")], notify);
        storage.setItem = () => { throw Error("blocked"); }; ledger.observe([task("succeeded")], notify); expect(notify).not.toHaveBeenCalled();
    });
    it("handles unsupported browser", async () => { vi.stubGlobal("Notification", undefined); expect(notificationPermission()).toBe("unsupported"); expect(await requestTaskNotificationPermission()).toBe("unsupported"); });
    it.each(["granted", "denied", "default"])("returns browser permission %s", async permission => {
        const requestPermission = vi.fn().mockResolvedValue(permission); vi.stubGlobal("Notification", { permission: "default", requestPermission });
        expect(await requestTaskNotificationPermission()).toBe(permission); expect(requestPermission).toHaveBeenCalledOnce();
    });
});
describe("honest status and result presentation", () => {
    it("labels every backend state and uses only supplied elapsed time", () => {
        expect(Object.keys(taskStatusLabels)).toHaveLength(9); expect(stageLabel("cancel_requested")).toContain("等待确认"); expect(stageLabel("invented")).toBe("阶段未知"); expect(elapsedLabel(null)).toBe("耗时未知"); expect(elapsedLabel(61000)).toBe("1 分 1 秒");
    });
    it("extracts GPT and Fal results and rejects executable result URLs", () => {
        const result = task("succeeded"); result.result = { data: [{ b64_json: "aGVsbG8=" }, { url: "javascript:alert(1)" }], images: [{ url: "https://example.invalid/image.png" }] };
        expect(taskResultLinks(result)).toEqual(["https://example.invalid/image.png", "data:image/png;base64,aGVsbG8="]);
        result.resultExpired = true; expect(taskResultLinks(result)).toEqual([]);
    });
});
