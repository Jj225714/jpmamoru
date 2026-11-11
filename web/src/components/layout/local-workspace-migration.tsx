import { useEffect, useState } from "react";
import { encodeArchive, hash, payloadHash, snapshotWorkspace, transferHeaders, transferUrl, validatePayload } from "@/services/workspace-transfer";

// Window lifetime dedup survives StrictMode and HMR.
const runtime = globalThis as typeof globalThis & { __workspaceMigration?: Promise<void> };
async function migrate(report: (message: string) => void) {
    let response: Response;
    do {
        response = await fetch("/__local-workspace-migration", { cache: "no-store" });
        if (response.status !== 204 && response.status !== 404) break;
        await new Promise((resolve) => setTimeout(resolve, 15000));
    } while (true);
    if (!response.ok) throw new Error("无法读取本地迁移授权");
    const bootstrap = await response.json();
    if (bootstrap.authorized !== true || Date.parse(bootstrap.expiresAt) <= Date.now()) throw new Error("本地迁移授权已过期");
    const payload = validatePayload(bootstrap);
    const completedKey = `infinite-canvas:workspace-migration:${bootstrap.id}`;
    if (localStorage.getItem(completedKey)) return;
    const post = async (result: object) => {
        const reply = await fetch("/__local-workspace-migration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: bootstrap.id, ...result }) });
        if (!reply.ok) throw new Error("无法保存迁移结果");
    };
    try {
        report("正在等待本地工作区加载…");
        const modules = await Promise.all([
            import("@/stores/canvas/use-canvas-store"),
            import("@/stores/use-asset-store"),
            import("@/stores/use-commerce-store"),
            import("@/stores/use-product-white-store"),
            import("@/stores/use-config-store"),
            import("@/stores/use-prompt-source-store"),
            import("@/stores/canvas/use-plugin-store"),
        ]);
        type HydratingStore = { persist: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void } };
        const stores = modules.flatMap((module) => Object.values(module)).filter((value) => typeof value === "function" && "persist" in value) as unknown as HydratingStore[];
        await Promise.all(
            stores.map(
                (store) =>
                    new Promise<void>((resolve, reject) => {
                        if (store.persist.hasHydrated()) return resolve();
                        const timer = setTimeout(() => {
                            unsubscribe();
                            reject(new Error("工作区加载超时，请刷新后重试"));
                        }, 30000);
                        const unsubscribe = store.persist.onFinishHydration(() => {
                            clearTimeout(timer);
                            unsubscribe();
                            resolve();
                        });
                    }),
            ),
        );
        report("正在完整归档并上传，本地数据会保留…");
        const snapshot = await snapshotWorkspace();
        const states = snapshot.stores.find((s) => s.name === "app_state")?.records || [];
        const counts = { jobs: 0, canvases: 0, rulePacks: 0, assets: 0, whiteRecords: 0 };
        const hasWork = states.some((record) => {
            if (typeof record.value !== "string") return false;
            try {
                const state = JSON.parse(record.value).state;
                return [state?.jobs, state?.projects, state?.assets, state?.records].some((items) => Array.isArray(items) && items.length > 0);
            } catch {
                return false;
            }
        });
        for (const record of states) {
            if (typeof record.value !== "string") continue;
            try {
                const state = JSON.parse(record.value).state;
                if (record.key === "infinite-canvas:commerce_store") {
                    counts.jobs = state.jobs?.length || 0;
                    counts.rulePacks = state.policyPacks?.length || 0;
                }
                if (record.key === "infinite-canvas:canvas_store") counts.canvases = state.projects?.length || 0;
                if (record.key === "infinite-canvas:asset_store") counts.assets = state.assets?.length || 0;
                if (record.key === "infinite-canvas:product-white") counts.whiteRecords = state.records?.length || 0;
            } catch {
                /* Raw record remains in the archive unchanged. */
            }
        }
        if (!hasWork) throw new Error("未发现本地任务、画布或素材，已停止空工作区上传。请确认打开的是原本地地址。");
        const bytes = await encodeArchive(snapshot);
        const headers = transferHeaders(payload);
        const upload = await fetch(transferUrl(payload), { method: "PUT", headers: { ...headers, "Content-Type": "application/zip" }, body: bytes.slice().buffer, credentials: "omit", redirect: "error" });
        if (!upload.ok && ![405, 409, 412].includes(upload.status)) throw new Error(`归档上传失败（${upload.status}）`);
        const head = await fetch(transferUrl(payload), { method: "HEAD", headers, cache: "no-store", credentials: "omit", redirect: "error" });
        if (!head.ok || Number(head.headers.get("Content-Length")) !== bytes.length) throw new Error("服务器归档大小校验失败");
        // Unique immutable names make a failed retry safe, but verify exact bytes before using an existing object.
        {
            const existing = await fetch(transferUrl(payload), { headers, cache: "no-store", credentials: "omit", redirect: "error" });
            if (!existing.ok) throw new Error("无法验证已有归档");
            const saved = new Uint8Array(await existing.arrayBuffer());
            if (saved.length !== bytes.length || (await hash(saved)) !== (await hash(bytes))) throw new Error("服务器归档摘要不一致，请配置新的唯一迁移名称");
        }
        await post({ status: "uploaded", bytes: bytes.length, sha256: await hash(bytes), counts, stores: snapshot.stores.map((s) => ({ name: s.name, records: s.records.length })), localKeys: snapshot.local.length });
        localStorage.setItem(completedKey, "uploaded");
        location.assign(`${payload.server}/workspace-transfer.html#${payloadHash(payload)}`);
    } catch (error) {
        // No exception text from network/credentials is written to disk.
        await post({ status: "error", error: "migration_failed" }).catch(() => undefined);
        throw error;
    }
}
export function LocalWorkspaceMigration() {
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const start = () => {
        if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return;
        setFailed(false);
        runtime.__workspaceMigration ??= navigator.locks
            ? (async () => {
                  await navigator.locks.request("infinite-canvas:workspace-migration", () => migrate(setMessage));
              })()
            : Promise.reject(new Error("浏览器不支持多标签迁移保护，请使用新版 Chrome 或 Edge"));
        void runtime.__workspaceMigration.catch((error) => {
            setMessage(error instanceof Error ? error.message : "迁移失败");
            setFailed(true);
        });
    };
    useEffect(start, []);
    if (!import.meta.env.DEV || !message) return null;
    return (
        <div role="status" style={{ position: "fixed", bottom: 16, right: 16, zIndex: 99999, padding: 16, background: "white", color: "#292524", border: "1px solid #ddd", borderRadius: 12, maxWidth: 380 }}>
            {message}
            {failed && (
                <button
                    onClick={() => {
                        runtime.__workspaceMigration = undefined;
                        start();
                    }}
                >
                    重试
                </button>
            )}
        </div>
    );
}
