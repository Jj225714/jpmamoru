import { captureGenerationInfo, restoreGenerationInput } from "@/pages/assets/generation-info";
import { useAssetStore } from "@/stores/use-asset-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { GeneratedAsset } from "@/types/commerce";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export function captureCommerceSource(taskId: string, prompt: string, config: AiConfig, references: ReferenceImage[]) {
    return captureGenerationInfo({ prompt, model: config.model, parameters: { size: config.size, quality: config.quality, count: config.count, background: config.background }, references, generatedAt: new Date().toISOString(), source: { kind: "commerce", taskId } });
}

export async function saveCommerceAsset(asset: GeneratedAsset, sku: string, reuse = false) {
    if (!useAssetStore.getState().hydrated) throw new Error("我的资产尚未读取完成，请稍后重试");
    const snapshot = structuredClone(asset);
    if (reuse) {
        if (!snapshot.generation) throw new Error("此图片没有完整模型生成来源，不能恢复旧模型或参考图；可保存图片后手动设置");
        if (snapshot.generation.references.some((ref) => !ref.storageKey)) throw new Error("参考图缺少稳定引用，请重新上传后生成");
        await restoreGenerationInput(snapshot.generation);
    }
    const url = await resolveImageUrl(snapshot.storageKey, snapshot.storageKey ? "" : snapshot.url);
    if (!url) throw new Error("图片已不可用，请重新生成或上传");
    const stored = snapshot.storageKey ? { storageKey: snapshot.storageKey, url } : await uploadImage(url);
    if (!stored.storageKey) throw new Error("图片未能持久保存，请重试");
    return useAssetStore.getState().addAsset({ kind: "image", title: snapshot.title, coverUrl: stored.url, tags: ["跨境生图", sku], source: "commerce", generation: snapshot.generation,
        note: snapshot.generation ? "包含生成输入；带入生图后可编辑，不修改原任务。" : "无完整模型来源记录（历史图片或本地排版），不推测原模型。",
        metadata: { taskId: snapshot.jobId, skuId: snapshot.skuId, sku, generatedAt: snapshot.createdAt, stage: snapshot.stage, revision: snapshot.revision, prompt: snapshot.prompt, generationHistory: snapshot.generationHistory },
        data: { dataUrl: stored.url, storageKey: stored.storageKey, width: snapshot.width, height: snapshot.height, bytes: snapshot.bytes, mimeType: snapshot.mimeType } });
}
