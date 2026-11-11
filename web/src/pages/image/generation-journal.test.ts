import { expect, it, vi } from "vitest";
import { GenerationJournal, interruptedGenerationMessage } from "./generation-journal";
const row = { id: "run", accountId: "A", status: "running", prompt: "private" };
it("persists before submission and replaces the same receipt on success", async () => {
    const store = { setItem: vi.fn(async (_id: string, _record: typeof row & { error?: string }) => {}) }, journal = new GenerationJournal<typeof row>(store);
    expect(await journal.start(row)).toBe(true);
    expect(store.setItem).toHaveBeenCalledWith("run", row);
    await journal.finish({ ...row, status: "success" });
    expect(store.setItem.mock.calls.at(-1)).toEqual(["run", { ...row, status: "success" }]);
    expect(journal.isActive("run")).toBe(false);
});
it("storage failure prevents admission", async () => {
    const journal = new GenerationJournal({ setItem: vi.fn(async () => { throw Error("quota"); }) });
    const submit = vi.fn();
    await expect((async () => { if (await journal.start(row)) submit(); })()).rejects.toThrow("quota");
    expect(submit).not.toHaveBeenCalled(); expect(journal.isActive("run")).toBe(false);
});
it.each(["account switch", "unmount", "new session"])("serializes %s behind pending persistence and blocks late submission/completion", async () => {
    let release!: () => void; const stored: unknown[] = [];
    const journal = new GenerationJournal<typeof row>({ setItem: async (_id, record) => { stored.push(record); if (stored.length === 1) await new Promise<void>(resolve => { release = resolve; }); } });
    const submit = vi.fn();
    const start = journal.start(row).then(active => { if (active) submit(); return active; }); await Promise.resolve(); await Promise.resolve();
    const stop = journal.interrupt(row.id); release(); expect(await start).toBe(false); await stop;
    await journal.finish({ ...row, status: "success" });
    expect(stored).toEqual([row, { ...row, status: "interrupted", error: interruptedGenerationMessage }]);
    expect(submit).not.toHaveBeenCalled(); expect(journal.isActive(row.id)).toBe(false);
});
it("a different account cannot finalize the captured owner's receipt", async () => {
    const store = { setItem: vi.fn(async (_id: string, _record: typeof row & { error?: string }) => {}) }, journal = new GenerationJournal<typeof row>(store);
    await journal.start(row); await journal.finish({ ...row, accountId: "B", status: "success" });
    expect(store.setItem).toHaveBeenCalledTimes(1);
    await journal.interrupt(row.id); expect(store.setItem.mock.calls.at(-1)?.[1]).toMatchObject({ accountId: "A", status: "interrupted" });
});
it("after reload an orphan running record is uncertain, not an automatically resumed job", () => {
    const store = { setItem: vi.fn(async (_id: string, _record: typeof row & { error?: string }) => {}) }, journal = new GenerationJournal<typeof row>(store);
    expect(journal.display(row)).toMatchObject({ status: "interrupted", error: interruptedGenerationMessage });
    expect(store.setItem).not.toHaveBeenCalled();
});
it("retains explicit failure details", async () => {
    const store = { setItem: vi.fn(async (_id: string, value: typeof row & { error?: string }) => value) };
    const journal = new GenerationJournal<typeof row & { error?: string }>(store);
    await journal.start(row); await journal.finish({ ...row, status: "failed", error: "mock rejected" });
    expect(store.setItem.mock.calls.at(-1)?.[1]).toMatchObject({ status: "failed", error: "mock rejected" });
});
