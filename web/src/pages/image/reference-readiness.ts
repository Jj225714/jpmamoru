export type ReferenceReadState = { id: number; name: string; status: "reading" | "ready" | "failed"; error?: string };
/** Synchronous admission barrier; async completions belong to one session and one attempt. */
export class ReferenceReadiness {
    private items: ReferenceReadState[] = [];
    private tasks = new Map<number, () => Promise<void>>();
    private listeners = new Set<() => void>();
    private next = 0;
    private revision = 0;
    getSnapshot = () => this.items;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private emit() { this.listeners.forEach((listener) => listener()); }
    checkpoint = () => { const revision = this.revision; return () => revision === this.revision && this.ready(); };
    ready = () => this.items.every((item) => item.status === "ready");
    reset = () => { this.revision++; this.items = []; this.tasks.clear(); this.emit(); };
    remove = (id: number) => { this.items = this.items.filter((item) => item.id !== id); this.tasks.delete(id); this.emit(); };
    retry = (id: number) => { if (this.items.find((item) => item.id === id)?.status === "failed") void this.tasks.get(id)?.(); };
    add<T>(name: string, read: () => Promise<T>, commit: (value: T) => void) {
        const id = ++this.next, revision = this.revision;
        this.items = [...this.items, { id, name, status: "reading" }];
        const run = async () => {
            const current = () => revision === this.revision && this.tasks.get(id) === run;
            this.items = this.items.map((item) => item.id === id ? { ...item, status: "reading", error: undefined } : item); this.emit();
            try {
                const value = await read();
                if (!current()) return;
                commit(value);
                this.items = this.items.map((item) => item.id === id ? { ...item, status: "ready" } : item);
            } catch (error) {
                if (!current()) return;
                this.items = this.items.map((item) => item.id === id ? { ...item, status: "failed", error: error instanceof Error ? error.message : "读取失败" } : item);
            }
            this.emit();
        };
        this.tasks.set(id, run);
        void run();
        return id;
    }
}
