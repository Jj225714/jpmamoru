/** Metadata only: never pass request bodies or credentials to this store. */
export type StoredTaskIntent = {
    version: 1;
    intentId: string;
    idempotencyKey: string;
    fingerprint: string;
    createdAt: number;
    jobId?: string;
};
export interface TaskIntentStore {
    list(scope: string): Promise<StoredTaskIntent[]>;
    update(scope: string, intentId: string, change: (previous: StoredTaskIntent | undefined) => StoredTaskIntent): Promise<StoredTaskIntent>;
}
export class IntentStorageError extends Error {
    constructor() {
        super("Intent metadata storage unavailable or invalid");
    }
}
export async function intentDigest(value: string) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
type Lock = <T>(name: string, operation: () => Promise<T>) => Promise<T>;
/** Web Locks serialize read-modify-write across tabs. Unsupported storage/locks fail closed. */
export function createTaskIntentStore(storage?: Pick<Storage, "getItem" | "setItem">, lock?: Lock): TaskIntentStore {
    const key = (scope: string) => {
        if (!/^[a-f0-9]{64}$/.test(scope)) throw new IntentStorageError();
        return `sanhe-task-intents-v1:${scope}`;
    };
    const backend = () => storage ?? globalThis.localStorage;
    const read = (scope: string): StoredTaskIntent[] => {
        try {
            const raw = backend().getItem(key(scope));
            if (raw === null) return [];
            const rows: unknown = JSON.parse(raw);
            if (!Array.isArray(rows) || rows.length > 1000) throw new IntentStorageError();
            const ids = new Set<string>();
            return rows.map((row) => {
                if (
                    !row ||
                    row.version !== 1 ||
                    typeof row.intentId !== "string" ||
                    !/^[A-Za-z0-9._~-]{1,200}$/.test(row.intentId) ||
                    ids.has(row.intentId) ||
                    typeof row.idempotencyKey !== "string" ||
                    !/^[A-Za-z0-9._~-]{1,200}$/.test(row.idempotencyKey) ||
                    !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
                    !Number.isSafeInteger(row.createdAt) ||
                    row.createdAt < 0 ||
                    (row.jobId !== undefined && (typeof row.jobId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(row.jobId)))
                )
                    throw new IntentStorageError();
                ids.add(row.intentId);
                return { version: 1, intentId: row.intentId, idempotencyKey: row.idempotencyKey, fingerprint: row.fingerprint, createdAt: row.createdAt, ...(row.jobId ? { jobId: row.jobId } : {}) };
            });
        } catch {
            throw new IntentStorageError();
        }
    };
    return {
        async list(scope) {
            return read(scope);
        },
        async update(scope, intentId, change) {
            const withLock: Lock =
                lock ??
                (async (name, operation) => {
                    if (!globalThis.navigator?.locks) throw new IntentStorageError();
                    return navigator.locks.request(name, operation);
                });
            return withLock(key(scope), async () => {
                const rows = read(scope),
                    index = rows.findIndex((row) => row.intentId === intentId);
                const next = change(index < 0 ? undefined : rows[index]);
                // Whitelist fields even if a caller passes extra runtime properties.
                const safe: StoredTaskIntent = { version: 1, intentId: next.intentId, idempotencyKey: next.idempotencyKey, fingerprint: next.fingerprint, createdAt: next.createdAt, ...(next.jobId ? { jobId: next.jobId } : {}) };
                if (index < 0) rows.push(safe);
                else rows[index] = safe;
                if (rows.length > 1000) throw new IntentStorageError();
                try {
                    backend().setItem(key(scope), JSON.stringify(rows));
                } catch {
                    throw new IntentStorageError();
                }
                return safe;
            });
        },
    };
}
