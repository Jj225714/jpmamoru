import { ReferenceInputState } from "./reference-input-state";
import { beginAssetReuse } from "../assets/asset-reuse";
import { CurrentImageTasks } from "../tasks/current-image-tasks";
import { useGenerationAccountRevision } from "./generation-account-session";
import { GenerationJournal } from "./generation-journal";
import { createImageJobRecord, imageJobScope, imageJobStore, readImageJobs, recoverImageJob, updateImageJob, type ImageJobRecord } from "./gpt-job-recovery";
import { ReferenceOrderButtons, moveReferenceById, snapshotReferenceOrder } from "./reference-order";
import { captureGenerationInfo, type AssetGenerationInfo } from "../assets/generation-info";
import { useServerConfigStore } from "@/services/server-config";
import { getServerConfigEnabled } from "@/constant/runtime-config";
import { useReferenceReadiness, ReferenceReadinessPanel } from "./reference-readiness-panel";
import { lazy, Suspense } from "react";
import type { EditImage } from "@/types/image-editor";
const AdvancedHome = lazy(() => import("./advanced/home").then((m) => ({ default: m.AdvancedHome })));
const AdvancedImageEditor = lazy(() => import("./advanced/editor").then((m) => ({ default: m.AdvancedImageEditor })));

import { BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { targetAspectMismatch } from "@/lib/reference-frame";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { imagesFromGptJob, requestEdit, requestGeneration } from "@/services/api/image";
import type { GptImageJob, GptJobIntent } from "@/services/api/gpt-jobs";
import { deleteStoredImages, ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
import { useSearchParams } from "react-router-dom";
import { Segmented } from "antd";
import { ProductWhiteWorkbench } from "./product-white";
import { useProductBasePrompt } from "./use-product-base-prompt";
import { imageFilesForUpload } from "./product-base-prompt-controller";
import { ReversePromptPanel } from "./reverse-prompt-panel";

type GeneratedImage = {
    generation?: AssetGenerationInfo;
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    preventResubmit?: boolean;
    id: string;
    status: "pending" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
    warning?: string;
};

type GenerationLog = {
    accountId?: string;
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "running" | "interrupted" | "success" | "failed";
    error?: string;
    images: GeneratedImage[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const generationJournal = new GenerationJournal<GenerationLog>(logStore);

export default function ImagePage() {
    const accountRevision = useGenerationAccountRevision();
    const [params, setParams] = useSearchParams();
    const white = params.get("mode") === "product-white";
    const advanced = params.get("mode") === "advanced";
    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="px-3 pt-3 pb-2">
                <Segmented
                    aria-label="生图模式"
                    value={white ? "product-white" : advanced ? "advanced" : "general"}
                    options={[
                        { value: "general", label: "通用生图" },
                        { value: "advanced", label: "高级通用生图" },
                        { value: "product-white", label: "商品白底图" },
                    ]}
                    onChange={(mode) => setParams(mode === "general" ? {} : { mode })}
                />
            </div>
            {advanced && (
                <Suspense fallback={<div className="p-3">正在加载高级工作台…</div>}>
                    <AdvancedHome />
                </Suspense>
            )}
            <div className="min-h-0 flex-1">{white ? <ProductWhiteWorkbench /> : <GeneralImageWorkbench key={accountRevision} />}</div>
        </div>
    );
}

function GeneralImageWorkbench() {
    const { message } = App.useApp();
    const [workbenchParams, setWorkbenchParams] = useSearchParams();
    const [editing, setEditing] = useState<{ sourceId: string; source: EditImage }>();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const referenceStripRef = useRef<HTMLDivElement>(null);
    const [referenceInput] = useState(() => new ReferenceInputState());
    const [focusedReferenceId, setFocusedReferenceId] = useState<string>();
    const abandonedReuseRef = useRef<string | undefined>(undefined);
    const dragDepthRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const canManageRecognition = useServerConfigStore((state) => state.manageTeam) || !getServerConfigEnabled();
    const basePrompt = useProductBasePrompt(effectiveConfig);
    const { prompt, references } = basePrompt;
    const { setPrompt, setReferences } = basePrompt.controller;
    const focusedReferenceIndex = references.findIndex(item => item.id === focusedReferenceId);
    useLayoutEffect(() => {
        const strip = referenceStripRef.current;
        const card = strip && Array.from(strip.children).find(child => child.getAttribute("data-reference-id") === focusedReferenceId);
        if (!strip || !card) return;
        const container = strip.getBoundingClientRect(), target = card.getBoundingClientRect();
        // Scroll only the strip, not the enclosing page as scrollIntoView would do.
        if (target.right > container.right) strip.scrollLeft += target.right - container.right + 8;
        else if (target.left < container.left) strip.scrollLeft += target.left - container.left - 8;
    }, [focusedReferenceId, focusedReferenceIndex]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [gptJobs, setGptJobs] = useState<ImageJobRecord[]>([]);
    const [recovering, setRecovering] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const generationLockRef = useRef(false);
    const activeGenerationRef = useRef<GenerationLog | null>(null);
    const sessionRevisionRef = useRef(0);

    useLayoutEffect(
        () => () => {
            sessionRevisionRef.current++;
            const active = activeGenerationRef.current;
            if (active) void generationJournal.interrupt(active.id).catch(() => {});
        },
        [],
    );

    const referenceQueue = useReferenceReadiness("general", () => {
        sessionRevisionRef.current++;
        const active = activeGenerationRef.current;
        if (active) void generationJournal.interrupt(active.id).catch(() => {});
        activeGenerationRef.current = null;
        generationLockRef.current = false;
        setRunning(false);
        basePrompt.controller.reset();
        setEditing(undefined);
        setAssetPickerOpen(false);
        referenceInput.reset();
        setFocusedReferenceId(undefined);
        setResults([]);
        setGptJobs([]);
        setLogs([]);
        setPreviewLog(null);
        setLogsOpen(false);
    });
    const assetHydrated = useAssetStore((state) => state.hydrated);
    const reuseId = workbenchParams.get("reuseAsset");
    const reuseRequest = workbenchParams.get("reuseRequest");
    useEffect(() => {
        if (!assetHydrated || !reuseId) return;
        if (abandonedReuseRef.current === JSON.stringify([reuseId, reuseRequest])) return;
        interruptLocalGeneration();
        referenceInput.reset();
        setFocusedReferenceId(undefined);
        const asset = useAssetStore.getState().assets.find((item) => item.id === reuseId);
        sessionRevisionRef.current++;
        basePrompt.controller.reset();
        const cleanup = beginAssetReuse(referenceQueue, asset?.generation, (input) => {
            basePrompt.controller.restore(input.prompt, input.references);
            if (input.model) updateConfig("imageModel", input.model);
            for (const key of ["size", "quality", "count", "background"] as const) {
                if (input.parameters[key] !== undefined) updateConfig(key, input.parameters[key]!);
            }
        });
        referenceInput.attachRestore(cleanup);
        return cleanup;
    }, [assetHydrated, reuseId, reuseRequest, referenceQueue]);
    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = referenceQueue.ready() && basePrompt.controller.canGenerate();
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
        void refreshJobs();
    }, []);

    const refreshJobs = async () => {
        const revision = sessionRevisionRef.current;
        try {
            const scope = await imageJobScope(effectiveConfig, model);
            const items = await readImageJobs(scope);
            if (revision === sessionRevisionRef.current) setGptJobs(items);
        } catch { /* Signed-out sessions cannot read owned jobs. */ }
    };

    const editReferenceInput = () => {
        referenceInput.edit();
        // Consume reuse navigation even when the user edits before asset hydration.
        if (workbenchParams.has("reuseAsset") || workbenchParams.has("reuseRequest")) {
            abandonedReuseRef.current = JSON.stringify([workbenchParams.get("reuseAsset"), workbenchParams.get("reuseRequest")]);
            const next = new URLSearchParams(workbenchParams);
            next.delete("reuseAsset"); next.delete("reuseRequest");
            setWorkbenchParams(next, { replace: true });
        }
        if (previewLog) { setPreviewLog(null); setResults([]); }
    };
    const enqueueReference = (name: string, read: () => Promise<File | Blob | string>) => {
        editReferenceInput();
        const id = nanoid();
        referenceInput.request(id, basePrompt.controller.getSnapshot().references.map(item => item.id));
        referenceQueue.add(name, async () => uploadImage(await read()), (image) => {
            setReferences((value) => referenceInput.insert(value, { id, name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey }));
            if (referenceInput.completed(id)) setFocusedReferenceId(id);
        });
    };
    const addReferences = (files?: FileList | null) => {
        imageFilesForUpload(files).forEach((file) => enqueueReference(file.name, async () => file));
    };
    const addReferencesFromClipboard = () => {
        referenceQueue.add("剪贴板读取", () => navigator.clipboard.read(), (items) => {
            let count = 0;
            items.forEach((item) => item.types.filter((type) => type.startsWith("image/")).forEach((type) => {
                enqueueReference(`clipboard-${++count}`, () => item.getType(type));
            }));
            if (!count) throw new Error(t("imageWorkbench.clipboardEmpty"));
        });
    };

    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        // Never queue a paid generation behind an analysis result.
        if (!referenceQueue.ready() || basePrompt.controller.getSnapshot().stale || basePrompt.controller.getSnapshot().status === "analyzing" || generationLockRef.current) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t(basePrompt.controller.getSnapshot().stale ? "imageWorkbench.basePromptStale" : "imageWorkbench.busy") });
            return;
        }
        const text = basePrompt.controller.getSnapshot().prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.invalidParams") });
            return;
        }

        generationLockRef.current = true;
        const revision = sessionRevisionRef.current;
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })));
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const log = serializeLog({ ...buildLog({ prompt: text, model, config: { ...snapshot.config, count: String(generationCount) }, references: snapshot.references, durationMs: 0, successCount: 0, failCount: 0, status: "running", images: [] }), accountId: String(useServerConfigStore.getState().user?.id ?? "local") });
        activeGenerationRef.current = log;
        try {
            // Fail closed before any paid request if the local receipt cannot be saved.
            const active = await generationJournal.start(log);
            if (!active || revision !== sessionRevisionRef.current) return;
            setLogs(items => [log, ...items.filter(item => item.id !== log.id)]);
            const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(index, snapshot));
            const result = await Promise.allSettled(tasks);
            if (revision !== sessionRevisionRef.current) return;
            const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map(item => item.value);
            const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");
            const error = failed?.reason instanceof Error ? failed.reason.message : undefined;
            await generationJournal.finish(serializeLog({ ...log, durationMs: performance.now() - batchStartedAt, successCount: successImages.length, failCount: generationCount - successImages.length, status: successImages.length ? "success" : "failed", error, images: successImages }));
            if (revision !== sessionRevisionRef.current) return;
            await refreshLogs();
            if (revision !== sessionRevisionRef.current) return;
            if (agentTaskId) updateAgentTask(agentTaskId, { status: successImages.length ? "succeeded" : "failed", successCount: successImages.length, failCount: generationCount - successImages.length, error });
            successImages.length ? message.success(t("imageWorkbench.generated")) : message.error(error || t("workbench.generationFailed"));
        } catch (error) {
            if (revision !== sessionRevisionRef.current) return;
            const detail = error instanceof Error ? error.message : String(error);
            message.error(`生成记录保存失败，未能确认本次操作状态：${detail}`);
            setResults(value => value.map(item => item.status === "pending" ? { ...item, status: "failed", preventResubmit: true, error: `本地记录保存失败，请核实原请求。${detail}` } : item));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: detail });
        } finally {
            if (revision === sessionRevisionRef.current) {
                activeGenerationRef.current = null;
                generationLockRef.current = false;
                setRunning(false);
            }
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run && running) {
            if (imageCommand.taskId) updateAgentTask(imageCommand.taskId, { status: "failed", error: t("imageWorkbench.busy") });
            return;
        }
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = (image: GeneratedImage, index: number) => {
        enqueueReference(`result-${index + 1}.png`, async () => image.dataUrl);
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const revision = sessionRevisionRef.current;
        const stored = await uploadImage(image.dataUrl);
        if (revision !== sessionRevisionRef.current) return;
        addAsset({
            kind: "image",
            title: t("imageWorkbench.resultTitle", { count: index + 1 }),
            coverUrl: stored.url,
            tags: [],
            source: t("imageWorkbench.source"),
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            generation: image.generation,
            metadata: { source: "image-page", prompt: image.generation?.prompt || "" },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        const sessionRevision = sessionRevisionRef.current;
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            enqueueReference(payload.title, async () => payload.dataUrl);
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
        }
        setAssetPickerOpen(false);
    };

    const interruptLocalGeneration = () => {
        const active = activeGenerationRef.current;
        if (active) void generationJournal.interrupt(active.id).then(refreshLogs).catch(() => {});
        activeGenerationRef.current = null;
        generationLockRef.current = false;
        setRunning(false);
    };
    const createSession = () => {
        interruptLocalGeneration();
        editReferenceInput();
        referenceInput.reset();
        setFocusedReferenceId(undefined);
        referenceQueue.reset();
        sessionRevisionRef.current++;
        basePrompt.controller.reset();
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const deletableIds = selectedLogIds.filter(id => !generationJournal.isActive(id));
        const imageKeys = logs.filter((log) => deletableIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...deletableIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (previewLog && deletableIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const refreshLogs = async () => {
        const revision = sessionRevisionRef.current;
        const accountId = String(useServerConfigStore.getState().user?.id ?? "local");
        const stored = await readStoredLogs();
        if (revision === sessionRevisionRef.current) setLogs(stored.filter(log => (log.accountId ?? "local") === accountId));
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        if (generationJournal.isActive(log.id)) {
            message.info("本次生成仍在当前页面运行，请等待结果。");
            return;
        }
        if (running) { message.info("请等待当前生成结束，或先新建会话停止本地跟踪。"); return; }
        editReferenceInput();
        referenceInput.reset();
        setFocusedReferenceId(undefined);
        referenceQueue.reset();
        sessionRevisionRef.current++;
        setPreviewLog(log);
        setLogsOpen(false);
        basePrompt.controller.restore(log.prompt, log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        setResults(
            log.images.map((image) => ({
                id: image.id,
                status: "success",
                image,
                warning: targetAspectMismatch(image.width, image.height, log.size) ? t("imageWorkbench.aspectMismatch", { size: log.size, actual: image.width + "x" + image.height }) : undefined,
            })),
        );
    };

    const buildRequestSnapshot = () => {
        if (!referenceQueue.ready() || !basePrompt.controller.canGenerate()) return null;
        const current = basePrompt.controller.getSnapshot();
        const text = current.prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: snapshotReferenceOrder(current.references) };
    };

    const runGenerationSlot = async (index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }, existing?: ImageJobRecord) => {
        const revision = sessionRevisionRef.current;
        const guard = () => { if (revision !== sessionRevisionRef.current) throw new Error("账号或页面已变化，请返回原账号查询任务"); };
        const itemStartedAt = performance.now();
        let record = existing;
        let durableIntent = Boolean(existing);
        let writes: Promise<unknown> = Promise.resolve();
        const persist = (value: ImageJobRecord) => {
            writes = writes.then(() => imageJobStore.setItem(value.id, value));
            return writes;
        };
        const onJobIntent = async (intent: GptJobIntent) => {
            guard();
            durableIntent = true;
            const scope = await imageJobScope(snapshot.config);
            guard();
            record = { ...createImageJobRecord(intent, snapshot.text, snapshot.config), scope, references: snapshot.references.map(item => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })) };
            await persist(record);
            guard();
            setGptJobs(items => [...items.filter(item => item.id !== record!.id), record!]);
        };
        const onJob = async (job: GptImageJob) => {
            // Poll callbacks may be unawaited by the legacy helper. Do not reject them.
            if (!record || revision !== sessionRevisionRef.current) return;
            record = updateImageJob(record, job);
            try { await persist(record); } catch { return; }
            if (revision === sessionRevisionRef.current) setGptJobs(items => [...items.filter(item => item.id !== record!.id), record!]);
        };
        try {
            guard();
            const requestOptions = { fitReferencesToSize: true, onJobIntent, onJob };
            const result = existing
                ? imagesFromGptJob(await recoverImageJob(existing, snapshot.config, onJob, { guard }))
                : snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references, requestOptions) : await requestGeneration(snapshot.config, snapshot.text, requestOptions);
            guard();
            const image = result[0];
            if (!image) throw new Error(t("imageWorkbench.missingResult"));
            const stored = await uploadImage(image.dataUrl);
            guard();
            const generation = await captureGenerationInfo({ prompt: snapshot.text, model: snapshot.config.model, parameters: snapshot.config, references: snapshot.references, generatedAt: new Date().toISOString(), source: { kind: "image", taskId: record?.jobId || image.id } });
            guard();
            const nextImage: GeneratedImage = { generation, id: image.id, dataUrl: stored.url, storageKey: stored.storageKey, durationMs: performance.now() - itemStartedAt, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
            const warning = targetAspectMismatch(stored.width, stored.height, snapshot.config.size) ? t("imageWorkbench.aspectMismatch", { size: snapshot.config.size, actual: stored.width + "x" + stored.height }) : undefined;
            await writes;
            guard();
            // Keep the receipt, including succeeded records, so refresh can read the same job.
            setResults(value => updateResultAt(value, index, { status: "success", image: nextImage, warning }));
            return nextImage;
        } catch (error) {
            if (revision === sessionRevisionRef.current) {
                const detail = error instanceof Error ? error.message : t("workbench.generationFailed");
                const text = durableIntent ? `原任务待核实，请查询原任务，勿重新生成以免重复扣费。${detail}` : detail;
                setResults(value => updateResultAt(value, index, { status: "failed", error: text, preventResubmit: durableIntent }));
            }
            throw error;
        }
    };

    const recoverJob = async (record: ImageJobRecord) => {
        if (generationLockRef.current || recovering || !record.jobId) return;
        const revision = sessionRevisionRef.current;
        generationLockRef.current = true;
        setRecovering(true);
        setResults([{ id: nanoid(), status: "pending" }]);
        try {
            await runGenerationSlot(0, { text: record.prompt, config: { ...effectiveConfig, ...record.config }, references: record.references || [] }, record);
        } catch { /* The slot displays the original-task warning. */ }
        finally { if (revision === sessionRevisionRef.current) { generationLockRef.current = false; setRecovering(false); } }
    };

    const retryResult = async (index: number) => {
        if (results[index]?.preventResubmit || generationLockRef.current) return;
        const revision = sessionRevisionRef.current;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        generationLockRef.current = true;
        setRunning(true);
        setPreviewLog(null);
        setResults(value => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined, warning: undefined }));
        const started = performance.now();
        const log = serializeLog({ ...buildLog({ prompt: snapshot.text, model: snapshot.config.model, config: { ...snapshot.config, count: "1" }, references: snapshot.references, durationMs: 0, successCount: 0, failCount: 0, status: "running", images: [] }), accountId: String(useServerConfigStore.getState().user?.id ?? "local") });
        activeGenerationRef.current = log;
        try {
            const active = await generationJournal.start(log);
            if (!active || revision !== sessionRevisionRef.current) return;
            setLogs(items => [log, ...items.filter(item => item.id !== log.id)]);
            let image: GeneratedImage | undefined, error: string | undefined;
            try { image = await runGenerationSlot(index, snapshot); }
            catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
            if (revision !== sessionRevisionRef.current) return;
            await generationJournal.finish(serializeLog({ ...log, durationMs: performance.now() - started, status: image ? "success" : "failed", successCount: image ? 1 : 0, failCount: image ? 0 : 1, images: image ? [image] : [], error }));
            if (revision !== sessionRevisionRef.current) return;
            await refreshLogs();
            if (image && revision === sessionRevisionRef.current) message.success(t("workbench.retrySuccess"));
        } catch (error) {
            if (revision === sessionRevisionRef.current) {
                const detail = `本地记录保存失败，请核实原请求。${error instanceof Error ? error.message : String(error)}`;
                message.error(detail);
                setResults(value => updateResultAt(value, index, { status: "failed", error: detail, preventResubmit: true }));
            }
        } finally {
            if (revision === sessionRevisionRef.current) { activeGenerationRef.current = null; generationLockRef.current = false; setRunning(false); }
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <CurrentImageTasks />
            {running ? <p role="status" className="border-b px-3 py-2 text-xs text-amber-700">生成中，请保持本页打开。刷新、离开或新建会话会中断本地跟踪；这不代表上游已取消，也不会自动重新提交。</p> : null}
            {gptJobs.length > 0 && <section aria-label="本地任务恢复" className="max-h-40 overflow-auto border-b p-2 text-xs">
                {gptJobs.map(job => <div key={job.id} className="flex items-center gap-2 p-1">
                    <span>{job.prompt.slice(0, 40)} · {job.status}</span>
                    {job.jobId ? <Button size="small" disabled={running || recovering} onClick={() => void recoverJob(job)}>查询原任务</Button> : <span role="status">提交结果待核实：未收到任务编号，请到任务中心核实，勿重新生成。</span>}
                </div>)}
            </section>}
            <ReferenceReadinessPanel queue={referenceQueue} />
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{workbenchParams.get("mode") === "advanced" ? "生成新图片" : t("imageWorkbench.title")}</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        {t("workbench.logs")}
                                    </Button>
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        {t("workbench.settings")}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="shrink-0 text-base font-semibold">{t("workbench.prompt")}</span>
                                    <div className="flex flex-wrap gap-2">
                                        <ReversePromptPanel getPrompt={() => basePrompt.controller.getSnapshot().prompt} onApply={text => { editReferenceInput(); setPrompt(text); }} />
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {t("workbench.viewPrompts")}
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {t("workbench.viewAssets")}
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => { editReferenceInput(); setPrompt(event.target.value); }} rows={7} placeholder={t("imageWorkbench.promptPlaceholder")} />
                                <p className="mt-2 text-xs text-stone-500">{t("imageWorkbench.basePromptHint")}</p>
                                <div aria-live="polite" className="mt-2 space-y-2 text-sm">
                                    {!basePrompt.ready && !prompt.trim() && references.length > 0 ? (
                                        <div>
                                            <p>{basePrompt.reason} 可以继续手动填写。</p>
                                            {canManageRecognition ? <Button size="small" onClick={() => openConfigDialog(false, "preferences")}>
                                                {t("imageWorkbench.basePromptConfigure")}
                                            </Button> : <p>请联系管理员配置支持图片输入的文本模型。</p>}
                                        </div>
                                    ) : null}
                                    {basePrompt.status === "analyzing" ? (
                                        <p className="flex items-center gap-2">
                                            <LoaderCircle className="size-4 animate-spin" />
                                            {t("imageWorkbench.basePromptAnalyzing")}
                                        </p>
                                    ) : null}
                                    {basePrompt.status === "done" ? <p>{t("imageWorkbench.basePromptDone")}</p> : null}
                                    {basePrompt.stale ? (
                                        <div role="alert" className="space-y-2">
                                            <p>{t("imageWorkbench.basePromptStale")}</p>
                                            <div className="flex flex-wrap gap-2">
                                                <Button size="small" onClick={basePrompt.controller.keepCurrent}>
                                                    {t("imageWorkbench.basePromptKeep")}
                                                </Button>
                                                <Button size="small" disabled={!basePrompt.ready || !references.length} onClick={basePrompt.controller.clearAndRetry}>
                                                    {t("imageWorkbench.basePromptClearRetry")}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}
                                    {basePrompt.status === "error" ? (
                                        <p role="alert" className="text-red-600">
                                            {basePrompt.error || t("imageWorkbench.basePromptError")}
                                        </p>
                                    ) : null}
                                    {basePrompt.ready && references.length > 0 && !prompt.trim() && basePrompt.status !== "analyzing" ? (
                                        <Button size="small" onClick={basePrompt.controller.retry}>
                                            {t(basePrompt.status === "error" ? "imageWorkbench.basePromptRetry" : "imageWorkbench.basePromptFill")}
                                        </Button>
                                    ) : null}
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("imageWorkbench.references")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    ref={referenceStripRef}
                                    aria-label="参考图列表"
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current += 1;
                                        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = 0;
                                        setIsReferenceDragActive(false);
                                        void addReferences(event.dataTransfer.files);
                                    }}
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} data-reference-id={item.id} className="group relative w-44 shrink-0 overflow-hidden rounded-md border border-stone-300 dark:border-stone-600">
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="h-24 w-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => { editReferenceInput(); referenceInput.select(item.id); setFocusedReferenceId(item.id); setReferences((value) => { const next = moveReferenceById(value, item.id, offset); referenceInput.arrange(next.map(ref => ref.id)); return next; }); }} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 flex size-8 items-center justify-center rounded bg-black/80 text-white focus-visible:outline-2 focus-visible:outline-blue-500"
                                                onClick={() => {
                                                    editReferenceInput();
                                                    referenceInput.remove(item.id);
                                                    const remaining = references.filter(ref => ref.id !== item.id);
                                                    const next = remaining[Math.min(index, remaining.length - 1)];
                                                    if (focusedReferenceId === item.id) { referenceInput.select(next?.id || ""); setFocusedReferenceId(next?.id); }
                                                    setReferences(remaining);
                                                }}
                                                aria-label={t("imageWorkbench.removeReference")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.noReferences")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running || basePrompt.status === "analyzing"} onClick={() => void generate()}>
                                {t("workbench.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                            </div>
                            {running ? <Tag className="m-0 px-2 py-1">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard
                                            key={result.id}
                                            image={result.image}
                                            index={index}
                                            warning={result.warning}
                                            onEdit={addResultToReferences}
                                            onDownload={downloadImage}
                                            onSaveAsset={saveResultToAssets}
                                            onLayers={(image) => {
                                                setWorkbenchParams({ mode: "advanced" });
                                                setEditing({ sourceId: image.id, source: { url: image.dataUrl, ...image } });
                                            }}
                                        />
                                ) : result.status === "failed" ? (
                                        <FailedImageCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={result.preventResubmit || result.error?.includes("不确定") ? undefined : () => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("imageWorkbench.empty")} />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            {editing && (
                <Suspense fallback={<div>正在加载编辑器…</div>}>
                    <AdvancedImageEditor {...editing} onClose={() => setEditing(undefined)} />
                </Suspense>
            )}
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    warning,
    onEdit,
    onDownload,
    onSaveAsset,
    onLayers,
}: {
    image: GeneratedImage;
    index: number;
    warning?: string;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onLayers: (image: GeneratedImage) => void;
}) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={previewUrlFor(image.storageKey) || image.dataUrl} preview={{ src: image.dataUrl }} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square object-contain" />
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                {warning ? (
                    <div role="alert" className="text-xs text-amber-700 dark:text-amber-400">
                        {warning}
                    </div>
                ) : null}
                <Button block className="mb-2" type="primary" onClick={() => onLayers(image)}>
                    分层编辑
                </Button>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry?: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger disabled={!onRetry} onClick={onRetry}>
                    {onRetry ? t("workbench.retry") : "查询原任务"}
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnails = log.images.filter((image) => image.dataUrl).slice(0, 4);

    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
            data-generation-log={log.id}
            data-generation-status={log.status}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" disabled={generationJournal.isActive(log.id)} checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        <p role="status" className="mt-1 text-xs">{log.status === "running" ? "生成中 · 仅当前页面跟踪" : log.status === "interrupted" ? "跟踪已中断 · 待核实" : log.status === "failed" ? "生成失败" : "已完成"}</p>
                        {log.error ? <p className="mt-1 break-words text-xs text-amber-700">{log.error}</p> : null}
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image) => (
                                    <img key={image.id} src={previewUrlFor(image.storageKey) || image.dataUrl} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            {t("workbench.successCount", { count: log.successCount ?? log.imageCount })}
                        </Tag>
                        {log.failCount ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                {t("workbench.failCount", { count: log.failCount })}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.imageCount })}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(generationJournal.display(value));
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        accountId: log.accountId,
        error: log.error,
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        images,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
    };
}
