export type JournalRecord = { id: string; accountId?: string; status: string; error?: string };
export const interruptedGenerationMessage = "本地页面已中断跟踪，服务端是否完成待核实。此记录不代表后台任务；请核实原请求后再决定是否重新生成。";

/** Local history only, not a resumable server queue. All writes retain the captured owner. */
export class GenerationJournal<T extends JournalRecord> {
    private live = new Map<string, T>();
    private writes = new Map<string, Promise<unknown>>();
    constructor(private storage: { setItem(key: string, value: T): Promise<unknown> }) {}
    isActive = (id: string) => this.live.has(id);
    private write(record: T) {
        const previous = this.writes.get(record.id) || Promise.resolve();
        const write = previous.catch(() => {}).then(() => this.storage.setItem(record.id, record));
        this.writes.set(record.id, write);
        void write.finally(() => { if (this.writes.get(record.id) === write) this.writes.delete(record.id); }).catch(() => {});
        return write;
    }
    async start(record: T) {
        this.live.set(record.id, record);
        try { await this.write(record); } catch (error) { this.live.delete(record.id); throw error; }
        return this.isActive(record.id);
    }
    async finish(record: T) {
        const current = this.live.get(record.id);
        if (!current || current.accountId !== record.accountId) return;
        this.live.delete(record.id);
        await this.write(record);
    }
    interrupt(id: string) {
        const record = this.live.get(id);
        if (!record) return Promise.resolve();
        this.live.delete(id);
        return this.write({ ...record, status: "interrupted", error: interruptedGenerationMessage });
    }
    display(record: T): T {
        return record.status === "running" && !this.isActive(record.id)
            ? { ...record, status: "interrupted", error: interruptedGenerationMessage }
            : record;
    }
}
