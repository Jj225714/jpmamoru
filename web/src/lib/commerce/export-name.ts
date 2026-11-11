import type { GeneratedAsset } from "@/types/commerce";

export function exportName(asset: Pick<GeneratedAsset, "stage" | "templateId" | "requirementId" | "siteLocale" | "variantKey" | "sequence">, ext: string) {
    if (asset.stage === "main-white") return "01-main-white." + ext;
    const prefix = asset.stage === "scene" ? "02-scene" : asset.stage === "detail" ? "03-detail" : asset.stage === "usage-size" ? "04-usage-size" : asset.stage === "detail-white" ? "05-detail-white" : "marketing-" + safe(asset.requirementId || asset.templateId || "image");
    const qualifiers = [asset.stage === "marketing" ? "" : asset.requirementId ? safe(asset.requirementId) : "", asset.siteLocale ? safe(asset.siteLocale) : "", asset.variantKey ? safe(asset.variantKey) : ""].filter(Boolean);
    return [prefix, ...qualifiers, String(asset.sequence || 1).padStart(2, "0")].join("-") + "." + ext;
}

function safe(value: string) { return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-").slice(0, 80) || "commerce-job"; }
