import { categoryPreflightErrors } from "@/lib/commerce/category-rules";
import { selectedRequirementPresets, requirementVariantValues } from "@/lib/commerce/generation-config";
import { categorySelectionErrors, COMMERCE_REFERENCE_LIMIT, generationReferences } from "@/lib/commerce/generation-inputs";
import { usesDetailSources } from "@/lib/commerce/detail-sources";
import { visualPreflightErrors } from "@/lib/commerce/visual-plan";
import { imageToDataUrl } from "@/services/image-storage";
import type { CommerceJob, CommerceSku, PolicyPack, StoredImageRef } from "@/types/commerce";

export type PreparedReference = { dataUrl: string; mimeType: string; contentHash: string; bytes?: number };

export async function readGenerationReference(ref: StoredImageRef): Promise<PreparedReference> {
    const dataUrl = await imageToDataUrl(ref);
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(blob.type) || blob.size > 20 * 1024 * 1024) throw new Error(`${ref.name}：请使用PNG、JPEG、WebP或GIF图片，每张不超过20MB`);
    await new Promise<void>((resolve, reject) => {
        const image = new Image();
        const timer = setTimeout(() => {
            image.src = "";
            reject(new Error(`${ref.name}：图片解码超时`));
        }, 15000);
        image.onload = () => {
            clearTimeout(timer);
            image.naturalWidth && image.naturalHeight && image.naturalWidth * image.naturalHeight <= 40_000_000 ? resolve() : reject(new Error(`${ref.name}：图片尺寸无效或超过4000万像素`));
        };
        image.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`${ref.name}：图片无法解码`));
        };
        image.src = dataUrl;
    });
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const contentHash = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if ("contentHash" in ref && ref.contentHash !== contentHash) throw new Error(`${ref.name}：图片内容已改变，请重新上传并绑定`);
    return { dataUrl, mimeType: blob.type, contentHash, bytes: blob.size };
}

/** Resolve and decode the entire SKU before the first paid request. Return immutable in-memory request inputs. */
export async function preflightGenerationInputs(job: CommerceJob, sku: CommerceSku, pack: PolicyPack, read = readGenerationReference): Promise<Map<string, PreparedReference>> {
    const errors = [...categoryPreflightErrors(pack, sku.product), ...visualPreflightErrors(job, sku, pack.requirementPresets)];
    const refs = new Map<string, StoredImageRef>();
    const requestGroups: string[][] = [];
    const white = sku.assets.find((asset) => asset.stage === "main-white" && asset.revision === sku.activeRevision);
    if (!white && sku.product.images[0]) refs.set(sku.product.images[0].id, sku.product.images[0]);
    const whiteRef: StoredImageRef | undefined = white && { id: white.id, name: white.title, url: white.url, storageKey: white.storageKey, source: "generated" };
    for (const { preset, selection } of selectedRequirementPresets(job, sku, pack.requirementPresets)) {
        if (preset.stage === "marketing" && !job.generationConfig.marketingEnabled) continue;
        errors.push(...categorySelectionErrors(pack, job, sku, preset, selection));
        for (const variant of requirementVariantValues(sku, selection)) {
            try {
                const inputs = generationReferences(pack, sku, preset, selection, variant, whiteRef);
                const detail = usesDetailSources(sku, preset, selection);
                const original = selection.detailRenderMode === "original" && detail;
                const reserve = 1 + (!detail && !whiteRef ? 1 : 0) + (preset.generationStrategy === "paired-before-after" ? 1 : 0);
                if (!original && inputs.length + reserve > COMMERCE_REFERENCE_LIMIT) errors.push(`${preset.title}：参考图过多（包括补全及前后对比最多${COMMERCE_REFERENCE_LIMIT}张），请减少补充图片`);
                if (!original) requestGroups.push(inputs.map((ref) => ref.id));
                for (const ref of inputs) refs.set(ref.id, ref);
            } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
    }
    if (errors.length) throw new Error([...new Set(errors)].join("\n"));
    const prepared = new Map<string, PreparedReference>();
    for (const [id, ref] of refs) {
        try { prepared.set(id, await read(ref)); }
        catch (error) { throw new Error(`${ref.name}：参考图不可读取（刷新后本地素材可能已丢失），请重新上传、重新绑定或移除对应方案后重试。${error instanceof Error ? error.message : String(error)}`); }
    }
    // Leave room in the 128MB transport envelope for base64 encoding and generated repair/comparison sources.
    if (requestGroups.some((ids) => ids.reduce((sum, id) => sum + (prepared.get(id)?.bytes || 0), 0) > 64 * 1024 * 1024)) throw new Error("单次生图参考素材合计超过64MB，请压缩或减少补充照片后重试");
    return prepared;
}
