import { useSyncExternalStore } from "react";
import { useServerConfigStore } from "@/services/server-config";

/** Configuration refresh is not an account switch. Keep paid in-flight UI mounted. */
export function generationAccountIdentity(state: { user: { id: string | number } | null; phase: string }) {
    return JSON.stringify([state.user ? String(state.user.id) : null, state.phase === "signed-out"]);
}
let identity = generationAccountIdentity(useServerConfigStore.getState());
let revision = 0;
const listeners = new Set<() => void>();
useServerConfigStore.subscribe(state => {
    const next = generationAccountIdentity(state);
    if (next === identity) return;
    identity = next; revision++; listeners.forEach(listener => listener());
});
export function useGenerationAccountRevision() {
    return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getGenerationAccountRevision);
}
export function getGenerationAccountRevision() { return revision; }
