import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, Checkbox, ConfigProvider, Input, InputNumber, Select, Slider, Spin, theme as antTheme } from "antd";
import { Scissors, Eraser, Expand, Layers, ScanText, Sparkles, Brush } from "lucide-react";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useThemeStore } from "@/stores/use-theme-store";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { AiTools, type EditorTool } from "./ai-tools";
import { imageLayer, matchesRevision, revise } from "@/lib/image-editor/document";
import { canvasBlob, renderDocument } from "@/lib/image-editor/render";
import { loadEditDocument, saveEditDocument } from "@/services/image-editor-storage";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import type { EditImage, EditLayer, ImageEditDocument } from "@/types/image-editor";

export function DocumentPreview({ doc }: { doc: ImageEditDocument }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let active = true;
        setError("");
        void renderDocument(doc)
            .then((canvas) => {
                if (!active || !ref.current) return;
                ref.current.width = canvas.width;
                ref.current.height = canvas.height;
                ref.current.getContext("2d")!.drawImage(canvas, 0, 0);
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [doc]);
    return (
        <>
            {error && (
                <div role="alert" className="absolute z-10 bg-red-50 p-2 text-red-700">
                    {error}
                </div>
            )}
            <canvas ref={ref} aria-label="设计画布" className="h-full w-full" />
        </>
    );
}

export function AdvancedImageEditor({ sourceId, source, onClose }: { sourceId: string; source?: EditImage; onClose: () => void }) {
    const theme = useThemeStore((s) => s.theme);
    const dark = theme === "dark";
    const [doc, setDoc] = useState<ImageEditDocument>();
    const [error, setError] = useState("");
    const [saved, setSaved] = useState("读取中…");
    const [selected, setSelected] = useState("");
    const [zoom, setZoom] = useState(0.55);
    const [tool, setTool] = useState<EditorTool>();
    const [candidate, setCandidate] = useState<{ doc: ImageEditDocument; label: string; baseRevision: number; separate: boolean }>();
    const [compare, setCompare] = useState(false);
    const [, setHistoryRevision] = useState(0);
    const undo = useRef<ImageEditDocument[]>([]);
    const redo = useRef<ImageEditDocument[]>([]);
    const current = useRef<ImageEditDocument | undefined>(undefined);
    const uploadRef = useRef<HTMLInputElement>(null);
    const uploadKind = useRef("image");
    const svgRef = useRef<SVGSVGElement>(null);
    const drag = useRef<{ doc: ImageEditDocument; layer: EditLayer; x: number; y: number; type: "move" | "scale" | "rotate" } | undefined>(undefined);
    const { message } = App.useApp();
    const addAsset = useAssetStore((s) => s.addAsset);
    useEffect(() => {
        let active = true;
        void loadEditDocument(sourceId, source)
            .then((value) => {
                if (active) {
                    current.current = value;
                    setDoc(value);
                    setSelected(value.layers.at(-1)?.id || "");
                    setZoom(Math.min(0.7, 650 / value.width, 650 / value.height));
                }
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [sourceId]);
    useEffect(() => {
        if (!doc) return;
        setSaved("保存中…");
        let active = true;
        const timer = setTimeout(() => {
            void saveEditDocument(doc)
                .then(() => {
                    if (active) setSaved("已保存到当前浏览器");
                })
                .catch(() => {
                    if (active) setSaved("保存失败，请重试");
                });
        }, 400);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [doc]);
    const commit = useCallback((next: ImageEditDocument, previous = current.current) => {
        if (!previous) return;
        undo.current.push(previous);
        if (undo.current.length > 40) undo.current.shift();
        redo.current = [];
        const revised = revise(previous, next);
        current.current = revised;
        setDoc(revised);
        setHistoryRevision((n) => n + 1);
    }, []);
    const history = useCallback((direction: "undo" | "redo") => {
        if (!current.current) return;
        const from = direction === "undo" ? undo : redo,
            to = direction === "undo" ? redo : undo;
        const next = from.current.pop();
        if (!next) return;
        to.current.push(current.current);
        const revised = revise(current.current, next);
        current.current = revised;
        setDoc(revised);
        setHistoryRevision((n) => n + 1);
    }, []);
    const changeLayer = (patch: Partial<EditLayer>) => {
        if (!doc) return;
        commit({ ...doc, layers: doc.layers.map((l) => (l.id === selected ? { ...l, ...patch } : l)) });
    };
    const layer = doc?.layers.find((l) => l.id === selected);
    useEffect(() => {
        const keyboard = (e: KeyboardEvent) => {
            if (candidate || tool || (e.target as HTMLElement).closest("input,textarea,[contenteditable=true],.ant-select")) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
                e.preventDefault();
                history(e.shiftKey ? "redo" : "undo");
            }
            if (e.key === "Delete" && current.current && selected && !current.current.layers.find((l) => l.id === selected)?.locked) {
                e.preventDefault();
                commit({ ...current.current, layers: current.current.layers.filter((l) => l.id !== selected) });
            }
        };
        window.addEventListener("keydown", keyboard);
        return () => window.removeEventListener("keydown", keyboard);
    }, [selected, tool, candidate, history, commit]);
    const safe = (work: () => Promise<void>) => {
        void work().catch((e) => {
            setError(e.message || "操作失败");
        });
    };
    const close = () =>
        safe(async () => {
            if (current.current) await saveEditDocument(current.current);
            onClose();
        });
    const addText = () => {
        if (!doc) return;
        const text: EditLayer = {
            id: nanoid(),
            name: "新增文字",
            kind: "text",
            text: "双击右侧修改文字",
            x: doc.width * 0.1,
            y: doc.height * 0.1,
            width: doc.width * 0.65,
            height: doc.height * 0.18,
            rotation: 0,
            opacity: 1,
            visible: true,
            locked: false,
            fontSize: Math.round(doc.width / 20),
            fontFamily: "Arial",
            color: "#222222",
        };
        commit({ ...doc, layers: [...doc.layers, text] });
        setSelected(text.id);
    };
    const addImage = (file: File) =>
        safe(async () => {
            if (!doc) return;
            const image = await uploadImage(file);
            const background = uploadKind.current === "background";
            const ratio = background ? Math.max(doc.width / image.width, doc.height / image.height) : Math.min(1, (doc.width * 0.7) / image.width, (doc.height * 0.7) / image.height);
            const item = {
                ...imageLayer(image, background ? "上传背景" : file.name),
                width: image.width * ratio,
                height: image.height * ratio,
                x: (doc.width - image.width * ratio) / 2,
                y: (doc.height - image.height * ratio) / 2,
                ...(background ? { role: "background" as const } : {}),
            };
            if (current.current?.id !== doc.id) return;
            commit({ ...current.current!, layers: background ? [item, ...current.current!.layers.map((l) => (l.role === "background" ? { ...l, visible: false } : l))] : [...current.current!.layers, item] });
            setSelected(item.id);
        });
    const exportImage = (format: "png" | "jpeg", asset = false) =>
        safe(async () => {
            if (!doc) return;
            const blob = await canvasBlob(await renderDocument(doc, format === "jpeg"), `image/${format}`);
            if (!asset) {
                saveAs(blob, `${doc.title}.${format === "jpeg" ? "jpg" : "png"}`);
                return;
            }
            const image = await uploadImage(blob);
            addAsset({
                kind: "image",
                title: doc.title,
                coverUrl: image.url,
                tags: ["高级通用生图"],
                data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
                metadata: { source: "advanced-image", documentId: doc.id },
            });
            message.success("已保存到素材");
        });
    const point = (event: React.PointerEvent) => {
        const rect = svgRef.current!.getBoundingClientRect();
        return { x: ((event.clientX - rect.left) / rect.width) * doc!.width, y: ((event.clientY - rect.top) / rect.height) * doc!.height };
    };
    const start = (e: React.PointerEvent, target: EditLayer, type: "move" | "scale" | "rotate") => {
        e.stopPropagation();
        setSelected(target.id);
        if (target.locked || !doc || candidate) return;
        svgRef.current!.setPointerCapture(e.pointerId);
        drag.current = { doc, layer: target, ...point(e), type };
    };
    const move = (e: React.PointerEvent) => {
        const active = drag.current;
        if (!active) return;
        const p = point(e),
            dx = p.x - active.x,
            dy = p.y - active.y;
        const l = active.layer;
        let patch: Partial<EditLayer>;
        if (active.type === "move") patch = { x: l.x + dx, y: l.y + dy };
        else if (active.type === "rotate") patch = { rotation: (Math.atan2(p.y - l.y - l.height / 2, p.x - l.x - l.width / 2) * 180) / Math.PI + 90 };
        else {
            const angle = (l.rotation * Math.PI) / 180;
            const localDx = dx * Math.cos(angle) + dy * Math.sin(angle);
            const localDy = -dx * Math.sin(angle) + dy * Math.cos(angle);
            const ratio = Math.max(0.02, 1 + (localDx * l.width + localDy * l.height) / (l.width ** 2 + l.height ** 2));
            const dw = l.width * (ratio - 1),
                dh = l.height * (ratio - 1);
            patch = { width: l.width * ratio, height: l.height * ratio, x: l.x + ((Math.cos(angle) - 1) * dw) / 2 - (Math.sin(angle) * dh) / 2, y: l.y + (Math.sin(angle) * dw) / 2 + ((Math.cos(angle) - 1) * dh) / 2 };
        }
        setDoc({ ...active.doc, layers: active.doc.layers.map((item) => (item.id === l.id ? { ...item, ...patch } : item)) });
    };
    const finish = () => {
        if (drag.current && doc) {
            const before = drag.current.doc;
            drag.current = undefined;
            if (JSON.stringify(doc.layers) !== JSON.stringify(before.layers)) commit(doc, before);
        }
    };
    const display = candidate && !compare ? candidate.doc : doc;
    const toolIcons = { cutout: Scissors, erase: Eraser, expand: Expand, layers: Layers, ocr: ScanText, upscale: Sparkles, mask: Brush };
    const actions: Array<[EditorTool, string]> = [
        ["cutout", "抠图"],
        ["erase", "消除"],
        ["upscale", "高清"],
        ["expand", "扩图"],
        ["ocr", "编辑文字"],
        ["layers", "拆分图层"],
        ["mask", "修正蒙版"],
    ];
    return createPortal(
        <ConfigProvider theme={{ inherit: false, algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm, token: { colorPrimary: "#8b5cf6", borderRadius: 10, colorText: dark ? "#e7e5e4" : "#292524" } }}>
            <div style={{ colorScheme: theme }} className="fixed inset-0 z-[900] flex flex-col bg-[#f6f7fb] text-stone-800 dark:bg-stone-900 dark:text-stone-100" role="dialog" aria-label="高级通用生图编辑器">
                <header className="flex shrink-0 flex-wrap items-center gap-3 border-b dark:border-stone-700 bg-white dark:bg-stone-950 px-5 py-3">
                    <Button onClick={close}>← 返回</Button>
                    <strong className="text-xl">高级通用生图</strong>
                    <UserStatusActions />
                    {doc && <Input disabled={!!candidate} aria-label="设计名称" className="!w-48" value={doc.title} onChange={(e) => commit({ ...doc, title: e.target.value })} />}
                    <span className="text-xs text-stone-500 dark:text-stone-400">{saved}</span>
                    {saved.startsWith("保存失败") && (
                        <Button
                            onClick={() =>
                                safe(async () => {
                                    await saveEditDocument(doc!);
                                    setSaved("已保存到当前浏览器");
                                })
                            }
                        >
                            重试保存
                        </Button>
                    )}
                    <div className="ml-auto flex gap-2">
                        <Button disabled={!undo.current.length || !!candidate || !!tool} onClick={() => history("undo")}>
                            撤销
                        </Button>
                        <Button disabled={!redo.current.length || !!candidate || !!tool} onClick={() => history("redo")}>
                            重做
                        </Button>
                        <Button disabled={!doc || !!candidate} onClick={() => exportImage("png", true)}>
                            保存到素材
                        </Button>
                        <Button disabled={!doc || !!candidate} onClick={() => exportImage("jpeg")}>
                            下载 JPG
                        </Button>
                        <Button type="primary" disabled={!doc || !!candidate} onClick={() => exportImage("png")}>
                            下载 PNG
                        </Button>
                    </div>
                </header>
                {error && <Alert type="error" title={error} closable onClose={() => setError("")} />}
                {!doc || !display ? (
                    <div className="m-auto">
                        <Spin />
                    </div>
                ) : (
                    <>
                        {candidate && (
                            <div className="flex items-center gap-3 border-b border-violet-200 bg-violet-50 dark:bg-violet-950/40 px-5 py-3">
                                <strong>{candidate.label} · 结果预览</strong>
                                <Checkbox checked={compare} onChange={(e) => setCompare(e.target.checked)}>
                                    查看处理前
                                </Checkbox>
                                <span className="text-sm">可在左侧逐层查看，应用后继续编辑。</span>
                                <div className="ml-auto flex gap-2">
                                    <Button
                                        onClick={() => {
                                            setCandidate(undefined);
                                            setCompare(false);
                                        }}
                                    >
                                        放弃结果
                                    </Button>
                                    <Button
                                        type="primary"
                                        onClick={() =>
                                            safe(async () => {
                                                if (!matchesRevision(current.current!, { documentId: doc.id, revision: candidate.baseRevision })) throw new Error("设计已经改变，请重新处理");
                                                if (candidate.separate) {
                                                    await saveEditDocument(candidate.doc);
                                                    message.success("已保存高清副本，可从编辑稿列表打开");
                                                } else {
                                                    commit(candidate.doc);
                                                    const added = candidate.doc.layers.filter((l) => l.visible && l.role !== "background" && !doc.layers.some((old) => old.id === l.id));
                                                    setSelected(added.at(-1)?.id || candidate.doc.layers.find((l) => l.id === selected && l.visible)?.id || candidate.doc.layers.filter((l) => l.visible).at(-1)?.id || "");
                                                }
                                                setCandidate(undefined);
                                                setCompare(false);
                                            })
                                        }
                                    >
                                        {candidate.separate ? "保存独立副本" : "应用结果"}
                                    </Button>
                                </div>
                            </div>
                        )}
                        <main className="grid min-h-0 flex-1 grid-cols-[220px_minmax(260px,1fr)_280px]">
                            <aside className="space-y-4 overflow-auto border-r bg-white dark:bg-stone-950 p-4">
                                <fieldset disabled={!!candidate} className="space-y-3">
                                    <div className="grid grid-cols-2 gap-2">
                                        <Button onClick={addText}>添加文字</Button>
                                        <Button
                                            onClick={() => {
                                                uploadKind.current = "image";
                                                uploadRef.current?.click();
                                            }}
                                        >
                                            图片 / Logo
                                        </Button>
                                    </div>
                                    <div className="rounded-lg bg-stone-50 dark:bg-stone-900 p-3">
                                        <div className="mb-2 font-medium">画布背景</div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                aria-label="背景颜色"
                                                type="color"
                                                value={doc.background === "transparent" ? "#ffffff" : doc.background}
                                                onChange={(e) => commit({ ...doc, background: e.target.value, layers: doc.layers.map((l) => (l.role === "background" ? { ...l, visible: false } : l)) })}
                                            />
                                            <Checkbox
                                                checked={doc.background === "transparent"}
                                                onChange={(e) => commit({ ...doc, background: e.target.checked ? "transparent" : "#ffffff", layers: doc.layers.map((l) => (l.role === "background" ? { ...l, visible: false } : l)) })}
                                            >
                                                透明
                                            </Checkbox>
                                        </div>
                                        <Button
                                            className="mt-3 w-full"
                                            onClick={() => {
                                                uploadKind.current = "background";
                                                uploadRef.current?.click();
                                            }}
                                        >
                                            上传背景
                                        </Button>
                                    </div>
                                </fieldset>
                                <div className="flex justify-between font-semibold">
                                    <span>图层</span>
                                    <span>{display.layers.length}</span>
                                </div>
                                <div className="space-y-2">
                                    {[...display.layers].reverse().map((item) => (
                                        <div key={item.id} className={`rounded-lg border p-2 ${selected === item.id ? "border-violet-500 bg-violet-50 dark:bg-violet-950/40" : "border-stone-200 dark:border-stone-700"}`}>
                                            <button className="mb-2 w-full truncate text-left text-sm" onClick={() => setSelected(item.id)}>
                                                {item.kind === "text" ? "T" : "▧"} {item.name}
                                                {item.groupId ? " · 分组" : ""}
                                            </button>
                                            <div className="flex gap-2 text-xs">
                                                <Checkbox
                                                    checked={item.visible}
                                                    onChange={(e) => {
                                                        if (candidate) setCandidate({ ...candidate, doc: { ...candidate.doc, layers: candidate.doc.layers.map((l) => (l.id === item.id ? { ...l, visible: e.target.checked } : l)) } });
                                                        else commit({ ...doc, layers: doc.layers.map((l) => (l.id === item.id ? { ...l, visible: e.target.checked } : l)) });
                                                    }}
                                                >
                                                    显示
                                                </Checkbox>
                                                <Checkbox disabled={!!candidate} checked={item.locked} onChange={(e) => commit({ ...doc, layers: doc.layers.map((l) => (l.id === item.id ? { ...l, locked: e.target.checked } : l)) })}>
                                                    锁定
                                                </Checkbox>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </aside>
                            <section className="relative min-w-0 overflow-auto p-10 pb-24">
                                <div className="relative mx-auto shadow-lg" style={{ width: display.width * zoom, height: display.height * zoom, backgroundImage: "conic-gradient(#eee 25%,white 0 50%,#eee 0 75%,white 0)", backgroundSize: "20px 20px" }}>
                                    <DocumentPreview doc={display} />
                                    {!candidate && (
                                        <svg
                                            ref={svgRef}
                                            viewBox={`0 0 ${doc.width} ${doc.height}`}
                                            className="absolute inset-0 h-full w-full touch-none overflow-visible"
                                            onPointerMove={move}
                                            onPointerUp={finish}
                                            onPointerCancel={() => {
                                                if (drag.current) setDoc(drag.current.doc);
                                                drag.current = undefined;
                                            }}
                                            onPointerDown={() => setSelected("")}
                                        >
                                            {doc.layers
                                                .filter((l) => l.visible)
                                                .map((l) => (
                                                    <g key={l.id} transform={`rotate(${l.rotation} ${l.x + l.width / 2} ${l.y + l.height / 2})`}>
                                                        <rect
                                                            x={l.x}
                                                            y={l.y}
                                                            width={l.width}
                                                            height={l.height}
                                                            fill="transparent"
                                                            stroke={selected === l.id ? "#8b5cf6" : "none"}
                                                            strokeWidth={2 / zoom}
                                                            style={{ cursor: l.locked ? "default" : "move" }}
                                                            onPointerDown={(e) => start(e, l, "move")}
                                                        />
                                                        {selected === l.id && !l.locked && (
                                                            <>
                                                                <circle
                                                                    cx={l.x + l.width}
                                                                    cy={l.y + l.height}
                                                                    r={6 / zoom}
                                                                    fill="white"
                                                                    stroke="#8b5cf6"
                                                                    strokeWidth={2 / zoom}
                                                                    style={{ cursor: "nwse-resize" }}
                                                                    onPointerDown={(e) => start(e, l, "scale")}
                                                                />
                                                                <line x1={l.x + l.width / 2} y1={l.y} x2={l.x + l.width / 2} y2={l.y - 25 / zoom} stroke="#8b5cf6" strokeWidth={1 / zoom} />
                                                                <circle cx={l.x + l.width / 2} cy={l.y - 25 / zoom} r={6 / zoom} fill="white" stroke="#8b5cf6" style={{ cursor: "grab" }} onPointerDown={(e) => start(e, l, "rotate")} />
                                                            </>
                                                        )}
                                                    </g>
                                                ))}
                                        </svg>
                                    )}
                                </div>
                                <div className="sticky bottom-0 mx-auto mt-6 flex w-fit items-center gap-3 rounded-xl border bg-white dark:bg-stone-950 p-2 shadow">
                                    <Button onClick={() => setZoom((z) => Math.max(0.1, z - 0.1))}>−</Button>
                                    <span>{Math.round(zoom * 100)}%</span>
                                    <Button onClick={() => setZoom((z) => Math.min(2, z + 0.1))}>＋</Button>
                                    <Button onClick={() => setZoom(Math.min(0.8, 600 / doc.width, 600 / doc.height))}>适应</Button>
                                </div>
                            </section>
                            <aside className="space-y-5 overflow-auto border-l bg-white dark:bg-stone-950 p-4">
                                <h2 className="font-semibold">编辑图片</h2>
                                <div className="grid grid-cols-3 gap-2">
                                    {actions.map(([id, name]) => (
                                        <button
                                            key={id}
                                            disabled={!!candidate || (id !== "expand" && id !== "upscale" && (!layer?.image || layer.locked)) || (id === "upscale" && !!layer?.locked)}
                                            onClick={() => setTool(id)}
                                            className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl bg-violet-100 dark:bg-violet-950 px-1 text-sm text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-900 disabled:opacity-40"
                                        >
                                            {(() => {
                                                const Icon = toolIcons[id];
                                                return <Icon className="size-5" />;
                                            })()}
                                            {name}
                                        </button>
                                    ))}
                                </div>
                                <p className="text-xs text-stone-500 dark:text-stone-400">
                                    {doc.width} × {doc.height}px · 编辑稿保存在当前浏览器
                                </p>
                                {!layer ? (
                                    <p className="text-sm text-stone-500 dark:text-stone-400">选择图层后调整属性</p>
                                ) : (
                                    <fieldset disabled={!!candidate || layer.locked} className="space-y-4">
                                        <Input aria-label="图层名称" value={layer.name} onChange={(e) => changeLayer({ name: e.target.value })} />
                                        <div className="grid grid-cols-2 gap-3">
                                            {(["x", "y", "width", "height", "rotation"] as const).map((key) => (
                                                <label key={key} className="text-xs">
                                                    {{ x: "X 位置", y: "Y 位置", width: "宽度", height: "高度", rotation: "旋转" }[key]}
                                                    <InputNumber
                                                        aria-label={key}
                                                        className="!w-full"
                                                        min={key === "width" || key === "height" ? 1 : -8192}
                                                        max={8192}
                                                        value={Math.round(layer[key])}
                                                        onChange={(n) => {
                                                            const value = n || (key === "width" || key === "height" ? 1 : 0);
                                                            changeLayer(
                                                                layer.kind === "image" && key === "width"
                                                                    ? { width: value, height: (layer.height * value) / layer.width }
                                                                    : layer.kind === "image" && key === "height"
                                                                      ? { height: value, width: (layer.width * value) / layer.height }
                                                                      : { [key]: value },
                                                            );
                                                        }}
                                                    />
                                                </label>
                                            ))}
                                        </div>
                                        <label className="block text-sm">
                                            不透明度 {Math.round(layer.opacity * 100)}%<Slider min={0} max={100} value={Math.round(layer.opacity * 100)} onChange={(n) => changeLayer({ opacity: n / 100 })} />
                                        </label>
                                        {layer.kind === "text" && (
                                            <>
                                                <Input.TextArea aria-label="文字内容" rows={3} value={layer.text} onChange={(e) => changeLayer({ text: e.target.value })} />
                                                <Select
                                                    aria-label="字体"
                                                    className="w-full"
                                                    value={layer.fontFamily || "Arial"}
                                                    options={["Arial", "Microsoft YaHei", "SimSun", "serif", "sans-serif", "monospace"].map((v) => ({ value: v, label: v }))}
                                                    onChange={(fontFamily) => changeLayer({ fontFamily })}
                                                />
                                                <div className="flex gap-2">
                                                    <InputNumber aria-label="字号" min={4} max={1000} value={layer.fontSize} onChange={(n) => changeLayer({ fontSize: n || 40 })} />
                                                    <input aria-label="文字颜色" type="color" value={layer.color || "#222222"} onChange={(e) => changeLayer({ color: e.target.value })} />
                                                    <Checkbox checked={layer.bold} onChange={(e) => changeLayer({ bold: e.target.checked })}>
                                                        粗体
                                                    </Checkbox>
                                                </div>
                                                <Select
                                                    aria-label="文字对齐"
                                                    className="w-full"
                                                    value={layer.align || "left"}
                                                    options={[
                                                        { value: "left", label: "左对齐" },
                                                        { value: "center", label: "居中" },
                                                        { value: "right", label: "右对齐" },
                                                    ]}
                                                    onChange={(align) => changeLayer({ align })}
                                                />
                                            </>
                                        )}
                                        <div className="grid grid-cols-2 gap-2">
                                            {[-1, 1].map((direction) => (
                                                <Button
                                                    key={direction}
                                                    onClick={() => {
                                                        const layers = [...doc.layers];
                                                        const index = layers.findIndex((l) => l.id === selected);
                                                        const next = index + direction;
                                                        if (next < 0 || next >= layers.length) return;
                                                        [layers[index], layers[next]] = [layers[next], layers[index]];
                                                        commit({ ...doc, layers });
                                                    }}
                                                >
                                                    {direction === 1 ? "上移一层" : "下移一层"}
                                                </Button>
                                            ))}
                                            <Button
                                                onClick={() => {
                                                    const copy = { ...layer, id: nanoid(), name: layer.name + " 副本", x: layer.x + 20, y: layer.y + 20 };
                                                    commit({ ...doc, layers: [...doc.layers, copy] });
                                                    setSelected(copy.id);
                                                }}
                                            >
                                                复制
                                            </Button>
                                            <Button
                                                danger
                                                onClick={() => {
                                                    commit({ ...doc, layers: doc.layers.filter((l) => l.id !== selected) });
                                                    setSelected("");
                                                }}
                                            >
                                                删除
                                            </Button>
                                        </div>
                                    </fieldset>
                                )}
                            </aside>
                        </main>
                    </>
                )}
                <input
                    ref={uploadRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) addImage(file);
                        e.target.value = "";
                    }}
                />
                {tool && doc && (
                    <AiTools
                        tool={tool}
                        doc={doc}
                        target={layer}
                        onClose={() => setTool(undefined)}
                        onCandidate={(next, label, separate = false) => {
                            setCandidate({ doc: next, label, baseRevision: doc.revision, separate });
                            setTool(undefined);
                            setCompare(false);
                        }}
                    />
                )}
            </div>
        </ConfigProvider>,
        document.body,
    );
}
