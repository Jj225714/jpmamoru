import { getLocalAssetLibraryId, type Asset } from "@/stores/use-asset-store";
import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { librarySession } from "@/services/membership-library";
import { mapLegacyAssetMetadata, migrateLibraryAsset, type AssetScope } from "@/services/asset-library";

async function localBlob(storageKey?: string, url?: string, video = false) {
    const stored = storageKey ? await (video ? getMediaBlob(storageKey) : getImageBlob(storageKey)) : null;
    if (stored) return stored;
    // Historical remote URLs are not silently copied or fetched with credentials.
    if (!url || !/^(blob:|data:)/.test(url)) throw new Error("本地原文件不可用，请先下载原文件再上传；历史资产保留");
    const response = await fetch(url); if (!response.ok) throw new Error("本地文件读取失败"); return response.blob();
}
/** References first, then generated asset. The client verifies and persists every receipt. Never deletes local rows/blobs. */
export async function migrateLocalAsset(scope: AssetScope, asset: Asset, isCurrent: () => boolean = () => true) {
    const accountGuard = librarySession();
    const guard = () => { accountGuard(); if (!isCurrent()) throw new Error("资产范围已切换，已停止后续复制，本地原件保留"); };
    const target = { ...scope } as AssetScope;
    const snapshot = structuredClone(asset);
    const libraryId = await getLocalAssetLibraryId(); guard();
    const generation = snapshot.generation ? { ...snapshot.generation } : undefined;
    if ((generation?.references.length || 0) > 16) throw new Error("参考图超过服务端来源上限，本地资产保留");
    // Reject incompatible prompt/parameter metadata before copying any reference files.
    mapLegacyAssetMetadata({ kind: generation ? "generated" : "original", generation: generation ? { ...generation, references: [] } : undefined });
    const referenceIds: string[] = [];
    for (const ref of snapshot.generation?.references || []) {
        const blob = await localBlob(ref.storageKey, ref.dataUrl); guard();
        const result = await migrateLibraryAsset(target, { libraryId, localId: `reference:${ref.storageKey || ref.id}`, name: ref.name || "reference", blob, metadata: { version: 1, kind: "original" } });
        guard(); referenceIds.push(result.asset.id);
    }
    const metadata = mapLegacyAssetMetadata({ kind: generation ? "generated" : "original", generation, referenceIds: generation ? referenceIds : undefined });
    const blob = snapshot.kind === "text" ? new Blob([snapshot.data.content], { type: "text/plain" }) : await localBlob(snapshot.data.storageKey, snapshot.kind === "image" ? snapshot.data.dataUrl : snapshot.data.url, snapshot.kind === "video");
    guard();
    const result = await migrateLibraryAsset(target, { libraryId, localId: snapshot.id, name: snapshot.title || "asset", blob, metadata });
    guard(); return result;
}
