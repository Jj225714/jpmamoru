import { App, Button, Card, Checkbox, Collapse, ColorPicker, Form, Image, Input, InputNumber, Tag, Upload, Select } from "antd";
import { UploadCloud } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
import { useServerConfigStore } from "@/services/server-config";
import { GenerationConfigFields } from "./generation-config-fields";
import { uploadSettingsAsset } from "@/services/server-config";
import type { BrandProfile, PolicyPack } from "@/types/commerce";

export function TeamBrandEditor({ brands, pack, onChange, disabled }: { brands: BrandProfile[]; pack: PolicyPack; onChange: (brands: BrandProfile[]) => void; disabled?: boolean }) {
    const [selected, setSelected] = useState<string>();
    const brand = brands.find((item) => item.id === selected) || brands[0];
    const updateBrand = (id: string, patch: Partial<BrandProfile>) => {
        if (!disabled) onChange(brands.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };
    return (
        <Collapse
            items={[
                {
                    key: "brands",
                    label: `团队品牌与出图默认值（${brands.length} 个品牌）`,
                    children: (
                        <>
                            <Select aria-label="编辑团队品牌" value={brand?.id} options={brands.map((item) => ({ value: item.id, label: item.name }))} onChange={setSelected} className="mb-4 min-w-48" />
                            <BrandFields brand={brand} pack={pack} updateBrand={updateBrand} disabled={disabled} />
                        </>
                    ),
                },
            ]}
        />
    );
}
function BrandFields({ brand, pack, updateBrand, disabled }: { brand?: BrandProfile; pack: PolicyPack; updateBrand: (id: string, patch: Partial<BrandProfile>) => void; disabled?: boolean }) {
    const { message } = App.useApp();
    return brand ? (
        <fieldset disabled={disabled}>
            <div className="grid gap-4 lg:grid-cols-2">
                <Card title="品牌基础信息">
                    <Form layout="vertical">
                        <Form.Item label="品牌名称">
                            <Input value={brand.name} onChange={(event) => updateBrand(brand.id, { name: event.target.value })} />
                        </Form.Item>
                        <div className="grid grid-cols-2 gap-3">
                            <Form.Item label="主色">
                                <ColorPicker value={brand.primaryColor} onChange={(_, hex) => updateBrand(brand.id, { primaryColor: hex })} showText />
                            </Form.Item>
                            <Form.Item label="辅助色">
                                <ColorPicker value={brand.secondaryColor} onChange={(_, hex) => updateBrand(brand.id, { secondaryColor: hex })} showText />
                            </Form.Item>
                        </div>
                        <Form.Item label="拉丁与越南文字体">
                            <Input value={brand.fontFamily} onChange={(event) => updateBrand(brand.id, { fontFamily: event.target.value })} placeholder="Arial" />
                        </Form.Item>
                        <Form.Item label="品牌 Logo">
                            {brand.logo ? (
                                <div className="mb-2">
                                    <Image width={100} src={brand.logo.url} alt={brand.logo.name} />
                                </div>
                            ) : null}
                            <Upload
                                accept="image/*"
                                maxCount={1}
                                showUploadList={false}
                                beforeUpload={async (file) => {
                                    const account = useServerConfigStore.getState().user;
                                    try {
                                        const stored = await uploadSettingsAsset("team", file.name, file);
                                        if (useServerConfigStore.getState().user !== account) return false;
                                        updateBrand(brand.id, { logo: { id: nanoid(), name: file.name, url: stored.url, source: "upload" } });
                                        message.success("Logo 已加入草稿，保存并发布后跨设备生效");
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "Logo 上传失败");
                                    }
                                    return false;
                                }}
                            >
                                <Button icon={<UploadCloud className="size-4" />}>{brand.logo ? "更换 Logo" : "上传 Logo"}</Button>
                            </Upload>
                        </Form.Item>
                        <Form.Item label="泰国站 KodchiangUPC 字体">
                            {brand.thaiFont ? <p className="mb-2">已配置：{brand.thaiFont.name}</p> : null}
                            <Upload
                                accept=".ttf,.otf,.woff,.woff2"
                                maxCount={1}
                                showUploadList={false}
                                beforeUpload={async (file) => {
                                    const account = useServerConfigStore.getState().user;
                                    try {
                                        const asset = await uploadSettingsAsset("team", file.name, file);
                                        if (useServerConfigStore.getState().user !== account) return false;
                                        const dataUrl = asset.url;
                                        updateBrand(brand.id, { thaiFont: { name: file.name, family: "KodchiangUPC", dataUrl } });
                                        message.success("字体已加入草稿，保存并发布后跨设备生效");
                                    } catch (error) {
                                        message.error(error instanceof Error ? error.message : "字体上传失败");
                                    }
                                    return false;
                                }}
                            >
                                <Button icon={<UploadCloud className="size-4" />}>{brand.thaiFont ? "已配置，点击更换" : "上传字体文件"}</Button>
                            </Upload>
                        </Form.Item>
                    </Form>
                </Card>
                <Card title="品牌术语">
                    <Form layout="vertical">
                        <Form.Item label="品牌禁用词（逗号或换行分隔）">
                            <Input.TextArea rows={5} value={brand.bannedWords.join("\n")} onChange={(event) => updateBrand(brand.id, { bannedWords: splitWords(event.target.value) })} />
                        </Form.Item>
                        <Form.Item label="术语映射（每行：原词=目标词）">
                            <Input.TextArea
                                rows={6}
                                value={Object.entries(brand.terminology)
                                    .map(([key, value]) => key + "=" + value)
                                    .join("\n")}
                                onChange={(event) => updateBrand(brand.id, { terminology: parseMapping(event.target.value) })}
                            />
                        </Form.Item>
                    </Form>
                </Card>
                <Card title="默认生成方案" className="lg:col-span-2">
                    <GenerationConfigFields
                        config={brand.generationDefaults}
                        locales={brand.generationDefaults.locales}
                        watermarkRange={pack?.watermarkOpacityRange}
                        onChange={(generationDefaults) => updateBrand(brand.id, { generationDefaults: { ...generationDefaults, locales: brand.generationDefaults.locales } })}
                        onLocalesChange={(locales) => {
                            if (locales.length) updateBrand(brand.id, { generationDefaults: { ...brand.generationDefaults, locales } });
                        }}
                    />
                </Card>
                <Card title="类目作图方案默认值" className="lg:col-span-2">
                    <div className="mb-3 text-sm text-stone-500">新任务会复制这里的启用状态和数量，任务及 SKU 层仍可单独覆盖。</div>
                    <Collapse
                        items={Array.from(new Set((pack?.requirementPresets || []).filter((item) => item.category !== "通用").map((item) => item.category))).map((category) => ({
                            key: category,
                            label: category,
                            children: (
                                <div className="space-y-2">
                                    {(pack?.requirementPresets || [])
                                        .filter((item) => item.category === category)
                                        .sort((a, b) => a.order - b.order)
                                        .map((preset) => {
                                            const defaults = brand.requirementDefaultsByCategory[category] || [];
                                            const current = defaults.find((item) => item.requirementId === preset.id);
                                            const selection = current || {
                                                requirementId: preset.id,
                                                enabled: preset.enabledByDefault,
                                                count: preset.defaultCount,
                                                referenceIds: preset.referenceIds,
                                                layout: preset.layout,
                                                variantScope: preset.variantScope,
                                                variantValues: [],
                                                reviewed: !preset.needsReview,
                                            };
                                            const save = (patch: Record<string, unknown>) =>
                                                updateBrand(brand.id, { requirementDefaultsByCategory: { ...brand.requirementDefaultsByCategory, [category]: [...defaults.filter((item) => item.requirementId !== preset.id), { ...selection, ...patch }] } });
                                            return (
                                                <div key={preset.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                                    <Checkbox checked={selection.enabled} onChange={(event) => save({ enabled: event.target.checked })}>
                                                        {preset.order}. {preset.title}
                                                    </Checkbox>
                                                    <Tag>{preset.stage === "marketing" ? "营销" : preset.stage}</Tag>
                                                    <InputNumber min={0} max={4} value={selection.count} addonAfter="张" onChange={(value) => save({ count: Number(value || 0) })} />
                                                    {preset.needsReview ? <Tag color="orange">需校对</Tag> : null}
                                                </div>
                                            );
                                        })}
                                </div>
                            ),
                        }))}
                    />
                </Card>
            </div>
        </fieldset>
    ) : null;
}
function splitWords(value: string) {
    return value
        .split(/[，,；;\n\r]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}
function parseMapping(value: string) {
    return Object.fromEntries(
        value
            .split(/\n+/)
            .map((line) => line.split("=").map((item) => item.trim()))
            .filter(([key, target]) => key && target)
            .map(([key, target]) => [key, target]),
    );
}
