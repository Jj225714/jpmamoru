export const COMMERCE_LOCALES = ["en-US", "en-GB", "th-TH", "vi-VN", "ms-MY", "fil-PH", "id-ID"] as const;

export type CommerceLocale = (typeof COMMERCE_LOCALES)[number];
export type CommercePlatform = "shopee" | "tiktok";
export type CommerceStage = "draft" | "white-background" | "white-review" | "content-generation" | "content-review" | "localization" | "compliance" | "ready" | "failed";
export type GenerationAssetStage = "scene" | "detail" | "usage-size" | "detail-white";
export type AssetStage = "main-white" | GenerationAssetStage | "marketing-base" | "comparison-source" | "marketing-preview" | "marketing";
export type RequirementVisualMode = "generate" | "white-layout";
export type PolicySeverity = "BLOCK" | "WARN" | "GUIDE";
export type PolicyCheckStatus = "pass" | "violation" | "uncertain";
export type TemplateSlot = "scene" | "detail" | "usage-size" | "marketing";
export type LogoPlacement = "off" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type WatermarkMode = "off" | "single" | "tile";
export type WatermarkPosition = "top-left" | "top-center" | "top-right" | "center-left" | "center" | "center-right" | "bottom-left" | "bottom-center" | "bottom-right";
export type CommerceOutputSize = 800 | 1024 | 1254 | 1600;
export type CommerceOutputFormat = "jpeg" | "png";
export type CommerceDpi = 96 | 120 | 150;
export type SiteImageMode = "shared" | "per-site";
export type CommerceDeliveryMode = "flattenedOnly" | "editableCanvas";
export type OverlayApplyTo = "marketing" | "all" | "custom";
export type RequirementVariantScope = "per-sku" | "per-color" | "per-size" | "per-site" | "custom";
export type MarketingLayoutPreset = "single-hero" | "feature-grid" | "before-after" | "competitor-comparison" | "size-comparison" | "color-options" | "multi-scene" | "layer-structure" | "lighting-comparison" | "installation-methods" | "installation-steps" | "faq" | "custom-reference";

export type CommerceCreativeBrief = {
    scene?: string;
    lighting?: "natural-window" | "soft-studio" | "warm-indoor" | "side-light";
    audience?: string;
    people?: "none" | "adult-partial" | "adult-half" | "adult-full";
    framing?: "auto" | "close" | "medium" | "wide";
};
export type CommerceRecipeRole = "hero" | "detail" | "usage" | "selling-point" | "secondary-scene" | "interaction" | "lighting" | "before-after";
export type CommerceGenerationStrategy = "single" | "paired-before-after";
export type CommerceProductInformation = { name: string; audience: string; sellingPoints: string; material: string; usage: string; category: string };
export type CommerceUncertaintyResolution = { status: "confirmed" | "ignored"; factKey?: string; value?: string; resolvedAt: string };
export type CommerceProductSuggestion = {
    information: CommerceProductInformation; uncertainties: string[]; sourceFingerprint: string; createdAt: string; suggestedCategory?: string;
    uncertaintyResolutions?: Record<string, CommerceUncertaintyResolution>;
};

export type CommerceOutputSpec = { size: CommerceOutputSize; format: CommerceOutputFormat; maxBytes: number; colorSpace: "sRGB"; dpi: CommerceDpi };
export type CommerceBrandOverlayConfig = {
    logo: { placement: LogoPlacement; applyTo: OverlayApplyTo; customStages: AssetStage[] };
    watermark: { mode: WatermarkMode; position: WatermarkPosition; opacity: number; applyTo: OverlayApplyTo; customStages: AssetStage[] };
};

export type CommerceGenerationConfig = {
    assetCounts: Record<GenerationAssetStage, number>;
    marketingEnabled: boolean;
    outputSpec: CommerceOutputSpec;
    siteImageMode: SiteImageMode;
    delivery: CommerceDeliveryMode;
    overlay: CommerceBrandOverlayConfig;
    creativeBrief?: CommerceCreativeBrief;
};

export type BrandGenerationDefaults = CommerceGenerationConfig & { locales: CommerceLocale[] };

export type StoredImageRef = { id: string; name: string; url: string; storageKey?: string; source: "upload" | "url" | "zip" | "generated" | "rule-reference" };

export type DetailImagePurpose = "front-texture" | "back" | "edge" | "side" | "accessory" | "other";
export type CommerceDetailImage = StoredImageRef & { purposes: DetailImagePurpose[]; variantKey: string; shared: boolean; contentHash: string; note?: string };
export type CommerceCategoryRule = { id: string; text: string; strength: "required" | "guide"; stages: GenerationAssetStage[]; key?: "people" | "scene"; value?: string };
export type CommerceCategory = {
    id: string; parentId?: string; name: string; aliases: string[]; active: boolean; order: number;
    rules: CommerceCategoryRule[]; referenceIds: string[]; requirementIds: string[]; creativeBrief?: CommerceCreativeBrief;
    source?: { fileName: string; sheet: string; range: string; originalText: string };
};

export type ProductRecord = {
    id: string; sku: string; productType: string; name: string; brandName: string; category: string; audience: string; description: string; size: string;
    sizeImage?: StoredImageRef; images: StoredImageRef[]; imageUrls: string[]; extraFields: Record<string, string>; verifiedFacts: Record<string, string>;
    factsConfirmed: boolean; imageStatus: "ready" | "missing" | "loading";
    materialDescription?: string; usageInstructions?: string; categoryPath?: string;
    categoryId?: string; subcategoryId?: string; detailImages?: CommerceDetailImage[];
    informationSuggestion?: CommerceProductSuggestion;
};

export type GeneratedAsset = {
    consistencyRequest?: import("@/lib/commerce/consistency-types").ConsistencyRequestSnapshot;
    generation?: import("@/pages/assets/generation-info").AssetGenerationInfo;
    generationHistory?: import("@/pages/assets/generation-info").AssetGenerationInfo[];
    id: string; jobId: string; skuId: string; stage: AssetStage; locale?: CommerceLocale; templateId?: string; sequence: number; revision: number; title: string;
    requirementId?: string; compositionId?: string; siteLocale?: CommerceLocale; variantKey?: string;
    visualKey?: string; visualFingerprint?: string; sourceAssetIds?: string[]; layoutDigest?: string; rasterDigest?: string;
    comparisonRole?: "before" | "after"; comparisonGroupKey?: string;
    url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string; prompt?: string; createdAt: string;
};

export type RequirementSelection = {
    requirementId: string; enabled: boolean; count: number; promptOverride?: string; referenceIds: string[]; layout?: MarketingLayoutPreset;
    variantScope: RequirementVariantScope; variantValues: string[]; siteLocales?: CommerceLocale[]; reviewed?: boolean;
    visualMode?: RequirementVisualMode; visualKind?: GenerationAssetStage;
    creativeBrief?: CommerceCreativeBrief;
    detailPurpose?: DetailImagePurpose; sourceImageIds?: string[]; primaryImageId?: string; primaryImageIds?: Record<string, string>; detailRenderMode?: "optimize" | "original";
};

export type CompositionLayerType = "background" | "product" | "decoration" | "text" | "logo" | "watermark" | "shape" | "flattened";
export type CompositionLayer = {
    id: string; type: CompositionLayerType; name: string; x: number; y: number; width: number; height: number; zIndex: number;
    opacity: number; rotation: number; visible: boolean; locked: boolean; content?: string; storageKey?: string; mimeType?: string;
    fill?: string; fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeight?: number; letterSpacing?: number; autoFit?: boolean; minFontSize?: number; textAlign?: "left" | "center" | "right";
    textRaster?: { key: string; dataUrl: string; fontSize: number; lineHeight: number; overflow: boolean; family: string; warning?: string };
    sourceAssetId?: string; comparisonRole?: "before" | "after";
};
export type LayeredComposition = {
    id: string; jobId: string; skuId: string; assetId?: string; requirementId: string; locale?: CommerceLocale; siteLocale?: CommerceLocale; variantKey?: string;
    layoutVersion?: 2; revision: number; width: number; height: number; backgroundColor: string; layout: MarketingLayoutPreset; layers: CompositionLayer[]; createdAt: string; updatedAt: string;
};

export type MarketingLayout = { id: string; name: string; width: number; height: number; layers: Array<Pick<CompositionLayer, "type" | "name" | "x" | "y" | "width" | "height" | "fontSize" | "fontFamily" | "lineHeight" | "letterSpacing" | "textAlign" | "autoFit" | "minFontSize" | "zIndex">> };

export type ApprovalRecord = { gate: "white-background" | "content"; approved: boolean; reviewer: string; reviewedAt: string; assetRevision: number };
export type PolicyCheckResult = { id: string; ruleId: string; severity: PolicySeverity; status: PolicyCheckStatus; message: string; evidence?: string; assetId?: string; assetRevision?: number; reviewedAsFalsePositive?: boolean; checkedAt: string };

export type CommerceSku = {
    consistency?: import("@/lib/commerce/consistency-types").SkuConsistencyState;
    id: string; product: ProductRecord; stage: CommerceStage; stageMessage?: string; canvasProjectId?: string; assets: GeneratedAsset[]; selectedTemplateIds: string[];
    requirementSelections: RequirementSelection[]; compositions: LayeredComposition[]; marketingLayouts?: MarketingLayout[]; marketingLayoutReview?: { revision: number; signature: string };
    copyZh: Record<string, string>; localizedCopy: Partial<Record<CommerceLocale, Record<string, string>>>; approvals: ApprovalRecord[]; checks: PolicyCheckResult[]; activeRevision: number;
};

export type CommerceJob = {
    id: string; name: string; brandProfileId?: string; platform: CommercePlatform; locales: CommerceLocale[]; generationConfig: CommerceGenerationConfig; policyPackId?: string; policyVersion?: number;
    visualPipelineVersion?: 2 | 3;
    skus: CommerceSku[]; status: "draft" | "running" | "waiting-review" | "ready" | "failed"; createdAt: string; updatedAt: string;
};

export type FontAsset = { name: string; family: string; dataUrl: string };
export type BrandProfile = {
    id: string; name: string; logo?: StoredImageRef; primaryColor: string; secondaryColor: string; fontFamily: string; thaiFont?: FontAsset;
    terminology: Record<string, string>; bannedWords: string[]; generationDefaults: BrandGenerationDefaults;
    requirementDefaultsByCategory: Record<string, RequirementSelection[]>; createdAt: string; updatedAt: string;
};

export type ModelRoleConfig = { sceneModel: string; repairModel: string; copyModel: string; translationModel: string; complianceModel: string; removalApiUrl: string; removalApiKey: string };
export type CountryProfile = { countryCode: string; countryName: string; locale: CommerceLocale; audience: string; visualKeywords: string; mainImageStyle: string; preferredColors: string[]; avoidedColors: string[]; modelPreference: string };
export type PolicyRule = {
    id: string; title: string; description: string; severity: PolicySeverity; priority: number; countries: string[]; platforms: CommercePlatform[]; categories: string[];
    locales: CommerceLocale[]; assetStages: AssetStage[]; phase: "prompt" | "preflight" | "post-render"; checker: "metadata" | "text" | "vision" | "manual";
    source: { fileName: string; sheet: string; range: string };
};

export type TemplateReference = StoredImageRef & { sheet: string; anchor: string; kind: "reference" | "example" };
export type CategoryTemplate = {
    id: string; category: string; order: number; title: string; requirement: string; slot: TemplateSlot; chineseCopy: string;
    translationSeeds: Partial<Record<CommerceLocale, string>>; requiredVariables: string[]; referenceIds: string[];
};
export type CommerceRequirementPreset = {
    id: string; category: string; order: number; title: string; stage: GenerationAssetStage | "marketing"; enabledByDefault: boolean; defaultCount: number;
    prompt: string; layout: MarketingLayoutPreset; chineseCopy: string; translationSeeds: Partial<Record<CommerceLocale, string>>;
    requiredFacts: string[]; referenceIds: string[]; variantScope: RequirementVariantScope; needsReview: boolean;
    visualMode?: RequirementVisualMode; visualKind?: GenerationAssetStage;
    creativeBrief?: CommerceCreativeBrief; recipeRole?: CommerceRecipeRole; generationStrategy?: CommerceGenerationStrategy;
    detailPurpose?: DetailImagePurpose;
};
export type CommerceSiteReference = { id: string; product: string; locale?: CommerceLocale; url?: string; referenceIds: string[]; note?: string };
export type PolicyPack = {
    id: string; name: string; version: number; status: "draft" | "published" | "retired"; sourceFileName: string; profiles: CountryProfile[]; rules: PolicyRule[];
    templates: CategoryTemplate[]; requirementPresets: CommerceRequirementPreset[]; references: TemplateReference[]; siteReferences: CommerceSiteReference[];
    globalStandards: string[]; generationDefaults?: Partial<CommerceGenerationConfig>; watermarkOpacityRange?: [number, number]; createdAt: string; publishedAt?: string;
    diffSummary?: { rulesAdded: number; rulesChanged: number; rulesRemoved: number; severityChanged: number; templatesAdded: number; templatesChanged: number; templatesRemoved: number };
    editSummary?: string[];
    creativeLibraryVersion?: 1;
    categories?: CommerceCategory[];
};

export type OwnerProfile = { name: string; pinHash: string };
export type AuditEvent = { id: string; action: string; actor: string; jobId?: string; skuId?: string; policyPackId?: string; detail?: string; createdAt: string };
