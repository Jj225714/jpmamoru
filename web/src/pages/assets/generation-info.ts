import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
export type AssetGenerationInfo = {
    version: 1; prompt: string; model: string;
    parameters: { size?: string; quality?: string; count?: string; background?: string };
    references: Array<{ id: string; name: string; type: string; storageKey?: string; dataUrl?: string }>;
    generatedAt?: string;
    source: { kind: "image" | "canvas" | "commerce"; taskId?: string; nodeId?: string; projectId?: string };
};
export async function captureGenerationInfo(input: Omit<AssetGenerationInfo, "version" | "references" | "parameters"> & { parameters: AssetGenerationInfo["parameters"]; references: ReferenceImage[] }): Promise<AssetGenerationInfo> {
    const references = await Promise.all(input.references.map(async (ref) => {
        const stored = ref.storageKey ? { storageKey: ref.storageKey } : await uploadImage(ref.dataUrl || ref.url || "");
        if (!stored.storageKey) throw new Error("参考图未能持久保存，请重试");
        return { id: ref.id, name: ref.name, type: ref.type, storageKey: stored.storageKey };
    }));
    return { version: 1, prompt: input.prompt, model: input.model, generatedAt: input.generatedAt, source: { ...input.source }, parameters: { size: input.parameters.size, quality: input.parameters.quality, count: input.parameters.count, background: input.parameters.background }, references };
}
export async function restoreGenerationInput(info: AssetGenerationInfo) {
    const references = await Promise.all(info.references.map(async (ref) => {
        const dataUrl = await resolveImageUrl(ref.storageKey, ref.storageKey ? "" : ref.dataUrl || "");
        if (!dataUrl) throw new Error(`参考图 ${ref.name} 已不可用，请重新上传`);
        return { ...ref, dataUrl };
    }));
    return { prompt: info.prompt, model: info.model, parameters: { ...info.parameters }, references };
}
