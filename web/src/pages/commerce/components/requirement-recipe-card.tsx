import { Checkbox, Collapse, Input, InputNumber, Select, Tag } from "antd";
import { CreativeBriefFields } from "./creative-brief-fields";
import { requirementOutputCount, requirementVariantValues } from "@/lib/commerce/generation-config";
import { visualSiteLocales } from "@/lib/commerce/visual-plan";
import { DETAIL_PURPOSE_LABELS, usesDetailSources } from "@/lib/commerce/detail-sources";
import type { CommerceJob, CommerceRecipeRole, CommerceRequirementPreset, CommerceSku, RequirementSelection } from "@/types/commerce";
const DETAIL_PURPOSES = Object.entries(DETAIL_PURPOSE_LABELS).map(([value, label]) => ({ value, label }));

const GOALS: Record<CommerceRecipeRole, string> = {
    hero: "清楚展示商品主体与使用场景",
    detail: "展示真实材质与细节",
    usage: "说明正常使用方式",
    "selling-point": "突出有依据的产品卖点",
    "secondary-scene": "补充另一种使用场景",
    interaction: "通过成人互动展示使用方式",
    lighting: "展示不同光线下的商品",
    "before-after": "将使用前后画面并排展示",
};
export function RequirementRecipeCard({
    requirement,
    selection,
    job,
    sku,
    onChange,
}: {
    requirement: CommerceRequirementPreset;
    selection: RequirementSelection;
    job: CommerceJob;
    sku: CommerceSku;
    onChange: (patch: Partial<RequirementSelection>) => void;
}) {
    const paired = requirement.generationStrategy === "paired-before-after";
    const detail = usesDetailSources(sku, requirement, selection);
    const sites = visualSiteLocales(job, selection).length;
    const variants = requirementVariantValues(sku, selection).length;
    const bases = selection.enabled && (requirement.stage !== "marketing" || job.generationConfig.marketingEnabled) ? selection.count * sites * variants : 0;
    return (
        <div className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="flex flex-wrap items-center gap-3">
                <Checkbox checked={selection.enabled} onChange={(event) => onChange({ enabled: event.target.checked })}>
                    {requirement.title}
                </Checkbox>
                <InputNumber
                    aria-label={requirement.title + "数量"}
                    min={0}
                    max={detail && selection.detailRenderMode === "original" ? 1 : 4}
                    precision={0}
                    value={selection.count}
                    addonAfter="张"
                    onChange={(count) => onChange({ count: Number(count || 0) })}
                />
                <Select
                    aria-label={requirement.title + "变体"}
                    value={selection.variantScope}
                    options={[
                        { value: "per-sku", label: "每 SKU" },
                        { value: "per-color", label: "每颜色" },
                        { value: "per-size", label: "每尺寸" },
                        { value: "per-site", label: "每站点" },
                        { value: "custom", label: "指定组合" },
                    ]}
                    onChange={(variantScope) => onChange({ variantScope })}
                />
            </div>
            <p className="text-sm text-stone-500">{GOALS[requirement.recipeRole!]}</p>
            <Tag>预计成品 {selection.enabled ? requirementOutputCount(job, sku, selection, requirement) : 0} 张</Tag>
            {paired ? (
                <Tag color="cyan">
                    每组底图 2 次模型调用 × 数量 {selection.count} × 站点 {sites} × 变体 {variants} = {bases * 2} 次；中间图不计入成品
                </Tag>
            ) : null}
            {selection.enabled ? (
                <>
                    {detail ? (
                        <div className="space-y-2 rounded border p-3">
                            <Select
                                aria-label="细节渲染方式"
                                value={selection.detailRenderMode || "optimize"}
                                options={[
                                    { value: "optimize", label: "实拍保真优化" },
                                    { value: "original", label: "实拍原图排版（不调用生图模型）" },
                                ]}
                                onChange={(detailRenderMode) => onChange({ detailRenderMode, ...(detailRenderMode === "original" ? { count: 1 } : {}) })}
                            />
                            <Select
                                aria-label="细节目标用途"
                                value={selection.detailPurpose || requirement.detailPurpose}
                                options={DETAIL_PURPOSES}
                                placeholder="选择真实拍摄部位"
                                onChange={(detailPurpose) => onChange({ detailPurpose, sourceImageIds: [], primaryImageId: undefined, primaryImageIds: {} })}
                            />
                            <Select
                                mode="multiple"
                                aria-label="绑定细节实拍"
                                className="w-full"
                                value={selection.sourceImageIds || []}
                                options={(sku.product.detailImages || [])
                                    .filter((image) => image.purposes.includes(selection.detailPurpose || requirement.detailPurpose!))
                                    .map((image) => ({ value: image.id, label: `${image.name} · ${image.shared ? "通用" : image.variantKey}` }))}
                                onChange={(sourceImageIds) => onChange({ sourceImageIds, primaryImageId: undefined, primaryImageIds: {} })}
                            />
                            {requirementVariantValues(sku, selection).map((variantKey) => (
                                <label className="block" key={variantKey}>
                                    变体 {variantKey || "当前商品"} 的主参考图
                                    <Select
                                        className="ml-2 min-w-48"
                                        aria-label={`${variantKey}原图主图`}
                                        value={selection.primaryImageIds?.[variantKey] || selection.primaryImageId}
                                        options={(sku.product.detailImages || [])
                                            .filter((image) => selection.sourceImageIds?.includes(image.id) && (image.shared || image.variantKey === variantKey))
                                            .map((image) => ({ value: image.id, label: image.name }))}
                                        onChange={(id) => onChange({ primaryImageIds: { ...selection.primaryImageIds, [variantKey]: id } })}
                                    />
                                </label>
                            ))}
                            <p className="text-sm text-stone-500">每个方案仅展示一个真实拍摄部位；背面或其他部位请另建方案。缺照片请补图或关闭方案。</p>
                        </div>
                    ) : null}
                    {selection.variantScope === "custom" ? <Select mode="tags" className="w-full" aria-label="指定组合" value={selection.variantValues} onChange={(variantValues) => onChange({ variantValues })} /> : null}
                    {sku.product.categoryId ? <p className="text-sm text-stone-500">类目人物设置仅作默认建议；当前选择优先。人物不得遮挡商品关键结构。</p> : <p className="text-sm text-stone-500">人物不得遮挡商品关键结构。</p>}
                    <CreativeBriefFields
                        value={selection.creativeBrief}
                        onChange={(creativeBrief) => onChange({ creativeBrief })}
                    />
                    <Collapse
                        items={[
                            {
                                key: "prompt",
                                label: "高级：编辑画面提示词",
                                children: <Input.TextArea aria-label={requirement.title + "提示词"} rows={4} value={selection.promptOverride ?? requirement.prompt} onChange={(event) => onChange({ promptOverride: event.target.value })} />,
                            },
                        ]}
                    />
                    {requirement.needsReview ? (
                        <Checkbox checked={selection.reviewed} onChange={(event) => onChange({ reviewed: event.target.checked })}>
                            中文文案、混合语言和缺失语种已人工校对
                        </Checkbox>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
