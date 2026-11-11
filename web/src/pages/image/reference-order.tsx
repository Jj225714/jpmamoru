import { ArrowLeft, ArrowRight } from "lucide-react";

/** Resolve identity against the latest list, including uploads completed between clicks. */
export function moveReferenceById<T extends { id: string }>(items: T[], id: string, offset: -1 | 1): T[] {
    const index = items.findIndex((item) => item.id === id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

export function snapshotReferenceOrder<T extends { id: string }>(items: T[]): T[] {
    return items.map((item) => ({ ...item }));
}

export function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: -1 | 1) => void }) {
    return (
        <div className="space-y-1 border-t border-stone-300 bg-white p-1.5 text-stone-950 dark:border-stone-600 dark:bg-stone-900 dark:text-white" role="group" aria-label={`参考图 ${index + 1}，共 ${total} 张，调整顺序`}>
            <div className="text-center text-xs font-semibold" aria-live="polite" aria-atomic="true">参考图 {index + 1} / {total}</div>
            <div className="flex gap-1">
                {([-1, 1] as const).map((offset) => {
                    const unavailable = offset === -1 ? index === 0 : index === total - 1;
                    const label = offset === -1 ? "前移" : "后移";
                    const Icon = offset === -1 ? ArrowLeft : ArrowRight;
                    return <button key={offset} type="button" aria-label={`参考图 ${index + 1}${label}`} aria-disabled={unavailable}
                        title={unavailable ? (offset === -1 ? "已是第一张" : "已是最后一张") : label}
                        className="flex min-h-11 min-w-11 flex-1 items-center justify-center gap-1 rounded border border-stone-400 bg-white text-xs font-semibold text-stone-950 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 aria-disabled:cursor-not-allowed aria-disabled:border-dashed aria-disabled:border-stone-300 aria-disabled:bg-stone-100 aria-disabled:text-stone-500 dark:border-stone-500 dark:bg-stone-800 dark:text-white dark:hover:bg-stone-700 dark:aria-disabled:border-stone-600 dark:aria-disabled:bg-stone-900 dark:aria-disabled:text-stone-400"
                        onClick={() => { if (!unavailable) onMove(offset); }}>
                        <Icon className="size-5 shrink-0" aria-hidden="true" />{label}
                    </button>;
                })}
            </div>
        </div>
    );
}
