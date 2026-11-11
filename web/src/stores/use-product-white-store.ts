import { create } from "zustand";
import { useSyncExternalStore } from "react";
import { createJSONStorage, persist } from "zustand/middleware";
import { localForageStorage } from "@/lib/localforage-storage";
import type { StoredImageRef } from "@/types/commerce";
import type { UploadedImage } from "@/services/image-storage";
import type { WhiteDraft, WhiteEditorData, WhiteOutput } from "@/lib/commerce/white-image-edit";

export type WhiteResult = {
    id: string;
    source: StoredImageRef;
    image: UploadedImage;
    createdAt: string;
    rootId?: string;
    editor?: WhiteEditorData;
    output?: WhiteOutput;
    draft?: WhiteDraft;
    renderSignature?: string;
};
type HydrationStatus = "loading" | "ready" | "error";
let hydrationStatus: HydrationStatus = "loading";
const hydrationListeners = new Set<() => void>();
function setHydrationStatus(status: HydrationStatus) {
    hydrationStatus = status;
    hydrationListeners.forEach((listener) => listener());
}
// Keep readiness outside persisted state: marking a failed read must not write
// the initial empty records back over the user's history.
export function useProductWhiteHydration() {
    return useSyncExternalStore(
        (listener) => { hydrationListeners.add(listener); return () => { hydrationListeners.delete(listener); }; },
        () => hydrationStatus,
        () => "loading" as HydrationStatus,
    );
}
export const useProductWhiteStore = create<{
    records: WhiteResult[];
    pending?: WhiteResult;
    selectedId?: string;
    add: (result: WhiteResult) => void;
    update: (id: string, patch: Partial<WhiteResult>) => void;
    select: (id?: string) => void;
    setPending: (result?: WhiteResult) => void;
}>()(
    persist(
        (set) => ({
            records: [],
            add: (result) => set((state) => ({ records: [result, ...state.records] })),
            update: (id, patch) => set((state) => ({ records: state.records.map((record) => (record.id === id ? { ...record, ...patch, id } : record)) })),
            select: (selectedId) => set({ selectedId }),
            setPending: (pending) => set({ pending }),
        }),
        {
            name: "infinite-canvas:product-white",
            storage: createJSONStorage(() => localForageStorage),
            onRehydrateStorage: () => {
                setHydrationStatus("loading");
                return (_state, error) => setHydrationStatus(error ? "error" : "ready");
            },
        },
    ),
);
