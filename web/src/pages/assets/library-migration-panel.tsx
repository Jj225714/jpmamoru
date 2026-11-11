import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Select } from "antd";
import { useAssetStore } from "@/stores/use-asset-store";
import { librarySession } from "@/services/membership-library";
import type { AssetScope } from "@/services/asset-library";
import { migrateLocalAsset } from "./library-migration";

export function LibraryMigrationPanel({ scope, writable, onDone, suspended }: { scope: AssetScope; writable: boolean; onDone: () => void; suspended: boolean }) {
    const active = useRef(true);
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const assets = useAssetStore(state => state.assets), hydrated = useAssetStore(state => state.hydrated);
    const [open, setOpen] = useState(false), [id, setId] = useState<string>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
    const asset = assets.find(item => item.id === id);
    const migrate = async () => {
        if (!asset || !writable || busy) return;
        let guard: ReturnType<typeof librarySession>;
        try { guard = librarySession(); } catch { return; }
        setBusy(true); setNotice("");
        try { const result = await migrateLocalAsset(scope, asset, () => active.current); guard(); if (!active.current) return; setNotice(`已验证并保存映射：${result.asset.id}${result.deduplicated ? "（内容去重）" : ""}${result.resumed ? "（恢复原映射）" : ""}。本地原件仍保留。`); onDone(); }
        catch (error) { try { guard(); if (!active.current) return; const message = error instanceof Error ? error.message : "迁移未确认，本地原件保留"; setNotice(`${/元数据|契约/.test(message) ? "待兼容：" : ""}${message}。本地原件保留；若已复制部分参考图，可在当前范围查看。`); } catch { /* Account changed: the keyed parent discards this view. */ } }
        finally { if (active.current) setBusy(false); }
    };
    return <><Button disabled={!writable || !hydrated} onClick={() => setOpen(true)}>复制本地资产到此范围</Button><Modal title="迁移本地资产副本" open={open && !suspended} onCancel={() => { if (!busy) setOpen(false); }} footer={null} maskClosable={!busy} closable={!busy}>
        <p className="mb-3">复制文件及可用生成来源到当前范围；有参考图时先复制参考图，再保存主资产。不会自动删除任何本地资产。共享范围的成员可读取所复制的提示词和来源。</p>
        <Select aria-label="待迁移本地资产" className="w-full" value={id} disabled={busy} options={assets.map(item => ({ value: item.id, label: `${item.title} · ${item.kind}` }))} onChange={value => { setId(value); setNotice(""); }} />
        {asset ? <p className="my-2">本地 ID：{asset.id} · 参考图 {asset.generation?.references.length || 0} 张{asset.generation ? " · 包含生成来源" : ""}</p> : null}
        {notice ? <Alert className="my-3" type="info" title={notice} /> : null}
        <Button className="mt-3" type="primary" loading={busy} disabled={!asset || !writable} onClick={() => void migrate()}>复制并校验映射 / 继续原迁移</Button>
    </Modal></>;
}
