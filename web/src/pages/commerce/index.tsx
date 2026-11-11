import { App, Button, Card, Empty, Form, Input, Modal, Progress, Radio, Select, Space, Table, Tag, Upload } from "antd";
import { FileSpreadsheet, PackagePlus, Settings2, Trash2, UploadCloud } from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useProductWhiteStore } from "@/stores/use-product-white-store";
import { adoptWorkbenchWhite } from "@/lib/commerce/pipeline";

import { loadImportPreview, buildImportProducts, type ImportPreviewState } from "@/lib/commerce/importers-preview";
import { ImportPreview } from "./components/import-preview";
import { cloneGenerationConfig, DEFAULT_BRAND_GENERATION_DEFAULTS } from "@/lib/commerce/generation-config";
import { GenerationConfigFields } from "@/pages/commerce/components/generation-config-fields";
import { ProductSuggestionEditor } from "@/pages/commerce/components/product-suggestion-editor";
import { adoptProductSuggestion, resolveProductUncertainty } from "@/lib/commerce/product-suggestions";
import { createCreativeRequirementPresets } from "@/lib/commerce/creative-presets";
import { uploadImage } from "@/services/image-storage";
import { catalogBlocksNewJob } from "@/services/commerce-policy-catalog";
import { useCommerceStore } from "@/stores/use-commerce-store";
import { useServerConfigStore } from "@/services/server-config";
import { captureCommerceRequestSession, getCommerceAccountEpoch } from "@/lib/commerce/request-session";
import { getServerConfigEnabled } from "@/constant/runtime-config";
import type { CommerceGenerationConfig, CommerceLocale, CommercePlatform, CommerceProductSuggestion, ProductRecord, StoredImageRef } from "@/types/commerce";

type SingleForm = { sku: string; productType: string; name: string; brandName?: string; category: string; audience?: string; description?: string; size?: string; materialDescription?: string; usageInstructions?: string; categoryPath?: string };

export default function CommercePage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const pendingWhite = useProductWhiteStore((state) => state.pending);
    const incomingWhite = params.get("from") === "product-white" ? pendingWhite : undefined;
    const jobs = useCommerceStore((state) => state.jobs);
    const allBrands = useCommerceStore((state) => state.brands);
    const teamPolicyPackId = useCommerceStore((state) => state.teamPolicyPackId);
    const teamBrandIds = useCommerceStore((state) => state.teamBrandIds);
    const brands = useMemo(() => allBrands.filter((brand) => teamPolicyPackId ? teamBrandIds.includes(brand.id) : !brand.id.startsWith("server-brand-") && !brand.id.startsWith("team-brand-")), [allBrands, teamPolicyPackId, teamBrandIds]);
    const syncPhase = useServerConfigStore((state) => state.phase);
    const hydrated = useCommerceStore((state) => state.hydrated);
    const catalog = useCommerceStore((state) => state.catalogStatus);
    const createJob = useCommerceStore((state) => state.createJob);
    const removeJob = useCommerceStore((state) => state.removeJob);
    const policyPacks = useCommerceStore((state) => state.policyPacks);
    const initializing = !hydrated || (!teamPolicyPackId && catalogBlocksNewJob(catalog, policyPacks)) || (getServerConfigEnabled() && !["ready", "saving"].includes(syncPhase));
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<"excel" | "single">("excel");
    const [jobName, setJobName] = useState("跨境商品图片任务");
    const [platform, setPlatform] = useState<CommercePlatform>("shopee");
    const [brandId, setBrandId] = useState(brands[0]?.id);
    const initialDefaults = brands[0]?.generationDefaults || DEFAULT_BRAND_GENERATION_DEFAULTS;
    const activePack = policyPacks.find((item) => item.id === teamPolicyPackId) || policyPacks.filter((item) => item.status === "published").sort((a, b) => b.version - a.version)[0];
    const newJobRequirements = activePack?.creativeLibraryVersion ? activePack.requirementPresets : createCreativeRequirementPresets();
    const [generationConfig, setGenerationConfig] = useState<CommerceGenerationConfig>(() => cloneGenerationConfig(initialDefaults));
    const [locales, setLocales] = useState<CommerceLocale[]>(() => [...initialDefaults.locales]);
    const [excelFile, setExcelFile] = useState<File>();
    const [zipFile, setZipFile] = useState<File>();
    const [sourceImages, setSourceImages] = useState<File[]>([]);
    const [importPreview, setImportPreview] = useState<ImportPreviewState>();
    const [previewLoading, setPreviewLoading] = useState(false);
    const previewFiles = useRef<{ excel?: File; zip?: File } | undefined>(undefined);
    useEffect(() => { setImportPreview(undefined); previewFiles.current = undefined; }, [excelFile, zipFile]);
    const [creating, setCreating] = useState(false);
    const submitting = useRef(false);
    const creationInputs = useRef<object | undefined>(undefined);
    creationInputs.current = useMemo(() => ({}), [open, mode, excelFile, zipFile, sourceImages, jobName, platform, brandId, locales, generationConfig, importPreview]);
    const [form] = Form.useForm<SingleForm>();
    const values = Form.useWatch([], form) as Partial<SingleForm> | undefined;
    const [suggestion, setSuggestion] = useState<CommerceProductSuggestion>();
    const [confirmedSuggestionFacts, setConfirmedSuggestionFacts] = useState<Record<string, string>>({});
    const [inputRevision, setInputRevision] = useState(0);
    const inputRevisionRef = useRef(0);
    const invalidateInput = () => {
        inputRevisionRef.current += 1;
        setInputRevision(inputRevisionRef.current);
    };
    const changeOpen = (value: boolean) => {
        invalidateInput();
        setOpen(value);
    };
    const [, setUploadRevision] = useState(0);
    const productId = useRef(nanoid());
    const uploadCache = useRef(new Map<File, Promise<StoredImageRef>>());
    const resolvedImages = useRef(new Map<File, StoredImageRef>());
    const localProduct = (
        value: Partial<SingleForm> = form.getFieldsValue(),
        images: StoredImageRef[] = sourceImages.length ? sourceImages.flatMap((file) => resolvedImages.current.get(file) || []) : incomingWhite ? [incomingWhite.source] : [],
    ): ProductRecord => ({
        id: productId.current,
        sku: value.sku?.trim() || "",
        productType: value.productType?.trim() || "",
        name: value.name?.trim() || "",
        brandName: value.brandName?.trim() || "",
        category: value.category?.trim() || "",
        audience: value.audience?.trim() || "",
        description: value.description?.trim() || "",
        size: value.size?.trim() || "",
        materialDescription: value.materialDescription?.trim() || "",
        usageInstructions: value.usageInstructions?.trim() || "",
        categoryPath: value.categoryPath?.trim() || "",
        informationSuggestion: suggestion,
        images,
        imageUrls: [],
        extraFields: {},
        verifiedFacts: confirmedSuggestionFacts,
        factsConfirmed: false,
        imageStatus: images.length ? "ready" : "missing",
    });
    const prepareProduct = async () => {
        const accountEpoch = getCommerceAccountEpoch();
        const value = form.getFieldsValue();
        const images = sourceImages.length
            ? await Promise.all(
                  sourceImages.slice(0, 6).map((file) => {
                      let pending = uploadCache.current.get(file);
                      if (!pending) {
                          pending = uploadImage(file)
                              .then((stored) => {
                                  if (accountEpoch !== getCommerceAccountEpoch()) throw new Error("账号已变化，请重新上传商品图片。");
                                  const image: StoredImageRef = { id: nanoid(), name: file.name, url: stored.url, storageKey: stored.storageKey, source: "upload" };
                                  resolvedImages.current.set(file, image);
                                  return image;
                              })
                              .catch((error) => {
                                  uploadCache.current.delete(file);
                                  throw error;
                              });
                          uploadCache.current.set(file, pending);
                      }
                      return pending;
                  }),
              )
            : incomingWhite
              ? [incomingWhite.source]
              : [];
        if (accountEpoch !== getCommerceAccountEpoch()) throw new Error("账号已变化，请重新上传商品图片。");
        setUploadRevision((revision) => revision + 1);
        return localProduct(value, images);
    };
    useEffect(() => useServerConfigStore.subscribe((state, previous) => {
        if (state.user?.id === previous.user?.id && !(state.phase === "signed-out" && previous.phase !== "signed-out")) return;
        invalidateInput();
        uploadCache.current.clear();
        resolvedImages.current.clear();
        setSourceImages([]);
        setExcelFile(undefined);
        setZipFile(undefined);
        setSuggestion(undefined);
        setImportPreview(undefined);
        previewFiles.current = undefined;
        setConfirmedSuggestionFacts({});
        form.resetFields();
        setOpen(false);
    }), [form]);

    useEffect(() => {
        if (incomingWhite) {
            invalidateInput();
            setMode("single");
            setOpen(true);
            setJobName("商品白底图 · 跨境任务");
            form.setFieldsValue({ name: incomingWhite.source.name.replace(/\.[^.]+$/, "") });
        }
    }, [incomingWhite?.id, form]);

    useEffect(() => {
        if (!brands.some((brand) => brand.id === brandId)) setBrandId(brands[0]?.id);
    }, [brandId, brands]);

    useEffect(() => {
        const defaults = brands.find((brand) => brand.id === brandId)?.generationDefaults;
        if (defaults) {
            setGenerationConfig(cloneGenerationConfig(defaults));
            setLocales([...defaults.locales]);
        }
    }, [brandId, brands]);

    const rows = useMemo(() => (jobs || []).map((job) => ({ ...job, progress: Math.round((job.skus || []).reduce((sum, sku) => sum + stageProgress(sku.stage), 0) / Math.max(1, (job.skus || []).length)) })), [jobs]);

    const previewImport = async () => {
        const session = captureCommerceRequestSession();
        const snapshot = creationInputs.current;
        setPreviewLoading(true);
        try {
            const value = await loadImportPreview({ workbook: excelFile, zip: zipFile });
            session.assertCurrent();
            if (snapshot !== creationInputs.current) throw new Error("导入文件或配置已变化，请重新读取预览");
            previewFiles.current = { excel: excelFile, zip: zipFile };
            setImportPreview(value);
        } catch (error) { message.error(error instanceof Error ? error.message : "读取预览失败"); }
        finally { session.dispose(); setPreviewLoading(false); }
    };

    const submit = async () => {
        if (submitting.current) return;
        submitting.current = true;
        const session = captureCommerceRequestSession();
        const snapshot = creationInputs.current;
        const inputRevisionAtSubmit = inputRevisionRef.current;
        setCreating(true);
        try {
            await (await import("@/services/settings-readiness")).ensureSettingsReady();
            if (!locales.length) throw new Error("请至少选择 1 种目标语言");
            const estimate = await navigator.storage?.estimate?.();
            if (estimate?.quota && estimate?.usage && estimate.quota - estimate.usage < 150 * 1024 * 1024) throw new Error("浏览器剩余存储空间不足 150MB，请先清理旧任务或导出后删除素材");
            let products: ProductRecord[];
            if (mode === "excel") {
                if (!importPreview || previewFiles.current?.excel !== excelFile || previewFiles.current?.zip !== zipFile) throw new Error("请先读取并确认 SKU 图片映射预览");
                products = buildImportProducts(importPreview);
            } else {
                await form.validateFields();
                products = [await prepareProduct()];
            }
            await useCommerceStore.getState().loadServerCatalog(true);
            const current = useCommerceStore.getState();
            session.assertCurrent();
            if (snapshot !== creationInputs.current || inputRevisionAtSubmit !== inputRevisionRef.current) throw new Error("商品或参考图选择已变化，本次读取结果未创建任务，请重新提交");
            if (!current.teamPolicyPackId && (catalogBlocksNewJob(current.catalogStatus, current.policyPacks) || current.catalogStatus.phase === "error")) throw new Error("规则目录更新失败，请重试后创建任务");
            const id = createJob({ name: jobName, products, platform, brandProfileId: brandId, locales, generationConfig });
            if (mode === "single" && incomingWhite && !sourceImages.length) {
                try {
                    const sku = useCommerceStore.getState().jobs.find((job) => job.id === id)!.skus[0];
                    await adoptWorkbenchWhite(id, sku.id, incomingWhite.image);
                } catch (error) {
                    message.warning("任务已创建，白底图导入失败：" + (error instanceof Error ? error.message : "请从工作台重新采用"));
                }
                useProductWhiteStore.getState().setPending(undefined);
            }
            setOpen(false);
            setExcelFile(undefined);
            setZipFile(undefined);
            setSourceImages([]);
            setSuggestion(undefined);
            setConfirmedSuggestionFacts({});
            productId.current = nanoid();
            uploadCache.current.clear();
            resolvedImages.current.clear();
            if (mode === "single") form.resetFields();
            message.success("跨境任务已创建");
            navigate("/commerce/" + id);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务创建失败");
        } finally {
            session.dispose();
            submitting.current = false;
            setCreating(false);
        }
    };

    return (
        <main className="h-full overflow-y-auto bg-stone-50 p-4 text-stone-900 dark:bg-stone-950 dark:text-stone-100 md:p-6">
            <div className="mx-auto max-w-7xl">
                {catalog.phase === "error" ? (
                    <p role="alert" className="mb-3 text-sm text-amber-700">
                        {catalog.error}{" "}
                        <Button type="link" onClick={() => navigate("/commerce/settings")}>
                            规则与品牌
                        </Button>
                    </p>
                ) : null}
                <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-2xl font-semibold">跨境生图</h1>
                        <p className="mt-1 text-sm text-stone-500">按任务选择场景、营销模板、目标语言与品牌覆盖，并在导出前检查当地文化与品牌规则。</p>
                    </div>
                    <Space>
                        <Button icon={<Settings2 className="size-4" />} onClick={() => navigate("/commerce/settings")}>
                            规则与品牌
                        </Button>
                        <Button disabled={initializing} loading={initializing} type="primary" icon={<PackagePlus className="size-4" />} onClick={() => changeOpen(true)}>
                            新建任务
                        </Button>
                    </Space>
                </div>
                {rows.length ? (
                    <div className="grid gap-4 lg:grid-cols-2">
                        {rows.map((job) => (
                            <Card key={job.id} hoverable onClick={() => navigate("/commerce/" + job.id)}>
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="text-lg font-semibold">{job.name}</div>
                                        <div className="mt-1 text-sm text-stone-500">
                                            {job.skus.length} 个 SKU · {job.platform === "shopee" ? "Shopee" : "TikTok Shop"} · 规则 v{job.policyVersion || "-"}
                                        </div>
                                    </div>
                                    <Button
                                        type="text"
                                        danger
                                        icon={<Trash2 className="size-4" />}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            modal.confirm({ title: "删除任务？", content: "任务记录会被删除，已保存到画布或素材库的图片不会自动删除。", okText: "删除", okButtonProps: { danger: true }, cancelText: "取消", onOk: () => removeJob(job.id) });
                                        }}
                                    />
                                </div>
                                <div className="mt-5">
                                    <div className="mb-2 flex justify-between text-sm">
                                        <Tag>{statusLabel(job.status)}</Tag>
                                        <span>{job.progress}%</span>
                                    </div>
                                    <Progress percent={job.progress} showInfo={false} />
                                </div>
                            </Card>
                        ))}
                    </div>
                ) : (
                    <Empty className="mt-24" description={initializing ? "正在读取任务与规则" : "还没有跨境生图任务"}>
                        <Button disabled={initializing} type="primary" onClick={() => changeOpen(true)}>
                            创建第一个任务
                        </Button>
                    </Empty>
                )}
            </div>

            <Modal
                title="新建跨境生图任务"
                open={open}
                onCancel={() => changeOpen(false)}
                onOk={() => void submit()}
                okButtonProps={{ disabled: initializing }}
                okText="创建任务"
                cancelText="取消"
                confirmLoading={creating}
                width={960}
                style={{ top: 16 }}
                styles={{ body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" } }}
            >
                <div className="space-y-4">
                    {incomingWhite && mode === "single" && !sourceImages.length ? <div className="rounded border border-green-500 p-3">已带入商品原图和工作台白底图。创建后直接进入白底审核，无需重复抠图。上传其他商品图片将取消本次白底图复用。</div> : null}
                    <div className="grid gap-3 sm:grid-cols-3">
                        <Input value={jobName} onChange={(event) => setJobName(event.target.value)} placeholder="任务名称" />
                        <Select
                            value={platform}
                            onChange={setPlatform}
                            options={[
                                { value: "shopee", label: "Shopee" },
                                { value: "tiktok", label: "TikTok Shop" },
                            ]}
                        />
                        <Select value={brandId} onChange={setBrandId} options={brands.map((brand) => ({ value: brand.id, label: brand.name }))} placeholder="品牌" />
                    </div>
                    <Radio.Group
                        value={mode}
                        onChange={(event) => {
                            invalidateInput();
                            setMode(event.target.value);
                        }}
                        options={[
                            { value: "excel", label: "Excel 批量导入" },
                            { value: "single", label: "单个 SKU 录入" },
                        ]}
                    />
                    {mode === "excel" ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="min-w-0 space-y-2">
                                <Upload.Dragger
                                    className="block"
                                    accept=".xlsx"
                                    maxCount={1}
                                    showUploadList={false}
                                    beforeUpload={(file) => {
                                        setExcelFile(file);
                                        return false;
                                    }}
                                    fileList={excelFile ? [excelFile as any] : []}
                                >
                                    <FileSpreadsheet className="mx-auto mb-2 size-8" />
                                    <p>选择商品信息录入模板</p>
                                    <p className="text-xs text-stone-500">按表头匹配；单批最多 20 个 SKU</p>
                                </Upload.Dragger>
                                {excelFile ? <SelectedImportFile file={excelFile} onRemove={() => setExcelFile(undefined)} /> : null}
                            </div>
                            <div className="min-w-0 space-y-2">
                                <Upload.Dragger
                                    className="block"
                                    accept=".zip"
                                    maxCount={1}
                                    showUploadList={false}
                                    beforeUpload={(file) => {
                                        setZipFile(file);
                                        return false;
                                    }}
                                    fileList={zipFile ? [zipFile as any] : []}
                                >
                                    <UploadCloud className="mx-auto mb-2 size-8" />
                                    <p>可选：商品图片 ZIP</p>
                                    <p className="text-xs text-stone-500">可含 1 个商品 Excel；图片按 SKU/01.jpg…06.jpg 放置</p>
                                </Upload.Dragger>
                                {zipFile ? <SelectedImportFile file={zipFile} onRemove={() => setZipFile(undefined)} /> : null}
                            </div>
                        </div>
                    ) : (
                        <Form form={form} layout="vertical" className="grid gap-x-4 sm:grid-cols-2" onValuesChange={() => invalidateInput()}>
                            <Form.Item name="sku" label="SKU" rules={[{ required: true }]}>
                                <Input />
                            </Form.Item>
                            <Form.Item name="productType" label="商品类型" rules={[{ required: true }]}>
                                <Input />
                            </Form.Item>
                            <Form.Item name="name" label="产品名称" rules={[{ required: true }]}>
                                <Input />
                            </Form.Item>
                            <Form.Item name="brandName" label="品牌名称">
                                <Input />
                            </Form.Item>
                            <Form.Item name="category" label="内部作图类目" rules={[{ required: true }]}>
                                <Select
                                    options={
                                        activePack?.categories?.length
                                            ? activePack.categories
                                                  .filter(
                                                      (node) =>
                                                          node.active &&
                                                          !activePack.categories!.some((child) => child.active && child.parentId === node.id) &&
                                                          (!node.parentId || activePack.categories!.some((parent) => parent.id === node.parentId && parent.active)),
                                                  )
                                                  .map((node) => ({ value: node.name, label: node.parentId ? `${activePack.categories!.find((parent) => parent.id === node.parentId)?.name} / ${node.name}` : node.name }))
                                            : Array.from(new Set(newJobRequirements.map((item) => item.category))).map((value) => ({ value, label: value }))
                                    }
                                />
                            </Form.Item>
                            <Form.Item name="audience" label="目标受众">
                                <Input />
                            </Form.Item>
                            <Form.Item name="categoryPath" label="英文类目路径">
                                <Input placeholder="Home & Living > …（不改变内部类目）" />
                            </Form.Item>
                            <Form.Item name="materialDescription" label="材料说明">
                                <Input.TextArea rows={2} />
                            </Form.Item>
                            <Form.Item name="usageInstructions" label="使用说明">
                                <Input.TextArea rows={2} />
                            </Form.Item>
                            <Form.Item name="size" label="产品尺寸">
                                <Input />
                            </Form.Item>
                            <Form.Item label="商品主图（最多 6 张）">
                                <Upload
                                    accept="image/*"
                                    multiple
                                    beforeUpload={(file) => {
                                        setSourceImages((items) => [...items, file].slice(0, 6));
                                        invalidateInput();
                                        return false;
                                    }}
                                    onRemove={(file) => {
                                        setSourceImages((items) => items.filter((item) => (item as File & { uid?: string }).uid !== file.uid));
                                        invalidateInput();
                                    }}
                                    fileList={sourceImages as any}
                                >
                                    <Button>选择图片</Button>
                                </Upload>
                            </Form.Item>
                            <Form.Item name="description" label="产品描述/卖点" className="sm:col-span-2">
                                <Input.TextArea rows={4} />
                            </Form.Item>
                            {open ? (
                                <div className="sm:col-span-2">
                                    <ProductSuggestionEditor
                                        product={localProduct(values)}
                                        inputKey={String(inputRevision)}
                                        getInputKey={() => String(inputRevisionRef.current)}
                                        hasImages={Boolean(sourceImages.length || incomingWhite)}
                                        prepareProduct={prepareProduct}
                                        onSave={setSuggestion}
                                        onApply={(draft, fields, replace) => {
                                            const next = adoptProductSuggestion(localProduct(), draft, fields, replace);
                                            form.setFieldsValue({
                                                name: next.name,
                                                audience: next.audience,
                                                description: next.description,
                                                materialDescription: next.materialDescription,
                                                usageInstructions: next.usageInstructions,
                                                categoryPath: next.categoryPath,
                                            });
                                            invalidateInput();
                                        }}
                                        onResolve={(draft, item, resolution) => {
                                            try {
                                                const next = resolveProductUncertainty(localProduct(), draft, item, resolution);
                                                setSuggestion(next.informationSuggestion);
                                                setConfirmedSuggestionFacts(next.verifiedFacts);
                                            } catch (error) {
                                                message.error(error instanceof Error ? error.message : "处理待确认信息失败");
                                            }
                                        }}
                                    />
                                </div>
                            ) : null}
                        </Form>
                    )}
                    <Card size="small" title="生成配置（已带入品牌默认值）">
                        {mode === "excel" ? <div className="space-y-3">
                        <Button loading={previewLoading} disabled={!excelFile && !zipFile} onClick={() => void previewImport()}>读取 SKU 图片映射预览</Button>
                        {importPreview ? <ImportPreview value={importPreview} onChange={setImportPreview} /> : <p>创建任务前请逐项核对 SKU、主图顺序和未分配图片。</p>}
                    </div> : null}
                    <GenerationConfigFields config={generationConfig} locales={locales} watermarkRange={activePack?.watermarkOpacityRange} onChange={setGenerationConfig} onLocalesChange={setLocales} />
                    </Card>
                </div>
            </Modal>
        </main>
    );
}

function SelectedImportFile({ file, onRemove }: { file: File; onRemove: () => void }) {
    return (
        <div className="flex min-w-0 items-center gap-2 rounded border border-stone-300 bg-background px-3 py-1.5 text-sm dark:border-stone-700">
            <span className="min-w-0 flex-1 truncate" title={file.name}>
                {file.name}
            </span>
            <Button size="small" type="link" danger aria-label={"移除 " + file.name} onClick={onRemove}>
                移除
            </Button>
        </div>
    );
}

function stageProgress(stage: string) {
    return ({ draft: 0, "white-background": 10, "white-review": 20, "content-generation": 35, "content-review": 50, localization: 70, compliance: 90, ready: 100, failed: 0 } as Record<string, number>)[stage] || 0;
}
function statusLabel(status: string) {
    return ({ draft: "待开始", running: "生成中", "waiting-review": "等待审核", ready: "可导出", failed: "有失败" } as Record<string, string>)[status] || status;
}
