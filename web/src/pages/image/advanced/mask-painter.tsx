import { useEffect, useRef, useState } from "react";
import { Button, Slider } from "antd";
import { makeCanvas } from "@/lib/image-editor/render";

export function MaskPainter({ src, width, height, onMask }: { src: string; width: number; height: number; onMask: (mask: string) => void }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const last = useRef<{ x: number; y: number } | null>(null);
    const [brush, setBrush] = useState(Math.max(8, Math.round(width / 30)));
    const clear = () => {
        const canvas = ref.current;
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        onMask("");
    };
    useEffect(clear, [src, width, height]);
    const publish = () => {
        const mask = makeCanvas(width, height);
        const ctx = mask.getContext("2d")!;
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, width, height);
        const overlay = ref.current!;
        const pixels = overlay.getContext("2d")!.getImageData(0, 0, width, height);
        for (let i = 0; i < pixels.data.length; i += 4) {
            const a = pixels.data[i + 3];
            pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = a;
            pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        onMask(mask.toDataURL());
    };
    const stroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = event.currentTarget;
        const box = canvas.getBoundingClientRect();
        const point = { x: ((event.clientX - box.left) / box.width) * width, y: ((event.clientY - box.top) / box.height) * height };
        const ctx = canvas.getContext("2d")!;
        ctx.strokeStyle = "#8b5cf6";
        ctx.fillStyle = "#8b5cf6";
        ctx.lineWidth = brush;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (last.current) {
            ctx.beginPath();
            ctx.moveTo(last.current.x, last.current.y);
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.arc(point.x, point.y, brush / 2, 0, 2 * Math.PI);
            ctx.fill();
        }
        last.current = point;
    };
    return (
        <div className="space-y-3">
            <div className="flex items-center gap-3">
                <span>画笔 {brush}px</span>
                <Slider className="flex-1" min={2} max={Math.max(50, width / 4)} value={brush} onChange={setBrush} />
                <Button onClick={clear}>清空选区</Button>
            </div>
            <div className="relative mx-auto max-w-full overflow-hidden rounded-lg border bg-stone-100 dark:bg-stone-900" style={{ width: Math.min(620, width), aspectRatio: `${width}/${height}` }}>
                <img src={src} className="absolute inset-0 h-full w-full" draggable={false} />
                <canvas
                    ref={ref}
                    aria-label="涂抹选区"
                    className="absolute inset-0 h-full w-full touch-none opacity-60"
                    onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        drawing.current = true;
                        last.current = null;
                        stroke(e);
                    }}
                    onPointerMove={(e) => {
                        if (drawing.current) stroke(e);
                    }}
                    onPointerUp={() => {
                        if (drawing.current) {
                            drawing.current = false;
                            last.current = null;
                            publish();
                        }
                    }}
                    onPointerCancel={() => {
                        drawing.current = false;
                        last.current = null;
                        publish();
                    }}
                />
            </div>
            <p className="text-xs text-stone-500 dark:text-stone-400">紫色区域为将要处理的部分，可多次涂抹。</p>
        </div>
    );
}
