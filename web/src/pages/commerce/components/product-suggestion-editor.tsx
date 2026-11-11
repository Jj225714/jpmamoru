import { Alert, App, Button, Checkbox, Input, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import { productSuggestionFingerprint, suggestedUncertaintyFactKey, uncertaintyResolutionKey } from "@/lib/commerce/product-suggestions";
import { generateCommerceProductSuggestion } from "@/services/product-base-prompt";
import { useConfigStore } from "@/stores/use-config-store";
import { getImageInputTextModelStatus } from "@/stores/use-config-store";
import { productTextModelReason } from "@/services/product-base-prompt";
import { captureCommerceRequestSession } from "@/lib/commerce/request-session";
import type { CommerceProductInformation, CommerceProductSuggestion, CommerceUncertaintyResolution, ProductRecord } from "@/types/commerce";

export const SUGGESTION_FIELDS: Array<{ key: keyof CommerceProductInformation; label: string; productKey: keyof ProductRecord }> = [
    { key: "name", label: "产品名称", productKey: "name" },
    { key: "audience", label: "目标受众", productKey: "audience" },
    { key: "sellingPoints", label: "产品描述 / 卖点", productKey: "description" },
    { key: "material", label: "材料说明", productKey: "materialDescription" },
    { key: "usage", label: "使用说明", productKey: "usageInstructions" },
    { key: "category", label: "英文类目路径", productKey: "categoryPath" },
];

export function ProductSuggestionEditor({
    product,
    prepareProduct,
    hasImages = product.images.length > 0,
    inputKey = "",
    getInputKey,
    onSave,
    onApply,
    onResolve,
}: {
    product: ProductRecord;
    prepareProduct?: () => Promise<ProductRecord>;
    hasImages?: boolean;
    inputKey?: string;
    getInputKey?: () => string;
    onSave: (draft: CommerceProductSuggestion) => void;
    onApply: (draft: CommerceProductSuggestion, fields: Array<keyof CommerceProductInformation>, replace: boolean) => void;
    onResolve?: (draft: CommerceProductSuggestion, item: string, resolution?: CommerceUncertaintyResolution) => void;
}) {
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState(product.informationSuggestion);
    const [fields, setFields] = useState<Array<keyof CommerceProductInformation>>(() => SUGGESTION_FIELDS.filter((field) => !String(product[field.productKey] || "").trim()).map((field) => field.key));
    const [replace, setReplace] = useState(false);
    const fingerprint = productSuggestionFingerprint(product);
    // New forms provide an input revision so materializing cached upload refs does
    // not cancel the very request that prepared them. SKU inputs use their fingerprint.
    const identity = product.id + (inputKey || fingerprint);
    const latest = useRef(identity);
    latest.current = identity;
    const request = useRef<AbortController | null>(null);
    useEffect(() => {
        request.current?.abort();
        setBusy(false);
        setDraft(product.informationSuggestion);
        setReplace(false);
        setFields(SUGGESTION_FIELDS.filter((field) => !String(product[field.productKey] || "").trim()).map((field) => field.key));
        return () => {
            request.current?.abort();
        };
    }, [identity]);
    const analyze = async () => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const started = latest.current;
        const startedInput = getInputKey?.();
        const session = captureCommerceRequestSession();
        const isCurrent = () => session.isCurrent() && !controller.signal.aborted && latest.current === started && (!getInputKey || getInputKey() === startedInput);
        setBusy(true);
        try {
            const status = getImageInputTextModelStatus(useConfigStore.getState().config);
            if (status.status !== "ready") throw new Error(productTextModelReason(status.status) + " 可继续手动填写商品信息。");
            const source = prepareProduct ? await prepareProduct() : product;
            if (!isCurrent()) return;
            const next = await generateCommerceProductSuggestion(useConfigStore.getState().config, source, { signal: controller.signal });
            if (!isCurrent()) return;
            setDraft(next);
            setReplace(false);
            setFields(SUGGESTION_FIELDS.filter((field) => !String(source[field.productKey] || "").trim()).map((field) => field.key));
            onSave(next);
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : "识别失败，请重试");
        } finally {
            session.dispose();
            if (request.current === controller) setBusy(false);
        }
    };
    const stale = Boolean(draft && draft.sourceFingerprint !== fingerprint);
    const saveDraft = (next: CommerceProductSuggestion) => {
        try {
            onSave(next);
            setDraft(next);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存建议失败");
        }
    };
    return (
        <div className="space-y-3">
            <Space wrap>
                <Button loading={busy} disabled={!hasImages} onClick={() => void analyze()}>
                    AI识别商品并建议卖点
                </Button>
                <span className="text-xs text-stone-500">仅点击时识别，建议需人工核对后采用。</span>
            </Space>
            {!hasImages ? <Alert type="info" title="请先上传商品实拍图" /> : null}
            {draft ? (
                <>
                    {stale ? <Alert type="warning" title="商品输入已变化，请重新生成建议后采用。" /> : null}
                    <div className="grid gap-3 sm:grid-cols-2">
                        {SUGGESTION_FIELDS.map(({ key, label, productKey }) => (
                            <div key={key}>
                                <Checkbox
                                    checked={fields.includes(key)}
                                    disabled={!replace && Boolean(String(product[productKey] || "").trim())}
                                    onChange={(event) => setFields((current) => (event.target.checked ? [...current, key] : current.filter((field) => field !== key)))}
                                >
                                    {label}
                                    {String(product[productKey] || "").trim() ? "（已有内容）" : ""}
                                </Checkbox>
                                <Input.TextArea aria-label={label + "建议"} rows={2} disabled={stale} value={draft.information[key]} onChange={(event) => saveDraft({ ...draft, information: { ...draft.information, [key]: event.target.value } })} />
                            </div>
                        ))}
                    </div>
                    {draft.uncertainties.length ? (
                        <div className="rounded-lg border border-amber-500/50 bg-amber-50 p-4 dark:bg-amber-950/30">
                            <div className="mb-1 font-medium text-amber-900 dark:text-amber-100">待确认信息（确认后才会写入产品事实）</div>
                            <div className="mb-3 text-xs text-amber-700 dark:text-amber-300">请依据实物、包装、说明书或检测数据填写；忽略的内容不会进入卖点。</div>
                            <div className="space-y-3">
                                {draft.uncertainties.map((item) => (
                                    <UncertaintyRow key={item} item={item} stale={stale} resolution={draft.uncertaintyResolutions?.[uncertaintyResolutionKey(item)]} onResolve={(resolution) => {
                                        if (onResolve) onResolve(draft, item, resolution);
                                        else saveDraft({ ...draft, uncertaintyResolutions: { ...(draft.uncertaintyResolutions || {}), ...(resolution ? { [uncertaintyResolutionKey(item)]: resolution } : {}) } });
                                    }} />
                                ))}
                            </div>
                        </div>
                    ) : null}
                    {draft.suggestedCategory ? <p className="text-xs text-stone-500">内部类目建议：{draft.suggestedCategory}。请在类目选择器中手动选择。</p> : null}
                    <Checkbox
                        checked={replace}
                        onChange={(event) => {
                            setReplace(event.target.checked);
                            if (!event.target.checked) setFields((current) => current.filter((key) => !String(product[SUGGESTION_FIELDS.find((field) => field.key === key)!.productKey] || "").trim()));
                        }}
                    >
                        允许替换所选字段的已有内容
                    </Checkbox>
                    <Button
                        type="primary"
                        disabled={stale || !fields.length || busy}
                        onClick={() => {
                            try {
                                onApply(draft, fields, replace);
                            } catch (error) {
                                message.error(error instanceof Error ? error.message : "采用失败");
                            }
                        }}
                    >
                        采用所选字段
                    </Button>
                </>
            ) : null}
        </div>
    );
}

function UncertaintyRow({ item, stale, resolution, onResolve }: { item: string; stale: boolean; resolution?: CommerceUncertaintyResolution; onResolve: (resolution?: CommerceUncertaintyResolution) => void }) {
    const [factKey, setFactKey] = useState(resolution?.factKey || suggestedUncertaintyFactKey(item));
    const [value, setValue] = useState(resolution?.value || "");
    useEffect(() => { setFactKey(resolution?.factKey || suggestedUncertaintyFactKey(item)); setValue(resolution?.value || ""); }, [item, resolution?.factKey, resolution?.value]);
    const resolvedLabel = resolution?.status === "confirmed" ? "已确认并写入产品事实" : resolution?.status === "ignored" ? "已忽略，不用于生成" : "待处理";
    return (
        <div className="rounded-md border border-amber-300 bg-white/70 p-3 dark:border-amber-800 dark:bg-stone-950/50">
            <div className="text-sm">{item}</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[180px_1fr]">
                <Input aria-label={item + "事实名称"} value={factKey} disabled={stale || resolution?.status === "ignored"} onChange={(event) => setFactKey(event.target.value)} placeholder="事实名称" />
                <Input aria-label={item + "核实结果"} value={value} disabled={stale || resolution?.status === "ignored"} onChange={(event) => setValue(event.target.value)} placeholder="填写核实后的准确内容" />
            </div>
            <Space wrap className="mt-2">
                <Button size="small" type="primary" disabled={stale || !factKey.trim() || !value.trim()} onClick={() => onResolve({ status: "confirmed", factKey: factKey.trim(), value: value.trim(), resolvedAt: new Date().toISOString() })}>确认并写入事实</Button>
                <Button size="small" disabled={stale} onClick={() => onResolve({ status: "ignored", resolvedAt: new Date().toISOString() })}>忽略</Button>
                {resolution ? <Button size="small" disabled={stale} onClick={() => onResolve(undefined)}>恢复待确认</Button> : null}
                <span className="text-xs text-stone-500">{resolvedLabel}</span>
            </Space>
        </div>
    );
}
