import { Alert, App, Button, Card, Space, Table, Tag, Modal } from "antd";
import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { getCommerceAccountEpoch } from "@/lib/commerce/request-session";
import { ImportPreview } from "./import-preview";
import { createImportPreview, buildImportProducts, type ImportPreviewState } from "@/lib/commerce/importers-preview";
import { useCommerceStore } from "@/stores/use-commerce-store";
import type { CommerceJob } from "@/types/commerce";
import { useServerConfigStore } from "@/services/server-config";
import { approveContent, approveWhiteBackground } from "@/lib/commerce/pipeline";
import { batchAccount, batchSnapshot, batchSubscribe, isBatchRunning, runCommerceBatch, stopCommerceBatch } from "@/lib/commerce/pipeline-batch";
import { readBatchJournal } from "@/lib/commerce/pipeline-batch-task";

export function BatchProgress({ job }: { job: CommerceJob }) {
    const { message, modal } = App.useApp();
    const [missingPreview, setMissingPreview] = useState<ImportPreviewState>();
    useSyncExternalStore(batchSubscribe, batchSnapshot);
    const accountId = useServerConfigStore((state) => state.user?.id);
    const missingSession = useRef({account:batchAccount(),epoch:getCommerceAccountEpoch()});
    useEffect(() => setMissingPreview(undefined),[accountId]);
    let journal: ReturnType<typeof readBatchJournal> | undefined; let error = "";
    try { journal = readBatchJournal(job.id, batchAccount()); } catch (e) { error = e instanceof Error ? e.message : "无法读取批次"; }
    const running = isBatchRunning(job.id);
    const act = async (work: () => Promise<unknown>) => { try { await work(); } catch (e) { message.error(e instanceof Error ? e.message : "批次操作失败"); } };
    const labels: Record<string,string> = { queued:"排队",running:"运行中",review:"待人工审核",succeeded:"完成",failed:"失败/待处理",paused:"已暂停" };
    return <Card title="多 SKU 安全批次" className="mb-4">
        {error ? <Alert type="error" title={error} /> : null}
        <p className="mb-3 text-sm text-stone-500">逐 SKU 生成白底图，人工确认后自动排队后续方案。成功项保留；刷新只恢复原任务查询。未确定结果的请求不会自动再次付费提交。</p>
        <Space wrap className="mb-3">
            <Button disabled={running || !job.skus.some(sku => !sku.product.images.length && !sku.assets.length)} onClick={() => { missingSession.current={account:batchAccount(),epoch:getCommerceAccountEpoch()}; setMissingPreview(createImportPreview(job.skus.filter(sku => !sku.product.images.length && !sku.assets.length).map(sku => sku.product), job.skus.flatMap(sku => sku.product.images))); }}>纠正缺图 SKU</Button>
            <Button type="primary" disabled={running || Boolean(error)} onClick={() => void act(() => runCommerceBatch(job.id))}>批量开始 / 恢复查询</Button>
            <Button disabled={running || Boolean(error) || !Object.values(journal?.skus || {}).some((s) => s.status === "failed")} onClick={() => void act(() => runCommerceBatch(job.id,{retryFailed:true}))}>仅重试失败项</Button>
            <Button disabled={running || Boolean(error) || !job.skus.some((sku) => sku.stage === "white-review")} onClick={() => modal.confirm({title:"已逐项检查以下白底图？",content:"确认后批准所有待审核白底图，并按 SKU 排队生成后续方案；这会产生新的模型调用。",onOk:()=>act(async()=>{for(const sku of job.skus.filter(s=>s.stage==="white-review"))await approveWhiteBackground(job.id,sku.id,"batch-review");await runCommerceBatch(job.id);})})}>批准已检查白底并继续方案</Button>
            <Button disabled={running || Boolean(error) || !job.skus.some(sku => sku.stage === "content-review")} onClick={() => modal.confirm({title:"已逐项检查待审核内容？",content:"确认后批准待审核图片与文案，并继续翻译、排版和合规检查；这些步骤可能产生文本模型调用。",onOk:()=>act(async()=>{for(const sku of job.skus.filter(s=>s.stage==="content-review"))await approveContent(job.id,sku.id,"batch-review");await runCommerceBatch(job.id);})})}>批准已检查内容并继续交付</Button>
            <Button disabled={!running} onClick={() => void act(() => stopCommerceBatch(job.id))}>暂停并请求取消</Button>
            <Button disabled={running || Boolean(error)} onClick={() => modal.confirm({title:"核对响应丢失的原请求",content:"请先在任务中心核对原任务。确认渠道与商品输入完全一致后，将只以原幂等键找回任务，不创建新意图；超过安全窗口或状态不明时保持阻断。",onOk:()=>act(()=>runCommerceBatch(job.id,{confirmSameInput:true}))})}>核对同一输入后恢复</Button>
        </Space>
        <Table size="small" pagination={false} rowKey="id" dataSource={job.skus} columns={[
            {title:"SKU",render:(_,sku)=>sku.product.sku},
            {title:"批次状态",render:(_,sku)=><Tag>{labels[journal?.skus[sku.id]?.status || "queued"]}</Tag>},
            {title:"已完成请求 / 已登记请求",render:(_,sku)=>{const ops=Object.values(journal?.operations||{}).filter(op=>{try{return JSON.parse(op.key)[0]===sku.id;}catch{return false;}});return `${ops.filter(op=>op.status==="succeeded").length} / ${ops.length}`;}},
            {title:"进度与提示",render:(_,sku)=>{const ops=Object.values(journal?.operations||{}).filter(op=>{try{return JSON.parse(op.key)[0]===sku.id;}catch{return false;}});return <div><div>{journal?.skus[sku.id]?.message || sku.stageMessage || sku.stage}</div>{ops.filter(op=>op.jobId).map(op=><div key={op.key} className="text-xs">{op.jobId} · {op.status}{op.percent == null ? "" : ` · ${op.percent}%`}</div>)}</div>; }},
        ]}/>
        {journal?.stopped ? <p>批次已暂停。已发送的请求以服务端取消结果为准；恢复时先查询原任务。</p> : null}
        <Modal title="纠正缺图 SKU 映射" open={Boolean(missingPreview)} onCancel={() => setMissingPreview(undefined)} width={900} onOk={() => {
            if (!missingPreview) return;
            try {
                if(missingSession.current.account!==batchAccount() || missingSession.current.epoch!==getCommerceAccountEpoch()) throw new Error("账号已变化，请重新读取映射");
                const products = buildImportProducts(missingPreview);
                const current = useCommerceStore.getState().jobs.find(item => item.id === job.id);
                for (const product of products) {
                    const sku = current?.skus.find(item => item.product.id === product.id);
                    if (!sku || sku.assets.length || isBatchRunning(job.id)) throw new Error("SKU 状态已变化，请重新读取");
                }
                for (const product of products) {
                    const sku = current!.skus.find(item => item.product.id === product.id)!;
                    useCommerceStore.getState().updateSku(job.id,sku.id, {product});
                }
                setMissingPreview(undefined); message.success("缺图映射已修正，可仅重试失败项");
            } catch(error) {message.error(error instanceof Error ? error.message : "保存失败");}
        }}>{missingPreview ? <ImportPreview value={missingPreview} onChange={setMissingPreview}/> : null}</Modal>
    </Card>;
}
