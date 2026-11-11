import { InputNumber, Select, Switch } from "antd";
import { CreativeBriefFields } from "./creative-brief-fields";

import { GENERATION_ASSET_STAGES, GENERATION_STAGE_LABELS, LOCALE_LABELS } from "@/lib/commerce/generation-config";
import { COMMERCE_LOCALES, type AssetStage, type CommerceGenerationConfig, type CommerceLocale } from "@/types/commerce";

export function GenerationConfigFields({
    config,
    locales,
    onChange,
    onLocalesChange,
    watermarkRange = [0.03, 0.3],
}: {
    config: CommerceGenerationConfig;
    locales: CommerceLocale[];
    onChange: (config: CommerceGenerationConfig) => void;
    onLocalesChange: (locales: CommerceLocale[]) => void;
    watermarkRange?: [number, number];
}) {
    const patch = (value: Partial<CommerceGenerationConfig>) => onChange({ ...config, ...value });
    const patchOverlay = (key: "logo" | "watermark", value: Partial<CommerceGenerationConfig["overlay"][typeof key]>) =>
        onChange({ ...config, overlay: { ...config.overlay, [key]: { ...config.overlay[key], ...value } } as CommerceGenerationConfig["overlay"] });
    return (
        <div className="space-y-5">
            <div>
                <div className="mb-2 text-sm font-medium">默认拍摄要求</div>
                <CreativeBriefFields value={config.creativeBrief} onChange={(creativeBrief) => patch({ creativeBrief })} />
                <p className="mt-2 text-xs text-stone-500">未设置的项自动继承商品与方案要求；每个配方可单独调整。</p>
            </div>
            <div>
                <div className="mb-2 text-sm font-medium">目标语言（至少 1 种）</div>
                <Select mode="multiple" className="w-full" value={locales} options={COMMERCE_LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] }))} onChange={onLocalesChange} />
            </div>
            <div>
                <div className="mb-2 text-sm font-medium">兼容图片数量</div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                    <Field label="白底主图">
                        <InputNumber className="w-full" value={1} disabled />
                    </Field>
                    {GENERATION_ASSET_STAGES.map((stage) => (
                        <Field key={stage} label={GENERATION_STAGE_LABELS[stage]}>
                            <InputNumber className="w-full" min={0} max={4} precision={0} value={config.assetCounts[stage]} onChange={(value) => patch({ assetCounts: { ...config.assetCounts, [stage]: Number(value || 0) } })} />
                        </Field>
                    ))}
                </div>
                <div className="mt-2 text-xs text-stone-500">Excel 类目方案启用后，以每个 SKU 的方案选择为准；这里的数量继续用于旧任务和通用兼容方案。</div>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
                <Field label="输出尺寸">
                    <Select className="w-full" value={config.outputSpec.size} options={[800, 1024, 1254, 1600].map((value) => ({ value, label: `${value} × ${value}` }))} onChange={(size) => patch({ outputSpec: { ...config.outputSpec, size } })} />
                </Field>
                <Field label="文件格式">
                    <Select
                        className="w-full"
                        value={config.outputSpec.format}
                        options={[
                            { value: "jpeg", label: "JPG" },
                            { value: "png", label: "PNG" },
                        ]}
                        onChange={(format) => patch({ outputSpec: { ...config.outputSpec, format } })}
                    />
                </Field>
                <Field label="DPI">
                    <Select className="w-full" value={config.outputSpec.dpi} options={[96, 120, 150].map((value) => ({ value, label: `${value} DPI` }))} onChange={(dpi) => patch({ outputSpec: { ...config.outputSpec, dpi } })} />
                </Field>
                <Field label="单张最大文件体积">
                    <InputNumber
                        className="w-full"
                        aria-label="单张最大文件体积（MiB）"
                        min={0.25}
                        max={20}
                        precision={2}
                        step={0.25}
                        addonAfter="MiB"
                        value={config.outputSpec.maxBytes / 1024 / 1024}
                        onChange={(value) => {
                            if (value !== null && Number.isFinite(value) && value >= 0.25 && value <= 20)
                                patch({ outputSpec: { ...config.outputSpec, maxBytes: Math.round(value * 1024 * 1024) } });
                        }}
                    />
                    <span className="text-xs text-stone-500">1 MiB = 1,048,576 字节</span>
                </Field>
                <Field label="站点图片方式">
                    <Select
                        className="w-full"
                        value={config.siteImageMode}
                        options={[
                            { value: "shared", label: "各站点共享无文字图" },
                            { value: "per-site", label: "按站点分别生成" },
                        ]}
                        onChange={(siteImageMode) => patch({ siteImageMode })}
                    />
                </Field>
                <Field label="交付方式">
                    <Select
                        className="w-full"
                        value={config.delivery}
                        options={[
                            { value: "flattenedOnly", label: "仅成品图" },
                            { value: "editableCanvas", label: "成品图 + 可编辑分层画布" },
                        ]}
                        onChange={(delivery) => patch({ delivery })}
                    />
                </Field>
            </div>
            <label className="flex items-center justify-between rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <span>
                    <span className="block text-sm font-medium">生成营销图</span>
                    <span className="mt-1 block text-xs text-stone-500">关闭后跳过文案、翻译和营销排版</span>
                </span>
                <Switch checked={config.marketingEnabled} onChange={(marketingEnabled) => patch({ marketingEnabled })} />
            </label>
            <div className="grid gap-4 md:grid-cols-3">
                <Field label="Logo 位置">
                    <Select className="w-full" value={config.overlay.logo.placement} onChange={(placement) => patchOverlay("logo", { placement })} options={LOGO_POSITIONS} />
                </Field>
                <Field label="Logo 应用范围">
                    <Select className="w-full" value={config.overlay.logo.applyTo} onChange={(applyTo) => patchOverlay("logo", { applyTo })} options={APPLY_OPTIONS} />
                </Field>
                {config.overlay.logo.applyTo === "custom" ? (
                    <Field label="Logo 图片类型">
                        <Select mode="multiple" className="w-full" value={config.overlay.logo.customStages} options={STAGE_OPTIONS} onChange={(customStages: AssetStage[]) => patchOverlay("logo", { customStages })} />
                    </Field>
                ) : (
                    <div />
                )}
                <Field label="水印方式">
                    <Select
                        className="w-full"
                        value={config.overlay.watermark.mode}
                        onChange={(mode) => patchOverlay("watermark", { mode })}
                        options={[
                            { value: "off", label: "关闭" },
                            { value: "single", label: "单枚水印" },
                            { value: "tile", label: "全图平铺" },
                        ]}
                    />
                </Field>
                {config.overlay.watermark.mode === "single" ? (
                    <Field label="单枚水印位置">
                        <Select className="w-full" value={config.overlay.watermark.position} onChange={(position) => patchOverlay("watermark", { position })} options={WATERMARK_POSITIONS} />
                    </Field>
                ) : (
                    <div />
                )}
                {config.overlay.watermark.mode !== "off" ? (
                    <Field label="水印透明度">
                        <InputNumber
                            className="w-full"
                            min={Math.round(watermarkRange[0] * 100)}
                            max={Math.round(watermarkRange[1] * 100)}
                            precision={0}
                            value={Math.round(config.overlay.watermark.opacity * 100)}
                            addonAfter="%"
                            onChange={(value) => patchOverlay("watermark", { opacity: Number(value || 5) / 100 })}
                        />
                    </Field>
                ) : null}
                {config.overlay.watermark.mode !== "off" ? (
                    <Field label="水印应用范围">
                        <Select className="w-full" value={config.overlay.watermark.applyTo} onChange={(applyTo) => patchOverlay("watermark", { applyTo })} options={APPLY_OPTIONS} />
                    </Field>
                ) : null}
                {config.overlay.watermark.mode !== "off" && config.overlay.watermark.applyTo === "custom" ? (
                    <Field label="水印图片类型">
                        <Select mode="multiple" className="w-full" value={config.overlay.watermark.customStages} options={STAGE_OPTIONS} onChange={(customStages: AssetStage[]) => patchOverlay("watermark", { customStages })} />
                    </Field>
                ) : null}
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block">
            <span className="mb-2 block text-sm font-medium">{label}</span>
            {children}
        </label>
    );
}
const LOGO_POSITIONS = [
    { value: "off", label: "不显示" },
    { value: "top-left", label: "左上" },
    { value: "top-right", label: "右上" },
    { value: "bottom-left", label: "左下" },
    { value: "bottom-right", label: "右下" },
];
const APPLY_OPTIONS = [
    { value: "marketing", label: "仅营销图" },
    { value: "all", label: "全部成品" },
    { value: "custom", label: "自定义图片类型" },
];
const STAGE_OPTIONS = [{ value: "main-white", label: "白底主图" }, ...GENERATION_ASSET_STAGES.map((value) => ({ value, label: GENERATION_STAGE_LABELS[value] })), { value: "marketing", label: "营销图" }];
const WATERMARK_POSITIONS = [
    ["top-left", "左上"],
    ["top-center", "上中"],
    ["top-right", "右上"],
    ["center-left", "左中"],
    ["center", "居中"],
    ["center-right", "右中"],
    ["bottom-left", "左下"],
    ["bottom-center", "下中"],
    ["bottom-right", "右下"],
].map(([value, label]) => ({ value, label }));
