import type { LibraryAsset } from "@/services/asset-library";
export type LibraryQuota = { limitBytes: number; usedBytes: number; maxFileBytes: number; maxAssets: number; trashCounts: boolean };
export type LibraryApi = {
    list: (trash: boolean) => Promise<{ assets: LibraryAsset[] }>;
    quota: () => Promise<LibraryQuota>;
    detail: (id: string) => Promise<{ asset: LibraryAsset }>;
    content: (id: string) => Promise<Blob>;
    upload: (name: string, blob: Blob) => Promise<{ asset: LibraryAsset; deduplicated?: boolean; confirmedAfterError?: boolean }>;
    trash: (id: string) => Promise<unknown>;
    restore: (id: string) => Promise<unknown>;
    audit: () => Promise<{ events: unknown[]; lastSequence: number; retention: number }>;
};
type LibraryState = { assets: LibraryAsset[]; quota: LibraryQuota | null; busy: boolean; error: string; notice: string; detail: LibraryAsset | null; content: Blob | null; audit: unknown[] | null };
export class AssetLibraryModel {
    private state: LibraryState = { assets: [], quota: null, busy: false, error: "", notice: "", detail: null, content: null, audit: null };
    private listeners = new Set<() => void>();
    private alive = true;
    constructor(private api: LibraryApi, readonly trash: boolean, readonly writable: boolean, private guard: () => unknown) {}
    getSnapshot = () => this.state;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private publish(patch: Partial<LibraryState>) { if (!this.alive) return; this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
    private current() { if (!this.alive) throw new Error("资产视图已切换"); this.guard(); }
    private async run(work: () => Promise<void>) {
        if (!this.alive || this.state.busy) return;
        this.publish({ busy: true, error: "", notice: "" });
        try { this.current(); await work(); this.current(); }
        catch (error) {
            const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
            if (this.alive) this.publish({ assets: [], quota: null, detail: null, content: null, audit: null, error: status === 413 ? "服务端容量、文件数量或单文件大小达到限制，请检查配额；回收站仍计入容量" : error instanceof Error ? error.message : "操作未完成，请刷新服务器状态" });
        } finally { this.publish({ busy: false }); }
    }
    private async read() {
        const [list, quota] = await Promise.all([this.api.list(this.trash), this.api.quota()]);
        this.current();
        this.publish({ assets: list.assets, quota });
    }
    load = () => this.run(async () => { this.publish({ detail: null, content: null, audit: null }); await this.read(); });
    inspect = (id: string) => this.run(async () => { const { asset } = await this.api.detail(id); this.current(); this.publish({ detail: asset, content: null }); });
    readContent = (id: string) => this.run(async () => {
        const { asset } = await this.api.detail(id); this.current();
        const blob = await this.api.content(id); this.current(); this.publish({ detail: asset, content: blob });
    });
    closeDetail = () => this.publish({ detail: null, content: null });
    upload = (name: string, blob: Blob) => this.run(async () => {
        if (!this.writable || this.trash) throw new Error("当前范围只读或位于回收站，不能上传");
        if (!this.state.quota) throw new Error("请先刷新配额");
        if (!blob.size || blob.size > this.state.quota.maxFileBytes) throw new Error("文件为空或超过服务端单文件上限");
        // At full quota, identical content can still deduplicate: let the server decide atomically.
        const result = await this.api.upload(name, blob); this.current();
        await this.read();
        this.publish({ notice: result.confirmedAfterError ? `上传响应中断，已按内容哈希确认资产 ${result.asset.id}` : result.deduplicated ? `内容已存在，复用稳定 ID：${result.asset.id}` : `上传成功：${result.asset.id}` });
    });
    mutate = (id: string, action: "trash" | "restore") => this.run(async () => {
        if (!this.writable) throw new Error("当前范围为只读");
        await this.api[action](id); this.current();
        this.publish({ detail: null, content: null }); await this.read();
        this.publish({ notice: action === "trash" ? "已移入回收站，仍计入容量；可恢复原 ID" : "已恢复原资产 ID" });
    });
    readAudit = () => this.run(async () => { const audit = await this.api.audit(); this.current(); this.publish({ audit: audit.events, notice: `审计最新序号 ${audit.lastSequence}，最多保留 ${audit.retention} 条成功操作` }); });
    closeAudit = () => this.publish({ audit: null });
    dispose() { this.alive = false; this.state = { ...this.state, assets: [], detail: null, content: null, audit: null }; this.listeners.clear(); }
}

/** Only raster signatures may become inline previews; metadata MIME is never trusted. */
export async function rasterPreview(blob: Blob): Promise<Blob | null> {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const type = bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG" ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
        : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" ? "image/webp" : null;
    return type ? new Blob([blob], { type }) : null;
}
