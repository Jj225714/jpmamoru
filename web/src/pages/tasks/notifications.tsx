import { useEffect, useState } from "react";
import { Button } from "antd";
import { taskClient, taskLink, taskSources, useTaskSessionRevision } from "./session";

import { CompletionLedger, notificationPermission, requestTaskNotificationPermission } from "./notifications-core";
function usePermission() {
    const [permission, setPermission] = useState(notificationPermission);
    useEffect(() => {
        const update = () => setPermission(notificationPermission());
        window.addEventListener("focus", update); window.addEventListener("task-notification-permission", update);
        return () => { window.removeEventListener("focus", update); window.removeEventListener("task-notification-permission", update); };
    }, []);
    return permission;
}
export function TaskNotificationPermission() {
    const permission = usePermission();
    const [busy, setBusy] = useState(false);
    if (permission === "unsupported") return <span>此浏览器不支持系统通知</span>;
    if (permission === "denied") return <span>通知已被拒绝，可在浏览器网站设置中允许；任务仍可在此查看。</span>;
    if (permission === "granted") return <span>完成通知已允许（需保持本站打开）</span>;
    return <Button loading={busy} onClick={async () => { setBusy(true); await requestTaskNotificationPermission(); setBusy(false); window.dispatchEvent(new Event("task-notification-permission")); }}>允许任务完成通知</Button>;
}
export function TaskNotificationMonitor() {
    const revision = useTaskSessionRevision(), permission = usePermission();
    useEffect(() => {
        if (permission !== "granted") return;
        const sources = taskSources();
        const clients = sources.map(source => { try { return taskClient(source); } catch { return null; } });
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const run = async () => {
            await Promise.all(sources.map(async (source, index) => {
                const client = clients[index]; if (!client) return;
                try {
                    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([source.session.accountId, source.session.apiKey, source.id])));
                    const key = `task-completion:${Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("")}`;
                    let cursor: string | null = null;
                    const seen = new Set<string>();
                    do {
                        const page = await client.list({ cursor, limit: 50 });
                        if (stopped) return;
                        const observe = () => {
                            if (stopped || notificationPermission() !== "granted") return;
                            new CompletionLedger(localStorage, key).observe(page.items, task => {
                                try {
                                    const notification = new Notification(task.status === "succeeded" ? "图片任务已完成" : task.status === "canceled" ? "图片任务已取消" : "图片任务失败", { body: "点击查看任务详情", tag: `${key}:${task.jobId}` });
                                    notification.onclick = () => { window.focus(); window.location.assign(taskLink(source.id, task.jobId)); notification.close(); };
                                } catch { /* Permission or platform support can change between checks. */ }
                            });
                        };
                        if (navigator.locks) await navigator.locks.request(key, observe); else observe();
                        cursor = page.nextCursor;
                        if (cursor && seen.has(cursor)) break;
                        if (cursor) seen.add(cursor);
                    } while (!stopped && cursor && seen.size < 20);
                } catch { /* Read failures do not change task state or create jobs. */ }
            }));
            if (!stopped) timer = setTimeout(run, 15000);
        };
        void run();
        return () => { stopped = true; clearTimeout(timer); clients.forEach(client => client?.dispose()); };
    }, [revision, permission]);
    return null;
}
