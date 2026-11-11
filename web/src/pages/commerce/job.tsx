import { ConsistencyPanel } from "./components/consistency-panel";
import { MarketingLayoutEditor } from "./components/marketing-layout-editor";
import { App, Button, Card, Checkbox, Collapse, Descriptions, Empty, Image, Input, InputNumber, Modal, Progress, Select, Space, Table, Tag, Tooltip } from "antd";
import { CheckCircle2, Download, ExternalLink, ImageOff, Play, Send, Settings2, ShieldCheck } from "lucide-react";
import { saveAs } from "file-saver";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { ExportImageQuality } from "@/lib/commerce/export-image";
import { estimateCommerceExport, exportCommerceJob } from "@/lib/commerce/export";
import { assertVisualsReady, visualPreflightErrors } from "@/lib/commerce/visual-plan";
import { cloneGenerationConfig, createRequirementSelections, expectedAssetCount, requirementFactFields, GENERATION_ASSET_STAGES, GENERATION_STAGE_LABELS, LOCALE_LABELS } from "@/lib/commerce/generation-config";
import { approveContent, approveWhiteBackground, generateContent, localizeAndRender, markCheckFalsePositive, prepareWhiteBackground, refreshChinesePreviews, runCompliance, submitCanvasToJob } from "@/lib/commerce/pipeline";
import { canApproveContent, canApproveWhite, canExportSku, marketingLineageErrors } from "@/lib/commerce/policy-engine";
import { GenerationConfigFields } from "@/pages/commerce/components/generation-config-fields";
import { ProductSuggestionEditor } from "@/pages/commerce/components/product-suggestion-editor";
import { ProductCategoryFields } from "@/pages/commerce/components/product-category-fields";
import { DetailMaterials } from "@/pages/commerce/components/detail-materials";
import { categoryRequirements as resolvedCategoryRequirements } from "@/lib/commerce/category-rules";
import { catalogBlocksNewJob } from "@/services/commerce-policy-catalog";
import { RequirementRecipeCard } from "@/pages/commerce/components/requirement-recipe-card";
import { resolveReviewErrorTarget, reviewTargetIds } from "@/pages/commerce/review-error-navigation";
import { useCommerceStore } from "@/stores/use-commerce-store";
import type { CommerceGenerationConfig, CommerceLocale, CommerceRequirementPreset, CommerceSku, RequirementSelection } from "@/types/commerce";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasWhiteRepair } from "@/lib/commerce/pipeline";
import type { CanvasNodeData } from "@/types/canvas";
import { resolveImageUrl } from "@/services/image-storage";
import { saveCommerceAsset } from "@/lib/commerce/asset-source";
import { useReferenceReadiness } from "@/pages/image/reference-readiness-panel";
import { BatchProgress } from "./components/batch-progress";
import { runCommerceBatch } from "@/lib/commerce/pipeline-batch";
import { batchAccount } from "@/lib/commerce/pipeline-batch";
import { readBatchJournal } from "@/lib/commerce/pipeline-batch-task";
import { useServerConfigStore } from "@/services/server-config";

export default function CommerceJobPage() {
    const { jobId = "" } = useParams();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();
    const job = useCommerceStore((state) => state.jobs.find((item) => item.id === jobId));
    const brands = useCommerceStore((state) => state.brands);
    const packs = useCommerceStore((state) => state.policyPacks);
    const operator = useCommerceStore((state) => state.operatorName);
    const updateSku = useCommerceStore((state) => state.updateSku);
    const updateJob = useCommerceStore((state) => state.updateJob);
    const updateJobGenerationConfig = useCommerceStore((state) => state.updateJobGenerationConfig);
    const createCreativeJobCopy = useCommerceStore((state) => state.createCreativeJobCopy);
    const [activeSkuId, setActiveSkuId] = useState(job?.skus[0]?.id);
    const [busy, setBusy] = useState<string>();
    const [exportFormat, setExportFormat] = useState<"jpeg" | "webp">("jpeg");
    const [exportQuality, setExportQuality] = useState<ExportImageQuality>("high");
    const [repairNodes, setRepairNodes] = useState<CanvasNodeData[]>([]);
    const [repairNodeId, setRepairNodeId] = useState<string>();
    const [editingCompositionId, setEditingCompositionId] = useState<string>();
    const [configOpen, setConfigOpen] = useState(false);
    const [configDraft, setConfigDraft] = useState<CommerceGenerationConfig>();
    const [localeDraft, setLocaleDraft] = useState<CommerceLocale[]>([]);
    const [highlightedReviewTarget, setHighlightedReviewTarget] = useState<string>();
    const [openMarketingCopies, setOpenMarketingCopies] = useState<string[]>([]);
    const pack = packs.find((item) => item.id === job?.policyPackId && item.version === job?.policyVersion) || (!job?.policyPackId ? packs.find((item) => item.status === "published") : undefined);
    const sku = job?.skus.find((item) => item.id === activeSkuId) || job?.skus[0];
    const referenceQueue = useReferenceReadiness(jobId + ":" + sku?.id);
    useEffect(() => useServerConfigStore.subscribe((state, previous) => {
        if (state.user?.id !== previous.user?.id || (state.phase === "signed-out" && previous.phase !== "signed-out")) referenceQueue.reset();
    }), [referenceQueue]);
    const requirements = useMemo(
        () => (pack?.categories?.length && sku ? resolvedCategoryRequirements(pack, sku.product) : categoryRequirements(pack?.requirementPresets || [], sku)),
        [pack, sku?.product.category, sku?.product.categoryId, sku?.product.subcategoryId],
    );
    const categories = useMemo(() => Array.from(new Set((pack?.requirementPresets || []).filter((item) => item.category !== "通用").map((item) => item.category))).sort(), [pack?.requirementPresets]);
    const selectedRequirements = requirements.filter((item) => sku?.requirementSelections.find((selection) => selection.requirementId === item.id)?.enabled);
    const selectedTemplates = selectedRequirements.filter((item) => item.stage === "marketing");
    const requiredFacts = job && sku ? requirementFactFields(job, sku, requirements) : [];

    if (!job)
        return (
            <Empty className="mt-24" description="跨境任务不存在">
                <Button onClick={() => navigate("/commerce")}>返回任务列表</Button>
            </Empty>
        );
    const visualErrors = sku && (job.visualPipelineVersion || 0) >= 2 ? visualPreflightErrors(job, sku, requirements) : [];
    let previewBlocked = "";
    if (sku && (job.visualPipelineVersion || 0) >= 2) {
        try {
            assertVisualsReady(job, sku, requirements);
        } catch (error) {
            previewBlocked = error instanceof Error ? error.message : "请先批准白底图并生成需求画面";
        }
    }
    const contentReviewErrors =
        sku?.stage === "content-review"
            ? selectedRequirements.flatMap((requirement) => {
                  const selection = sku.requirementSelections.find((item) => item.requirementId === requirement.id);
                  if (requirement.needsReview && selection?.enabled && !selection.reviewed) return [requirement.title + "：请完成人工校对"];
                  if (job.generationConfig.marketingEnabled && requirement.stage === "marketing" && !sku.copyZh[requirement.id]?.trim()) return [requirement.title + "：请补充中文文案"];
                  return [];
              })
            : [];
    const lineageErrors = sku?.stage === "content-review" && job.generationConfig.marketingEnabled ? marketingLineageErrors(job, sku, requirements, "marketing-preview") : [];
    const reviewErrors = [...new Set([...visualErrors, ...previewBlocked.split(/[；\n]/).filter(Boolean), ...contentReviewErrors, ...lineageErrors])];

    const jumpToReviewError = (error: string) => {
        const targetId = resolveReviewErrorTarget(error, requirements);
        const matchingRequirement = requirements.find((requirement) => error.startsWith(requirement.title + "："));
        if (matchingRequirement && targetId === reviewTargetIds.marketingCopy(matchingRequirement.id)) {
            setOpenMarketingCopies((current) => (current.includes(matchingRequirement.id) ? current : [...current, matchingRequirement.id]));
        }
        window.setTimeout(() => {
            const target = document.getElementById(targetId);
            if (!target) return message.warning("没有找到对应位置，请刷新页面后重试");
            setHighlightedReviewTarget(targetId);
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            const focusable = target.matches("input, textarea, button, [role='combobox']") ? target : target.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role='combobox']");
            window.setTimeout(() => focusable?.focus({ preventScroll: true }), 350);
        }, 50);
        window.setTimeout(() => setHighlightedReviewTarget((current) => (current === targetId ? undefined : current)), 2200);
    };

    const reviewTargetClass = (targetId: string, base = "") => base + (highlightedReviewTarget === targetId ? " rounded-lg ring-2 ring-amber-400 ring-offset-4 transition-shadow" : " transition-shadow");

    const run = async (key: string, action: () => Promise<unknown> | unknown) => {
        if (!referenceQueue.ready()) { message.warning("参考图仍在读取或上传失败，请重试或移除后继续"); return; }
        setBusy(key);
        try {
            await action();
            message.success("操作完成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
        } finally {
            setBusy(undefined);
        }
    };

    const processNext = (item: CommerceSku, api = false) => {
        const batch = readBatchJournal(job.id, batchAccount());
        if (Object.keys(batch.operations).some((key) => { try { return JSON.parse(key)[0] === item.id; } catch { return false; } })) throw new Error("该 SKU 已有安全批次记录，请使用批次恢复或仅重试失败项，避免重复提交");
        const hasWhite = item.assets.some((asset) => asset.stage === "main-white" && asset.revision === item.activeRevision);
        const whiteApproved = item.approvals.some((approval) => approval.gate === "white-background" && approval.assetRevision === item.activeRevision && approval.approved);
        const contentApproved = item.approvals.some((approval) => approval.gate === "content" && approval.assetRevision === item.activeRevision && approval.approved);
        if (!hasWhite || item.stage === "draft" || (item.stage === "failed" && !hasWhite)) return prepareWhiteBackground(job.id, item.id, api ? "api" : "local");
        if (whiteApproved && !contentApproved && item.stage !== "content-review") return generateContent(job.id, item.id);
        if (item.stage === "compliance") return runCompliance(job.id, item.id);
        if (contentApproved && item.stage !== "ready") return localizeAndRender(job.id, item.id);
        throw new Error("当前阶段需要先完成人工审核");
    };

    const batchNext = () => run("batch", () => runCommerceBatch(job.id));

    const download = () =>
        run("export", async () => {
            const latest = useCommerceStore.getState().jobs.find((item) => item.id === job.id)!;
            const blob = await exportCommerceJob(latest, pack, activeBrand, { compressionFormat: exportFormat, compressionQuality: exportQuality });
            saveAs(blob, safeName(job.name) + ".zip");
            useCommerceStore.getState().addAudit({ action: "导出跨境任务", actor: operator, jobId: job.id, detail: job.skus.length + " 个 SKU" });
        });

    const progress = Math.round(job.skus.reduce((sum, item) => sum + progressOf(item.stage), 0) / Math.max(1, job.skus.length));
    const activeBrand = brands.find((brand) => brand.id === job.brandProfileId);
    const exportEstimate = estimateCommerceExport(job);

    const editGenerationConfig = () => {
        setConfigDraft(cloneGenerationConfig(job.generationConfig));
        setLocaleDraft([...job.locales]);
        setConfigOpen(true);
    };
    const saveGenerationConfig = () => {
        if (!configDraft || !localeDraft.length) return message.error("请至少选择 1 种目标语言");
        const apply = () => {
            updateJobGenerationConfig(job.id, { generationConfig: configDraft, locales: localeDraft });
            setConfigOpen(false);
            message.success("生成方案已更新");
        };
        const hasResults = job.skus.some((item) => item.assets.some((asset) => asset.revision === item.activeRevision && asset.stage !== "main-white"));
        if (!hasResults) return apply();
        modal.confirm({ title: "修改生成方案？", content: "受影响的场景、营销图、审核和合规结果会按变更范围失效，需要重新生成或审核。", okText: "确认修改", cancelText: "取消", onOk: apply });
    };

    const changeTemplates = (ids: string[]) => {
        const apply = () => {
            for (const requirement of requirements.filter((item) => item.stage === "marketing")) updateRequirement(job.id, sku!, requirement, { enabled: ids.includes(requirement.id) });
        };
        const hasMarketing = sku!.assets.some((asset) => asset.revision === sku!.activeRevision && ["marketing-preview", "marketing"].includes(asset.stage));
        if (!hasMarketing) return apply();
        modal.confirm({ title: "修改营销模板？", content: "现有营销预览、各语言营销图、内容审核和合规结果将失效。", okText: "确认修改", cancelText: "取消", onOk: apply });
    };

    return (
        <main className="h-full overflow-y-auto bg-stone-50 p-4 dark:bg-stone-950 md:p-6">
            <div className="mx-auto max-w-[1500px]">
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <Button type="link" className="!px-0" onClick={() => navigate("/commerce")}>
                            ← 返回任务列表
                        </Button>
                        <h1 className="text-2xl font-semibold">{job.name}</h1>
                        <div className="mt-2 flex flex-wrap gap-2">
                            <Tag>{job.platform === "shopee" ? "Shopee" : "TikTok Shop"}</Tag>
                            <Tag>{activeBrand?.name || "未映射品牌"}</Tag>
                            <Tag>规则 v{job.policyVersion || "-"}</Tag>
                            <Tag color={job.status === "ready" ? "green" : "blue"}>{statusLabel(job.status)}</Tag>
                        </div>
                    </div>
                    <Space wrap>
                        <Button icon={<Settings2 className="size-4" />} onClick={editGenerationConfig}>
                            编辑生成方案
                        </Button>
                        <Button disabled={!referenceQueue.ready()} icon={<Play className="size-4" />} loading={busy === "batch"} onClick={() => void batchNext()}>
                            全部运行到下一审核点
                        </Button>
                        <span className="text-sm">
                            成品 {exportEstimate.count} 张，每张 ≤ {(job.generationConfig.outputSpec.maxBytes / 1024 / 1024).toFixed(2)} MiB。
                            压缩前约 {(exportEstimate.sourceBytes / 1024 / 1024).toFixed(2)} MiB（按已保存元数据{exportEstimate.unknownCount ? `，另有 ${exportEstimate.unknownCount} 张大小未知` : "，可能与实际文件有差异"}）；
                            压缩成功后成品总量最多 {(exportEstimate.deliveredCeilingBytes / 1024 / 1024).toFixed(2)} MiB（张数 × 单张上限，并非压缩预测）。
                            不含编辑源图层、清单及 ZIP 开销；最终包大小需导出后确定，实际成品大小见清单。
                        </span>
                        <Select aria-label="超限图片压缩格式" value={exportFormat} onChange={setExportFormat} options={[{ value: "jpeg", label: "超限转 JPEG（透明区域变白）" }, { value: "webp", label: "超限转 WebP（请确认平台支持）" }]} />
                        <Select aria-label="超限图片压缩质量" value={exportQuality} onChange={setExportQuality} options={[{ value: "high", label: "高画质优先" }, { value: "balanced", label: "均衡压缩" }, { value: "small", label: "小体积优先" }]} />
                        <span className="text-xs text-stone-500">仅超限图片重编码；仍超限会自动降低质量，保持尺寸和原图不变。</span>
                        <Button icon={<Download className="size-4" />} disabled={!job.skus.every(canExportSku)} loading={busy === "export"} onClick={() => void download()}>
                            导出 ZIP
                        </Button>
                    </Space>
                </div>
                {sku && editingCompositionId && sku.compositions.find(c => c.id === editingCompositionId) ? <MarketingLayoutEditor key={editingCompositionId} job={job} sku={sku} composition={sku.compositions.find(c => c.id === editingCompositionId)!} reviewer={operator} onClose={() => setEditingCompositionId(undefined)}/> : null}
                <BatchProgress job={job} />
                {sku && <ConsistencyPanel key={sku.id} job={job} sku={sku} reviewer={operator} />}
                {(job.visualPipelineVersion || 0) < 3 ? (
                    <Card className="mb-4" title="历史视觉流程">
                        <p className="mb-3">历史任务继续保留。可用最新创意方案创建独立副本，再审核并生成图片。</p>
                        <Button
                            disabled={Boolean(busy)}
                            onClick={() =>
                                void run("copy", async () => {
                                    await useCommerceStore.getState().loadServerCatalog(true);
                                    const current = useCommerceStore.getState();
                                    await (await import("@/services/settings-readiness")).ensureSettingsReady();
                                    if (!current.teamPolicyPackId && (catalogBlocksNewJob(current.catalogStatus, current.policyPacks) || current.catalogStatus.phase === "error")) throw new Error("规则目录更新失败，请重试后升级任务");
                                    navigate("/commerce/" + createCreativeJobCopy(job.id));
                                })
                            }
                        >
                            使用新版方案创建副本
                        </Button>
                    </Card>
                ) : null}
                <Card className="mb-4">
                    <div className="flex items-center gap-4">
                        <Progress percent={progress} />
                        <span className="whitespace-nowrap text-sm text-stone-500">
                            {job.skus.filter(canExportSku).length}/{job.skus.length} 可导出
                        </span>
                    </div>
                </Card>
                <Card
                    className="mb-4"
                    title="生成方案"
                    extra={
                        <Button size="small" onClick={editGenerationConfig}>
                            修改
                        </Button>
                    }
                >
                    <div className="flex flex-wrap gap-2">
                        <Tag>白底主图 1 张</Tag>
                        <Tag>
                            {job.generationConfig.outputSpec.size}px · {job.generationConfig.outputSpec.format === "jpeg" ? "JPG" : "PNG"} · {job.generationConfig.outputSpec.dpi} DPI
                        </Tag>
                        <Tag>{job.generationConfig.siteImageMode === "shared" ? "站点共享无文字图" : "按站点生成无文字图"}</Tag>
                        <Tag>{job.generationConfig.delivery === "editableCanvas" ? "可编辑分层交付" : "仅成品图"}</Tag>
                        <Tag color={job.generationConfig.marketingEnabled ? "purple" : "default"}>营销图{job.generationConfig.marketingEnabled ? "开启" : "关闭"}</Tag>
                        <Tag>Logo：{logoLabel(job.generationConfig.overlay.logo.placement)}</Tag>
                        <Tag>水印：{watermarkLabel(job.generationConfig)}</Tag>
                    </div>
                    <div className="mt-3 text-sm text-stone-500">目标语言：{job.locales.map((locale) => LOCALE_LABELS[locale]).join("、")}；实际数量按每个 SKU 的需求方案、变体和站点范围动态计算。</div>
                </Card>

                <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                    <Card title="SKU 列表" styles={{ body: { padding: 0 } }}>
                        {job.skus.map((item) => (
                            <button
                                type="button"
                                key={item.id}
                                className={"block w-full border-b border-stone-200 px-4 py-3 text-left last:border-b-0 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900 " + (item.id === sku?.id ? "bg-stone-100 dark:bg-stone-900" : "")}
                                onClick={() => setActiveSkuId(item.id)}
                            >
                                <div className="flex justify-between gap-2">
                                    <span className="font-medium">{item.product.sku}</span>
                                    <Tag color={stageColor(item.stage)}>{stageLabel(item.stage)}</Tag>
                                </div>
                                <div className="mt-1 truncate text-xs text-stone-500">{item.product.name}</div>
                            </button>
                        ))}
                    </Card>

                    {sku ? (
                        <div className="min-w-0 space-y-4">
                            <Card
                                title={sku.product.sku + " · " + sku.product.name}
                                extra={
                                    <Space>
                                        <Button size="small" icon={<ExternalLink className="size-4" />} disabled={!sku.canvasProjectId} onClick={() => sku.canvasProjectId && navigate("/canvas/" + sku.canvasProjectId)}>
                                            在画布中编辑
                                        </Button>
                                        <Button size="small" icon={<Send className="size-4" />} disabled={!sku.canvasProjectId} onClick={() => void run("canvas", () => submitCanvasToJob(job.id, sku.id, operator))}>
                                            提交画布版本
                                        </Button>
                                    </Space>
                                }
                            >
                                <Descriptions
                                    size="small"
                                    column={{ xs: 1, md: 3 }}
                                    items={[
                                        { key: "category", label: "类目", children: sku.product.category },
                                        { key: "size", label: "尺寸", children: sku.product.size || "未填写" },
                                        { key: "stage", label: "当前阶段", children: stageLabel(sku.stage) },
                                        { key: "images", label: "源图片", children: sku.product.images.length + " 张" },
                                        {
                                            key: "assets",
                                            label: "当前成图",
                                            children:
                                                sku.assets.filter((asset) => asset.revision === sku.activeRevision && !["marketing-preview", "marketing-base", "comparison-source"].includes(asset.stage)).length +
                                                "/" +
                                                expectedAssetCount(job, sku, pack?.requirementPresets || []),
                                        },
                                        { key: "revision", label: "版本", children: "v" + sku.activeRevision },
                                    ]}
                                />
                                {sku.product.imageStatus !== "ready" ? <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">商品图片缺失，不能开始生成。请重新创建任务并补齐 ZIP 或可访问的图片 URL。</div> : null}
                                {sku.stageMessage ? <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{sku.stageMessage}</div> : null}
                                <div id={reviewTargetIds.reviewActions} className={reviewTargetClass(reviewTargetIds.reviewActions, "mt-5 flex scroll-mt-6 flex-wrap gap-2")}>
                                    <Button disabled={Boolean(busy) || !sku.product.images.length} onClick={() => navigate("/image?mode=product-white&job=" + encodeURIComponent(job.id) + "&sku=" + encodeURIComponent(sku.id))}>
                                        到工作台处理白底图
                                    </Button>
                                    <Button
                                        type="primary"
                                        loading={busy === "next"}
                                        disabled={!referenceQueue.ready() || sku.product.imageStatus !== "ready" || ["white-review", "content-review", "ready"].includes(sku.stage)}
                                        onClick={() => void run("next", () => processNext(sku))}
                                    >
                                        运行到下一阶段
                                    </Button>
                                    <Button loading={busy === "api"} disabled={!useCommerceStore.getState().modelRoles.removalApiUrl || sku.stage !== "failed"} onClick={() => void run("api", () => prepareWhiteBackground(job.id, sku.id, "api"))}>
                                        使用抠图 API 重试
                                    </Button>
                                    {sku.stage === "white-review" ? (
                                        <Button icon={<CheckCircle2 className="size-4" />} disabled={!canApproveWhite(sku)} onClick={() => void run("approve-white", () => approveWhiteBackground(job.id, sku.id, operator))}>
                                            批准白底图
                                        </Button>
                                    ) : null}
                                    {sku.stage === "content-review" ? (
                                        <Button icon={<CheckCircle2 className="size-4" />} disabled={!canApproveContent(job, sku, pack?.requirementPresets || [])} onClick={() => void run("approve-content", () => approveContent(job.id, sku.id, operator))}>
                                            {job.generationConfig.marketingEnabled ? "批准图片、文案与方案" : "批准无文字图片"}
                                        </Button>
                                    ) : null}
                                    {sku.stage === "compliance" ? (
                                        <Button icon={<ShieldCheck className="size-4" />} loading={busy === "check"} onClick={() => void run("check", () => runCompliance(job.id, sku.id))}>
                                            重新检查
                                        </Button>
                                    ) : null}
                                </div>
                            </Card>

                            <Card id={reviewTargetIds.currentImages} className={reviewTargetClass(reviewTargetIds.currentImages, "scroll-mt-6")} title="当前版本图片">
                                {sku.canvasProjectId ? (
                                    <div className="mb-4 flex flex-wrap gap-2">
                                        <Button
                                            onClick={() => {
                                                const project = useCanvasStore.getState().openProject(sku.canvasProjectId!);
                                                setRepairNodes(project?.nodes.filter((node) => node.type === "image" && node.metadata?.status === "success" && node.metadata.content) || []);
                                                setRepairNodeId(undefined);
                                            }}
                                        >
                                            选择画布白底修复图
                                        </Button>
                                        {repairNodes.length ? (
                                            <>
                                                <Select
                                                    aria-label="白底修复图片"
                                                    style={{ width: 300 }}
                                                    placeholder="选择已修复的图片"
                                                    value={repairNodeId}
                                                    options={repairNodes.map((node) => ({ value: node.id, label: node.title || node.id }))}
                                                    onChange={setRepairNodeId}
                                                />
                                                <Button
                                                    disabled={!repairNodeId || Boolean(busy)}
                                                    onClick={() =>
                                                        void run("repair", async () => {
                                                            await useCanvasWhiteRepair(job.id, sku.id, repairNodeId!, operator);
                                                            setRepairNodes([]);
                                                        })
                                                    }
                                                >
                                                    作为新版本提交审核
                                                </Button>
                                            </>
                                        ) : null}
                                    </div>
                                ) : null}
                                {sku.assets.some((asset) => asset.revision === sku.activeRevision) ? (
                                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                                        {sku.assets
                                            .filter((asset) => asset.revision === sku.activeRevision)
                                            .map((asset) => (
                                                <div key={asset.id}>
                                                    <StoredAssetImage url={asset.url} storageKey={asset.storageKey} />
                                                    <div className="mt-1 truncate text-xs">{asset.title}</div>
                                                    {asset.compositionId && ["marketing", "marketing-preview"].includes(asset.stage) ? <Button size="small" disabled={Boolean(busy) || ["content-generation", "localization", "white-background"].includes(sku.stage)} onClick={() => setEditingCompositionId(asset.compositionId)}>编辑营销排版</Button> : null}
                                                    <div className="text-xs">{asset.generation ? `模型：${asset.generation.model}` : "无完整模型来源（历史图片或本地处理）"}</div>
                                                    <Button size="small" disabled={Boolean(busy)} onClick={() => void run("save-asset", () => saveCommerceAsset(asset, sku.product.sku))}>保存到我的资产</Button>
                                                    <Button size="small" disabled={Boolean(busy) || !asset.generation} onClick={() => void run("reuse-asset", async () => { const id = await saveCommerceAsset(asset, sku.product.sku, true); navigate(`/image?reuseAsset=${encodeURIComponent(id)}`); })}>带入生图（可编辑）</Button>
                                                    {asset.stage === "marketing-base" ? <Tag color="cyan">营销底图 · 不计入成图</Tag> : null}
                                                    {asset.stage === "comparison-source" ? <Tag color="cyan">{asset.comparisonRole === "before" ? "使用前" : "使用后"}中间图 · 不计入成图</Tag> : null}
                                                    <div className="text-[11px] text-stone-400">
                                                        {asset.locale || asset.stage} · {(asset.bytes / 1024).toFixed(0)}KB
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                ) : (
                                    <Empty image={<ImageOff className="mx-auto size-12 text-stone-300" />} description="尚未生成图片" />
                                )}
                            </Card>

                            {sku.assets.some((asset) => asset.revision !== sku.activeRevision) ? (
                                <Collapse
                                    items={[
                                        {
                                            key: "history",
                                            label: "历史版本图片（保留供查看）",
                                            children: (
                                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                                                    {sku.assets
                                                        .filter((asset) => asset.revision !== sku.activeRevision)
                                                        .map((asset) => (
                                                            <div key={asset.id}>
                                                                <StoredAssetImage url={asset.url} storageKey={asset.storageKey} />
                                                                <div className="mt-1 text-xs">
                                                                    v{asset.revision} · {asset.title}
                                                                </div>
                                                            </div>
                                                        ))}
                                                </div>
                                            ),
                                        },
                                    ]}
                                />
                            ) : null}

                            <Card title="商品信息建议">
                                <ProductSuggestionEditor
                                    key={job.id + sku.id}
                                    product={sku.product}
                                    onSave={(draft) => useCommerceStore.getState().saveProductSuggestion(job.id, sku.id, draft)}
                                    onApply={(draft, fields, replace) => {
                                        try {
                                            useCommerceStore.getState().applyProductSuggestion(job.id, sku.id, draft, fields, replace);
                                            message.success("所选商品信息已采用，请核对后生成");
                                        } catch (error) {
                                            message.error(error instanceof Error ? error.message : "采用失败");
                                        }
                                    }}
                                    onResolve={(draft, item, resolution) => {
                                        try {
                                            useCommerceStore.getState().resolveProductUncertainty(job.id, sku.id, draft, item, resolution);
                                            message.success(resolution?.status === "confirmed" ? "已写入产品事实" : resolution?.status === "ignored" ? "已忽略该项" : "已恢复为待确认");
                                        } catch (error) {
                                            message.error(error instanceof Error ? error.message : "处理待确认信息失败");
                                        }
                                    }}
                                />
                            </Card>
                            {pack?.categories?.length ? <DetailMaterials key={job.id + sku.id} queue={referenceQueue} disabled={Boolean(busy)} product={sku.product} onChange={(detailImages) => updateSku(job.id, sku.id, (previous) => ({ ...previous, product: { ...previous.product, detailImages } }))} /> : null}
                            <Card id={reviewTargetIds.requirements} className={reviewTargetClass(reviewTargetIds.requirements, "scroll-mt-6")} title="类目作图方案与产品事实">
                                <div className="mb-4">
                                    <div className="mb-2 text-sm font-medium">类目映射</div>
                                    {pack?.categories?.length ? (
                                        <ProductCategoryFields
                                            pack={pack}
                                            product={sku.product}
                                            onChange={(product) => {
                                                const next = resolvedCategoryRequirements(pack, product);
                                                const selections = createRequirementSelections(next);
                                                updateSku(job.id, sku.id, {
                                                    product,
                                                    requirementSelections: selections,
                                                    selectedTemplateIds: job.generationConfig.marketingEnabled
                                                        ? selections.filter((item) => item.enabled && next.find((preset) => preset.id === item.requirementId)?.stage === "marketing").map((item) => item.requirementId)
                                                        : [],
                                                });
                                            }}
                                        />
                                    ) : (
                                        <Select
                                            showSearch
                                            optionFilterProp="label"
                                            className="w-full"
                                            value={sku.product.category}
                                            options={categories.map((category) => ({ value: category, label: category }))}
                                            onChange={(category) => {
                                                const next = categoryRequirements(pack?.requirementPresets || [], { ...sku, product: { ...sku.product, category } });
                                                const selections = createRequirementSelections(next, activeBrand?.requirementDefaultsByCategory?.[category]);
                                                updateSku(job.id, sku.id, {
                                                    product: { ...sku.product, category },
                                                    stage: sku.approvals.some((item) => item.gate === "white-background" && item.approved) ? "content-generation" : sku.stage,
                                                    assets: sku.assets.filter((asset) => asset.revision !== sku.activeRevision || asset.stage === "main-white"),
                                                    selectedTemplateIds: job.generationConfig.marketingEnabled
                                                        ? selections.filter((item) => item.enabled && next.find((preset) => preset.id === item.requirementId)?.stage === "marketing").map((item) => item.requirementId)
                                                        : [],
                                                    requirementSelections: selections,
                                                    compositions: [],
                                                    copyZh: {},
                                                    localizedCopy: {},
                                                    approvals: sku.approvals.filter((item) => item.gate !== "content"),
                                                    checks: [],
                                                    stageMessage: "类目已变更，请重新生成并审核对应方案",
                                                });
                                            }}
                                        />
                                    )}
                                </div>
                                <div className="mb-4">
                                    <div className="mb-2 text-sm font-medium">需求方案（可逐项关闭、调整数量与变体）</div>
                                    {!selectedRequirements.length ? <p className="mb-2 text-sm text-stone-500">类目方案为可选项；建议至少选择一项以获得更贴合类目的画面。</p> : null}
                                    <div className="space-y-2">
                                        {requirements.map((requirement) => {
                                            const selection = sku.requirementSelections.find((item) => item.requirementId === requirement.id);
                                            if (!selection) return null;
                                            if (requirement.recipeRole || pack?.categories?.length)
                                                return (
                                                    <div key={requirement.id} id={reviewTargetIds.requirement(requirement.id)} className={reviewTargetClass(reviewTargetIds.requirement(requirement.id), "scroll-mt-6")}>
                                                        <RequirementRecipeCard requirement={requirement} selection={selection} job={job} sku={sku} onChange={(patch) => updateRequirement(job.id, sku, requirement, patch)} />
                                                    </div>
                                                );
                                            return (
                                                <div
                                                    key={requirement.id}
                                                    id={reviewTargetIds.requirement(requirement.id)}
                                                    className={reviewTargetClass(reviewTargetIds.requirement(requirement.id), "scroll-mt-6 rounded-lg border border-stone-200 p-3 dark:border-stone-800")}
                                                >
                                                    <div className="flex flex-wrap items-center gap-3">
                                                        <Checkbox checked={selection.enabled} onChange={(event) => updateRequirement(job.id, sku, requirement, { enabled: event.target.checked })}>
                                                            {requirement.order}. {requirement.title}
                                                        </Checkbox>
                                                        <Tag>{requirement.stage === "marketing" ? "营销图" : GENERATION_STAGE_LABELS[requirement.stage]}</Tag>
                                                        {requirement.needsReview ? <Tag color={selection.reviewed ? "green" : "orange"}>需校对</Tag> : null}
                                                        <InputNumber min={0} max={4} value={selection.count} addonAfter="张" onChange={(value) => updateRequirement(job.id, sku, requirement, { count: Number(value || 0) })} />
                                                        <Select style={{ minWidth: 130 }} value={selection.variantScope} options={VARIANT_OPTIONS} onChange={(variantScope) => updateRequirement(job.id, sku, requirement, { variantScope })} />
                                                    </div>
                                                    {selection.enabled ? (
                                                        <Input.TextArea
                                                            className="mt-2"
                                                            autoSize={{ minRows: 1, maxRows: 4 }}
                                                            value={selection.promptOverride ?? requirement.prompt}
                                                            onChange={(event) => updateRequirement(job.id, sku, requirement, { promptOverride: event.target.value })}
                                                        />
                                                    ) : null}
                                                    {selection.enabled && selection.variantScope === "custom" ? (
                                                        <Select
                                                            mode="tags"
                                                            aria-label={requirement.title + "指定组合"}
                                                            className="mt-2 w-full"
                                                            placeholder="输入组合后按回车添加"
                                                            value={selection.variantValues}
                                                            onChange={(variantValues) => updateRequirement(job.id, sku, requirement, { variantValues })}
                                                        />
                                                    ) : null}
                                                    {requirement.needsReview && selection.enabled ? (
                                                        <Checkbox className="mt-2" checked={selection.reviewed} onChange={(event) => updateRequirement(job.id, sku, requirement, { reviewed: event.target.checked })}>
                                                            中文文案、混合语言和缺失语种已人工校对
                                                        </Checkbox>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                                {reviewErrors.length ? (
                                    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                                        <div className="mb-1 font-medium">需要处理以下问题（点击可定位）</div>
                                        <div className="flex flex-col items-start gap-1">
                                            {reviewErrors.map((error) => (
                                                <button key={error} type="button" className="text-left underline decoration-amber-400 underline-offset-2 hover:text-amber-950" onClick={() => jumpToReviewError(error)}>
                                                    {error}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}
                                {requiredFacts.length ? (
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        {requiredFacts.map((fact) => (
                                            <label key={fact} id={reviewTargetIds.fact(fact)} className={reviewTargetClass(reviewTargetIds.fact(fact), "scroll-mt-6 text-sm")}>
                                                <span className="mb-1 block font-medium">{fact}</span>
                                                <Input
                                                    value={sku.product.verifiedFacts[fact] ?? (fact === "颜色" ? sku.product.extraFields["颜色"] || sku.product.extraFields["花色"] : fact === "尺寸列表" ? sku.product.size : "")}
                                                    onChange={(event) => useCommerceStore.getState().updateSkuFacts(job.id, sku.id, { verifiedFacts: { ...sku.product.verifiedFacts, [fact]: event.target.value }, factsConfirmed: false })}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-sm text-stone-500">当前模板没有额外参数占位符。</div>
                                )}
                                {requiredFacts.length ? (
                                    <div id={reviewTargetIds.factsConfirmed} className={reviewTargetClass(reviewTargetIds.factsConfirmed, "scroll-mt-6")}>
                                        <Checkbox className="mt-4" checked={sku.product.factsConfirmed} onChange={(event) => useCommerceStore.getState().updateSkuFacts(job.id, sku.id, { factsConfirmed: event.target.checked })}>
                                            我已根据实物或检测数据核对以上参数
                                        </Checkbox>
                                    </div>
                                ) : null}
                                {job.generationConfig.marketingEnabled ? (
                                    <div id={reviewTargetIds.marketing} className={reviewTargetClass(reviewTargetIds.marketing, "scroll-mt-6")}>
                                            <div className="mb-4">
                                                <div className="mb-2 text-sm font-medium">营销方案（至少选择 1 个）</div>
                                            <Select
                                                mode="multiple"
                                                className="w-full"
                                                value={sku.selectedTemplateIds}
                                                options={requirements.filter((item) => item.stage === "marketing").map((item) => ({ value: item.id, label: item.order + ". " + item.title }))}
                                                onChange={changeTemplates}
                                            />
                                        </div>
                                        {sku.selectedTemplateIds.length ? (
                                            <Collapse
                                                className="mt-4"
                                                activeKey={openMarketingCopies}
                                                onChange={(keys) => setOpenMarketingCopies(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
                                                items={selectedTemplates.map((template) => ({
                                                    key: template.id,
                                                    label: template.title,
                                                    children: (
                                                        <div id={reviewTargetIds.marketingCopy(template.id)} className={reviewTargetClass(reviewTargetIds.marketingCopy(template.id), "scroll-mt-6")}>
                                                            <Input.TextArea
                                                                rows={4}
                                                                value={sku.copyZh[template.id] || template.chineseCopy}
                                                                onChange={(event) => updateSku(job.id, sku.id, { copyZh: { ...sku.copyZh, [template.id]: event.target.value }, approvals: sku.approvals.filter((item) => item.gate !== "content") })}
                                                            />
                                                        </div>
                                                    ),
                                                }))}
                                            />
                                        ) : null}
                                        <Tooltip title={previewBlocked}>
                                            <Button
                                                className="mt-4"
                                                loading={busy === "preview"}
                                                disabled={Boolean(busy) || Boolean(previewBlocked) || !sku.selectedTemplateIds.length || !sku.assets.some((asset) => asset.stage === "main-white" && asset.revision === sku.activeRevision)}
                                                onClick={() => void run("preview", () => refreshChinesePreviews(job.id, sku.id))}
                                            >
                                                生成/刷新中文模板预览
                                            </Button>
                                        </Tooltip>
                                    </div>
                                ) : (
                                    <div className="text-sm text-stone-500">当前任务已关闭营销图，仅审核白底图和所选场景图片。</div>
                                )}
                            </Card>

                            <Card
                                title="合规检查"
                                extra={
                                    <Tag color={sku.checks.some((item) => item.severity === "BLOCK" && item.status !== "pass" && !item.reviewedAsFalsePositive) ? "red" : "green"}>
                                        {sku.checks.length ? (canExportSku(sku) ? "通过" : "待处理") : "未运行"}
                                    </Tag>
                                }
                            >
                                <Table
                                    size="small"
                                    pagination={false}
                                    scroll={{ x: 720 }}
                                    rowKey="id"
                                    dataSource={sku.checks}
                                    columns={[
                                        { title: "等级", dataIndex: "severity", width: 80, render: (value) => <Tag color={value === "BLOCK" ? "red" : value === "WARN" ? "orange" : "blue"}>{value}</Tag> },
                                        {
                                            title: "结果",
                                            dataIndex: "status",
                                            width: 100,
                                            render: (value, row) => (
                                                <Tag color={row.reviewedAsFalsePositive || value === "pass" ? "green" : value === "violation" ? "red" : "gold"}>
                                                    {row.reviewedAsFalsePositive ? "已判误报" : value === "pass" ? "通过" : value === "violation" ? "违规" : "待确认"}
                                                </Tag>
                                            ),
                                        },
                                        { title: "检查项", dataIndex: "message" },
                                        { title: "证据", dataIndex: "evidence" },
                                        {
                                            title: "操作",
                                            width: 110,
                                            render: (_, row) =>
                                                row.status === "uncertain" && !row.reviewedAsFalsePositive ? (
                                                    <Tooltip title="仅用于确认模型误报，不得越过真实红线">
                                                        <Button size="small" onClick={() => markCheckFalsePositive(job.id, sku.id, row.id, operator)}>
                                                            判定误报
                                                        </Button>
                                                    </Tooltip>
                                                ) : null,
                                        },
                                    ]}
                                />
                            </Card>
                        </div>
                    ) : null}
                </div>
            </div>
            <Modal title="编辑生成方案" open={configOpen} onCancel={() => setConfigOpen(false)} onOk={saveGenerationConfig} okText="保存方案" cancelText="取消" width={920}>
                {configDraft ? <GenerationConfigFields config={configDraft} locales={localeDraft} watermarkRange={pack?.watermarkOpacityRange} onChange={setConfigDraft} onLocalesChange={setLocaleDraft} /> : null}
            </Modal>
        </main>
    );
}

function StoredAssetImage({ url, storageKey }: { url: string; storageKey?: string }) {
    const [src, setSrc] = useState(storageKey ? "" : url);
    useEffect(() => {
        let active = true;
        void resolveImageUrl(storageKey, url).then((resolved) => {
            if (active) setSrc(resolved);
        });
        return () => {
            active = false;
        };
    }, [storageKey, url]);
    return <Image src={src || undefined} className="aspect-square rounded-lg object-cover" />;
}

function categoryRequirements(requirements: CommerceRequirementPreset[], sku?: CommerceSku) {
    if (!sku) return [];
    const category = sku.product.category;
    return requirements.filter((item) => item.category === "通用" || item.category === category || item.category.includes(category) || category.includes(item.category.replace(/类$/, ""))).sort((a, b) => a.order - b.order);
}
function progressOf(stage: string) {
    return ({ draft: 0, "white-background": 10, "white-review": 20, "content-generation": 35, "content-review": 50, localization: 70, compliance: 90, ready: 100, failed: 0 } as Record<string, number>)[stage] || 0;
}
function stageLabel(stage: string) {
    return (
        (
            {
                draft: "待开始",
                "white-background": "白底处理中",
                "white-review": "审核白底图",
                "content-generation": "生成场景与文案",
                "content-review": "审核场景与模板",
                localization: "翻译与排版",
                compliance: "合规检查",
                ready: "可导出",
                failed: "失败",
            } as Record<string, string>
        )[stage] || stage
    );
}
function statusLabel(status: string) {
    return ({ draft: "待开始", running: "运行中", "waiting-review": "等待审核", ready: "可导出", failed: "有失败" } as Record<string, string>)[status] || status;
}
function stageColor(stage: string) {
    return stage === "ready" ? "green" : stage === "failed" ? "red" : ["white-review", "content-review", "compliance"].includes(stage) ? "gold" : "blue";
}
function safeName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "-") || "跨境生图任务";
}
function logoLabel(value: CommerceGenerationConfig["overlay"]["logo"]["placement"]) {
    return ({ off: "关闭", "top-left": "左上", "top-right": "右上", "bottom-left": "左下", "bottom-right": "右下" } as Record<string, string>)[value];
}
function watermarkLabel(config: CommerceGenerationConfig) {
    const value = config.overlay.watermark;
    return value.mode === "off" ? "关闭" : value.mode === "tile" ? "平铺 " + Math.round(value.opacity * 100) + "%" : "单枚 " + Math.round(value.opacity * 100) + "%";
}
function updateRequirement(jobId: string, sku: CommerceSku, requirement: CommerceRequirementPreset, patch: Partial<RequirementSelection>) {
    useCommerceStore.getState().updateRequirementSelection(jobId, sku.id, requirement.id, patch);
}
const VARIANT_OPTIONS = [
    { value: "per-sku", label: "每 SKU" },
    { value: "per-color", label: "每颜色" },
    { value: "per-size", label: "每尺寸" },
    { value: "per-site", label: "每站点" },
    { value: "custom", label: "指定组合" },
];
