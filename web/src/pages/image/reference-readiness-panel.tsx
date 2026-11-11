import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ReferenceReadiness } from "./reference-readiness";
import { useServerConfigStore } from "@/services/server-config";

export function referenceAccountKey() {
    const state = useServerConfigStore.getState();
    return JSON.stringify([state.user?.id ?? null, state.phase === "signed-out"]);
}
/** Subscribe synchronously: even A -> B -> A inside one React batch invalidates old work. */
export function bindReferenceAccount(queue: ReferenceReadiness, onReset: () => void = () => {}, initial = referenceAccountKey()) {
    let account = initial;
    const check = () => {
        const next = referenceAccountKey();
        if (next === account) return;
        account = next;
        queue.reset();
        onReset();
    };
    const unsubscribe = useServerConfigStore.subscribe(check);
    check();
    return unsubscribe;
}
export function useReferenceReadiness(session: string, onAccountReset?: () => void) {
    const [queue] = useState(() => new ReferenceReadiness());
    const resetRef = useRef(onAccountReset);
    resetRef.current = onAccountReset;
    const initialAccount = useRef(referenceAccountKey());
    useSyncExternalStore(queue.subscribe, queue.getSnapshot);
    useLayoutEffect(() => bindReferenceAccount(queue, () => resetRef.current?.(), initialAccount.current), [queue]);
    useLayoutEffect(() => { queue.reset(); return queue.reset; }, [queue, session]);
    return queue;
}
export function ReferenceReadinessPanel({ queue }: { queue: ReferenceReadiness }) {
    const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
    return <div aria-live="polite" className="max-h-36 overflow-auto text-xs">
        {items.map((item) => <div key={item.id} className="flex gap-2 p-1">
            <span>{item.name}: {item.status === "reading" ? "读取/上传中" : item.status === "ready" ? "已就绪" : `失败：${item.error}`}</span>
            {item.status === "failed" && <button onClick={() => queue.retry(item.id)}>重试</button>}
            {item.status !== "ready" && <button onClick={() => queue.remove(item.id)}>移除</button>}
        </div>)}
    </div>;
}
