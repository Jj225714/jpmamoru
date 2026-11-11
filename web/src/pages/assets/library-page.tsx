import { LibraryMigrationPanel } from "./library-migration-panel";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, Button, Drawer, Empty, Input, Modal, Select, Space, Tag } from "antd";
import { saveAs } from "file-saver";
import { useServerConfigStore } from "@/services/server-config";
import { librarySession, refreshMemberships, useMembershipLibrary } from "@/services/membership-library";
import { getLibraryAsset, getLibraryAssetContent, getLibraryAudit, getLibraryQuota, listLibraryAssets, restoreLibraryAsset, trashLibraryAsset, uploadLibraryAsset, type LibraryAsset } from "@/services/asset-library";
import { formatBytes } from "@/lib/image-utils";
import { AssetLibraryModel, rasterPreview } from "./library-model";
import { libraryScopes, useAssetAccountEpoch, type LibraryScopeOption } from "./library-session";

export function AssetsWorkspace({ local }: { local: ReactNode }) {
    const epoch = useAssetAccountEpoch();
    return <Workspace key={epoch} local={local} />;
}
function Workspace({ local }: { local: ReactNode }) {
    const user = useServerConfigStore(state => state.user), phase = useServerConfigStore(state => state.phase);
    const { teams, error, loading } = useMembershipLibrary();
    const [selection, setSelection] = useState("local"), [trash, setTrash] = useState(false);
    const signedIn = !!user && !["checking", "signed-out"].includes(phase);
    const options = signedIn ? libraryScopes(teams) : [];
    const authorized = options.find(option => option.value === selection);
    const lastScope = useRef<LibraryScopeOption | undefined>(undefined);
    if (authorized) lastScope.current = authorized;
    // An expected mapping 404 can trigger a membership refresh. Keep the operation
    // instance during that read, but hide data until authorization is resolved.
    const rechecking = loading && !authorized && lastScope.current?.value === selection;
    const selected = authorized || (rechecking ? lastScope.current : undefined);
    useEffect(() => {
        if (!signedIn) return;
        const refresh = () => { void refreshMemberships().catch(() => {}); };
        refresh(); window.addEventListener("focus", refresh);
        const timer = setInterval(refresh, 20000);
        return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
    }, [signedIn]);
    return <div className="flex h-full min-h-0 flex-col">
        <div className="space-y-2 border-b border-stone-200 p-3 dark:border-stone-700">
            <Space wrap>
                <Select aria-label="资产范围" className="min-w-64" value={selection} options={[{ value: "local", label: "本地历史资产" }, ...options.map(option => ({ value: option.value, label: `${option.label} · ${option.role === "read" ? "只读" : "可写"}` }))]} onChange={value => { setSelection(value); setTrash(false); }} />
                <Button disabled={!signedIn || loading} onClick={() => void refreshMemberships().catch(() => {})}>刷新范围与权限</Button>
                {selected ? <Button onClick={() => setTrash(value => !value)}>{trash ? "返回资产列表" : "回收站"}</Button> : null}
            </Space>
            <p className="text-xs text-stone-500">本地历史资产保留在当前浏览器中。服务端资产按账号及团队/项目授权读取，每次操作由服务端校验权限。</p>
            {error ? <Alert type="warning" title={error} /> : null}
        </div>
        {rechecking ? <p role="status" className="p-4">正在重新确认范围权限…</p> : null}
        {selection === "local" ? local : selected ? <div className={rechecking ? "hidden" : "flex min-h-0 flex-1 flex-col"}><RemoteLibrary key={`${selected.value}:${selected.role}:${trash}`} option={selected} trash={trash} suspended={!!rechecking} /></div> : <div className="p-6"><Alert type="warning" title="该范围不可用，可能已撤权或登录失效" description="刷新权限，或切换到本地历史资产。" /></div>}
    </div>;
}
function RemoteLibrary({ option, trash, suspended }: { option: LibraryScopeOption; trash: boolean; suspended: boolean }) {
    const [model, setModel] = useState<AssetLibraryModel>();
    const [error, setError] = useState("");
    useEffect(() => {
        try {
            const scope = option.scope;
            const next = new AssetLibraryModel({ list: deleted => listLibraryAssets(scope, deleted), quota: () => getLibraryQuota(scope), detail: id => getLibraryAsset(scope, id), content: id => getLibraryAssetContent(scope, id), upload: (name, blob) => uploadLibraryAsset(scope, name, blob, { version: 1, kind: "original" }), trash: id => trashLibraryAsset(scope, id), restore: id => restoreLibraryAsset(scope, id), audit: () => getLibraryAudit(scope) }, trash, option.role !== "read", librarySession());
            setModel(next); void next.load();
            const refresh = () => void next.load(); window.addEventListener("focus", refresh);
            const timer = setInterval(refresh, 30000);
            return () => { next.dispose(); clearInterval(timer); window.removeEventListener("focus", refresh); };
        } catch (error) { setError(error instanceof Error ? error.message : "无法打开资产库"); }
    }, [option.value, option.role, trash]);
    return error ? <Alert type="error" title={error} /> : model ? <LibraryView model={model} option={option} suspended={suspended} /> : <p role="status">正在读取资产…</p>;
}
function LibraryView({ model, option, suspended }: { model: AssetLibraryModel; option: LibraryScopeOption; suspended: boolean }) {
    const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
    const input = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState(""), [pendingTrash, setPendingTrash] = useState<LibraryAsset | null>(null);
    const items = state.assets.filter(item => `${item.name} ${item.id} ${item.sha256}`.toLowerCase().includes(query.trim().toLowerCase()));
    return <main className="min-h-0 flex-1 space-y-4 overflow-auto p-4 md:p-6" aria-busy={state.busy}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">{option.label}{model.trash ? " · 回收站" : ""}</h1><Tag>{model.writable ? "可写（服务端最终校验）" : "只读"}</Tag></div>
        {state.quota ? <div className="rounded-lg border border-stone-200 p-3 text-sm dark:border-stone-700">
            <p>容量：{formatBytes(state.quota.usedBytes)} / {formatBytes(state.quota.limitBytes)} · 单文件上限 {formatBytes(state.quota.maxFileBytes)} · 数量上限 {state.quota.maxAssets}</p>
            <p>{state.quota.trashCounts ? "回收站仍占用容量，移入回收站不会释放配额。" : "回收站容量按服务端规则计算。"}</p>
            {state.quota.usedBytes >= state.quota.limitBytes ? <p className="text-amber-600">容量已达上限；相同内容可能去重，新增内容由服务端拒绝。</p> : null}
        </div> : null}
        <Space wrap>
            <Button loading={state.busy} onClick={() => void model.load()}>刷新资产</Button>
            <Button disabled={state.busy || !model.writable || model.trash || !state.quota || !!state.error} onClick={() => input.current?.click()}>上传文件</Button>
            <Button disabled={state.busy} onClick={() => void model.readAudit()}>审计记录</Button>
            {!model.trash ? <LibraryMigrationPanel suspended={suspended} scope={option.scope} writable={model.writable && !state.busy && !state.error && !!state.quota} onDone={() => void model.load()} /> : null}
            <Input aria-label="搜索服务端资产" placeholder="名称、稳定 ID 或 SHA-256" value={query} onChange={event => setQuery(event.target.value)} allowClear />
        </Space>
        <input ref={input} type="file" aria-label="上传服务端资产" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void model.upload(file.name, file); }} />
        {state.error ? <Alert showIcon type="error" title="资产操作未完成" description={`${state.error}。未删除本地资产，请刷新确认服务器状态。`} /> : null}
        {state.notice ? <Alert type="info" title={state.notice} /> : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map(asset => <article key={asset.id} data-library-asset={asset.id} className="space-y-2 rounded-xl border border-stone-200 p-4 dark:border-stone-700">
            <h2 className="break-all font-semibold">{asset.name}</h2><p className="text-sm">{formatBytes(asset.bytes)} · {asset.mimeType}</p>
            <p className="break-all text-xs">ID：{asset.id}</p><p className="break-all text-xs text-stone-500">SHA-256：{asset.sha256}</p>
            <p className="text-xs">创建：{asset.createdAt}{asset.deletedAt ? ` · 删除：${asset.deletedAt}` : ""}</p>
            <Space wrap><Button size="small" disabled={state.busy} onClick={() => void model.inspect(asset.id)}>来源与详情</Button><Button size="small" disabled={state.busy || model.trash} onClick={() => void model.readContent(asset.id)}>读取文件</Button>
                {model.trash ? <Button size="small" disabled={state.busy || !model.writable} onClick={() => void model.mutate(asset.id, "restore")}>恢复</Button> : <Button size="small" danger disabled={state.busy || !model.writable} onClick={() => setPendingTrash(asset)}>移入回收站</Button>}
            </Space>
        </article>)}</div>
        {!items.length && !state.busy && !state.error ? <Empty description={model.trash ? "回收站为空" : "没有匹配的资产"} /> : null}
        <Modal open={!suspended && !!pendingTrash} title="移入回收站" okText="移入回收站" cancelText="取消" onCancel={() => setPendingTrash(null)} onOk={() => { if (pendingTrash) void model.mutate(pendingTrash.id, "trash"); setPendingTrash(null); }}><p>{pendingTrash?.name} 将保留原 ID，可恢复；仍占用容量。</p></Modal>
        <Drawer title="资产来源与内容" open={!suspended && !!state.detail} onClose={model.closeDetail} size={560}>
            {state.detail ? <><p className="break-all">稳定 ID：{state.detail.id}</p><p className="break-all">内容哈希：{state.detail.sha256}</p><Provenance asset={state.detail} />{state.content ? <ContentPreview blob={state.content} asset={state.detail} /> : null}</> : null}
        </Drawer>
        <Drawer title="审计记录" open={!suspended && state.audit !== null} onClose={model.closeAudit} size={560}>
            <p className="mb-3 text-sm">仅展示服务端保留的成功变更记录，不含所有读取或拒绝日志。</p>
            {state.audit?.map((event, index) => { const item = event && typeof event === "object" ? event as Record<string, unknown> : {}; return <div className="mb-2 rounded border p-2 text-sm" key={index}>{["sequence", "actor", "action", "assetId", "at"].map(key => <p key={key} className="break-all">{key}：{typeof item[key] === "string" || typeof item[key] === "number" ? String(item[key]) : "—"}</p>)}</div>; })}
        </Drawer>
    </main>;
}
function ContentPreview({ blob, asset }: { blob: Blob; asset: LibraryAsset }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let disposed = false, current = ""; setUrl("");
        void rasterPreview(blob).then(image => { if (image && !disposed) { current = URL.createObjectURL(image); setUrl(current); } });
        return () => { disposed = true; if (current) URL.revokeObjectURL(current); };
    }, [blob]);
    return <div className="mt-4 space-y-3">{url ? <img src={url} alt={asset.name} className="max-w-full" /> : <p>文件已读取，此格式不内嵌预览。</p>}<Button onClick={() => saveAs(blob, asset.name)}>下载原文件</Button></div>;
}
function Provenance({ asset }: { asset: LibraryAsset }) {
    // The server contract is additive; older client/server rows legitimately have no provenance.
    const entries = asset.metadataEntries;
    if (!Array.isArray(entries) || !entries.length) return <p className="my-3 text-sm text-stone-500">未记录生成来源（历史资产）。</p>;
    return <div className="my-3 space-y-3"><p className="text-xs text-stone-500">以下为提交方记录的来源，不代表服务端验证了模型执行。</p>{entries.map((entry, index) => {
        const data = entry && typeof entry === "object" ? entry as Record<string, any> : {};
        return <section key={index} className="rounded border p-3 text-sm"><p>类型：{String(data.kind || "other")}</p>
            {["taskId", "nodeId", "localId"].map(key => typeof data.source?.[key] === "string" ? <p key={key} className="break-all">{key}：{data.source[key]}</p> : null)}
            {typeof data.generation?.model === "string" ? <p>模型：{data.generation.model}</p> : null}
            {typeof data.generation?.prompt === "string" ? <p className="whitespace-pre-wrap break-words">提示词：{data.generation.prompt}</p> : null}
            {data.generation?.parameters ? <p className="break-all">参数：{JSON.stringify(data.generation.parameters)}</p> : null}
            {Array.isArray(data.referenceIds) ? <p className="break-all">参考资产 ID：{data.referenceIds.filter((id: unknown) => typeof id === "string").join("、")}</p> : null}
        </section>;
    })}</div>;
}
