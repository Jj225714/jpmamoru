import type { AssetGenerationInfo } from "./generation-info";

const valueLabel = (value: unknown) => typeof value === "string" ? value === "" ? "未指定（空值）" : value : "未记录";
export function LocalAssetProvenance({ generation }: { generation?: AssetGenerationInfo }) {
    const references = Array.isArray(generation?.references) ? generation.references : null;
    return <section aria-label="本地资产生成来源" className="space-y-3 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
        <h3 className="font-semibold">生成来源</h3>
        <p className="text-xs text-stone-500">以下为保存资产时记录的客户端来源，不代表服务端验证了模型执行。</p>
        {!generation ? <p>此历史资产未记录生成来源，无法带入生成参数。</p> : <>
            <div><h4 className="text-xs text-stone-500">提示词</h4><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{valueLabel(generation.prompt)}</pre></div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt>模型</dt><dd className="break-all">{valueLabel(generation.model)}</dd>
                <dt>生成时间</dt><dd className="break-all">{valueLabel(generation.generatedAt)}</dd>
                <dt>请求尺寸 / 比例</dt><dd>{valueLabel(generation.parameters?.size)}</dd>
                <dt>质量</dt><dd>{valueLabel(generation.parameters?.quality)}</dd>
                <dt>生成数量</dt><dd>{valueLabel(generation.parameters?.count)}</dd>
                <dt>背景</dt><dd>{valueLabel(generation.parameters?.background)}</dd>
                <dt>来源入口</dt><dd>{generation.source?.kind === "image" ? "通用生图" : generation.source?.kind === "canvas" ? "画布" : generation.source?.kind === "commerce" ? "跨境生图" : "未记录"}</dd>
                <dt>任务 ID</dt><dd className="break-all">{valueLabel(generation.source?.taskId)}</dd>
                <dt>节点 ID</dt><dd className="break-all">{valueLabel(generation.source?.nodeId)}</dd>
                <dt>项目 ID</dt><dd className="break-all">{valueLabel(generation.source?.projectId)}</dd>
            </dl>
            <div><h4 className="font-medium">参考图：{references ? `${references.length} 张（按生成请求顺序）` : "未记录"}</h4>
                {references?.length ? <ol className="mt-2 list-inside list-decimal space-y-1 text-sm">{references.map((reference, index) => <li key={`${reference.id}:${index}`} className="break-all">{reference.name || "未命名参考图"}<span className="ml-2 text-xs text-stone-500">ID：{valueLabel(reference.id)}</span></li>)}</ol> : references ? <p className="text-sm text-stone-500">已记录为无参考图。</p> : null}
            </div>
        </>}
    </section>;
}
