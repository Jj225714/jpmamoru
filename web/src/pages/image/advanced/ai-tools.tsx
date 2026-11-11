import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Spin } from "antd";
import { nanoid } from "nanoid";
import { estimateTextColor } from "@/lib/image-editor/text-color";
import { MaskPainter } from "./mask-painter";
import { alphaStats, canvasBlob, compositeMasked, loadEditImage, makeCanvas, opaqueInput, renderDocument, restoreAlpha } from "@/lib/image-editor/render";
import { expandDocument, imageLayer, splitLayers, validUpscale } from "@/lib/image-editor/document";
import { extractProductBackground } from "@/lib/commerce/background-removal";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { captureEditorConfig, editCapabilities, runEditTask, type EditorSnapshot, type EditRequest } from "@/services/api/image-editor";
import type { EditImage, EditLayer, EditOperation, ImageEditDocument, OcrLine } from "@/types/image-editor";

import { useConfigStore } from "@/stores/use-config-store";

export type EditorTool = EditOperation | "cutout" | "mask";
const names: Record<EditorTool, string> = { erase: "消除", expand: "扩图", upscale: "高清增强", ocr: "编辑原图文字", layers: "复杂图层拆分", cutout: "主体分离", mask: "修正透明蒙版" };
type TextBox = { id: string; selected: boolean; text: string; x: number; y: number; width: number; height: number; rotation: number; confidence: number; color: string };

export function AiTools({ tool, doc, target, onClose, onCandidate }: { tool: EditorTool; doc: ImageEditDocument; target?: EditLayer; onClose: () => void; onCandidate: (doc: ImageEditDocument, label: string, separate?: boolean) => void }) {
    const config = useConfigStore((s) => s.config);
    const openConfig = useConfigStore((s) => s.openConfigDialog);
    const snapshot = useRef<EditorSnapshot | undefined>(undefined);
    const [source, setSource] = useState("");
    const [mask, setMask] = useState("");
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [capabilities, setCapabilities] = useState<Awaited<ReturnType<typeof editCapabilities>>>();
    const [scale, setScale] = useState(2);
    const [scope, setScope] = useState<"layer" | "document">(target?.image ? "layer" : "document");
    const [padding, setPadding] = useState({ left: 128, top: 128, right: 128, bottom: 128 });
    const [restore, setRestore] = useState(false);
    const [boxes, setBoxes] = useState<TextBox[]>([]);
    const [recognized, setRecognized] = useState(false);
    const controller = useRef<AbortController | null>(null);
    const busy = useRef(false);
    const mounted = useRef(true);
    const isDocument = tool === "expand" || (tool === "upscale" && scope === "document");
    const width = isDocument ? doc.width : target?.image?.width || doc.width;
    const height = isDocument ? doc.height : target?.image?.height || doc.height;
    useEffect(() => {
        mounted.current = true;
        void editCapabilities(config)
            .then(setCapabilities)
            .catch((e) => {
                if (mounted.current) setError(e.message);
            });
        return () => {
            mounted.current = false;
            controller.current?.abort();
        };
    }, []);
    useEffect(() => {
        void editCapabilities(config).then(setCapabilities);
    }, [config]);
    useEffect(() => {
        let active = true;
        setSource("");
        setMask("");
        const load = async () => {
            if (tool === "expand") {
                const background = { ...doc, layers: doc.layers.filter((l) => l.role === "background" || l.role === "source") };
                return (await renderDocument(background)).toDataURL();
            }
            if (isDocument) return (await renderDocument(doc)).toDataURL();
            if (!target?.image) throw new Error("请先选择一个图片图层");
            return imageToDataUrl(target.image);
        };
        void load()
            .then((value) => {
                if (active) setSource(value);
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [isDocument, tool, target, doc]);
    const run = async (operation: EditOperation, image: string, extra: Partial<EditRequest> = {}) => {
        const input = await loadEditImage(image);
        const normalized = makeCanvas(input.width, input.height);
        normalized.getContext("2d")!.drawImage(input, 0, 0);
        const task = await runEditTask(
            { operation, image: normalized.toDataURL(), width, height, documentId: doc.id, revision: doc.revision, idempotencyKey: nanoid(), ...extra },
            controller.current!.signal,
            (task) => {
                if (mounted.current) setStatus(task.status === "queued" ? "排队中…" : task.status === "running" ? "处理中…" : "正在准备预览…");
            },
            snapshot.current,
        );
        controller.current!.signal.throwIfAborted();
        return task.result!;
    };
    const replace = (image: EditImage) => ({ ...doc, layers: doc.layers.map((l) => (l.id === target?.id ? { ...l, image } : l)) });
    const candidate = (next: ImageEditDocument, separate = false) => {
        controller.current!.signal.throwIfAborted();
        if (mounted.current) onCandidate(next, names[tool], separate);
    };
    const process = async () => {
        if (busy.current || !source) return;
        busy.current = true;
        snapshot.current = captureEditorConfig(config);
        controller.current = new AbortController();
        setError("");
        setStatus("正在准备…");
        try {
            if (tool === "cutout") {
                const image = await uploadImage(await extractProductBackground({ ...target!.image!, id: target!.id, name: target!.name, source: "generated" }));
                const stats = await alphaStats(image);
                if (!stats.transparent || !stats.visible) throw new Error("未获得有效透明主体，请更换图片或重试");
                const next = replace(image);
                next.background = "#ffffff";
                next.layers = next.layers.map((l) => (l.id === target!.id ? { ...l, role: "product" } : l));
                candidate(next);
            } else if (tool === "mask") {
                if (!mask) throw new Error("请先涂抹需要修正的区域");
                const current = await loadEditImage(source);
                const canvas = makeCanvas(width, height);
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(current, 0, 0);
                const base = await loadEditImage(target!.maskBase || target!.image!);
                const baseCanvas = makeCanvas(width, height);
                const bctx = baseCanvas.getContext("2d")!;
                bctx.drawImage(base, 0, 0, width, height);
                const m = await loadEditImage(mask);
                const mc = makeCanvas(width, height);
                mc.getContext("2d")!.drawImage(m, 0, 0);
                const selection = mc.getContext("2d")!.getImageData(0, 0, width, height);
                const pixels = ctx.getImageData(0, 0, width, height);
                const original = bctx.getImageData(0, 0, width, height);
                for (let i = 0; i < pixels.data.length; i += 4) {
                    const weight = selection.data[i] / 255;
                    if (restore) {
                        for (let c = 0; c < 4; c++) pixels.data[i + c] = pixels.data[i + c] * (1 - weight) + original.data[i + c] * weight;
                    } else pixels.data[i + 3] *= 1 - weight;
                }
                ctx.putImageData(pixels, 0, 0);
                const next = replace(await uploadImage(await canvasBlob(canvas)));
                next.layers = next.layers.map((l) => (l.id === target!.id ? { ...l, maskBase: target!.maskBase || target!.image } : l));
                candidate(next);
            } else if (tool === "erase") {
                if (!mask) throw new Error("请先涂抹要消除的内容");
                const result = await run("erase", source, { mask });
                candidate(replace(await uploadImage(await compositeMasked(source, result.images![0].url, mask))));
            } else if (tool === "expand") {
                const w = width + padding.left + padding.right,
                    h = height + padding.top + padding.bottom;
                if (Math.max(w, h) > 4096 || (w === width && h === height)) throw new Error("请设置扩展区域，最长边不得超过 4096 像素");
                const canvas = makeCanvas(w, h);
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(await loadEditImage(source), padding.left, padding.top);
                const selection = makeCanvas(w, h);
                const sctx = selection.getContext("2d")!;
                sctx.fillStyle = "white";
                sctx.fillRect(0, 0, w, h);
                sctx.fillStyle = "black";
                sctx.fillRect(padding.left, padding.top, width, height);
                const input = canvas.toDataURL(),
                    expandedMask = selection.toDataURL();
                const result = await run("expand", input, { mask: expandedMask, width: w, height: h, prompt: "Seamlessly extend the existing background into the masked area, preserving lighting and perspective. No text, no additional products." });
                const image = await uploadImage(await compositeMasked(input, result.images![0].url, expandedMask));
                candidate(expandDocument(doc, padding.left, padding.top, padding.right, padding.bottom, image));
            } else if (tool === "upscale") {
                if (!validUpscale(width, height, scale)) throw new Error("增强后最长边不能超过 4096 像素，请降低倍率");
                const input: EditImage = isDocument ? { url: source, width, height } : target!.image!;
                const result = await run("upscale", await opaqueInput(input), { scale });
                const image = await uploadImage(await restoreAlpha(input, result.images![0].url, scale));
                candidate(
                    isDocument
                        ? { ...doc, id: nanoid(), sourceId: `enhanced-${nanoid()}`, title: doc.title + " 高清副本", width: image.width, height: image.height, original: image, background: "transparent", layers: [imageLayer(image, "高清合成图")] }
                        : replace(image),
                    isDocument,
                );
            } else if (tool === "layers") {
                const result = await run("layers", source);
                const images = await Promise.all(result.images!.map((i) => uploadImage(i.url)));
                const stats = await Promise.all(images.map(alphaStats));
                if (images.length < 2 || !stats.some((s) => s.transparent && s.visible)) throw new Error("模型未返回有效透明图层，请重试或使用主体分离");
                candidate(splitLayers(doc, target!, images));
            } else if (!recognized) {
                const result = await run("ocr", source);
                const image = await loadEditImage(source);
                const cv = makeCanvas(width, height);
                const ctx = cv.getContext("2d")!;
                ctx.drawImage(image, 0, 0);
                const convert = (line: OcrLine): TextBox => {
                    const [p0, p1, , p3] = line.polygon;
                    const w = Math.hypot(p1.x - p0.x, p1.y - p0.y),
                        h = Math.hypot(p3.x - p0.x, p3.y - p0.y);
                    const x = Math.max(0, Math.floor(Math.min(...line.polygon.map((p) => p.x)))),
                        y = Math.max(0, Math.floor(Math.min(...line.polygon.map((p) => p.y))));
                    const cw = Math.max(1, Math.min(width - x, Math.ceil(w))),
                        ch = Math.max(1, Math.min(height - y, Math.ceil(h)));
                    const color = estimateTextColor(ctx.getImageData(x, y, cw, ch).data);
                    return {
                        id: nanoid(),
                        selected: true,
                        text: line.text,
                        x: line.polygon.reduce((s, p) => s + p.x, 0) / 4 - w / 2,
                        y: line.polygon.reduce((s, p) => s + p.y, 0) / 4 - h / 2,
                        width: w,
                        height: h,
                        rotation: (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI,
                        confidence: line.confidence,
                        color,
                    };
                };
                setBoxes((result.lines || []).filter((l) => l.polygon.length === 4).map(convert));
                setRecognized(true);
            } else {
                const selected = boxes.filter((b) => b.selected);
                if (!selected.length) throw new Error("请选择需要转换的文字");
                const canvas = makeCanvas(width, height);
                const ctx = canvas.getContext("2d")!;
                ctx.fillStyle = "black";
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = "white";
                for (const box of selected) {
                    ctx.save();
                    ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
                    ctx.rotate((box.rotation * Math.PI) / 180);
                    ctx.fillRect(-box.width / 2 - 2, -box.height / 2 - 2, box.width + 4, box.height + 4);
                    ctx.restore();
                }
                const textMask = canvas.toDataURL();
                const result = await run("erase", source, { mask: textMask, prompt: "Remove only the masked lettering. Reconstruct the underlying surface without any text. Preserve product structure and colors." });
                const next = replace(await uploadImage(await compositeMasked(source, result.images![0].url, textMask)));
                const layer = target!;
                const sx = layer.width / width,
                    sy = layer.height / height,
                    angle = (layer.rotation * Math.PI) / 180;
                const textLayers: EditLayer[] = selected.map((b) => {
                    const w = b.width * sx,
                        h = b.height * sy * 1.25;
                    const cx = (b.x + b.width / 2) * sx - layer.width / 2,
                        cy = (b.y + b.height / 2) * sy - layer.height / 2;
                    return {
                        id: nanoid(),
                        name: b.text.slice(0, 16) || "文字",
                        kind: "text",
                        text: b.text,
                        x: layer.x + layer.width / 2 + cx * Math.cos(angle) - cy * Math.sin(angle) - w / 2,
                        y: layer.y + layer.height / 2 + cx * Math.sin(angle) + cy * Math.cos(angle) - h / 2,
                        width: w,
                        height: h,
                        rotation: layer.rotation + b.rotation,
                        opacity: layer.opacity,
                        visible: true,
                        locked: false,
                        fontSize: Math.max(8, b.height * sy * 0.85),
                        fontFamily: "Arial",
                        color: b.color,
                    };
                });
                const index = next.layers.findIndex((l) => l.id === layer.id);
                next.layers.splice(index + 1, 0, ...textLayers);
                candidate(next);
            }
        } catch (e) {
            if (mounted.current) setError(e instanceof Error && e.name === "AbortError" ? "已取消，原图未改变" : e instanceof Error ? e.message : "处理失败");
        } finally {
            busy.current = false;
            if (mounted.current) setStatus("");
        }
    };
    const operation = tool === "ocr" && recognized ? "erase" : tool;
    const available = operation === "cutout" || operation === "mask" || capabilities?.operations[operation]?.enabled;
    const patchBox = (id: string, patch: Partial<TextBox>) => setBoxes((all) => all.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    return (
        <Modal
            maskClosable={false}
            title={names[tool]}
            open
            width={860}
            onCancel={() => {
                controller.current?.abort();
                onClose();
            }}
            footer={
                <div className="flex justify-between">
                    <Button
                        onClick={() => {
                            controller.current?.abort();
                            onClose();
                        }}
                    >
                        关闭
                    </Button>
                    <div className="flex gap-2">
                        {status && <Button onClick={() => controller.current?.abort()}>取消处理</Button>}
                        <Button type="primary" disabled={!source || !available || !!status} onClick={() => void process()}>
                            {tool === "ocr" ? (recognized ? "清除旧字并生成文字层" : "识别文字") : "生成预览"}
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="space-y-4 py-3">
                {error && <Alert type="warning" title={error} />}
                {!available && capabilities && <Alert type="info" title={capabilities.operations[operation].message} action={<Button onClick={() => openConfig(false, "editor-tools")}>前往配置</Button>} />}
                {status && (
                    <div role="status" className="flex items-center gap-3">
                        <Spin size="small" />
                        {status}
                    </div>
                )}
                <fieldset disabled={!!status} className="space-y-4">
                    {(tool === "erase" || tool === "mask") && source && (
                        <>
                            {tool === "mask" && (
                                <Checkbox checked={restore} onChange={(e) => setRestore(e.target.checked)}>
                                    恢复此前擦除的区域
                                </Checkbox>
                            )}
                            <MaskPainter src={source} width={width} height={height} onMask={setMask} />
                        </>
                    )}
                    {tool === "expand" && (
                        <>
                            <Alert type="info" title="只扩展背景，已有商品和文字随画板平移。纯色背景将生成对应背景的延伸。" />
                            <div className="flex flex-wrap gap-3">
                                {(["left", "top", "right", "bottom"] as const).map((key, i) => (
                                    <label key={key}>
                                        {["左", "上", "右", "下"][i]}
                                        <InputNumber aria-label={`向${["左", "上", "右", "下"][i]}扩展`} min={0} max={2048} value={padding[key]} onChange={(n) => setPadding((p) => ({ ...p, [key]: Math.round(n || 0) }))} />
                                    </label>
                                ))}
                            </div>
                            <Select
                                aria-label="扩图比例"
                                placeholder="按比例扩展"
                                className="w-48"
                                options={[
                                    { value: 1, label: "1:1" },
                                    { value: 1.777777, label: "16:9" },
                                    { value: 0.5625, label: "9:16" },
                                ]}
                                onChange={(ratio) => {
                                    const w = Math.max(width, Math.ceil(height * ratio)),
                                        h = Math.max(height, Math.ceil(width / ratio));
                                    setPadding({ left: Math.floor((w - width) / 2), right: Math.ceil((w - width) / 2), top: Math.floor((h - height) / 2), bottom: Math.ceil((h - height) / 2) });
                                }}
                            />
                            <p>
                                输出：{width + padding.left + padding.right} × {height + padding.top + padding.bottom}
                            </p>
                        </>
                    )}
                    {tool === "upscale" && (
                        <div className="flex gap-3">
                            <Select
                                aria-label="高清范围"
                                value={scope}
                                onChange={setScope}
                                className="w-48"
                                options={[
                                    { value: "layer", label: "选中图层", disabled: !target?.image },
                                    { value: "document", label: "整图独立副本" },
                                ]}
                            />
                            <Select
                                aria-label="高清倍率"
                                value={scale}
                                onChange={setScale}
                                options={[
                                    { value: 2, label: "2 倍" },
                                    { value: 4, label: "4 倍" },
                                ]}
                            />
                            <span>
                                {width * scale} × {height * scale}px
                            </span>
                        </div>
                    )}
                    {tool === "ocr" && recognized && (
                        <>
                            <p>勾选要转换的文字，校对内容与选区；取消勾选可保留商品标签。字体可在应用后调整。</p>
                            <div className="relative mx-auto max-w-full" style={{ width: Math.min(width, 650), aspectRatio: `${width}/${height}` }}>
                                <img src={source} className="h-full w-full" />
                                <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full">
                                    {boxes.map((b) => (
                                        <rect
                                            key={b.id}
                                            x={b.x}
                                            y={b.y}
                                            width={b.width}
                                            height={b.height}
                                            transform={`rotate(${b.rotation} ${b.x + b.width / 2} ${b.y + b.height / 2})`}
                                            fill={b.selected ? "#8b5cf630" : "transparent"}
                                            stroke={b.selected ? "#8b5cf6" : "#777"}
                                            strokeWidth={2}
                                            onClick={() => patchBox(b.id, { selected: !b.selected })}
                                        />
                                    ))}
                                </svg>
                            </div>
                            {!boxes.length && <p>未识别到文字，可返回编辑器手动添加。</p>}
                            <div className="max-h-64 space-y-3 overflow-auto">
                                {boxes.map((b) => (
                                    <div key={b.id} className="space-y-2 rounded border p-2">
                                        <div className="flex items-center gap-2">
                                            <Checkbox checked={b.selected} onChange={(e) => patchBox(b.id, { selected: e.target.checked })} />
                                            <Input aria-label="识别文字" value={b.text} onChange={(e) => patchBox(b.id, { text: e.target.value })} />
                                            <span>{Math.round(b.confidence * 100)}%</span>
                                            <input type="color" aria-label="文字颜色" value={b.color} onChange={(e) => patchBox(b.id, { color: e.target.value })} />
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            {(["x", "y", "width", "height", "rotation"] as const).map((k) => (
                                                <label key={k}>
                                                    {{ x: "X", y: "Y", width: "宽", height: "高", rotation: "旋转" }[k]}
                                                    <InputNumber size="small" value={Math.round(b[k])} min={k === "width" || k === "height" ? 1 : -4096} max={4096} onChange={(v) => patchBox(b.id, { [k]: v || 0 })} />
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                    {!["erase", "mask"].includes(tool) && !(tool === "ocr" && recognized) && <img alt="待处理图片" src={source} className="mx-auto max-h-80 max-w-full rounded border" />}
                    {tool === "layers" && <p>将生成约 4 个透明图层。预览后可逐层调整和修正蒙版，原图作为隐藏备份保留。</p>}
                </fieldset>
            </div>
        </Modal>
    );
}
