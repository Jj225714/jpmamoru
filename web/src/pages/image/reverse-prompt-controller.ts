type State = { image: string; result: string; status: "idle" | "reading" | "running" | "done" | "error"; error: string };
export class ReversePromptController {
    private state: State = { image: "", result: "", status: "idle", error: "" };
    private revision = 0;
    private abort?: AbortController;
    private listeners = new Set<() => void>();
    getSnapshot = () => this.state;
    getRevision = () => this.revision;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private publish(patch: Partial<State>) {
        this.state = { ...this.state, ...patch };
        this.listeners.forEach((listener) => listener());
    }
    cancel = () => {
        this.revision++;
        this.abort?.abort();
        this.abort = undefined;
        this.publish({ result: "", status: "idle", error: "" });
    };
    setResult = (result: string) => this.publish({ result });
    async select(read: () => Promise<string>) {
        this.cancel();
        const revision = this.revision;
        this.publish({ image: "", status: "reading" });
        try {
            const image = await read();
            if (revision === this.revision) this.publish({ image, status: "idle" });
        } catch {
            if (revision === this.revision) this.publish({ status: "error", error: "imageError" });
        }
    }
    async run(analyze: (image: string, signal: AbortSignal) => Promise<string>) {
        if (!this.state.image || this.state.status === "running" || this.state.status === "reading") return;
        this.cancel();
        const revision = this.revision;
        const abort = new AbortController();
        this.abort = abort;
        this.publish({ status: "running" });
        try {
            const result = await analyze(this.state.image, abort.signal);
            if (revision === this.revision && !abort.signal.aborted) this.publish({ result, status: "done" });
        } catch (error) {
            if (revision === this.revision && !abort.signal.aborted) this.publish({ status: "error", error: error instanceof Error && error.message === "timeout" ? "timeout" : "failed" });
        }
    }
}
