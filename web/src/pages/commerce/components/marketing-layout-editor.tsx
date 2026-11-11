import { useCommerceStore } from "@/stores/use-commerce-store";
import { Alert, App, Button, Checkbox, Input, InputNumber, Modal, Select, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import type { CommerceJob, CommerceSku, CompositionLayer, LayeredComposition } from "@/types/commerce";
import { applyLayoutPreset, moveLayoutLayer, prepareEditableComposition, resizeComposition } from "@/lib/commerce/marketing-layout";
import { inspectCompositionLayout } from "@/lib/commerce/marketing-typography";
import { renderLayeredComposition } from "@/lib/commerce/template-renderer";
import { saveMarketingLayout } from "@/lib/commerce/marketing-layout-save";
import { useServerConfigStore } from "@/services/server-config";

export function MarketingLayoutEditor({ job, sku, composition, reviewer, onClose }: { job: CommerceJob; sku: CommerceSku; composition: LayeredComposition; reviewer: string; onClose: () => void }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState(() => prepareEditableComposition(composition));
    const [selected, setSelected] = useState(() => composition.layers.find(l => l.type === "text" && l.name === "营销文案")?.id || composition.layers[0]?.id);
    const [preview, setPreview] = useState("");
    const [report, setReport] = useState<{ errors: string[]; warnings: string[] }>({ errors: [], warnings: [] });
    const [rendering, setRendering] = useState(true), [saving, setSaving] = useState(false);
    const [presetName, setPresetName] = useState("");
    const [guides, setGuides] = useState(true);
    const stage = useRef<HTMLDivElement>(null);
    const openedComposition = useRef(composition);
    const layer = draft.layers.find(l => l.id === selected);
    useEffect(() => useServerConfigStore.subscribe((next, previous) => { if (next.user?.id !== previous.user?.id || next.phase === "signed-out") onClose(); }), [onClose]);
    useEffect(() => {
        let active = true, url = ""; setRendering(true);
        const timer = setTimeout(() => void (async () => {
            try {
                const next = await inspectCompositionLayout(draft);
                if (!active) return; setReport(next);
                if (![draft.width, draft.height].every(n => Number.isFinite(n) && n >= 64 && n <= 4096)) throw new Error("画幅必须介于 64–4096 px");
                const blob = await renderLayeredComposition(draft, job.generationConfig, { allowUnsafe: true });
                if (active) { url = URL.createObjectURL(blob); setPreview(url); }
            } catch (error) { if (active) setReport({ errors: [error instanceof Error ? error.message : "预览失败"], warnings: [] }); }
            finally { if (active) setRendering(false); }
        })(), 120);
        return () => { active = false; clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
    }, [draft, job.generationConfig]);
    const patch = (values: Partial<CompositionLayer>) => setDraft(current => ({ ...current, layers: current.layers.map(l => l.id === selected ? { ...l, ...values } : l) }));
    const number = (label: string, key: "x" | "y" | "width" | "height" | "fontSize" | "lineHeight" | "letterSpacing" | "minFontSize" | "zIndex", min: number, max: number, fallback = 0) => <label className="flex items-center justify-between gap-2">{label}<InputNumber precision={2} aria-label={label} value={layer?.[key] ?? fallback} min={min} max={max} step={key === "lineHeight" ? 0.05 : 1} onChange={value => value !== null && patch({ [key]: value })}/></label>;
    const save = async () => {
        setSaving(true);
        try {
            const current = useCommerceStore.getState().jobs.find(j=>j.id===job.id)?.skus.find(s=>s.id===sku.id)?.compositions.find(c=>c.id===composition.id);
            if (current !== openedComposition.current) throw new Error("排版已在其他位置更新，请重新打开编辑器；当前草稿未覆盖新内容");
            await saveMarketingLayout(job.id, sku.id, composition.id, draft, reviewer, { presetName: presetName.trim() || undefined }); message.success("布局已保存为新版本，请重新审核内容"); onClose(); }
        catch (error) { message.error(error instanceof Error ? error.message : "布局保存失败"); }
        finally { setSaving(false); }
    };
    return <Modal open title="营销图排版" width={1200} style={{top:36}} styles={{body:{maxHeight:"calc(100vh - 210px)",overflowY:"auto"}}} onCancel={saving ? undefined : onClose} maskClosable={false} footer={<Space><Button disabled={saving} onClick={onClose}>取消</Button><Button type="primary" loading={saving} disabled={rendering || report.errors.length > 0} onClick={() => void save()}>保存新版本</Button></Space>}>
        <p className="mb-3">拖拽图层，或聚焦图层后用方向键移动 1 px（Shift 为 10 px）。绿色框保护完整商品画面，文案不得进入；虚线为画幅安全边距。保存会保留历史版本并重新要求内容审核。</p>
        {!composition.layoutVersion && <Alert className="mb-3" type="info" title="旧版布局已转换为编辑草稿；取消不会改变原图。为避免遮挡主体，完整底图与文案区分开放置。"/>}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div>
                <Space wrap className="mb-3">
                    <Select aria-label="营销画幅" value={`${draft.width}:${draft.height}`} style={{width:160}} onChange={value => { const [w,h] = value.split(":").map(Number); setDraft(current => resizeComposition(current,w,h)); }} options={[[job.generationConfig.outputSpec.size,job.generationConfig.outputSpec.size,"方形 1:1"],[job.generationConfig.outputSpec.size,Math.round(job.generationConfig.outputSpec.size*1.25),"竖版 4:5"],[job.generationConfig.outputSpec.size,Math.round(job.generationConfig.outputSpec.size*.75),"横版 4:3"]].map(([w,h,label])=>({value:`${w}:${h}`,label}))}/>
                    <Checkbox checked={guides} onChange={e=>setGuides(e.target.checked)}>显示安全区</Checkbox>
                    <span>{draft.width} × {draft.height} px{rendering ? " · 更新预览…" : " · 实际成图预览"}</span>
                </Space>
                <div ref={stage} data-testid="marketing-layout-stage" style={{position:"relative",width:`min(100%, calc(62vh * ${draft.width/draft.height}))`,maxWidth:680,aspectRatio:`${draft.width}/${draft.height}`,background:"#ddd",overflow:"hidden",touchAction:"none"}}>
                    {preview && <img src={preview} data-testid="marketing-layout-raster" alt="营销图实际渲染预览" draggable={false} style={{width:"100%",height:"100%",display:"block"}}/>}
                    {guides && <div aria-hidden style={{position:"absolute",inset:"2%",border:"1px dashed #e39800",pointerEvents:"none"}}/>}
                    {draft.layers.filter(l=>l.visible && l.type!=="shape").map(item=><button type="button" key={item.id} aria-label={`移动图层 ${item.name}`} data-layer-id={item.id} disabled={saving || item.locked} style={{position:"absolute",left:`${item.x/draft.width*100}%`,top:`${item.y/draft.height*100}%`,width:`${item.width/draft.width*100}%`,height:`${item.height/draft.height*100}%`,padding:0,background:"transparent",border:item.id===selected?"2px solid #1677ff":guides&&["background","product","flattened","decoration"].includes(item.type)?"1px solid #008e57":"1px solid transparent",zIndex:item.zIndex+100,cursor:item.locked?"default":"move",touchAction:"none"}}
                        onFocus={()=>setSelected(item.id)} onKeyDown={event=>{const delta: Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!delta[event.key])return;event.preventDefault();const step=event.shiftKey?10:1;setDraft(current=>{const actual=current.layers.find(l=>l.id===item.id)!;return moveLayoutLayer(current,item.id,actual.x+delta[event.key][0]*step,actual.y+delta[event.key][1]*step);});}}
                        onPointerDown={event=>{event.preventDefault();event.currentTarget.focus();setSelected(item.id);const rect=stage.current!.getBoundingClientRect();const start={x:event.clientX,y:event.clientY,lx:item.x,ly:item.y};event.currentTarget.setPointerCapture(event.pointerId);const target=event.currentTarget;const move=(e:PointerEvent)=>setDraft(current=>moveLayoutLayer(current,item.id,start.lx+(e.clientX-start.x)*draft.width/rect.width,start.ly+(e.clientY-start.y)*draft.height/rect.height));const end=()=>{target.removeEventListener("pointermove",move);target.removeEventListener("pointerup",end);target.removeEventListener("pointercancel",end);};target.addEventListener("pointermove",move);target.addEventListener("pointerup",end);target.addEventListener("pointercancel",end);}}
                    />)}
                </div>
                <div className="mt-3 space-y-2" aria-live="polite">{report.errors.map(text=><Alert key={text} type="error" title={text}/>)}{report.warnings.map(text=><Alert key={text} type="warning" title={text}/>)}</div>
            </div>
            <div className="space-y-3">
                <Select aria-label="当前图层" className="w-full" value={selected} onChange={setSelected} options={draft.layers.filter(l=>l.type!=="shape").map(l=>({value:l.id,label:l.name}))}/>
                {layer && <div className="space-y-2">
                    {layer.type==="text" && <><label>文案<Input.TextArea aria-label="图层文案" value={layer.content} autoSize={{minRows:3,maxRows:7}} onChange={e=>patch({content:e.target.value})}/></label>
                        <label>字体<Input aria-label="字体" value={layer.fontFamily || "Arial"} onChange={e=>patch({fontFamily:e.target.value})}/></label>
                        {number("字号","fontSize",8,300,36)}{number("最小字号","minFontSize",8,100,Math.max(12,(layer.fontSize || 36)*0.45))}{number("行距","lineHeight",1,3,1.25)}{number("字距","letterSpacing",0,30)}
                        <Checkbox checked={layer.autoFit!==false} onChange={e=>patch({autoFit:e.target.checked})}>长文案自动缩小适配</Checkbox>
                        <Select aria-label="文字对齐" className="w-full" value={layer.textAlign || "left"} onChange={value=>patch({textAlign:value})} options={[{value:"left",label:"左对齐"},{value:"center",label:"居中"},{value:"right",label:"右对齐"}]}/>
                    </>}
                    {number("横向位置","x",0,draft.width)}{number("纵向位置","y",0,draft.height)}{number("区域宽度","width",16,draft.width)}{number("区域高度","height",16,draft.height)}{number("图层顺序","zIndex",1,100)}
                    {!["product","background","flattened","decoration","text"].includes(layer.type) && <Checkbox checked={layer.visible} onChange={e=>patch({visible:e.target.checked})}>显示图层</Checkbox>}
                </div>}
                <hr/>
                <label>已有自定义布局<Select aria-label="应用自定义布局" className="w-full" placeholder="选择已保存布局" value={undefined} options={(sku.marketingLayouts||[]).map(p=>({value:p.id,label:p.name}))} onChange={id=>{try{setDraft(applyLayoutPreset(draft,sku.marketingLayouts!.find(p=>p.id===id)!));}catch(error){message.error(String(error));}}}/></label>
                <label>同时保存为自定义布局<Input aria-label="自定义布局名称" maxLength={60} placeholder="可选，例如：品牌长文案竖版" value={presetName} onChange={e=>setPresetName(e.target.value)}/></label>
                <Button onClick={()=>setDraft(prepareEditableComposition({...draft,layoutVersion:undefined}))}>恢复安全排版</Button>
                <p className="text-xs text-stone-500">安全排版将旧平铺水印作为页眉中的单枚水印保留，避免覆盖主体。字体缺失时明确回退；保存使用与预览相同的渲染器。ZIP 成品在无需再次压缩时保留保存图片原始字节，图层与布局同时保存。</p>
            </div>
        </div>
    </Modal>;
}
