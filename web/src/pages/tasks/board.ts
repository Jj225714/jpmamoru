import type { createTaskCenterClient, Task, TaskPage } from "@/services/api/task-center";
export type TaskReader = Pick<ReturnType<typeof createTaskCenterClient>, "list" | "get" | "cancel" | "resumeQuery" | "dispose">;
type State = { page: TaskPage; detail: Task | null; busy: boolean; error: string; cursor: string | null; history: (string | null)[] };
export class TaskBoard {
    private state: State = { page: { items: [], nextCursor: null, retentionMs: null }, detail: null, busy: false, error: "", cursor: null, history: [] };
    private listeners = new Set<() => void>();
    private epoch = 0;
    private stopped = false;
    private abort?: AbortController;
    constructor(private client: TaskReader, readonly jobId?: string) {}
    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(value: Partial<State>) { this.state = { ...this.state, ...value }; this.listeners.forEach(fn => fn()); }
    async load(cursor = this.state.cursor, history = this.state.history) {
        if (this.stopped || this.state.busy) return;
        const epoch = ++this.epoch;
        this.abort = new AbortController();
        this.publish({ busy: true, error: "" });
        try {
            const page = await this.client.list({ cursor, signal: this.abort.signal });
            const detail = this.jobId ? await this.client.get(this.jobId, this.abort.signal) : null;
            if (!this.stopped && epoch === this.epoch) this.publish({ page, detail, cursor, history });
        } catch (error) {
            if (!this.stopped && epoch === this.epoch) this.publish({ error: error instanceof Error ? error.message : "查询失败，请继续查询原任务" });
        } finally { if (!this.stopped && epoch === this.epoch) this.publish({ busy: false }); }
    }
    first = () => this.load(null, []);
    next = () => this.state.page.nextCursor ? this.load(this.state.page.nextCursor, [...this.state.history, this.state.cursor]) : Promise.resolve();
    back = () => this.state.history.length ? this.load(this.state.history.at(-1)!, this.state.history.slice(0, -1)) : Promise.resolve();
    async action(task: Task, kind: "cancel" | "resume") {
        if (this.stopped || this.state.busy || task.status === "uncertain" || !(kind === "cancel" ? task.actions.cancel.allowed : task.actions.retry.allowed && task.actions.retry.mode === "resume_query")) return;
        const epoch = ++this.epoch;
        this.abort = new AbortController();
        this.publish({ busy: true, error: "" });
        try {
            const updated = await (kind === "cancel" ? this.client.cancel(task, this.abort.signal) : this.client.resumeQuery(task, this.abort.signal));
            if (!this.stopped && epoch === this.epoch) this.publish({ page: { ...this.state.page, items: this.state.page.items.map(item => item.jobId === updated.jobId ? updated : item) }, detail: this.state.detail?.jobId === updated.jobId ? updated : this.state.detail });
        } catch (error) { if (!this.stopped && epoch === this.epoch) this.publish({ error: error instanceof Error ? error.message : "操作失败，请查询原任务" }); }
        finally { if (!this.stopped && epoch === this.epoch) this.publish({ busy: false }); }
    }
    dispose() { this.stopped = true; this.epoch++; this.abort?.abort(); this.client.dispose(); this.listeners.clear(); }
}
