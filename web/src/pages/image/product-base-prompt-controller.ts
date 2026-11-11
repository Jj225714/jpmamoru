import type { ReferenceImage } from "@/types/image";

export function imageFilesForUpload(files?: ArrayLike<File> | null) {
    return Array.from(files || []).filter((file) => file.type.startsWith("image/"));
}

export type BasePromptState = {
    prompt: string;
    references: ReferenceImage[];
    status: "idle" | "analyzing" | "done" | "error";
    error: string;
    stale: boolean;
};

function referenceSignature(references: ReferenceImage[]) {
    return JSON.stringify(references.map((ref) => [ref.storageKey || ref.dataUrl || ref.url || "", ref.type]));
}

/** Owns revisions synchronously, including edits React may batch together. */
export class ProductBasePromptController {
    private state: BasePromptState = { prompt: "", references: [], status: "idle", error: "", stale: false };
    private listeners = new Set<() => void>();
    private attempted = new Set<string>();
    private manualSuppression = new Set<string>();
    private autoReferences?: string;
    private revision = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private abort?: AbortController;
    private configKey = "";
    private enabled = false;
    private analyze?: (references: ReferenceImage[], signal: AbortSignal) => Promise<string>;
    getSnapshot = () => this.state;
    canGenerate = () => Boolean(this.state.prompt.trim()) && !this.state.stale && this.state.status !== "analyzing";
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private publish(next: Partial<BasePromptState>) {
        this.state = { ...this.state, ...next };
        this.listeners.forEach((listener) => listener());
    }
    private key() {
        return JSON.stringify([this.configKey, referenceSignature(this.state.references)]);
    }
    cancel = () => {
        this.revision++;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.abort?.abort();
        this.abort = undefined;
    };
    setPrompt = (prompt: string) => {
        this.attempted.add(this.key());
        this.manualSuppression.add(referenceSignature(this.state.references));
        this.autoReferences = undefined;
        this.cancel();
        this.publish({ prompt, status: "idle", error: "", stale: false });
    };
    setReferences = (next: ReferenceImage[] | ((previous: ReferenceImage[]) => ReferenceImage[])) => {
        const references = typeof next === "function" ? next(this.state.references) : next;
        const signature = referenceSignature(references);
        if (signature === referenceSignature(this.state.references)) return;
        this.cancel();
        this.publish({ references, status: "idle", error: "", stale: this.autoReferences !== undefined && this.autoReferences !== signature });
        this.schedule();
    };
    keepCurrent = () => this.setPrompt(this.state.prompt);
    clearAndRetry = () => {
        this.setPrompt("");
        this.retry();
    };
    reset = () => {
        this.cancel();
        this.attempted.clear();
        this.manualSuppression.clear();
        this.autoReferences = undefined;
        this.publish({ prompt: "", references: [], status: "idle", error: "", stale: false });
    };
    restore = (prompt: string, references: ReferenceImage[]) => {
        this.cancel();
        this.autoReferences = undefined;
        this.manualSuppression.add(referenceSignature(references));
        this.publish({ prompt, references, status: "idle", error: "", stale: false });
        this.attempted.add(this.key());
    };
    configure(key: string, enabled: boolean, analyze: (references: ReferenceImage[], signal: AbortSignal) => Promise<string>) {
        if (key !== this.configKey || enabled !== this.enabled) {
            this.cancel();
            this.publish({ status: "idle", error: "" });
        }
        this.configKey = key;
        this.enabled = enabled;
        this.analyze = analyze;
        this.schedule();
    }
    retry = () => {
        if (this.state.status === "analyzing") return;
        this.attempted.delete(this.key());
        this.manualSuppression.delete(referenceSignature(this.state.references));
        this.schedule();
    };
    private schedule() {
        if (!this.enabled || this.state.prompt.trim() || !this.state.references.length || this.attempted.has(this.key()) || this.manualSuppression.has(referenceSignature(this.state.references)) || this.timer) return;
        const revision = this.revision;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (revision !== this.revision) return;
            void this.run(revision);
        }, 250);
    }
    private async run(revision: number) {
        const abort = new AbortController();
        this.abort = abort;
        this.attempted.add(this.key());
        this.publish({ status: "analyzing", error: "" });
        try {
            const prompt = await this.analyze!([...this.state.references], abort.signal);
            if (abort.signal.aborted || revision !== this.revision) return;
            if (!prompt.trim()) throw new Error("");
            this.autoReferences = referenceSignature(this.state.references);
            this.publish({ prompt, status: "done", stale: false });
        } catch (error) {
            if (abort.signal.aborted || revision !== this.revision) return;
            this.publish({ status: "error", error: error instanceof Error ? error.message : "" });
        } finally {
            if (this.abort === abort) this.abort = undefined;
        }
    }
}
