import { consistencyBlockReason } from "./consistency-state";
import { nanoid } from "nanoid";

import { comparisonCompositionErrors } from "@/lib/commerce/comparison-composition";
import { expectedAssetCount, expectedStageCounts, GENERATION_ASSET_STAGES, requirementOutputCount, requirementVariantValues, selectedRequirementPresets } from "@/lib/commerce/generation-config";
import { assertVisualsReady, isFinalAsset, matchVisualSources, requirementLocales, visualPreflightErrors, visualSiteLocales } from "@/lib/commerce/visual-plan";
import type { BrandProfile, CommerceJob, CommerceLocale, CommerceRequirementPreset, CommerceSku, GeneratedAsset, PolicyCheckResult, PolicyPack, PolicyRule } from "@/types/commerce";

const placeholders = /(?:X{2,}|x{2,}|待填写|待确认|TODO)/;

export function activeRules(pack: PolicyPack | undefined, job: CommerceJob, sku: CommerceSku, asset?: GeneratedAsset) {
    if (!pack) return [];
    const locale = asset?.locale || asset?.siteLocale;
    const profile = pack.profiles.find((item) => item.locale === locale);
    return pack.rules.filter((rule) => {
        if (rule.platforms.length && !rule.platforms.includes(job.platform)) return false;
        if (rule.categories.length && !rule.categories.includes(sku.product.category)) return false;
        if (rule.locales.length && !(locale ? rule.locales.includes(locale) : job.locales.some((selected) => rule.locales.includes(selected)))) return false;
        if (rule.countries.length) {
            const countries = profile ? [profile.countryCode] : pack.profiles.filter((item) => job.locales.includes(item.locale)).map((item) => item.countryCode);
            if (!rule.countries.some((country) => countries.includes(country))) return false;
        }
        if (rule.assetStages.length && (!asset || !rule.assetStages.includes(asset.stage))) return false;
        return true;
    }).sort((a, b) => b.priority - a.priority || severityRank(b.severity) - severityRank(a.severity));
}

export function promptGuidance(pack: PolicyPack | undefined, job: CommerceJob, sku: CommerceSku, locale?: CommerceLocale) {
    if (!pack) return "";
    const profiles = pack.profiles.filter((item) => locale ? item.locale === locale : job.locales.includes(item.locale));
    const creative = job.visualPipelineVersion === 3;
    const guideRules = pack.rules.filter((rule) => (rule.phase === "prompt" || creative && rule.severity === "BLOCK" && rule.checker === "vision") && !(creative && rule.severity === "GUIDE" && /人物|模特|受众/.test(rule.title)) && (!rule.categories.length || rule.categories.includes(sku.product.category)) && (!rule.platforms.length || rule.platforms.includes(job.platform)) && (!rule.locales.length || rule.locales.some((value) => locale ? value === locale : job.locales.includes(value))) && (!rule.countries.length || profiles.some((profile) => rule.countries.includes(profile.countryCode))));
    return [
        !locale && profiles.length > 1 ? "共享画面须满足以下所有目标市场的禁忌；审美冲突时采用中性布景，不得忽略任何站点禁忌。" : "",
        ...(creative && !locale ? ["共享站点采用中性布景；不根据国家自动指定人物面孔、族裔或宗教身份。"] : profiles.map((profile) => "目标市场视觉（" + profile.locale + "）：" + [profile.visualKeywords, profile.mainImageStyle, "推荐环境色 " + profile.preferredColors.join("、"), "避免 " + profile.avoidedColors.join("、"), creative ? "人物由拍摄设置决定，不自动推断族裔或宗教身份。" : profile.modelPreference].filter(Boolean).join("；"))),
        ...guideRules.map((rule) => rule.description),
    ].filter(Boolean).join("\n");
}

export function runDeterministicChecks(job: CommerceJob, sku: CommerceSku, pack: PolicyPack | undefined, brand: BrandProfile | undefined): PolicyCheckResult[] {
    const checks: PolicyCheckResult[] = [];
    const add = (ruleId: string, severity: PolicyCheckResult["severity"], status: PolicyCheckResult["status"], message: string, assetId?: string) => checks.push({ id: nanoid(), ruleId, severity, status, message, assetId, checkedAt: new Date().toISOString() });
    const consistencyReason = consistencyBlockReason(job, sku);
    if (consistencyReason) add("system-consistency", "BLOCK", "violation", consistencyReason);
    const assets = sku.assets.filter((asset) => asset.revision === sku.activeRevision && isFinalAsset(asset));
    const presets = pack?.requirementPresets || [];
    if ((job.visualPipelineVersion || 1) >= 2) {
        try { assertVisualsReady(job, sku, presets); } catch (error) { add("system-visual-ready", "BLOCK", "violation", error instanceof Error ? error.message : String(error)); }
        for (const message of marketingLineageErrors(job, sku, presets, "marketing")) add("system-visual-lineage", "BLOCK", "violation", message);
        if (!sku.approvals.some((approval) => approval.gate === "content" && approval.approved && approval.assetRevision === sku.activeRevision) && assets.some((asset) => asset.stage !== "main-white")) add("system-content-approval", "BLOCK", "violation", "请逐项确认画面满足需求、商品一致且没有虚构对比后批准内容");
    }
    const expectedTotal = expectedAssetCount(job, sku, presets);
    if (assets.length !== expectedTotal) add("system-asset-count", "BLOCK", "violation", "当前生成方案应有 " + expectedTotal + " 张成图，实际为 " + assets.length + " 张");
    const expected = expectedStageCounts(job, sku, presets);
    const actual = Object.fromEntries(Object.keys(expected).map((stage) => [stage, assets.filter((asset) => asset.stage === stage).length]));
    const mismatches = Object.entries(expected).filter(([stage, count]) => actual[stage] !== count).map(([stage, count]) => stage + " 应为 " + count + " 张，实际 " + actual[stage] + " 张");
    if (mismatches.length) add("system-stage-count", "BLOCK", "violation", "成图结构与生成方案不一致：" + mismatches.join("；"));
    if (job.generationConfig.marketingEnabled) {
        for (const { selection, preset } of selectedRequirementPresets(job, sku, presets).filter((item) => item.preset.stage === "marketing")) {
            const perLocale = selection.count * requirementVariantValues(sku, selection).length;
            for (const locale of requirementLocales(job, selection)) if (assets.filter((asset) => asset.stage === "marketing" && asset.locale === locale && asset.requirementId === preset.id).length !== perLocale) add("system-marketing-matrix", "BLOCK", "violation", locale + " 的“" + preset.title + "”应有 " + perLocale + " 张营销图");
        }
    }
    for (const asset of assets) {
        const spec = job.generationConfig.outputSpec;
        const custom = asset.stage === "marketing" ? sku.compositions.find(c => c.id === asset.compositionId && c.revision === sku.activeRevision && c.layoutVersion === 2) : undefined;
        const width = custom?.width ?? spec.size, height = custom?.height ?? spec.size;
        if (asset.width !== width || asset.height !== height) add("system-dimensions", "BLOCK", "violation", asset.title + " 应为 " + width + "×" + height, asset.id);
        if (asset.bytes > spec.maxBytes) add("system-file-size", "BLOCK", "violation", asset.title + " 超过 " + Math.round(spec.maxBytes / 1024 / 1024) + "MB", asset.id);
        if (asset.mimeType !== (spec.format === "png" ? "image/png" : "image/jpeg")) add("system-file-type", "BLOCK", "violation", asset.title + " 格式与输出设置不一致", asset.id);
        if (asset.stage === "marketing") {
            const copy = asset.templateId && asset.locale ? sku.localizedCopy[asset.locale]?.[asset.templateId] || "" : "";
            if (!copy || placeholders.test(copy)) add("system-placeholder", "BLOCK", "violation", asset.title + " 仍有未确认文案或占位符", asset.id);
            for (const word of brand?.bannedWords || []) if (word && copy.toLowerCase().includes(word.toLowerCase())) add("brand-banned-word", "BLOCK", "violation", asset.title + " 包含品牌禁用词：“" + word + "”", asset.id);
            if (asset.locale === "th-TH" && !brand?.thaiFont) add("thai-font", "BLOCK", "violation", "泰语营销图缺少 KodchiangUPC 字体文件", asset.id);
        }
    }
    const [watermarkMin, watermarkMax] = pack?.watermarkOpacityRange || [0.03, 0.3];
    const opacity = job.generationConfig.overlay.watermark.opacity;
    if (job.generationConfig.overlay.watermark.mode !== "off" && (opacity < watermarkMin || opacity > watermarkMax)) add("brand-watermark-opacity", "BLOCK", "violation", "水印透明度必须在 " + Math.round(watermarkMin * 100) + "%–" + Math.round(watermarkMax * 100) + "% 之间");
    const seen = new Map<string, GeneratedAsset>();
    for (const asset of assets) {
        const key = asset.storageKey || asset.url;
        if (seen.has(key)) add("system-duplicate", "BLOCK", "violation", asset.title + " 与 " + seen.get(key)!.title + " 完全重复", asset.id);
        else seen.set(key, asset);
    }
    for (const rule of pack?.rules.filter((rule) => rule.checker === "manual" && rule.severity !== "GUIDE") || []) {
        const applicableAssets = assets.filter((asset) => activeRules(pack, job, sku, asset).some((item) => item.id === rule.id));
        if (!applicableAssets.length) continue;
        add(rule.id, rule.severity, "uncertain", rule.title + " 需要人工确认");
        checks[checks.length - 1].evidence = JSON.stringify({ revision: sku.activeRevision, rule, assetIds: applicableAssets.map((asset) => asset.id).sort() });
    }
    if (!checks.length) add("system-complete", "GUIDE", "pass", "文件、数量、文案与品牌确定性检查已通过");
    return checks;
}

/** Rechecks must retain explicit decisions for unchanged manual evidence, not technical failures. */
export function retainManualDecisions(checks: PolicyCheckResult[], job: CommerceJob, sku: CommerceSku, pack?: PolicyPack): PolicyCheckResult[] {
    return checks.map((check) => {
        const rule = pack?.rules.find((item) => item.id === check.ruleId);
        if (rule?.checker !== "manual" || check.status !== "uncertain") return check;
        const reviewed = sku.checks.some((previous) => previous.ruleId === check.ruleId && previous.severity === check.severity && previous.status === "uncertain" && previous.message === check.message && previous.assetId === check.assetId && previous.reviewedAsFalsePositive && (previous.evidence === check.evidence || (!job.visualPipelineVersion && previous.evidence === undefined)));
        return reviewed ? { ...check, reviewedAsFalsePositive: true } : check;
    });
}

export async function runAssetContentChecks(sku: CommerceSku): Promise<PolicyCheckResult[]> {
    const { getImageBlob } = await import("@/services/image-storage");
    const checks: PolicyCheckResult[] = [];
    const assets = sku.assets.filter((asset) => asset.revision === sku.activeRevision && asset.stage !== "marketing-preview");
    const signatures: Array<{ asset: GeneratedAsset; exact: string; perceptual?: string }> = [];
    for (const asset of assets) {
        try {
            const blob = asset.storageKey ? await getImageBlob(asset.storageKey) : await fetch(asset.url).then((response) => response.ok ? response.blob() : Promise.reject(new Error("HTTP " + response.status)));
            if (!blob) throw new Error("本地图片文件不存在");
            const exact = await digestBlob(blob);
            const duplicate = signatures.find((item) => item.exact === exact);
            if (duplicate) {
                checks.push({ id: nanoid(), ruleId: "system-duplicate-content", severity: "BLOCK", status: "violation", message: asset.title + " 与 " + duplicate.asset.title + " 的图片内容完全重复", assetId: asset.id, checkedAt: new Date().toISOString() });
                continue;
            }
            const perceptual = await averageHash(blob).catch(() => undefined);
            const similar = perceptual ? signatures.find((item) => item.perceptual && hammingDistance(item.perceptual, perceptual) <= 4) : undefined;
            if (similar) checks.push({ id: nanoid(), ruleId: "system-similar-content", severity: "WARN", status: "violation", message: asset.title + " 与 " + similar.asset.title + " 的画面高度相似，请确认是否需要保留", assetId: asset.id, checkedAt: new Date().toISOString() });
            signatures.push({ asset, exact, perceptual });
        } catch (error) {
            checks.push({ id: nanoid(), ruleId: "system-file-read", severity: "BLOCK", status: "uncertain", message: asset.title + " 无法读取本地图片文件", evidence: error instanceof Error ? error.message : String(error), assetId: asset.id, checkedAt: new Date().toISOString() });
        }
    }
    return checks;
}

export function canExportSku(sku: CommerceSku) {
    if (consistencyBlockReason(undefined, sku)) return false;
    return sku.stage === "ready" && !sku.checks.some((check) => check.severity === "BLOCK" && check.status !== "pass" && !check.reviewedAsFalsePositive);
}

export function canApproveWhite(sku: CommerceSku) {
    if (consistencyBlockReason(undefined, sku, "white")) return false;
    return sku.assets.some((asset) => asset.stage === "main-white" && asset.revision === sku.activeRevision);
}

export function canApproveContent(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[]) {
    if (consistencyBlockReason(job, sku, "content")) return false;
    if ((job.visualPipelineVersion || 1) >= 2) {
        try { assertVisualsReady(job, sku, presets); } catch { return false; }
        if (visualPreflightErrors(job, sku, presets).length) return false;
        const selected = selectedRequirementPresets(job, sku, presets).filter(({ preset }) => preset.stage !== "marketing" || job.generationConfig.marketingEnabled);
        if (selected.some(({ selection, preset }) => preset.needsReview && !selection.reviewed)) return false;
        if (!job.generationConfig.marketingEnabled) return true;
        const marketing = selected.filter(({ preset }) => preset.stage === "marketing");
        if (!marketing.length || marketingLineageErrors(job, sku, presets, "marketing-preview").length) return false;
        return marketing.every(({ preset }) => Boolean(sku.copyZh[preset.id]?.trim()) && !placeholders.test(sku.copyZh[preset.id]));
    }
    const selected = selectedRequirementPresets(job, sku, presets);
    const scenes = sku.assets.filter((asset) => GENERATION_ASSET_STAGES.includes(asset.stage as typeof GENERATION_ASSET_STAGES[number]) && asset.revision === sku.activeRevision);
    const previews = sku.assets.filter((asset) => asset.stage === "marketing-preview" && asset.revision === sku.activeRevision);
    const contentRequirements = selected.filter((item) => item.preset.stage !== "marketing");
    const expectedScenes = contentRequirements.length ? contentRequirements.reduce((sum, item) => sum + requirementOutputCount(job, sku, item.selection, item.preset), 0) : GENERATION_ASSET_STAGES.reduce((sum, stage) => sum + job.generationConfig.assetCounts[stage], 0);
    if (scenes.length !== expectedScenes) return false;
    if (contentRequirements.length && contentRequirements.some(({ selection, preset }) => scenes.filter((asset) => asset.requirementId === preset.id).length !== requirementOutputCount(job, sku, selection, preset))) return false;
    if (!contentRequirements.length && GENERATION_ASSET_STAGES.some((stage) => scenes.filter((asset) => asset.stage === stage).length !== job.generationConfig.assetCounts[stage])) return false;
    if (!job.generationConfig.marketingEnabled) return true;
    const marketing = selected.filter((item) => item.preset.stage === "marketing");
    if (!marketing.length || previews.length !== marketing.reduce((sum, item) => sum + item.selection.count * requirementVariantValues(sku, item.selection).length, 0)) return false;
    if (!sku.selectedTemplateIds.every((id) => previews.some((asset) => asset.templateId === id && asset.prompt === sku.copyZh[id]))) return false;
    const required = marketing.flatMap((item) => item.preset.requiredFacts);
    const copiesReady = marketing.every(({ selection, preset }) => Boolean(sku.copyZh[preset.id]?.trim()) && !placeholders.test(sku.copyZh[preset.id]) && (!preset.needsReview || selection.reviewed));
    return required.every((key) => Boolean(sku.product.verifiedFacts[key]) && !placeholders.test(sku.product.verifiedFacts[key])) && (!required.length || sku.product.factsConfirmed) && copiesReady;
}

/** Count alone cannot prove that a preview was rendered from its own requirement's visual. */
export function marketingLineageErrors(job: CommerceJob, sku: CommerceSku, presets: CommerceRequirementPreset[], stage: "marketing" | "marketing-preview"): string[] {
    if (!job.generationConfig.marketingEnabled) return [];
    const errors: string[] = [];
    const outputs = sku.assets.filter((asset) => asset.revision === sku.activeRevision && asset.stage === stage);
    const selected = selectedRequirementPresets(job, sku, presets).filter(({ preset }) => preset.stage === "marketing");
    let expected = 0;
    for (const { preset, selection } of selected) {
        const sites = stage === "marketing" ? requirementLocales(job, selection) : visualSiteLocales(job, selection);
        for (const site of sites) for (const variant of requirementVariantValues(sku, selection)) for (let sequence = 1; sequence <= selection.count; sequence += 1) {
            expected += 1;
            const matches = outputs.filter((asset) => asset.requirementId === preset.id && asset.sequence === sequence && (asset.variantKey || "") === variant && (stage === "marketing" ? asset.locale === site : asset.siteLocale === site));
            if (matches.length !== 1) { errors.push(preset.title + "：缺少或重复的" + (stage === "marketing" ? "营销成图" : "中文预览")); continue; }
            try {
                const sources = matchVisualSources(job, sku, preset, selection, sequence, variant, site);
                const output = matches[0];
                if (output.sourceAssetIds?.length !== sources.length || sources.some((source, index) => output.sourceAssetIds?.[index] !== source.id)) errors.push(preset.title + "：成图没有绑定正确的需求画面");
                if (sources.length === 2) {
                    const composition = sku.compositions.find((item) => item.id === output.compositionId && item.revision === sku.activeRevision);
                    errors.push(...comparisonCompositionErrors(composition, sources).map((message) => preset.title + "：" + message));
                }
                const copy = stage === "marketing" && output.locale ? sku.localizedCopy[output.locale]?.[preset.id] : sku.copyZh[preset.id];
                if (!copy || output.prompt !== copy) errors.push(preset.title + "：文案已变更，需要重新渲染");
            } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        }
    }
    if (outputs.length !== expected) errors.push("营销成图/预览数量与需求矩阵不一致");
    return [...new Set(errors)];
}

export function visionRules(pack: PolicyPack | undefined, job: CommerceJob, sku: CommerceSku, asset: GeneratedAsset): PolicyRule[] {
    return activeRules(pack, job, sku, asset).filter((rule) => rule.checker === "vision" && rule.phase === "post-render");
}

function severityRank(value: PolicyCheckResult["severity"]) { return value === "BLOCK" ? 3 : value === "WARN" ? 2 : 1; }
async function digestBlob(blob: Blob) { const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()); return Array.from(new Uint8Array(bytes)).map((value) => value.toString(16).padStart(2, "0")).join(""); }
async function averageHash(blob: Blob) { const bitmap = await createImageBitmap(blob); try { const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8; const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("无法创建相似度画布"); context.drawImage(bitmap, 0, 0, 8, 8); const pixels = context.getImageData(0, 0, 8, 8).data; const values = Array.from({ length: 64 }, (_, index) => (pixels[index * 4] * 299 + pixels[index * 4 + 1] * 587 + pixels[index * 4 + 2] * 114) / 1000); const average = values.reduce((sum, value) => sum + value, 0) / values.length; return values.map((value) => value >= average ? "1" : "0").join(""); } finally { bitmap.close(); } }
function hammingDistance(left: string, right: string) { let distance = 0; for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] !== right[index]) distance += 1; return distance + Math.abs(left.length - right.length); }
