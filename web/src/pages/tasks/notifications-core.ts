import type { Task } from "@/services/api/task-center";
export type NotificationPermissionState = NotificationPermission | "unsupported";
export function notificationPermission(): NotificationPermissionState {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}
export async function requestTaskNotificationPermission(): Promise<NotificationPermissionState> {
    if (notificationPermission() === "unsupported") return "unsupported";
    try { return await Notification.requestPermission(); } catch { return notificationPermission(); }
}
const terminal = new Set(["succeeded", "failed", "canceled"]);
/** Persists only opaque IDs and observed state; terminal history is a baseline, never a notification flood. */
export class CompletionLedger {
    constructor(private storage: Pick<Storage, "getItem" | "setItem">, private key: string) {}
    observe(tasks: Task[], notify: (task: Task) => void) {
        let known: Record<string, string>;
        try { known = JSON.parse(this.storage.getItem(this.key) || "{}"); if (!known || typeof known !== "object" || Array.isArray(known)) known = {}; } catch { return; }
        const completed: Task[] = [];
        for (const task of tasks) {
            const id = `job:${task.jobId}`;
            if (terminal.has(task.status)) {
                if (known[id] && known[id] !== "notified") completed.push(task);
                known[id] = "notified";
            } else if (known[id] !== "notified") known[id] = "watching";
        }
        // Fail closed if persistence is unavailable: never promise refresh-safe dedup with volatile memory.
        try { this.storage.setItem(this.key, JSON.stringify(known)); } catch { return; }
        completed.forEach(notify);
    }
}
