import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Alert, Button, Card, Empty, Image, Select, Space, Upload } from "antd";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { extractProductBackground, extractProductBackgroundWithApi, extractProductFromWhiteBackground } from "@/lib/commerce/background-removal";
import { createWhiteEditor, inspectWhiteLayer, normalizeWhiteImage, renderWhiteImage } from "@/lib/commerce/white-image-renderer";
import { DEFAULT_WHITE_ADJUSTMENTS, whiteEditSignature, type WhiteDraft, type WhiteEditorData } from "@/lib/commerce/white-image-edit";
import { materializeWhiteResult, whiteDraftForResult } from "@/lib/commerce/white-image-result";
import { adoptWorkbenchWhite } from "@/lib/commerce/pipeline";
import { imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { requestEdit } from "@/services/api/image";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useCommerceStore } from "@/stores/use-commerce-store";
import { useProductWhiteStore, useProductWhiteHydration, type WhiteResult } from "@/stores/use-product-white-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { CanvasNodeType } from "@/types/canvas";
import type { StoredImageRef } from "@/types/commerce";
import { ProductWhiteEditor } from "./product-white-editor";
import { ReferenceReadiness } from "./reference-readiness";
import { ReferenceReadinessPanel, useReferenceReadiness } from "./reference-readiness-panel";
import { useServerConfigStore } from "@/services/server-config";

export function whiteAccountStamp() {
    const state = useServerConfigStore.getState();
    return JSON.stringify([state.user?.id ?? null, ["checking", "signed-out"].includes(state.phase) ? state.phase : "authenticated"]);
}

/** A white-background task has exactly one source: the latest selection wins. */
export class WhiteSourceAdmission {
    private resolved?: { source: StoredImageRef; dataUrl: string; owner: string };
    constructor(readonly queue: ReferenceReadiness, private owner = whiteAccountStamp) {}
    clear() { this.resolved = undefined; this.queue.reset(); }
    read(name: string, load: () => Promise<StoredImageRef>, commit: (source: StoredImageRef) => void = () => {}) {
        this.clear();
        const owner = this.owner();
        this.queue.add(name, async () => {
            const source = { ...await load() };
            const dataUrl = await imageToDataUrl(source);
            if (!dataUrl) throw new Error("商品图片读取失败，请重试");
            if (owner !== this.owner()) throw new Error("账号会话已切换，请重新选择商品图片");
            return { source, dataUrl, owner };
        }, (value) => { this.resolved = value; commit({ ...value.source }); });
    }
    snapshot() {
        if (!this.queue.ready() || !this.resolved || this.resolved.owner !== this.owner()) return undefined;
        const owner = this.resolved.owner, checkpoint = this.queue.checkpoint();
        return { source: { ...this.resolved.source }, dataUrl: this.resolved.dataUrl, current: () => owner === this.owner() && checkpoint() };
    }
}

export function ProductWhiteWorkbench() {
    const hydration = useProductWhiteHydration();
    if (hydration === "loading") return <div role="status" className="p-6">正在读取白底处理记录…</div>;
    if (hydration === "error") return <div className="p-6"><Alert type="error" title="白底处理记录读取失败，尚未修改已保存的数据" action={<Button onClick={() => void useProductWhiteStore.persist.rehydrate()}>重试读取</Button>} /></div>;
    return <HydratedProductWhiteWorkbench />;
}

function HydratedProductWhiteWorkbench() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const accountStamp = useServerConfigStore(() => whiteAccountStamp());
    const previousAccount = useRef(accountStamp);
    const session = JSON.stringify([accountStamp, params.get("job"), params.get("sku")]);
    const readiness = useReferenceReadiness(session);
    const [sourceAdmission] = useState(() => new WhiteSourceAdmission(readiness));
    const initializedSession = useRef<string | undefined>(undefined);
    const jobs = useCommerceStore((s) => s.jobs);
    const roles = useCommerceStore((s) => s.modelRoles);
    const config = useEffectiveConfig();
    const records = useProductWhiteStore((s) => s.records);
    const selectedId = useProductWhiteStore((s) => s.selectedId);
    const result = records.find((record) => record.id === selectedId);
    const [uploadedSource, setSource] = useState<StoredImageRef>();
    const source = result?.source || uploadedSource;
    const [method, setMethod] = useState<"ai" | "api">("ai");
    const [newOutput, setNewOutput] = useState<WhiteDraft["output"]>({ size: 1024, format: "jpeg" });
    const [localDraft, setLocalDraft] = useState<{ id: string; value: WhiteDraft }>();
    const draft = result ? (localDraft?.id === result.id ? localDraft.value : whiteDraftForResult(result)) : undefined;
    const output = draft?.output || newOutput;
    const draftRef = useRef<{ id: string; value: WhiteDraft } | undefined>(undefined);
    const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const epoch = useRef(0);
    const running = useRef(false);
    const [busy, setBusy] = useState(false);
    const [preparingEditor, setPreparingEditor] = useState(false);
    const [error, setError] = useState("");
    const [target, setTarget] = useState<string>();
    const targets = jobs.flatMap((job) => job.skus.map((sku) => ({ value: job.id + "/" + sku.id, label: job.name + " · " + sku.product.sku, job, sku })));
    const sourceJob = jobs.find((j) => j.id === params.get("job"));
    const sourceSku = sourceJob?.skus.find((s) => s.id === params.get("sku"));

    const flushDraft = () => {
        clearTimeout(draftTimer.current);
        const pending = draftRef.current;
        if (pending) {
            useProductWhiteStore.getState().update(pending.id, { draft: pending.value });
            draftRef.current = undefined;
        }
    };
    const changeDraft = (value: WhiteDraft) => {
        if (!result || running.current) return;
        const next = { id: result.id, value };
        setLocalDraft(next);
        draftRef.current = next;
        clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(flushDraft, 250);
    };
    const selectRecord = (record?: WhiteResult, invalidate = true) => {
        flushDraft();
        if (invalidate) {
            epoch.current++;
            sourceAdmission.clear();
            if (record) sourceAdmission.read(record.source.name, async () => record.source);
        }
        useProductWhiteStore.getState().select(record?.id);
        setSource(record?.source);
        setLocalDraft(undefined);
        setError("");
    };
    useLayoutEffect(() => {
        if (previousAccount.current !== accountStamp) {
            previousAccount.current = accountStamp;
            selectRecord(); setTarget(undefined); initializedSession.current = session;
            return;
        }
        if (sourceSku && sourceJob) {
            selectRecord();
            const skuSource = sourceSku.product.images[0];
            if (skuSource) sourceAdmission.read(skuSource.name, async () => skuSource, setSource);
            setTarget(sourceJob.id + "/" + sourceSku.id);
        } else {
            // StrictMode can repeat setup with the same session. Restore from the
            // hydrated store on both passes rather than clearing its selection.
            const sameSession = initializedSession.current === undefined || initializedSession.current === session;
            const state = useProductWhiteStore.getState();
            selectRecord(sameSession && !params.get("job") && !params.get("sku") ? state.records.find((record) => record.id === state.selectedId) : undefined);
            setTarget(undefined);
        }
        initializedSession.current = session;
    }, [session, sourceJob?.id, sourceSku?.id]);
    useLayoutEffect(() => useServerConfigStore.subscribe(() => {
        if (previousAccount.current === whiteAccountStamp()) return;
        // Synchronous invalidation closes the interval before React renders the new account.
        epoch.current++;
        sourceAdmission.clear();
        useProductWhiteStore.getState().select(undefined);
        setSource(undefined); setLocalDraft(undefined); setTarget(undefined);
    }), [sourceAdmission]);
    useEffect(() => {
        const onPageHide = () => flushDraft();
        window.addEventListener("pagehide", onPageHide);
        return () => {
            epoch.current++;
            sourceAdmission.clear();
            flushDraft();
            window.removeEventListener("pagehide", onPageHide);
        };
    }, []);

    const run = async (action: (current: () => boolean) => Promise<void>) => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        setError("");
        const token = epoch.current;
        const owner = whiteAccountStamp();
        const current = () => token === epoch.current && owner === whiteAccountStamp();
        try {
            await action(current);
        } catch (e) {
            if (current()) setError(e instanceof Error ? e.message : "处理失败，请重试");
        } finally {
            running.current = false;
            setBusy(false);
        }
    };

    const prepareEditor = async (record: WhiteResult, current: () => boolean) => {
        setPreparingEditor(true);
        try {
            const blob = await extractProductFromWhiteBackground({ ...record.source, url: record.image.url, storageKey: record.image.storageKey });
            if (!current()) return;
            const editor = await createWhiteEditor(blob, true);
            if (!current()) return;
            flushDraft();
            useProductWhiteStore.getState().update(record.id, { editor, renderSignature: undefined });
        } catch (e) {
            throw new Error("白底图已保留，调整面板准备失败，请重试。" + (e instanceof Error ? " " + e.message : ""));
        } finally {
            setPreparingEditor(false);
        }
    };

    const generate = () =>
        run(async (current) => {
            const reference = sourceAdmission.snapshot();
            if (!reference) throw new Error("商品图片尚未就绪，请等待上传完成，或重试/移除失败图片");
            const source = reference.source;
            const taskCurrent = current;
            current = () => taskCurrent() && reference.current();
            const snapshot = { ...output };
            let image;
            let editor: WhiteEditorData | undefined;
            if (method === "api") {
                const blob = await extractProductBackgroundWithApi({ ...source, url: reference.dataUrl, storageKey: undefined }, roles);
                if (!current()) return;
                const inspected = await inspectWhiteLayer(blob);
                if (inspected.transparent) {
                    editor = await createWhiteEditor(blob);
                    image = await renderWhiteImage(editor, editor.applied, snapshot);
                } else {
                    // Flattened results are retained before automatically preparing their editable layer.
                    image = await normalizeWhiteImage(await uploadImage(blob), snapshot);
                }
            } else {
                const model = config.imageModel || config.model;
                if (!useConfigStore.getState().isAiConfigReady(config, model)) {
                    useConfigStore.getState().openConfigDialog(true);
                    throw new Error("请先配置图片模型");
                }
                const generated = await requestEdit(
                    { ...config, model, imageModel: model, size: "1:1", count: "1" },
                    "将参考图中的商品制作成电商白底主图。纯白背景 RGB(255,255,255)，完整保留商品外形、颜色、纹理、配件及数量，商品居中，四周留白，不裁切主体。移除背景、文字、标志和水印，不虚构结构，不添加道具，无投影。只输出一张单一商品构图，不要拼图。",
                    [{ id: source.id, name: source.name, type: "image/png", dataUrl: reference.dataUrl }],
                );
                if (!current()) return;
                if (!generated[0]) throw new Error("模型未返回图片");
                image = await normalizeWhiteImage(await uploadImage(generated[0].dataUrl), snapshot);
            }
            if (!current()) return;
            const next: WhiteResult = { id: nanoid(), source, image, createdAt: new Date().toISOString(), output: snapshot, editor, renderSignature: whiteEditSignature(editor, DEFAULT_WHITE_ADJUSTMENTS, snapshot) };
            flushDraft();
            useProductWhiteStore.getState().add(next);
            selectRecord(next, false);
            if (!editor) await prepareEditor(next, current);
            if (current()) message.success("白底图已生成，调整完成后点击保存调整");
        });

    const startEditing = () =>
        run(async (current) => {
            if (!result) return;
            await prepareEditor(result, current);
            if (current()) message.success("商品图层已准备好，原结果已保留");
        });

    const withCurrentResult = (action: (record: WhiteResult, current: () => boolean) => Promise<void>) =>
        run(async (current) => {
            if (!result || !draft) return;
            const snapshot: WhiteDraft = { adjustments: { ...draft.adjustments }, output: { ...draft.output } };
            flushDraft();
            const next = await materializeWhiteResult(result, snapshot, useProductWhiteStore.getState().records);
            if (!current()) return;
            const store = useProductWhiteStore.getState();
            if (!store.records.some((record) => record.id === next.id)) store.add(next);
            store.update(next.id, { draft: undefined });
            store.select(next.id);
            setLocalDraft(undefined);
            draftRef.current = undefined;
            await action({ ...next, draft: undefined }, current);
        });

    const apply = () => {
        const selected = targets.find((t) => t.value === target);
        if (!selected || !result) return;
        const submit = () =>
            withCurrentResult(async (record, current) => {
                await adoptWorkbenchWhite(selected.job.id, selected.sku.id, record.image);
                if (current()) navigate("/commerce/" + selected.job.id);
            });
        if (selected.sku.assets.length) modal.confirm({ title: "替换该 SKU 的白底主图？", content: "旧版本会保留。新版本需要重新审核白底图，并重新生成场景、营销图和合规结果。", okText: "采用并重新审核", cancelText: "取消", onOk: submit });
        else void submit();
    };
    const sendToCanvas = () =>
        withCurrentResult(async (record, current) => {
            const image = record.image;
            const url = await resolveImageUrl(image.storageKey, image.url);
            if (!current()) return;
            const store = useCanvasStore.getState();
            const id = store.createProject("商品白底图 · " + record.source.name);
            const node = createCanvasNode(CanvasNodeType.Image, { x: 160, y: 160 }, { content: url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType });
            store.updateProject(id, { nodes: [{ ...node, title: "商品白底图" }] });
            navigate("/canvas/" + id);
        });

    return (
        <main className="h-full overflow-y-auto p-3 md:p-6">
            <div className="mx-auto max-w-7xl space-y-4">
                <div>
                    <h1 className="text-2xl font-semibold">商品白底图</h1>
                    <p className="mt-2 opacity-65">调整商品角度、大小和颜色，制作更贴近实物的白底主图。</p>
                </div>
                <Card>
                    <Space wrap>
                        <Upload
                            accept="image/*"
                            showUploadList={false}
                            disabled={busy}
                            beforeUpload={(file) => {
                                if (running.current) return false;
                                selectRecord();
                                setNewOutput({ ...output });
                                sourceAdmission.read(file.name, async () => {
                                    const image = await uploadImage(file);
                                    return { id: nanoid(), name: file.name, url: image.url, storageKey: image.storageKey, source: "upload" };
                                }, setSource);
                                return false;
                            }}
                        >
                            <Button disabled={busy}>上传商品图片</Button>
                        </Upload>
                        <Select
                            aria-label="白底处理方式"
                            disabled={busy}
                            value={method}
                            onChange={setMethod}
                            style={{ width: 180 }}
                            options={[
                                { value: "ai", label: "AI 白底优化" },
                                { value: "api", label: "已配置的抠图 API", disabled: !roles.removalApiUrl },
                            ]}
                        />
                        <Select
                            aria-label="白底输出尺寸"
                            disabled={busy}
                            value={output.size}
                            onChange={(size) => (draft ? changeDraft({ ...draft, output: { ...output, size } }) : setNewOutput({ ...output, size }))}
                            options={[800, 1024, 1254, 1600].map((n) => ({ value: n, label: n + " × " + n }))}
                        />
                        <Select
                            aria-label="白底输出格式"
                            disabled={busy}
                            value={output.format}
                            onChange={(format) => (draft ? changeDraft({ ...draft, output: { ...output, format } }) : setNewOutput({ ...output, format }))}
                            options={[
                                { value: "jpeg", label: "JPG" },
                                { value: "png", label: "PNG" },
                            ]}
                        />
                        <Button type="primary" disabled={!sourceAdmission.snapshot() || busy} loading={busy} onClick={() => void generate()}>
                            生成白底图
                        </Button>
                    </Space>
                    <ReferenceReadinessPanel queue={readiness} />
                    <p className="mt-3 text-sm opacity-65">纯白背景 · 96 DPI · 最大 2MB。</p>
                    {method === "ai" && <Alert type="info" title="AI 优化使用当前图片模型，请核对结果中的商品结构与纹理。" />}
                </Card>
                {error && <Alert type="error" title={error} closable onClose={() => setError("")} />}
                <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.8fr)]">
                    <Card title="商品原图" className="lg:sticky lg:top-0">
                        {source ? <StoredPreview image={source} /> : <Empty description="上传一张商品图片开始" />}
                    </Card>
                    <Card title={result?.editor ? "白底编辑" : "白底结果"} extra={result?.editor ? <span className="text-xs opacity-60">草稿自动保存</span> : undefined}>
                        {result && draft ? (
                            result.editor ? (
                                <ProductWhiteEditor
                                    key={result.id}
                                    editor={result.editor}
                                    value={draft.adjustments}
                                    outputFormat={output.format}
                                    disabled={busy}
                                    onChange={(adjustments) => changeDraft({ ...draft, adjustments })}
                                    onSave={() =>
                                        void withCurrentResult(async () => {
                                            message.success("当前调整已保存到白底处理记录");
                                        })
                                    }
                                />
                            ) : (
                                <div className="space-y-4">
                                    <StoredPreview image={result.image} />
                                    {preparingEditor ? (
                                        <Alert type="info" title="白底图已生成，正在准备右侧调整面板…" />
                                    ) : (
                                        <>
                                            <Button type="primary" disabled={busy} onClick={() => void startEditing()}>
                                                {error ? "重试准备调整面板" : "编辑构图与颜色"}
                                            </Button>
                                            <p className="text-xs opacity-65">保留当前构图和原始结果；准备完成后可直接调整并保存。</p>
                                        </>
                                    )}
                                </div>
                            )
                        ) : (
                            <Empty description={busy ? "正在处理，请稍候" : "生成后在这里预览和调整"} />
                        )}
                    </Card>
                </div>
                {result && (
                    <Card title="使用这张白底图">
                        <p className="mb-3 text-sm opacity-65">以下操作均使用当前调整效果；保存调整会保留原版本。</p>
                        <Space wrap>
                            <Button
                                type="primary"
                                disabled={busy}
                                onClick={() =>
                                    void withCurrentResult(async () => {
                                        message.success("当前调整已保存到白底处理记录");
                                    })
                                }
                            >
                                保存调整
                            </Button>
                            <Button
                                disabled={busy}
                                onClick={() =>
                                    void withCurrentResult(async (record, current) => {
                                        const data = await imageToDataUrl(record.image);
                                        const blob = await fetch(data).then((response) => response.blob());
                                        if (current()) saveAs(blob, "商品白底图." + (record.image.mimeType === "image/png" ? "png" : "jpg"));
                                    })
                                }
                            >
                                下载白底图
                            </Button>
                            <Button disabled={busy} onClick={() => void sendToCanvas()}>
                                送入画布
                            </Button>
                            <Button
                                disabled={busy}
                                onClick={() =>
                                    void withCurrentResult(async (record) => {
                                        const i = record.image;
                                        useAssetStore.getState().addAsset({
                                            kind: "image",
                                            title: "商品白底图 · " + record.source.name,
                                            coverUrl: i.url,
                                            tags: ["商品白底图"],
                                            data: { dataUrl: i.url, storageKey: i.storageKey, width: i.width, height: i.height, bytes: i.bytes, mimeType: i.mimeType },
                                        });
                                        message.success("已保存到素材库");
                                    })
                                }
                            >
                                保存到素材库
                            </Button>
                            <Button
                                disabled={busy}
                                onClick={() =>
                                    void withCurrentResult(async (record) => {
                                        useProductWhiteStore.getState().setPending(record);
                                        navigate("/commerce?from=product-white");
                                    })
                                }
                            >
                                用此图新建跨境任务
                            </Button>
                        </Space>
                        <div className="mt-4 flex flex-wrap gap-2">
                            <Select
                                aria-label="目标跨境 SKU"
                                showSearch
                                optionFilterProp="label"
                                disabled={busy}
                                value={target}
                                onChange={setTarget}
                                options={targets.map(({ value, label }) => ({ value, label }))}
                                placeholder="选择已有跨境任务 / SKU"
                                className="min-w-0 flex-1"
                                style={{ minWidth: 180 }}
                            />
                            <Button disabled={!target || busy} onClick={apply}>
                                用于此 SKU 白底主图
                            </Button>
                        </div>
                    </Card>
                )}
                {records.length > 0 && (
                    <Card title="白底处理记录">
                        <Select
                            aria-label="白底历史记录"
                            className="w-full"
                            disabled={busy}
                            value={result?.id}
                            placeholder="选择之前处理的图片"
                            options={records.map((r) => ({ value: r.id, label: r.source.name + " · " + new Date(r.createdAt).toLocaleString() + (r.rootId ? " · 调整版本" : "") + (r.draft ? " · 有草稿" : "") }))}
                            onChange={(id) => selectRecord(records.find((r) => r.id === id))}
                        />
                    </Card>
                )}
            </div>
        </main>
    );
}

function StoredPreview({ image }: { image: { url: string; storageKey?: string } }) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        let active = true;
        setUrl("");
        setError("");
        void resolveImageUrl(image.storageKey, image.url)
            .then((value) => {
                if (active) setUrl(value);
            })
            .catch(() => {
                if (active) setError("图片读取失败，请重新上传或选择其他记录");
            });
        return () => {
            active = false;
        };
    }, [image.url, image.storageKey]);
    return error ? <Alert type="error" title={error} /> : url ? <Image src={url} className="max-h-[36rem] object-contain" /> : <span>正在读取图片…</span>;
}
