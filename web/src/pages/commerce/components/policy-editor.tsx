import { Alert, App, Button, Collapse, Form, Input, InputNumber, Modal, Select, Space, Switch, Tabs } from "antd";
import { useEffect, useMemo, useState } from "react";
import { nanoid } from "nanoid";

import { normalizeGenerationConfig } from "@/lib/commerce/generation-config";
import { clonePolicy, POLICY_OPTIONS, policyChanges, policyEntryMatches, requiresPolicyReview, synchronizePolicyTemplates, validatePolicyEdit } from "@/lib/commerce/policy-editor";
import { resolveImageUrl } from "@/services/image-storage";
import { useCommerceStore } from "@/stores/use-commerce-store";
import { COMMERCE_LOCALES, type PolicyPack } from "@/types/commerce";

type Field = { key: string; label: string; kind?: "text" | "number" | "boolean" | "list" | "select" | "multi"; options?: readonly string[]; fields?: Field[]; min?: number; max?: number; step?: number; optional?: boolean; disabled?: boolean };
const optionLabels: Record<string, string> = {
    "paired-before-after": "前后两图顺序生成并拼版", "natural-window": "自然窗光", "soft-studio": "柔和棚拍", "warm-indoor": "暖色室内光", "side-light": "侧光质感", none: "无人", "adult-partial": "成人手部或局部", "adult-half": "成人半身", "adult-full": "成人全身", auto: "自动", close: "特写", medium: "中景", wide: "环境全景",
    generate: "生成需求场景底图", "white-layout": "白底商品排版（明确选用）",
    BLOCK: "阻断", WARN: "警告", GUIDE: "指导", shopee: "Shopee", tiktok: "TikTok",
    "en-US": "英语（美国）", "en-GB": "英语（英国）", "th-TH": "泰语", "vi-VN": "越南语", "ms-MY": "马来语", "fil-PH": "菲律宾语", "id-ID": "印尼语",
    "main-white": "白底主图", scene: "空间场景", detail: "材质特写", "usage-size": "用途与尺寸", "detail-white": "特写白底", "marketing-preview": "营销预览", marketing: "营销图",
    prompt: "提示词阶段", preflight: "生成前", "post-render": "渲染后", metadata: "元数据", text: "文本", vision: "视觉", manual: "人工",
    "single-hero": "单品主视觉", "feature-grid": "卖点网格", "before-after": "前后对比", "competitor-comparison": "竞品对比", "size-comparison": "尺寸对比", "color-options": "颜色选项", "multi-scene": "多场景", "layer-structure": "分层结构", "lighting-comparison": "光照对比", "installation-methods": "安装方式", "installation-steps": "安装步骤", faq: "常见问题", "custom-reference": "自定义参考",
    "per-sku": "按 SKU", "per-color": "按颜色", "per-size": "按尺寸", "per-site": "按站点", custom: "自定义", reference: "参考图", example: "示例图",
    shared: "各站点共享", flattenedOnly: "仅成品图", editableCanvas: "成品图与可编辑画布", off: "关闭", all: "全部图片", single: "单枚", tile: "平铺",
    "top-left": "左上", "top-center": "上中", "top-right": "右上", "center-left": "左中", center: "居中", "center-right": "右中", "bottom-left": "左下", "bottom-center": "下中", "bottom-right": "右下",
};
const text = (key: string, label: string): Field => ({ key, label });
const list = (key: string, label: string): Field => ({ key, label, kind: "list" });
const number = (key: string, label: string, min = 0, max = 9999, step = 1): Field => ({ key, label, kind: "number", min, max, step });
const select = (key: string, label: string, options: readonly string[], multi = false): Field => ({ key, label, options, kind: multi ? "multi" : "select" });
const boolean = (key: string, label: string): Field => ({ key, label, kind: "boolean" });
const creativeBriefField: Field = { key: "creativeBrief", label: "推荐拍摄设置（可在任务中覆盖）", fields: [text("scene", "场景描述"), text("audience", "成年目标人群与情境"), { ...select("lighting", "光影（留空继承）", ["natural-window", "soft-studio", "warm-indoor", "side-light"]), optional: true }, { ...select("people", "人物出镜（留空继承）", ["none", "adult-partial", "adult-half", "adult-full"]), optional: true }, { ...select("framing", "景别（留空继承）", ["auto", "close", "medium", "wide"]), optional: true }] };
const translations: Field = { key: "translationSeeds", label: "各语言文案", fields: COMMERCE_LOCALES.map((locale) => text(locale, optionLabels[locale])) };
const referenceField: Field = { key: "referenceIds", label: "关联参考图", kind: "multi" };
const profileFields: Field[] = [text("countryCode", "国家代码（两位大写字母）"), text("countryName", "国家名称"), select("locale", "语言", POLICY_OPTIONS.locale), text("audience", "目标人群"), text("visualKeywords", "视觉关键词"), text("mainImageStyle", "主图风格"), list("preferredColors", "偏好颜色"), list("avoidedColors", "避免颜色"), text("modelPreference", "人物偏好")];
const ruleFields: Field[] = [text("title", "规则标题"), text("description", "规则描述"), select("severity", "严重程度", POLICY_OPTIONS.severity), number("priority", "优先级", 0, 100), list("countries", "适用国家代码（留空为全部）"), select("platforms", "平台（留空为全部）", POLICY_OPTIONS.platforms, true), list("categories", "类目（留空为全部）"), select("locales", "语言（留空为全部）", POLICY_OPTIONS.locales, true), select("assetStages", "图片类型（留空为全部）", POLICY_OPTIONS.assetStages, true), select("phase", "检查阶段", POLICY_OPTIONS.phase), select("checker", "检查方式", POLICY_OPTIONS.checker), { key: "source", label: "规则来源", fields: [text("fileName", "文件名"), text("sheet", "工作表"), text("range", "单元格范围")] }];
const presetFields: Field[] = [text("title", "方案标题"), text("category", "类目"), number("order", "排序"), select("stage", "图片类型", POLICY_OPTIONS.stage), { ...select("visualMode", "底图生成方式（留空保留旧版行为）", POLICY_OPTIONS.visualMode), optional: true }, { ...select("visualKind", "底图内容类型（独立于营销用途）", POLICY_OPTIONS.visualKind), optional: true }, { ...select("generationStrategy", "画面生成策略", POLICY_OPTIONS.generationStrategy), optional: true }, creativeBriefField, boolean("enabledByDefault", "默认启用"), number("defaultCount", "默认数量", 0, 4), text("prompt", "提示词 / 作图要求"), select("layout", "排版", POLICY_OPTIONS.layout), text("chineseCopy", "中文文案"), translations, list("requiredFacts", "必需商品事实"), referenceField, select("variantScope", "变体范围", POLICY_OPTIONS.variantScope), boolean("needsReview", "需人工校对")];
const templateFields: Field[] = [text("title", "模板标题"), text("category", "类目"), number("order", "排序"), select("slot", "图片类型", POLICY_OPTIONS.slot), text("requirement", "作图要求"), text("chineseCopy", "中文文案"), translations, list("requiredVariables", "必需变量"), referenceField];
const siteFields: Field[] = [text("product", "商品 / 类目"), { ...select("locale", "站点语言（留空为通用）", POLICY_OPTIONS.locale), optional: true }, text("url", "站点网址"), referenceField, text("note", "备注")];
const referenceFields: Field[] = [text("name", "名称"), text("sheet", "来源工作表"), text("anchor", "图片锚点"), select("kind", "参考类型", POLICY_OPTIONS.kind)];
const overlayFields: Field[] = [select("applyTo", "应用范围", ["marketing", "all", "custom"]), select("customStages", "自定义图片类型", POLICY_OPTIONS.assetStages, true)];
const generationFields: Field[] = [
    creativeBriefField,
    { key: "assetCounts", label: "兼容图片数量", fields: POLICY_OPTIONS.stage.filter((s) => s !== "marketing").map((s) => number(s, optionLabels[s], 0, 4)) },
    boolean("marketingEnabled", "生成营销图"), select("siteImageMode", "站点图片方式", ["shared", "per-site"]), select("delivery", "交付方式", ["flattenedOnly", "editableCanvas"]),
    { key: "outputSpec", label: "输出规格", fields: [select("size", "尺寸", ["800", "1024", "1254", "1600"]), select("format", "格式", ["jpeg", "png"]), number("maxBytes", "最大文件体积（字节）", 262144, 20971520), select("dpi", "DPI", ["96", "120", "150"]), select("colorSpace", "色彩空间", ["sRGB"])] },
    { key: "overlay", label: "品牌覆盖", fields: [
        { key: "logo", label: "Logo", fields: [select("placement", "位置", ["off", "top-left", "top-right", "bottom-left", "bottom-right"]), ...overlayFields] },
        { key: "watermark", label: "水印", fields: [select("mode", "方式", ["off", "single", "tile"]), select("position", "位置", ["top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right"]), number("opacity", "透明度（%）", 0.03, 0.3, 0.01), ...overlayFields] },
    ] },
];

/** All edits stay here until the PIN-verified store transaction succeeds. */
export function PolicyEditor({ pack, onClose }: { pack: PolicyPack; onClose: () => void }) {
    const { modal, message } = App.useApp();
    const [base] = useState(() => clonePolicy(pack));
    const [draft, setDraft] = useState(() => clonePolicy(pack));
    const [pin, setPin] = useState("");
    const [intent, setIntent] = useState<"draft" | "publish">();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [countryFilter, setCountryFilter] = useState<string>();
    const [categoryFilter, setCategoryFilter] = useState<string>();
    const savePolicyEdit = useCommerceStore((state) => state.savePolicyEdit);
    const next = useMemo(() => synchronizePolicyTemplates(draft, base), [draft, base]);
    const changes = useMemo(() => policyChanges(base, next), [base, next]);
    const errors = useMemo(() => validatePolicyEdit(base, next), [base, next]);
    const dirty = JSON.stringify(base) !== JSON.stringify(draft);
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const close = () => {
        if (saving) return;
        if (!dirty) return onClose();
        modal.confirm({ title: "放弃未保存的修改？", content: "本地编辑内容尚未保存，关闭后将丢失。", okText: "放弃修改", cancelText: "继续编辑", onOk: onClose });
    };
    const save = async () => {
        if (!intent || saving) return;
        setSaving(true); setError("");
        try {
            const result = await savePolicyEdit({ base, edited: next, publish: intent === "publish", pin });
            message.success(`规则 v${result.version} 已${intent === "publish" ? "保存并发布" : "保存为草稿"}`);
            setPin(""); onClose();
        } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
        finally { setSaving(false); }
    };
    const update = <K extends keyof PolicyPack>(key: K, value: PolicyPack[K]) => setDraft((current) => ({ ...current, [key]: value }));
    const addAdvanced = () => setDraft((current) => ({ ...current, requirementPresets: [...current.requirementPresets, { id: "custom-" + nanoid(), category: categoryFilter || "通用", order: Math.max(0, ...current.requirementPresets.map((preset) => preset.order)) + 1, title: "自定义高级方案", stage: "marketing", enabledByDefault: false, defaultCount: 1, prompt: "请填写基于已确认商品事实的完整画面要求，并列出安装、性能或尺寸演示所需参数。", layout: "single-hero", chineseCopy: "", translationSeeds: {}, requiredFacts: [], referenceIds: [], variantScope: "per-sku", needsReview: true, visualMode: "generate", generationStrategy: "single" }] }));
    const records = <K extends "profiles" | "rules" | "requirementPresets" | "templates" | "references" | "siteReferences">(key: K, fields: Field[]) => {
        const entries = draft[key];
        const visible = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => policyEntryMatches(key, entry as unknown as Record<string, unknown>, draft, countryFilter, categoryFilter));
        if (!visible.length) return <p>{key === "templates" ? "暂无独立营销模板。已关联方案的模板统一在「需求方案」中编辑。" : "当前筛选下没有条目，可清除筛选查看全部。"}</p>;
        return <Collapse items={visible.map(({ entry, index }) => {
            const item = (key === "requirementPresets" ? next.requirementPresets[index] : entry) as unknown as Record<string, unknown>;
            const reviewLocked = key === "requirementPresets" && requiresPolicyReview(next.requirementPresets[index], base.requirementPresets.find((preset) => preset.id === item.id));
            return { key: String(item.id || index), label: `${index + 1}. ${item.title || item.countryName || item.product || item.name || "未命名"}`, children: <>
                {reviewLocked ? <Alert className="mb-3" type="warning" title="文案已修改或翻译尚未完成，已自动标记为待校对。请补全文案并保存后，再确认校对状态。" /> : null}
                <ObjectFields value={item} fields={fields.map((field) => field.key === "needsReview" ? { ...field, disabled: reviewLocked } : field)} references={draft.references} onChange={(value) => update(key, entries.map((old, i) => i === index ? value : old) as PolicyPack[K])} />
                {key === "references" ? <ReferencePreview reference={draft.references[index]} /> : null}
            </> };
        })} />;
    };
    return <>
        <Modal open title={`编辑规则 · ${base.name} · v${base.version}`} width={1100} onCancel={close} keyboard={!saving} mask={{ closable: false }} footer={<Space><Button disabled={saving} onClick={close}>取消</Button><Button disabled={saving || Boolean(errors.length)} onClick={() => { setError(""); setIntent("draft"); }}>保存草稿</Button><Button type="primary" disabled={saving || Boolean(errors.length)} onClick={() => { setError(""); setIntent("publish"); }}>保存并发布</Button></Space>}>
            <div className="max-h-[70vh] overflow-y-auto pr-2">
                <Alert className="mb-4" type="info" title={base.status === "draft" && base.id !== "builtin-sea-home" ? "保存更新此草稿；若任务已引用，将保存为新的规则版本。" : "保存将创建新的规则版本；已有任务继续使用原版本。"} description="可编辑已有条目或追加默认关闭的高级方案。请为性能、尺寸、安装等要求填写必需商品事实。保存及发布均需负责人 PIN，仅作用于当前浏览器，不会发布到全平台，也不修改历史任务。" />
                <Form layout="vertical"><Form.Item label="规则包名称"><Input value={draft.name} onChange={(event) => update("name", event.target.value)} /></Form.Item></Form>
                <Space wrap className="mb-3">
                    <Select aria-label="按国家筛选" className="min-w-44" allowClear showSearch optionFilterProp="label" placeholder="全部国家" value={countryFilter} onChange={setCountryFilter} options={Array.from(new Set([...draft.profiles.map((profile) => profile.countryCode), ...draft.rules.flatMap((rule) => rule.countries)])).map((code) => ({ value: code, label: draft.profiles.find((profile) => profile.countryCode === code)?.countryName || code }))} />
                    <Select aria-label="按类目筛选" className="min-w-44" allowClear showSearch optionFilterProp="label" placeholder="全部类目" value={categoryFilter} onChange={setCategoryFilter} options={Array.from(new Set([...draft.requirementPresets.map((item) => item.category), ...draft.templates.map((item) => item.category), ...draft.rules.flatMap((item) => item.categories)])).map((category) => ({ value: category, label: category }))} />
                    <Button onClick={() => { setCountryFilter(undefined); setCategoryFilter(undefined); }}>清除筛选</Button>
                </Space>
                <p className="mb-3 text-xs text-stone-500">国家筛选适用于国家配置、规则及站点参考；类目筛选适用于规则、需求方案和营销模板。通用条目始终显示。</p>
                <Tabs items={[
                    { key: "profiles", label: "国家配置", children: records("profiles", profileFields) },
                    { key: "rules", label: "规则", children: records("rules", ruleFields) },
                    { key: "presets", label: "需求方案", children: <><Button className="mb-3" onClick={addAdvanced}>新增高级方案</Button>{records("requirementPresets", presetFields)}</> },
                    { key: "templates", label: "营销模板", children: records("templates", templateFields) },
                    { key: "defaults", label: "标准与默认值", children: <>
                        <ObjectFields value={{ globalStandards: draft.globalStandards }} fields={[list("globalStandards", "全局标准（每项一条）")]} references={draft.references} onChange={(value) => update("globalStandards", value.globalStandards as string[])} />
                        <Space className="mb-4"><span>水印透明度范围（3%–30%）</span><InputNumber aria-label="水印最小透明度" min={3} max={30} step={1} suffix="%" value={(draft.watermarkOpacityRange || [0.03, 0.3])[0] * 100} onChange={(v) => update("watermarkOpacityRange", [(v ?? 3) / 100, (draft.watermarkOpacityRange || [0.03, 0.3])[1]])} /><span>至</span><InputNumber aria-label="水印最大透明度" min={3} max={30} step={1} suffix="%" value={(draft.watermarkOpacityRange || [0.03, 0.3])[1] * 100} onChange={(v) => update("watermarkOpacityRange", [(draft.watermarkOpacityRange || [0.03, 0.3])[0], (v ?? 30) / 100])} /></Space>
                        <div className="mb-4"><Switch checked={Boolean(draft.generationDefaults)} onChange={(enabled) => update("generationDefaults", enabled ? normalizeGenerationConfig(undefined, draft.watermarkOpacityRange) : undefined)} /> 自定义规则包生成默认值</div>
                        {draft.generationDefaults ? <ObjectFields value={{ ...normalizeGenerationConfig(draft.generationDefaults, draft.watermarkOpacityRange), ...draft.generationDefaults }} fields={generationFields} references={draft.references} onChange={(value) => update("generationDefaults", value as PolicyPack["generationDefaults"])} /> : <p>使用应用默认生成配置。</p>}
                    </> },
                    { key: "references", label: "参考图", children: records("references", referenceFields) },
                    { key: "sites", label: "站点参考", children: records("siteReferences", siteFields) },
                    { key: "changes", label: `修改摘要（${changes.length}）`, children: <><ul className="list-disc pl-5">{changes.map((change) => <li key={change}>{change}</li>)}</ul>{!changes.length ? <p>尚无修改。</p> : null}</> },
                ]} />
                {errors.length ? <Alert className="mt-4" type="error" title="请修正后保存" description={<ul>{errors.map((item) => <li key={item}>{item}</li>)}</ul>} /> : null}
            </div>
        </Modal>
        <Modal open={Boolean(intent)} title={intent === "publish" ? "负责人确认保存并发布" : "负责人确认保存草稿"} onCancel={() => { if (!saving) { setIntent(undefined); setPin(""); setError(""); } }} onOk={() => void save()} confirmLoading={saving} cancelButtonProps={{ disabled: saving }} closable={!saving} mask={{ closable: false }} keyboard={!saving} okText="验证并保存">
            <ul className="mb-4 list-disc pl-5">{changes.map((change) => <li key={change}>{change}</li>)}</ul>
            {!changes.length ? <p>内容未变更。</p> : null}
            <Input.Password aria-label="负责人 PIN" autoComplete="off" value={pin} disabled={saving} onChange={(event) => setPin(event.target.value)} placeholder="负责人 PIN" onPressEnter={() => void save()} />
            {error ? <Alert className="mt-3" type="error" title={error} /> : null}
        </Modal>
    </>;
}

function ObjectFields({ value, fields, references, onChange }: { value: object; fields: Field[]; references: PolicyPack["references"]; onChange: (value: Record<string, unknown>) => void }) {
    const values = value as Record<string, unknown>;
    return <Form layout="vertical" component="div" className="grid gap-x-4 md:grid-cols-2">{fields.map((field) => {
        const current = values[field.key];
        const scale = field.key === "opacity" ? 100 : 1;
        const change = (next: unknown) => onChange({ ...values, [field.key]: next });
        if (field.fields) return <div key={field.key} className="col-span-full rounded border border-stone-200 p-3 mb-3 dark:border-stone-700"><h3 className="mb-3 font-medium">{field.label}</h3><ObjectFields value={(current || {}) as object} fields={field.fields} references={references} onChange={change} /></div>;
        const options = field.key === "referenceIds" ? references.map((ref) => ({ value: ref.id, label: `${ref.name} · ${ref.sheet} ${ref.anchor}` })) : field.options?.map((option) => ({ value: typeof current === "number" ? Number(option) : option, label: field.key === "generationStrategy" && option === "single" ? "单张画面" : optionLabels[option] || option }));
        return <Form.Item key={field.key} label={field.label}>
            {field.kind === "boolean" ? <Switch aria-label={field.label} disabled={field.disabled} checked={Boolean(current)} onChange={change} />
                : field.kind === "number" ? <InputNumber aria-label={field.label} className="w-full" value={(current as number) * scale} min={field.min === undefined ? undefined : field.min * scale} max={field.max === undefined ? undefined : field.max * scale} step={(field.step || 1) * scale} onChange={(v) => change(v === null ? NaN : v / scale)} />
                : field.kind === "select" || field.kind === "multi" ? <Select aria-label={field.label} className="w-full" mode={field.kind === "multi" ? "multiple" : undefined} allowClear={field.kind === "multi" || field.optional} showSearch optionFilterProp="label" value={current} options={options} onChange={change} />
                : field.kind === "list" ? <Select aria-label={field.label} className="w-full" mode="tags" tokenSeparators={[",", "，", ";", "；"]} value={current as string[]} onChange={change} open={false} placeholder="输入一项后按回车，可删除已有项" />
                : <Input.TextArea aria-label={field.label} autoSize={{ minRows: 1, maxRows: 8 }} value={String(current ?? "")} onChange={(event) => change(event.target.value)} />}
            {field.key === "referenceIds" ? <div className="mt-2 flex flex-wrap gap-2">{references.filter((reference) => (current as string[] || []).includes(reference.id)).map((reference) => <ReferencePreview key={reference.id} reference={reference} />)}</div> : null}
        </Form.Item>;
    })}</Form>;
}

function ReferencePreview({ reference }: { reference: PolicyPack["references"][number] }) {
    const [src, setSrc] = useState(reference.url);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        setFailed(false); setSrc(reference.url);
        void resolveImageUrl(reference.storageKey, reference.url).then((resolved) => { if (active) { setSrc(resolved || reference.url); setFailed(false); } }).catch(() => { if (active) setSrc(reference.url); });
        return () => { active = false; };
    }, [reference.storageKey, reference.url]);
    return <figure className="w-32"><div className="flex h-24 items-center justify-center rounded border border-stone-200 dark:border-stone-700">
        {src && !failed ? <img src={src} alt={reference.name} loading="lazy" className="max-h-full max-w-full object-contain" onError={() => { if (src !== reference.url && reference.url) setSrc(reference.url); else setFailed(true); }} /> : <span className="text-xs text-stone-500">图片暂不可用</span>}
    </div><figcaption className="mt-1 break-words text-xs text-stone-500">{reference.name}</figcaption></figure>;
}

