import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Alert, Button, InputNumber, Slider, Space, Spin, Switch } from "antd";
import { centerWhiteImage, DEFAULT_WHITE_ADJUSTMENTS, fitWhiteImage, isWhiteImageClipped, updateWhiteAdjustments, whiteSamplePoint, WHITE_COLOR_KEYS, type WhiteAdjustments, type WhiteColorKey, type WhiteEditorData, type WhiteOutput } from "@/lib/commerce/white-image-edit";
import { rememberWhiteEdit, travelWhiteEdit, type WhiteEditHistory } from "@/lib/commerce/white-edit-history";
import { drawWhiteImage, loadWhiteLayer, type PreparedWhiteLayer } from "@/lib/commerce/white-image-renderer";
import { correctWhitePerspective } from "@/lib/commerce/white-image-edit";
import { quadMatrix, snapWhitePoint, type Point } from "@/lib/commerce/white-perspective";

const COLOR_LABELS: Record<WhiteColorKey, string> = { temperature: "色温（冷 / 暖）", tint: "色调（绿 / 洋红）", saturation: "饱和度", brightness: "亮度", contrast: "对比度" };

export function ProductWhiteEditor({ editor, value, disabled, onChange: emitChange, onSave, outputFormat = "png" }: { editor: WhiteEditorData; value: WhiteAdjustments; disabled: boolean; onChange: (value: WhiteAdjustments) => void; onSave?: () => void; outputFormat?: WhiteOutput["format"] }) {
    const [history, setHistory] = useState<WhiteEditHistory>({ past: [], future: [] });
    const dragRecorded = useRef(false);
    const onChange = (next: WhiteAdjustments) => {
        if (JSON.stringify(next) === JSON.stringify(value)) return;
        if (!drag.current || !dragRecorded.current) setHistory((current) => rememberWhiteEdit(current, value));
        if (drag.current) dragRecorded.current = true;
        emitChange(next);
    };
    const travel = (direction: "undo" | "redo") => {
        const next = travelWhiteEdit(history, value, direction);
        if (next) { setHistory(next.history); emitChange(next.value); }
    };
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [prepared, setPrepared] = useState<PreparedWhiteLayer>();
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const [compare, setCompare] = useState(false);
    const [picking, setPicking] = useState(false);
    const [grid, setGrid] = useState(true);
    const [gridStep, setGridStep] = useState(10);
    const [snap, setSnap] = useState(8);
    const [guides, setGuides] = useState({ x: 0.5, y: 0.5 });
    const [geometryWarning, setGeometryWarning] = useState("");
    const drag = useRef<{ id: number; clientX: number; clientY: number; x: number; y: number; width: number; height: number; corner?: "topLeft" | "topRight" | "bottomRight" | "bottomLeft" } | undefined>(undefined);
    useEffect(() => {
        let active = true;
        setPrepared(undefined);
        setError("");
        setCompare(false);
        setPicking(false);
        drag.current = undefined;
        setHistory({ past: [], future: [] });
        void loadWhiteLayer(editor.layer)
            .then((layer) => {
                if (active) setPrepared(layer);
            })
            .catch((e) => {
                if (active) setError(e instanceof Error ? e.message : "商品图层读取失败");
            });
        return () => {
            active = false;
        };
    }, [editor.layer.storageKey, editor.layer.url, attempt]);
    useEffect(() => {
        if (!prepared) return;
        const frame = requestAnimationFrame(() => {
            if (!canvasRef.current) return;
            try {
                const settings = { ...value };
                if (compare) for (const key of WHITE_COLOR_KEYS) settings[key] = 0;
                drawWhiteImage(canvasRef.current, prepared, editor, settings, 1024, outputFormat);
                if (value.perspectiveEnabled) {
                    const overlay = canvasRef.current.getContext("2d")!;
                    overlay.save(); overlay.lineWidth = 1; overlay.strokeStyle = "rgba(0,100,255,0.35)";
                    if (grid) for (let n = gridStep; n < 100; n += gridStep) {
                        overlay.beginPath(); overlay.moveTo(n * 10.24, 0); overlay.lineTo(n * 10.24, 1024); overlay.moveTo(0, n * 10.24); overlay.lineTo(1024, n * 10.24); overlay.stroke();
                    }
                    overlay.strokeStyle = "#fa8c16"; overlay.setLineDash([8, 5]); overlay.beginPath();
                    overlay.moveTo(guides.x * 1024, 0); overlay.lineTo(guides.x * 1024, 1024);
                    overlay.moveTo(0, guides.y * 1024); overlay.lineTo(1024, guides.y * 1024); overlay.stroke(); overlay.restore();
                    const ctx = canvasRef.current.getContext("2d")!; ctx.save(); ctx.fillStyle = "#1677ff"; ctx.strokeStyle = "#fff";
                    for (const point of Object.values(value.perspective)) { ctx.beginPath(); ctx.arc(point.x * 1024, point.y * 1024, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } ctx.restore();
                }
            } catch (e) {
                setError(e instanceof Error ? e.message : "预览失败，请重试");
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [prepared, editor, value, compare, outputFormat, grid, gridStep, guides]);
    useEffect(() => {
        if (disabled) drag.current = undefined;
    }, [disabled]);
    const update = (patch: Partial<WhiteAdjustments>) => onChange(updateWhiteAdjustments(editor.base, value, patch));
    const moveCorner = (corner: keyof WhiteAdjustments["perspective"], point: Point) => {
        const next = updateWhiteAdjustments(editor.base, value, { perspective: { ...value.perspective, [corner]: point } });
        try { quadMatrix(next.perspective); setGeometryWarning(""); onChange(next); }
        catch (e) { setGeometryWarning(e instanceof Error ? e.message : "无效四角"); }
    };
    const locked = disabled || !prepared || Boolean(error);
    const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
        if (locked || !event.isPrimary || event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (picking && prepared) {
            // Sample a clean render, excluding the checkerboard and perspective handles.
            const sample = document.createElement("canvas");
            const settings = { ...value };
            if (compare) for (const key of WHITE_COLOR_KEYS) settings[key] = 0;
            drawWhiteImage(sample, prepared, editor, settings, 1024, outputFormat);
            const point = whiteSamplePoint(event.clientX, event.clientY, rect, sample.width, sample.height);
            if (point) {
                const [r, g, b, a] = sample.getContext("2d")!.getImageData(point.x, point.y, 1, 1).data;
                if (a) update({ backgroundColor: "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("") });
            }
            setPicking(false);
            return;
        }
        const px = (event.clientX - rect.left) / rect.width, py = (event.clientY - rect.top) / rect.height;
        const corner = value.perspectiveEnabled ? (Object.entries(value.perspective).find(([, p]) => Math.hypot(p.x - px, p.y - py) < 0.05)?.[0] as "topLeft" | "topRight" | "bottomRight" | "bottomLeft" | undefined) : undefined;
        drag.current = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: value.x, y: value.y, width: rect.width, height: rect.height, corner };
        dragRecorded.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const pointerEnd = (event: PointerEvent<HTMLCanvasElement>) => {
        if (drag.current?.id === event.pointerId) drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };
    return (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
            {error && (
                <div className="xl:col-span-2">
                    <Alert type="error" title={error} action={<Button onClick={() => setAttempt((n) => n + 1)}>重试</Button>} />
                </div>
            )}
            <div className="space-y-3 xl:sticky xl:top-4">
                <div className="relative overflow-hidden rounded-lg border border-black/10" style={{ backgroundColor: "#fff", backgroundImage: "conic-gradient(#ddd 25%, transparent 0 50%, #ddd 0 75%, transparent 0)", backgroundSize: "20px 20px" }}>
                    <canvas
                        ref={canvasRef}
                        width={1024}
                        height={1024}
                        aria-label="商品编辑画布"
                        tabIndex={0}
                        className="block aspect-square w-full touch-none"
                        style={{ cursor: locked ? "default" : picking ? "crosshair" : "grab" }}
                        onPointerDown={pointerDown}
                        onPointerMove={(event) => {
                            const start = drag.current;
                            if (!start || start.id !== event.pointerId || locked) return;
                            if (start.corner && value.perspectiveEnabled) {
                                const rect = event.currentTarget.getBoundingClientRect();
                                const point = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
                                moveCorner(start.corner, snap > 0 && !event.altKey ? snapWhitePoint(point, grid ? gridStep / 100 : 0, snap / rect.width, guides) : point);
                            } else update({ x: start.x + (event.clientX - start.clientX) / start.width, y: start.y + (event.clientY - start.clientY) / start.height });
                        }}
                        onPointerUp={pointerEnd}
                        onPointerCancel={pointerEnd}
                        onLostPointerCapture={() => {
                            drag.current = undefined;
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") { setPicking(false); return; }
                            if (!locked && (event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
                                event.preventDefault();
                                travel(event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo");
                                return;
                            }
                            if (locked || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                            event.preventDefault();
                            const step = event.shiftKey ? 0.01 : 0.001;
                            update({ x: value.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: value.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) });
                        }}
                    />
                    {!prepared && !error && (
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Spin description="正在读取商品图层" />
                        </div>
                    )}
                    {compare && <span className="absolute left-3 top-3 rounded bg-black/65 px-2 py-1 text-xs text-white">调色前 · 构图保持不变</span>}
                </div>
                <p className="text-xs opacity-65">拖动商品调整位置，也可聚焦画布后用方向键微调。</p>
                {isWhiteImageClipped(editor.base, value) && (
                    <Alert
                        type="warning"
                        title="超出部分将被裁切"
                        action={
                            <Button disabled={locked} onClick={() => onChange(fitWhiteImage(editor.base, value))}>
                                完整放入画布
                            </Button>
                        }
                    />
                )}
            </div>
            <div className="space-y-4">
                <Space>
                    <Button disabled={locked || !history.past.length} onClick={() => travel("undo")}>撤销</Button>
                    <Button disabled={locked || !history.future.length} onClick={() => travel("redo")}>重做</Button>
                </Space>
                {onSave && (
                    <Button type="primary" block disabled={locked} onClick={onSave}>
                        保存调整
                    </Button>
                )}
                <div className="space-y-2 border-b border-black/10 pb-4">
                    <h3 className="font-medium">背景</h3>
                    <label className="flex items-center gap-2">背景颜色
                        <input aria-label="背景颜色" type="color" disabled={locked} value={value.backgroundColor || "#ffffff"} onChange={(event) => update({ backgroundColor: event.target.value })} />
                        <span>{value.backgroundColor || "#ffffff"}</span>
                    </label>
                    <AdjustmentControl label="背景透明度" value={100 - (value.backgroundOpacity ?? 100)} min={0} max={100} suffix="%" disabled={locked} onChange={(transparency) => update({ backgroundOpacity: 100 - transparency })} onReset={() => update({ backgroundOpacity: 100 })} />
                    <Button disabled={locked} aria-pressed={picking} onClick={() => setPicking(!picking)}>{picking ? "取消取色" : "画布取色"}</Button>
                    <p className="text-xs opacity-65">{picking ? "点击画布取色，透明像素不会改变颜色；按 Esc 取消。" : outputFormat === "jpeg" ? "JPG 不支持透明：透明区域将合成到白色底层，预览与导出一致。" : "PNG 保留透明度；棋盘格仅用于预览，不会导出。"}</p>
                </div>
                <div>
                    <h3 className="mb-2 font-medium">旋转与缩放</h3>
                    <AdjustmentControl label="旋转角度" value={value.rotation} min={-180} max={180} suffix="°" disabled={locked} onChange={(rotation) => update({ rotation })} onReset={() => update({ rotation: 0 })} />
                    <AdjustmentControl label="等比缩放" value={value.scale} min={10} max={300} suffix="%" disabled={locked} onChange={(scale) => update({ scale })} onReset={() => update({ scale: 100 })} />
                    <Space wrap size="small">
                        <Button disabled={locked} onClick={() => update({ rotation: value.rotation - 90 })}>
                            左转 90°
                        </Button>
                        <Button disabled={locked} onClick={() => update({ rotation: value.rotation + 90 })}>
                            右转 90°
                        </Button>
                        <Button disabled={locked} onClick={() => onChange(centerWhiteImage(editor.base, value))}>
                            居中
                        </Button>
                        <Button disabled={locked} onClick={() => onChange(fitWhiteImage(editor.base, value))}>
                            适应画布
                        </Button>
                        <Button disabled={locked} onClick={() => update({ rotation: 0, scale: 100, x: 0.5, y: 0.5 })}>
                            重置构图
                        </Button>
                    </Space>
                </div>
                <div className="border-t border-black/10 pt-4">
                    <div className="flex items-center justify-between"><h3 className="font-medium">主体透视</h3><Switch checked={value.perspectiveEnabled} disabled={locked} onChange={(perspectiveEnabled) => update({ perspectiveEnabled })} /></div>
                    <p className="mt-1 text-xs opacity-65">手动开启后，可拖动画布四角调整主体透视。</p>
                    {geometryWarning && <Alert type="warning" title={geometryWarning} />}
                    <Button disabled={disabled || !prepared} onClick={() => { setError(""); setGeometryWarning(""); onChange(correctWhitePerspective(editor.base, value)); }}>一键透视校正</Button>
                    <p className="text-xs opacity-65">校正恢复原图比例的正矩形，保留位置和缩放；不识别照片内部的透视。辅助线不会导出。</p>
                    {value.perspectiveEnabled && <div className="space-y-2 mt-2">
                        <label>网格 <Switch aria-label="透视网格" checked={grid} onChange={setGrid} /></label>
                        <label className="block">网格间距 % <InputNumber aria-label="网格间距" min={2} max={25} value={gridStep} onChange={n => n != null && setGridStep(Math.max(2, Math.min(25, n)))} /></label>
                        <label className="block">吸附距离 px <InputNumber aria-label="吸附距离" min={0} max={24} value={snap} onChange={n => n != null && setSnap(Math.max(0, Math.min(24, n)))} /></label>
                        <p className="text-xs opacity-65">0 关闭吸附；按住 Alt 临时关闭。</p>
                        {(["x", "y"] as const).map(axis => <label className="block" key={axis}>{axis === "x" ? "竖" : "横"}参考线 % <InputNumber aria-label={axis + "参考线"} min={0} max={100} value={guides[axis] * 100} onChange={n => n != null && setGuides({ ...guides, [axis]: Math.max(0, Math.min(100, n)) / 100 })} /></label>)}
                    </div>}
                    {value.perspectiveEnabled && <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                        {(["topLeft", "topRight", "bottomRight", "bottomLeft"] as const).map((corner) => <div key={corner}><div>{corner === "topLeft" ? "左上" : corner === "topRight" ? "右上" : corner === "bottomRight" ? "右下" : "左下"}</div><Space.Compact><InputNumber size="small" precision={3} style={{ width: 60 }} aria-label={corner + " X"} min={-16} max={16} step={0.01} value={value.perspective[corner].x} onChange={(x) => x != null && moveCorner(corner, { ...value.perspective[corner], x })} /><InputNumber size="small" precision={3} style={{ width: 60 }} aria-label={corner + " Y"} min={-16} max={16} step={0.01} value={value.perspective[corner].y} onChange={(y) => y != null && moveCorner(corner, { ...value.perspective[corner], y })} /></Space.Compact></div>)}
                    </div>}
                </div>
                <div className="border-t border-black/10 pt-4">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-medium">商品颜色</h3>
                        <Button disabled={locked} aria-pressed={compare} onClick={() => setCompare(!compare)}>
                            {compare ? "返回调色效果" : "查看调色前"}
                        </Button>
                    </div>
                    {WHITE_COLOR_KEYS.map((key) => (
                        <AdjustmentControl
                            key={key}
                            label={COLOR_LABELS[key]}
                            value={value[key]}
                            min={-100}
                            max={100}
                            disabled={locked}
                            onChange={(next) => {
                                setCompare(false);
                                update({ [key]: next });
                            }}
                            onReset={() => {
                                setCompare(false);
                                update({ [key]: 0 });
                            }}
                        />
                    ))}
                    <Button
                        disabled={locked}
                        onClick={() => {
                            setCompare(false);
                            onChange({ ...DEFAULT_WHITE_ADJUSTMENTS });
                        }}
                    >
                        全部还原
                    </Button>
                </div>
            </div>
        </div>
    );
}

function AdjustmentControl({ label, value, min, max, suffix, disabled, onChange, onReset }: { label: string; value: number; min: number; max: number; suffix?: string; disabled: boolean; onChange: (value: number) => void; onReset: () => void }) {
    return (
        <div className="mb-3">
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm">{label}</span>
                <Button type="text" size="small" disabled={disabled} aria-label={"还原" + label} onClick={onReset}>
                    还原
                </Button>
            </div>
            <div className="flex min-w-0 items-center gap-3">
                <Slider aria-label={label + "滑块"} className="min-w-0 flex-1" min={min} max={max} step={1} value={value} disabled={disabled} onChange={onChange} />
                <InputNumber
                    aria-label={label}
                    min={min}
                    max={max}
                    step={1}
                    precision={0}
                    value={value}
                    disabled={disabled}
                    suffix={suffix}
                    style={{ width: 96 }}
                    onChange={(next) => {
                        if (next !== null && Number.isFinite(next)) onChange(next);
                    }}
                />
            </div>
        </div>
    );
}
