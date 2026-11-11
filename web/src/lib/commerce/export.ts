import { assertConsistencyCurrent } from "./consistency-service";
import { inspectCompositionLayout } from "./marketing-typography";
import { compositionDigest, bytesDigest } from "./marketing-layout-binding";
import { createZip } from "@/lib/zip";
import { exportName } from "@/lib/commerce/export-name";
import { expectedAssetCount } from "@/lib/commerce/generation-config";
import { isFinalAsset } from "@/lib/commerce/visual-plan";
import { canExportSku, retainManualDecisions, runAssetContentChecks, runDeterministicChecks } from "@/lib/commerce/policy-engine";
import { renderCompositionLayerPng } from "@/lib/commerce/template-renderer";
import { getImageBlob } from "@/services/image-storage";
import { fitExportImage, type ExportImageFormat, type ExportImageQuality } from "./export-image";
import type { BrandProfile, CommerceJob, PolicyPack } from "@/types/commerce";

/** Metadata estimate only; source files are read and verified at export time. */
export function estimateCommerceExport(job: CommerceJob) {
    const assets = job.skus.flatMap((sku) => sku.assets.filter((asset) => asset.revision === sku.activeRevision && isFinalAsset(asset)));
    const known = assets.filter((asset) => Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
    return {
        count: assets.length,
        unknownCount: assets.length - known.length,
        sourceBytes: known.reduce((total, asset) => total + asset.bytes, 0),
        // This is a guaranteed ceiling for successful delivery, not a codec prediction.
        deliveredCeilingBytes: assets.length * job.generationConfig.outputSpec.maxBytes,
    };
}

export async function exportCommerceJob(job: CommerceJob, pack?: PolicyPack, brand?: BrandProfile, options?: { maxBytes?: number; compressionFormat?: ExportImageFormat; compressionQuality?: ExportImageQuality }) {
    const maxBytes = options?.maxBytes ?? job.generationConfig.outputSpec.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("导出图片大小上限必须是正整数字节数");
    const blocked = job.skus.filter((sku) => !canExportSku(sku));
    if (blocked.length) throw new Error("以下 SKU 尚未通过硬规则检查：" + blocked.map((sku) => sku.product.sku).join("、"));
    for (const sku of job.skus) {
        await assertConsistencyCurrent(job, sku);
        const checks = retainManualDecisions([...runDeterministicChecks(job, sku, pack, brand), ...await runAssetContentChecks(sku)], job, sku, pack);
        if (checks.some((check) => check.ruleId !== "system-file-size" && check.severity === "BLOCK" && check.status !== "pass" && !check.reviewedAsFalsePositive)) throw new Error(sku.product.sku + " 在导出复检中发现硬规则问题，请重新运行合规检查");
    }
    const files: Array<{ name: string; data: BlobPart }> = [];
    const manifest: string[][] = [["SKU", "站点", "国家/语言", "图片类型", "需求方案", "变体", "序号", "文件名", "宽度", "高度", "字节数", "规则版本"]];
    for (const sku of job.skus) {
        const assets = sku.assets.filter((asset) => asset.revision === sku.activeRevision && isFinalAsset(asset));
        if (sku.consistency) files.push({ name: safe(job.name) + "/" + safe(sku.product.sku) + "/consistency-evidence.json", data: JSON.stringify({ version: 1, activeRevision: sku.activeRevision, constraints: sku.consistency.constraints, reports: sku.consistency.reports, requests: assets.map(asset => ({ assetId: asset.id, request: asset.consistencyRequest })), boundary: "人工标注的平面几何检查；合成资料不证明实物尺寸精度或模型保真度。" }, null, 2) });
        for (const asset of assets) {
            const original = asset.storageKey ? await getImageBlob(asset.storageKey) : await fetch(asset.url).then((response) => { if (!response.ok) throw new Error("图片读取失败"); return response.blob(); });
            if (!original) throw new Error(asset.title + " 的本地图片文件已丢失");
            const composition = sku.compositions.find(c => c.id === asset.compositionId && c.revision === sku.activeRevision);
            if (composition?.layoutVersion === 2) {
                const validation = await inspectCompositionLayout(composition);
                if (validation.errors.length) throw new Error(asset.title + " 排版需修正：" + validation.errors.join("；"));
                if (asset.layoutDigest !== await compositionDigest(composition) || asset.rasterDigest !== await bytesDigest(await original.arrayBuffer())) throw new Error(asset.title + " 的布局与保存成图不一致，请重新保存排版后审核");
            }
            let blob: Blob;
            try { blob = await fitExportImage(original, maxBytes, options?.compressionFormat, options?.compressionQuality); }
            catch (error) { throw new Error(`${sku.product.sku} / ${asset.title}：${error instanceof Error ? error.message : error}`); }
            if (asset.consistencyRequest && blob !== original && await bytesDigest(await blob.arrayBuffer()) !== await bytesDigest(await original.arrayBuffer())) throw new Error(asset.title + " 的导出压缩会改变已复核图片；请使用原图可容纳的大小上限，或生成符合体积限制的新图后重新复核");
            const mime = blob.type || asset.mimeType;
            const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
            const fileName = exportName(asset, ext);
            const destination = asset.stage === "marketing" ? asset.locale : asset.siteLocale || "shared-gallery";
            const path = safe(job.name) + "/" + safe(sku.product.sku) + "/" + destination + "/" + fileName;
            files.push({ name: path, data: blob });
            manifest.push([sku.product.sku, asset.siteLocale || "shared", asset.locale || "gallery", asset.stage, asset.requirementId || asset.templateId || "", asset.variantKey || "", String(asset.sequence), fileName, String(asset.width), String(asset.height), String(blob.size), String(job.policyVersion || "")]);
        }
        if (job.generationConfig.delivery === "editableCanvas") {
            const compositions = sku.compositions.filter((item) => item.revision === sku.activeRevision);
            const projectRoot = safe(job.name) + "/" + safe(sku.product.sku) + "/editable-project/";
            files.push({ name: projectRoot + "composition.json", data: JSON.stringify({ schemaVersion: 1, sku: sku.product.sku, activeRevision: sku.activeRevision, outputSpec: job.generationConfig.outputSpec, compositions }, null, 2) });
            files.push({ name: projectRoot + "canvas-project.json", data: JSON.stringify({ schemaVersion: 1, jobId: job.id, skuId: sku.id, canvasProjectId: sku.canvasProjectId, generationConfig: job.generationConfig, requirementSelections: sku.requirementSelections, compositions }, null, 2) });
            for (const composition of compositions) for (const layer of composition.layers) {
                const layerBlob = await renderCompositionLayerPng(composition, layer);
                files.push({ name: projectRoot + safe(composition.requirementId) + "-" + safe(composition.locale || "zh-CN") + "-" + safe(composition.id) + "/layers/" + String(layer.zIndex).padStart(3, "0") + "-" + safe(layer.name) + ".png", data: layerBlob });
            }
        }
    }
    const root = safe(job.name) + "/";
    files.push({ name: root + "export-info.txt", data: `成品单张上限：${maxBytes} 字节（${(maxBytes / 1024 / 1024).toFixed(2)} MiB）。超限图片使用 ${options?.compressionFormat || "jpeg"} 压缩，质量偏好 ${options?.compressionQuality || "high"}（超限时自动逐档降低）；保留像素尺寸；JPEG 透明区域合成为白色。实际大小及格式见 manifest.csv。历史原图不变。editable-project 为编辑源文件，不属于平台上传成品，其图层不适用此大小限制。` });
    files.push({ name: root + "manifest.csv", data: "\uFEFF" + manifest.map((row) => row.map(csv).join(",")).join("\r\n") });
    files.push({ name: root + "compliance-report.json", data: JSON.stringify({ schemaVersion: job.visualPipelineVersion === 3 ? 3 : 2, visualPipelineVersion: job.visualPipelineVersion || 1, jobId: job.id, jobName: job.name, platform: job.platform, locales: job.locales, generationConfig: job.generationConfig, policyPackId: job.policyPackId, policyVersion: job.policyVersion, watermarkOpacityRange: pack?.watermarkOpacityRange, exportedAt: new Date().toISOString(), skus: job.skus.map((sku) => ({ sku: sku.product.sku, productFacts: sku.product.verifiedFacts, productInformation: { name: sku.product.name, audience: sku.product.audience, sellingPoints: sku.product.description, material: sku.product.materialDescription, usage: sku.product.usageInstructions, categoryPath: sku.product.categoryPath }, requirementSelections: sku.requirementSelections, expectedAssetCount: expectedAssetCount(job, sku, pack?.requirementPresets || []), actualAssetCount: sku.assets.filter((asset) => asset.revision === sku.activeRevision && isFinalAsset(asset)).length, visualSources: sku.assets.filter((asset) => asset.revision === sku.activeRevision).map((asset) => ({ id: asset.id, stage: asset.stage, requirementId: asset.requirementId, visualKey: asset.visualKey, sourceAssetIds: asset.sourceAssetIds, comparisonRole: asset.comparisonRole, comparisonGroupKey: asset.comparisonGroupKey })), selectedTemplateIds: sku.selectedTemplateIds, approvals: sku.approvals, checks: sku.checks })) }, null, 2) });
    // Recheck after asynchronous file/render work so a concurrent change cannot export stale evidence.
    for (const sku of job.skus) if (sku.consistency) await assertConsistencyCurrent(job, sku);
    return createZip(files);
}

function safe(value: string) { return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-").slice(0, 80) || "commerce-job"; }
function csv(value: string) { return '"' + value.replace(/"/g, '""') + '"'; }
