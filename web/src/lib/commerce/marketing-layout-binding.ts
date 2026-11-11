import type { LayeredComposition, CommerceJob, CommerceSku } from "@/types/commerce";
export async function bytesDigest(bytes: ArrayBuffer) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(n => n.toString(16).padStart(2, "0")).join(""); }
/** Identity/revision bookkeeping changes do not alter the raster; source bytes and all visual properties do. */
export async function compositionDigest(composition: LayeredComposition) {
    const layers = composition.layers.map(({ id: _id, sourceAssetId: _source, ...visual }) => visual);
    return bytesDigest(new TextEncoder().encode(JSON.stringify({ width: composition.width, height: composition.height, backgroundColor: composition.backgroundColor, layoutVersion: composition.layoutVersion, layers })).buffer);
}
export async function bindCompositionRaster(composition: LayeredComposition, blob: Blob) { return { layoutDigest: await compositionDigest(composition), rasterDigest: await bytesDigest(await blob.arrayBuffer()) }; }

export function marketingReviewSignature(job: CommerceJob, sku: CommerceSku) {
    return JSON.stringify([job.generationConfig, job.locales, sku.requirementSelections, sku.selectedTemplateIds, sku.copyZh, sku.localizedCopy,
        sku.assets.filter(a => a.revision === sku.activeRevision).map(a => [a.id, a.compositionId, a.stage, a.layoutDigest, a.storageKey, a.url]),
        sku.compositions.filter(c => c.revision === sku.activeRevision).map(c => [c.id, c.width, c.height, c.layers])]);
}
