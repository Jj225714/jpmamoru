import localforage from "localforage";
import { assetLibraryPath, type AssetScope, type LibraryAsset } from "./asset-library";
import { LibraryError, libraryRequest, librarySession } from "./membership-library";
import { normalizeAssetMetadata, validMigrationLocalId, type AssetMetadata } from "./asset-metadata";

export type AssetMigrationMapping = { actorId: string; localId: string; assetId: string; fingerprint: string; createdAt: string };
export type AssetMigrationResponse = { asset: LibraryAsset; mapping: AssetMigrationMapping; deduplicated?: boolean; replayed?: boolean };
export type AssetMigrationInput = { libraryId: string; localId: string; name: string; blob: Blob; metadata?: AssetMetadata };
export type VerifiedAssetMigration = AssetMigrationResponse & { verified: true; confirmedAfterError: boolean; resumed: boolean; receiptKey: string };
const receipts = localforage.createInstance({ name: "infinite-canvas", storeName: "asset_migration_receipts" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never { throw new LibraryError(409, "迁移结果与本地内容或来源不一致；保留本地资产，请核对原映射"); }
async function sha256(bytes: Uint8Array<ArrayBuffer>) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function namespaceInput(libraryId: string, localId: string) {
    if (typeof libraryId !== "string" || !libraryId.trim() || libraryId.length > 512 || typeof localId !== "string" || !localId || localId.length > 512) throw new LibraryError(400, "需要稳定的本地资产库标识和旧资产 ID");
    try { encodeURIComponent(libraryId); encodeURIComponent(localId); } catch { throw new LibraryError(400, "本地资产标识无效"); }
    return JSON.stringify([libraryId, localId]);
}
/** Persist libraryId once per independent local library. Never regenerate it on retry. */
export async function namespaceLibraryLocalId(libraryId: string, localId: string) {
    const value = namespaceInput(libraryId, localId);
    return `local-${await sha256(new TextEncoder().encode(value))}`;
}
function copyScope(scope: AssetScope): AssetScope {
    if (scope.scope === "personal" && Object.keys(scope).every(k => k === "scope")) return { scope: "personal" };
    if (scope.scope === "team" && uuid.test(scope.teamId) && Object.keys(scope).every(k => ["scope", "teamId"].includes(k))) return { scope: "team", teamId: scope.teamId };
    if (scope.scope === "project" && uuid.test(scope.teamId) && uuid.test(scope.projectId) && Object.keys(scope).every(k => ["scope", "teamId", "projectId"].includes(k))) return { scope: "project", teamId: scope.teamId, projectId: scope.projectId };
    throw new LibraryError(400, "资产容器无效");
}
/** Raw server state, not cleanup authorization. Resume with migrateLibraryAsset for verification. */
export function getLibraryMigration(scope: AssetScope, localId: string) {
    const target = copyScope(scope);
    if (!validMigrationLocalId(localId)) throw new LibraryError(400, "迁移 ID 无效");
    return libraryRequest<AssetMigrationResponse>(assetLibraryPath(target, `/migrations/${encodeURIComponent(localId)}`));
}
/** No deletion and no automatic POST retry. Every resume rechecks current server authorization. */
export async function migrateLibraryAsset(scope: AssetScope, input: AssetMigrationInput): Promise<VerifiedAssetMigration> {
    const guard = librarySession();
    const actorId = String(guard());
    const target = copyScope(scope);
    const namespace = namespaceInput(input.libraryId, input.localId);
    const name = input.name;
    const blob = input.blob;
    const metadataSnapshot = normalizeAssetMetadata(input.metadata);
    const origin = window.location.origin;
    if (typeof name !== "string" || !name.trim() || name.length > 512 || /[\x00-\x1f\x7f]/.test(name)) throw new LibraryError(400, "资产名称无效");
    try { encodeURIComponent(name); } catch { throw new LibraryError(400, "资产名称无效"); }
    if (!blob.size || blob.size > 20 * 1024 * 1024) throw new LibraryError(413, "文件须大于0且不超过20MB");
    const mimeType = blob.type || "application/octet-stream";
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType) || mimeType.length > 128) throw new LibraryError(400, "文件 MIME 类型无效");
    const localId = `local-${await sha256(new TextEncoder().encode(namespace))}`;
    guard();
    if (metadataSnapshot.source?.localId !== undefined && metadataSnapshot.source.localId !== localId) throw new LibraryError(400, "来源 localId 必须使用命名空间后的迁移 ID");
    const metadata = normalizeAssetMetadata({ ...metadataSnapshot, source: { ...metadataSnapshot.source, localId } });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    guard();
    const digest = await sha256(bytes);
    guard();
    const fingerprint = await sha256(new TextEncoder().encode(JSON.stringify({ sha256: digest, name, mimeType, metadata })));
    guard();
    const path = assetLibraryPath(target, `/migrations/${localId}`);
    let response: AssetMigrationResponse | undefined;
    let resumed = false;
    let confirmedAfterError = false;
    try { response = await libraryRequest<AssetMigrationResponse>(path, "GET", undefined, guard); resumed = true; }
    catch (error) { guard(); if (!(error instanceof LibraryError) || error.status !== 404) throw error; }
    if (!response) {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        try {
            response = await libraryRequest<AssetMigrationResponse>(assetLibraryPath(target, "/migrations"), "POST", { scope: target.scope, localId, name, mimeType, data: btoa(binary), metadata }, guard);
        } catch (error) {
            guard();
            if (error instanceof LibraryError && error.status > 0 && error.status < 500) throw error;
            // A commit may precede network failure. GET the original binding, never re-POST.
            response = await libraryRequest<AssetMigrationResponse>(path, "GET", undefined, guard);
            confirmedAfterError = true;
        }
    }
    guard();
    const { asset, mapping } = response;
    if (!asset || !mapping || !uuid.test(asset.id) || mapping.actorId !== actorId || mapping.localId !== localId || mapping.assetId !== asset.id || mapping.fingerprint !== fingerprint || !Number.isFinite(Date.parse(mapping.createdAt))) invalid();
    if (asset.scope !== target.scope || asset.teamId !== ("teamId" in target ? target.teamId : undefined) || asset.projectId !== ("projectId" in target ? target.projectId : undefined) || (target.scope === "personal" && asset.ownerId !== actorId)) invalid();
    if (asset.deletedAt !== null || asset.sha256 !== digest || asset.bytes !== bytes.length || !Array.isArray(asset.metadataEntries)) invalid();
    // Dedup preserves the first uploader's name, MIME and owner; fingerprint validates THIS request.
    if (!asset.metadataEntries.some(entry => JSON.stringify(normalizeAssetMetadata(entry)) === JSON.stringify(metadata))) invalid();
    const receiptKey = JSON.stringify([origin, actorId, target, localId]);
    const record = { version: 1, origin, actorId, scope: target, mapping, sha256: digest, bytes: bytes.length, metadata };
    guard();
    await receipts.setItem(receiptKey, record);
    guard();
    const persisted = await receipts.getItem(receiptKey);
    guard();
    if (JSON.stringify(persisted) !== JSON.stringify(record)) throw new LibraryError(0, "迁移映射未确认持久保存；请保留本地资产并重试读取");
    return { ...response, verified: true, confirmedAfterError, resumed, receiptKey };
}
