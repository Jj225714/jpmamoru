import { create } from "zustand";
import { getManagedSession, loginManagedSession, logoutManagedSession, ManagedModelSessionError, type ManagedSession } from "@/services/managed-model-session";

export type { ManagedSession } from "@/services/managed-model-session";
type ManagedState = {
    session: ManagedSession | null;
    phase: "checking" | "anonymous" | "authenticated" | "error";
    error: string | null;
    logoutPending: boolean;
    refresh: () => Promise<void>;
    login: (code: string) => Promise<boolean>;
    logout: () => Promise<void>;
    expire: () => void;
};

let revision = 0;
let mutation = false;
let refreshPromise: Promise<void> | null = null;
const errorMessage = (error: unknown) => (error instanceof ManagedModelSessionError ? error.message : "授权服务暂时不可用，请重试。");

export const useManagedModelStore = create<ManagedState>((set, get) => ({
    session: null,
    phase: "checking",
    error: null,
    logoutPending: false,
    expire: () => {
        revision++;
        refreshPromise = null;
        set({ session: null, phase: "anonymous", error: "授权已失效，请重新输入访问码。" });
    },
    refresh: async () => {
        if (mutation || get().logoutPending) return;
        if (refreshPromise) return refreshPromise;
        const current = revision;
        if (!get().session) set({ phase: "checking", error: null });
        const pending = (async () => {
            try {
                const session = await getManagedSession();
                if (current !== revision) return;
                set({ session, phase: session.authenticated ? "authenticated" : "anonymous", error: null });
            } catch (error) {
                if (current !== revision) return;
                if (error instanceof ManagedModelSessionError && error.status === 401) get().expire();
                else set({ phase: get().session?.authenticated ? "authenticated" : "error", error: errorMessage(error) });
            }
        })();
        refreshPromise = pending;
        try {
            await pending;
        } finally {
            if (refreshPromise === pending) refreshPromise = null;
        }
    },
    login: async (code) => {
        if (mutation || get().logoutPending || !code.trim()) return false;
        mutation = true;
        const current = ++revision;
        set({ phase: "checking", session: null, error: null });
        try {
            const session = await loginManagedSession(code);
            if (current !== revision) return false;
            set({ session, phase: session.authenticated ? "authenticated" : "anonymous", error: session.authenticated ? null : "访问码无效，请重新输入。" });
            return session.authenticated;
        } catch (error) {
            if (current === revision) set({ phase: "anonymous", error: errorMessage(error) });
            return false;
        } finally {
            mutation = false;
        }
    },
    logout: async () => {
        if (mutation) return;
        mutation = true;
        const current = ++revision;
        set({ session: null, phase: "checking", error: null, logoutPending: true });
        try {
            await logoutManagedSession();
            if (current === revision) set({ phase: "anonymous", logoutPending: false });
        } catch {
            if (current === revision) set({ phase: "error", error: "退出未完成，服务器授权可能仍有效，请重试退出。", logoutPending: true });
        } finally {
            mutation = false;
        }
    },
}));
