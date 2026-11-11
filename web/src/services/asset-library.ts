import { LibraryError, libraryRequest, librarySession } from "./membership-library";
import { normalizeAssetMetadata, type AssetMetadata } from "./asset-metadata";
export { normalizeAssetMetadata, mapLegacyAssetMetadata } from "./asset-metadata";
export type { AssetMetadata } from "./asset-metadata";
export { migrateLibraryAsset, getLibraryMigration, namespaceLibraryLocalId } from "./asset-migration";
export type { AssetMigrationInput, AssetMigrationMapping, AssetMigrationResponse, VerifiedAssetMigration } from "./asset-migration";
export type AssetScope = { scope: "personal" } | { scope: "team"; teamId: string } | { scope: "project"; teamId: string; projectId: string };
export type LibraryAsset = { id: string; ownerId: string; scope: AssetScope["scope"]; teamId?: string; projectId?: string; name: string; mimeType: string; bytes: number; sha256: string; createdAt: string; updatedAt: string; deletedAt: string | null; thumbnailId: string | null; metadataEntries?: AssetMetadata[] };
export function assetLibraryPath(target: AssetScope, suffix = "", trash = false) {
    const query = new URLSearchParams();
    if (target.scope !== "personal") {
        query.set("scope", target.scope); query.set("teamId", target.teamId);
        if (target.scope === "project") query.set("projectId", target.projectId);
    }
    if (trash) query.set("trash", "true");
    return `/asset-library${suffix}${query.size ? `?${query}` : ""}`;
}
const idPath = (id: string) => `/${encodeURIComponent(id)}`;
export const listLibraryAssets = (scope: AssetScope, trash = false) => libraryRequest<{ assets: LibraryAsset[] }>(assetLibraryPath(scope, "", trash));
export const getLibraryAsset = (scope: AssetScope, id: string) => libraryRequest<{ asset: LibraryAsset }>(assetLibraryPath(scope, idPath(id)));
export const getLibraryAssetContent = (scope: AssetScope, id: string) => libraryRequest<Blob>(assetLibraryPath(scope, `${idPath(id)}/content`), "GET", undefined, librarySession(), true);
export const trashLibraryAsset = (scope: AssetScope, id: string) => libraryRequest<{ asset: LibraryAsset }>(assetLibraryPath(scope, idPath(id)), "DELETE");
export const restoreLibraryAsset = (scope: AssetScope, id: string) => libraryRequest<{ asset: LibraryAsset }>(assetLibraryPath(scope, `${idPath(id)}/restore`), "POST");
export const setLibraryThumbnail = (scope: AssetScope, id: string, thumbnailId: string | null) => libraryRequest<{ asset: LibraryAsset }>(assetLibraryPath(scope, `${idPath(id)}/thumbnail`), "PUT", { thumbnailId });
export const getLibraryQuota = (scope: AssetScope) => libraryRequest<{ limitBytes: number; usedBytes: number; maxFileBytes: number; maxAssets: number; trashCounts: boolean }>(assetLibraryPath(scope, "/quota"));
export const getLibraryAudit = (scope: AssetScope) => libraryRequest<{ events: unknown[]; lastSequence: number; retention: number }>(assetLibraryPath(scope, "/audit"));
/** No automatic retry: a failed POST may already have committed. Confirm by content digest in the same container. */
export async function uploadLibraryAsset(scope: AssetScope, name: string, blob: Blob, metadata?: AssetMetadata): Promise<{ asset: LibraryAsset; deduplicated?: boolean; confirmedAfterError?: boolean }> {
    const guard = librarySession();
    const target = { ...scope } as AssetScope;
    const normalizedMetadata = metadata === undefined ? undefined : normalizeAssetMetadata(metadata);
    if (!blob.size || blob.size > 20 * 1024 * 1024) throw new LibraryError(413, "文件须大于0且不超过20MB");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    guard();
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    try {
        return await libraryRequest(assetLibraryPath(target), "POST", { scope: target.scope, name, mimeType: blob.type || "application/octet-stream", data: btoa(binary), ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}) }, guard);
    } catch (error) {
        guard();
        if (error instanceof LibraryError && error.status < 500) throw error;
        const data = await libraryRequest<{ assets: LibraryAsset[] }>(assetLibraryPath(target), "GET", undefined, guard);
        const asset = data.assets.find(item => item.sha256 === digest && item.bytes === bytes.length && !item.deletedAt && (!normalizedMetadata || item.metadataEntries?.some(entry => JSON.stringify(normalizeAssetMetadata(entry)) === JSON.stringify(normalizedMetadata))));
        if (asset) return { asset, confirmedAfterError: true };
        throw new LibraryError(0, "上传结果未确认；当前列表未找到文件，请刷新后再决定是否重试");
    }
}
