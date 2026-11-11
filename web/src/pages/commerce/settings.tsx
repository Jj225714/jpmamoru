import { Alert, App, Button, Card, Checkbox, Collapse, ColorPicker, Divider, Form, Input, InputNumber, Modal, Select, Space, Tabs, Tag, Upload } from "antd";
import { FileUp, KeyRound, ShieldCheck, UploadCloud } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { getServerConfigEnabled } from "@/constant/runtime-config";
import { ServerConfigPanel } from "@/components/layout/server-config-panel";
import { parsePolicyWorkbook } from "@/lib/commerce/importers";
import { GenerationConfigFields } from "@/pages/commerce/components/generation-config-fields";
import { PolicyEditor } from "@/pages/commerce/components/policy-editor";
import { CategoryConfigPanel } from "@/pages/commerce/components/category-config-panel";
import { uploadImage } from "@/services/image-storage";
import { hashCommercePin, useCommerceStore } from "@/stores/use-commerce-store";
import { modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useServerConfigStore } from "@/services/server-config";
import type { PolicyPack } from "@/types/commerce";

export default function CommerceSettingsPage() {
    const navigate = useNavigate();
    const online = getServerConfigEnabled();
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    const { message } = App.useApp();
    const brands = useCommerceStore((state) => state.brands);
    const packs = useCommerceStore((state) => state.policyPacks);
    const catalog = useCommerceStore((state) => state.catalogStatus);
    const loadServerCatalog = useCommerceStore((state) => state.loadServerCatalog);
    const roles = useCommerceStore((state) => state.modelRoles);
    const owner = useCommerceStore((state) => state.owner);
    const operatorName = useCommerceStore((state) => state.operatorName);
    const updateBrand = useCommerceStore((state) => state.updateBrand);
    const updateRoles = useCommerceStore((state) => state.updateModelRoles);
    const setOwner = useCommerceStore((state) => state.setOwner);
    const setOperatorName = useCommerceStore((state) => state.setOperatorName);
    const addPolicyPack = useCommerceStore((state) => state.addPolicyPack);
    const publishPolicyPack = useCommerceStore((state) => state.publishPolicyPack);
    const retirePolicyPack = useCommerceStore((state) => state.retirePolicyPack);
    const addAudit = useCommerceStore((state) => state.addAudit);
    const config = useConfigStore((state) => state.config);
    const team = useServerConfigStore((state) => state.serverTeam);
    const teamModelConfig = team?.modelConfig;
    const brand = brands[0];
    const activePack = packs.filter((item) => item.status === "published").sort((a, b) => b.version - a.version)[0];
    const [importing, setImporting] = useState(false);
    const [editingPack, setEditingPack] = useState<PolicyPack>();
    const [ownerOpen, setOwnerOpen] = useState(false);
    const [policyAction, setPolicyAction] = useState<{ id: string; type: "publish" | "retire" | "rollback" }>();
    const [pin, setPin] = useState("");
    const [ownerName, setOwnerName] = useState(owner?.name || "负责人");

    const modelOptions = (capability: "image" | "text") => selectableModelsByCapability(config, capability).map((value) => ({ value, label: modelOptionLabel(config, value) }));
    const teamModelOptions = (capability: "image" | "text"): Array<{ value: string; label: string }> => {
        const seen = new Set<string>();
        const options: Array<{ value: string; label: string }> = [];
        for (const channel of teamModelConfig?.channels || []) for (const model of channel.models) {
            const matches = capability === "image" ? model.capability === "image" : ["text", "text_vision"].includes(model.capability);
            if (matches && !seen.has(model.name)) { seen.add(model.name); options.push({ value: model.name, label: `${model.name}（${channel.name}）` }); }
        }
        return options;
    };

    const importRules = async (file: File) => {
        setImporting(true);
        try {
            const version = Math.max(0, ...packs.map((pack) => pack.version)) + 1;
            const parsed = await parsePolicyWorkbook(file, version);
            const base = packs.filter((pack) => pack.status === "published").sort((a, b) => b.version - a.version)[0];
            const pack = { ...parsed, diffSummary: comparePolicyPacks(base, parsed) };
            addPolicyPack(pack);
            addAudit({ action: "导入规则草稿", actor: operatorName, policyPackId: pack.id, detail: pack.profiles.length + " 个国家，" + pack.requirementPresets.length + " 个需求方案，" + pack.references.length + " 张参考图" });
            message.success("已导入规则草稿 v" + version + "，发布前不会影响现有任务");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "规则导入失败");
        } finally {
            setImporting(false);
        }
        return false;
    };

    const saveOwner = async () => {
        if (!ownerName.trim() || pin.length < 4) return message.error("负责人名称不能为空，PIN 至少 4 位");
        setOwner({ name: ownerName.trim(), pinHash: await hashCommercePin(pin) });
        setOperatorName(ownerName.trim());
        setPin("");
        setOwnerOpen(false);
        message.success("负责人已设置");
    };

    const confirmPolicyAction = async () => {
        if (!owner) return message.error("请先设置负责人");
        if ((await hashCommercePin(pin)) !== owner.pinHash) return message.error("负责人 PIN 不正确");
        const pack = packs.find((item) => item.id === policyAction?.id);
        if (!pack) return;
        if (policyAction?.type === "retire") {
            retirePolicyPack(pack.id);
            addAudit({ action: "停用规则版本", actor: owner.name, policyPackId: pack.id, detail: "v" + pack.version });
            message.success("规则 v" + pack.version + " 已停用");
        } else {
            publishPolicyPack(pack.id);
            addAudit({ action: policyAction?.type === "rollback" ? "回滚规则版本" : "发布规则版本", actor: owner.name, policyPackId: pack.id, detail: "v" + pack.version });
            message.success("规则 v" + pack.version + (policyAction?.type === "rollback" ? " 已恢复为当前版本" : " 已发布"));
        }
        setPolicyAction(undefined);
        setPin("");
    };

    const brandPanel = brand ? (
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
                        <Upload
                            accept="image/*"
                            maxCount={1}
                            showUploadList={false}
                            beforeUpload={async (file) => {
                                const stored = await uploadImage(file);
                                updateBrand(brand.id, { logo: { id: nanoid(), name: file.name, url: stored.url, storageKey: stored.storageKey, source: "upload" } });
                                message.success("Logo 已保存");
                                return false;
                            }}
                        >
                            <Button icon={<UploadCloud className="size-4" />}>{brand.logo ? "更换 Logo" : "上传 Logo"}</Button>
                        </Upload>
                    </Form.Item>
                    <Form.Item label="泰国站 KodchiangUPC 字体">
                        <Upload
                            accept=".ttf,.otf,.woff,.woff2"
                            maxCount={1}
                            showUploadList={false}
                            beforeUpload={async (file) => {
                                const dataUrl = await fileToDataUrl(file);
                                updateBrand(brand.id, { thaiFont: { name: file.name, family: "KodchiangUPC", dataUrl } });
                                message.success("泰文字体已保存");
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
                    watermarkRange={activePack?.watermarkOpacityRange}
                    onChange={(generationDefaults) => updateBrand(brand.id, { generationDefaults: { ...generationDefaults, locales: brand.generationDefaults.locales } })}
                    onLocalesChange={(locales) => {
                        if (locales.length) updateBrand(brand.id, { generationDefaults: { ...brand.generationDefaults, locales } });
                    }}
                />
            </Card>
            <Card title="类目作图方案默认值" className="lg:col-span-2">
                <div className="mb-3 text-sm text-stone-500">新任务会复制这里的启用状态和数量，任务及 SKU 层仍可单独覆盖。</div>
                <Collapse
                    items={Array.from(new Set((activePack?.requirementPresets || []).filter((item) => item.category !== "通用").map((item) => item.category))).map((category) => ({
                        key: category,
                        label: category,
                        children: (
                            <div className="space-y-2">
                                {(activePack?.requirementPresets || [])
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
    ) : null;

    return (
        <main className="h-full overflow-y-auto bg-stone-50 p-4 dark:bg-stone-950 md:p-6">
            <div className="mx-auto max-w-6xl">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <Button type="link" className="!px-0" onClick={() => navigate("/commerce")}>
                            ← 返回跨境任务
                        </Button>
                        <h1 className="text-2xl font-semibold">规则、品牌与模型</h1>
                    </div>
                    <Space wrap>
                        <Space.Compact>
                            <span className="flex items-center rounded-l-md border border-r-0 border-stone-300 px-3 text-sm dark:border-stone-700">当前操作人</span>
                            <Input value={operatorName} onChange={(event) => setOperatorName(event.target.value)} className="w-40" />
                        </Space.Compact>
                        <Button icon={<KeyRound className="size-4" />} onClick={() => setOwnerOpen(true)}>
                            {owner ? "更换负责人" : "设置负责人"}
                        </Button>
                    </Space>
                </div>
                <Card className="mb-4" size="small">
                    <div role="status">
                        {catalog.phase === "success" ? `共享服务器规则已加载：${catalog.count} 个方案` : catalog.phase === "error" ? catalog.error : catalog.phase === "disabled" ? "未配置共享服务器规则，使用本地规则" : "正在加载共享服务器规则…"}
                        {catalog.phase === "error" ? (
                            <Button type="link" onClick={() => void loadServerCatalog(true)}>
                                重试
                            </Button>
                        ) : null}
                    </div>
                    <p className="mt-1 text-sm text-stone-500">共享规则可查看并编辑本地副本，保存与发布仅作用于当前浏览器。全平台发布暂不可用；商品任务固定使用创建时的版本。</p>
                </Card>
                <Tabs
                    items={[
                        { key: "categories", label: "平台类目管理", children: <CategoryConfigPanel /> },
                        {
                            key: "rules",
                            label: "国家规则与模板",
                            children: (
                                <div className="space-y-4">
                                    <Card>
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div>
                                                <div className="font-semibold">导入规则 Excel</div>
                                                <div className="mt-1 text-sm text-stone-500">导入后先成为草稿；公式和单元格内容不会被执行，嵌入图片只作为参考素材。</div>
                                            </div>
                                            <Upload accept=".xlsx" showUploadList={false} beforeUpload={(file) => void importRules(file)}>
                                                <Button loading={importing} icon={<FileUp className="size-4" />}>
                                                    选择规则表
                                                </Button>
                                            </Upload>
                                        </div>
                                    </Card>
                                    {[...packs]
                                        .sort((a, b) => b.version - a.version)
                                        .map((pack) => (
                                            <Card key={pack.id} className="mb-3 w-full">
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                    <div>
                                                        <div className="flex items-center gap-2 font-semibold">
                                                            {pack.name}
                                                            <Tag color={pack.status === "published" ? "green" : pack.status === "draft" ? "gold" : "default"}>
                                                                v{pack.version} · {pack.status === "published" ? "已发布" : pack.status === "draft" ? "草稿" : "已停用"}
                                                            </Tag>
                                                        </div>
                                                        <div className="mt-2 text-sm text-stone-500">
                                                            {pack.profiles.length} 个国家 · {pack.rules.length} 条规则 · {pack.requirementPresets.length} 个可选方案 · {pack.references.length} 张参考图 · {pack.siteReferences.length} 组站点参考
                                                        </div>
                                                        {pack.diffSummary ? (
                                                            <div className="mt-2 text-xs text-stone-500">
                                                                规则差异：规则 +{pack.diffSummary.rulesAdded} / 改 {pack.diffSummary.rulesChanged} / 删 {pack.diffSummary.rulesRemoved} / 等级变化 {pack.diffSummary.severityChanged}；模板 +
                                                                {pack.diffSummary.templatesAdded} / 改 {pack.diffSummary.templatesChanged} / 删 {pack.diffSummary.templatesRemoved}
                                                            </div>
                                                        ) : null}
                                                        {pack.editSummary?.length ? <div className="mt-2 text-xs text-stone-500">编辑摘要：{pack.editSummary.join("；")}</div> : null}
                                                        <div className="mt-1 text-xs text-stone-400">来源：{pack.sourceFileName}</div>
                                                    </div>
                                                    <Space>
                                                        <Button onClick={() => setEditingPack(pack)}>{pack.id.startsWith("server-aoweisi-") ? "编辑本地副本" : "编辑"}</Button>
                                                        {!pack.id.startsWith("server-aoweisi-") && pack.status === "draft" ? (
                                                            <Button
                                                                type="primary"
                                                                icon={<ShieldCheck className="size-4" />}
                                                                onClick={() => {
                                                                    if (!owner) setOwnerOpen(true);
                                                                    else setPolicyAction({ id: pack.id, type: "publish" });
                                                                }}
                                                            >
                                                                负责人发布
                                                            </Button>
                                                        ) : null}
                                                        {pack.status === "published" && pack.id !== "builtin-sea-home" && !pack.id.startsWith("server-aoweisi-") ? (
                                                            <Button onClick={() => setPolicyAction({ id: pack.id, type: "retire" })}>停用</Button>
                                                        ) : null}
                                                        {pack.status === "retired" && pack.id !== "builtin-sea-home" && !pack.id.startsWith("server-aoweisi-") ? (
                                                            <Button onClick={() => setPolicyAction({ id: pack.id, type: "rollback" })}>回滚到此版本</Button>
                                                        ) : null}
                                                    </Space>
                                                </div>
                                            </Card>
                                        ))}
                                </div>
                            ),
                        },
                        {
                            key: "brand",
                            label: "品牌配置",
                            children: online ? (
                                <Card title="团队品牌配置">
                                    <Alert
                                        type="info"
                                        title="品牌、Logo、字体、默认出图规格与水印随团队规则一起发布"
                                        description="请在「平台类目管理」展开「团队品牌与出图默认值」，修改后保存草稿并发布。普通成员可使用已发布配置，本地 PIN 不作为团队发布权限。"
                                    />
                                    <Button className="mt-3" onClick={() => openConfig(false, "commerce-categories")}>
                                        打开团队配置编辑
                                    </Button>
                                </Card>
                            ) : (
                                brandPanel
                            ),
                        },
                        ...(online ? [{ key: "account", label: "账号与同步", children: <ServerConfigPanel /> }] : []),
                        {
                            key: "models",
                            label: "流程模型",
                            children: (
                                <Card>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        {teamModelConfig ? <Alert className="md:col-span-2" type="info" showIcon message="当前使用团队统一模型配置；个人模型仅作为旧配置兼容回退。" /> : null}
                                        <ModelSelect disabled={Boolean(teamModelConfig)} label="场景生图模型" value={teamModelConfig?.roles.sceneModel || roles.sceneModel} options={teamModelConfig ? teamModelOptions("image") : modelOptions("image")} onChange={(sceneModel) => updateRoles({ sceneModel })} />
                                        <ModelSelect disabled={Boolean(teamModelConfig)} label="蒙版修复模型" value={teamModelConfig?.roles.repairModel || roles.repairModel} options={teamModelConfig ? teamModelOptions("image") : modelOptions("image")} onChange={(repairModel) => updateRoles({ repairModel })} />
                                        <ModelSelect disabled={Boolean(teamModelConfig)} label="中文文案模型" value={teamModelConfig?.roles.copyModel || roles.copyModel} options={teamModelConfig ? teamModelOptions("text") : modelOptions("text")} onChange={(copyModel) => updateRoles({ copyModel })} />
                                        <ModelSelect disabled={Boolean(teamModelConfig)} label="翻译模型" value={teamModelConfig?.roles.translationModel || roles.translationModel} options={teamModelConfig ? teamModelOptions("text") : modelOptions("text")} onChange={(translationModel) => updateRoles({ translationModel })} />
                                        <ModelSelect disabled={Boolean(teamModelConfig)} label="多模态合规模型" value={teamModelConfig?.roles.complianceModel || roles.complianceModel} options={teamModelConfig ? teamModelOptions("text") : modelOptions("text")} onChange={(complianceModel) => updateRoles({ complianceModel })} />
                                        <div />
                                    </div>
                                    <Divider />
                                    <Form layout="vertical">
                                        <Form.Item label="可选抠图 API 地址">
                                            <Input value={roles.removalApiUrl} onChange={(event) => updateRoles({ removalApiUrl: event.target.value })} placeholder="https://..." />
                                        </Form.Item>
                                        <Form.Item label="抠图 API Key">
                                            <Input.Password value={roles.removalApiKey} onChange={(event) => updateRoles({ removalApiKey: event.target.value })} />
                                        </Form.Item>
                                    </Form>
                                </Card>
                            ),
                        },
                    ]}
                />
            </div>
            <Modal
                title="设置负责人"
                open={ownerOpen}
                onCancel={() => {
                    setOwnerOpen(false);
                    setPin("");
                }}
                onOk={() => void saveOwner()}
                okText="保存"
            >
                <Form layout="vertical">
                    <Form.Item label="负责人名称">
                        <Input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} />
                    </Form.Item>
                    <Form.Item label="本地 PIN">
                        <Input.Password value={pin} onChange={(event) => setPin(event.target.value)} placeholder="至少 4 位，仅用于防止误发布" />
                    </Form.Item>
                </Form>
            </Modal>
            <Modal
                title={policyAction?.type === "retire" ? "停用规则版本" : policyAction?.type === "rollback" ? "回滚规则版本" : "发布规则版本"}
                open={Boolean(policyAction)}
                onCancel={() => {
                    setPolicyAction(undefined);
                    setPin("");
                }}
                onOk={() => void confirmPolicyAction()}
                okText="负责人确认"
            >
                <p className="mb-4 text-sm text-stone-500">{policyAction?.type === "retire" ? "停用只影响后续新任务，已经启动的任务继续使用固定版本。" : "确认后，新任务将使用该版本；运行中的任务不会切换规则。"}</p>
                <Input.Password prefix={<KeyRound className="size-4" />} value={pin} onChange={(event) => setPin(event.target.value)} placeholder="负责人 PIN" />
            </Modal>
            {editingPack ? <PolicyEditor key={editingPack.id} pack={editingPack} onClose={() => setEditingPack(undefined)} /> : null}
        </main>
    );
}

function ModelSelect({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) {
    return (
        <label>
            <span className="mb-2 block text-sm font-medium">{label}</span>
            <Select disabled={disabled} allowClear showSearch optionFilterProp="label" className="w-full" value={value || undefined} options={options} onChange={(value) => onChange(value || "")} placeholder="使用全局默认模型" />
        </label>
    );
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
function fileToDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("字体读取失败"));
        reader.readAsDataURL(file);
    });
}
function comparePolicyPacks(base: PolicyPack | undefined, next: PolicyPack): NonNullable<PolicyPack["diffSummary"]> {
    const summary = { rulesAdded: 0, rulesChanged: 0, rulesRemoved: 0, severityChanged: 0, templatesAdded: 0, templatesChanged: 0, templatesRemoved: 0 };
    const baseRules = new Map((base?.rules || []).map((rule) => [rule.title, rule]));
    const nextRules = new Map(next.rules.map((rule) => [rule.title, rule]));
    for (const [key, rule] of nextRules) {
        const previous = baseRules.get(key);
        if (!previous) summary.rulesAdded += 1;
        else {
            if (previous.severity !== rule.severity) summary.severityChanged += 1;
            if (previous.description !== rule.description || previous.checker !== rule.checker || JSON.stringify(previous.assetStages) !== JSON.stringify(rule.assetStages)) summary.rulesChanged += 1;
        }
    }
    for (const key of baseRules.keys()) if (!nextRules.has(key)) summary.rulesRemoved += 1;
    const templateKey = (template: PolicyPack["templates"][number]) => template.category + "::" + template.order;
    const baseTemplates = new Map((base?.templates || []).map((template) => [templateKey(template), template]));
    const nextTemplates = new Map(next.templates.map((template) => [templateKey(template), template]));
    for (const [key, template] of nextTemplates) {
        const previous = baseTemplates.get(key);
        if (!previous) summary.templatesAdded += 1;
        else if (previous.requirement !== template.requirement || previous.chineseCopy !== template.chineseCopy || previous.slot !== template.slot || JSON.stringify(previous.requiredVariables) !== JSON.stringify(template.requiredVariables))
            summary.templatesChanged += 1;
    }
    for (const key of baseTemplates.keys()) if (!nextTemplates.has(key)) summary.templatesRemoved += 1;
    return summary;
}
