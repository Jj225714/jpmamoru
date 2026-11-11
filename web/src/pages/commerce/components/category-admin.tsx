import { Alert, App, Button, Card, Checkbox, Collapse, Image, Input, InputNumber, Modal, Select, Space, Tabs, Tag, Upload } from "antd";
import { nanoid } from "nanoid";
import { useEffect, useState } from "react";
import { apiSettingsRequest, loadTeamDraft, saveTeamDraft, publishTeamDraft, reloadTeamConfiguration, uploadSettingsAsset, useServerConfigStore } from "@/services/server-config";
import { captureLocalTeamSettings, prepareTeamSettingsForServer } from "@/services/settings-data";
import type { TeamSettings, SettingsSection, SettingsEnvelope } from "@/types/settings-sync";
import { prepareCategoryTeamDraft } from "./category-team-draft";
import { getCommerceAccountEpoch } from "@/lib/commerce/request-session";
import { TeamBrandEditor } from "./team-brand-editor";
import { addSmallGlassMousePad, createCategorySeedPack, SMALL_GLASS_MOUSE_PAD_ID } from "@/lib/commerce/category-seed";
import { resolveCategory } from "@/lib/commerce/category-rules";

import type { CommerceCategory, CommerceRequirementPreset, PolicyPack } from "@/types/commerce";
import { DETAIL_PURPOSES } from "./detail-materials";
import { CreativeBriefFields } from "./creative-brief-fields";

const stages = [
    { value: "scene", label: "场景" },
    { value: "usage-size", label: "使用场景" },
    { value: "detail", label: "细节" },
    { value: "detail-white", label: "白底细节" },
];
export function CategoryAdmin({ activePack, onPublished }: { activePack?: PolicyPack; onPublished: () => void | Promise<unknown> }) {
    const { message, modal } = App.useApp();
    const sync = useServerConfigStore();
    const [state, setState] = useState<{ revision: number; activeVersion: number; canManage: boolean; history: Array<{ version: number; publishedAt: string }> }>();
    const [brands, setBrands] = useState<TeamSettings["brands"]>([]);
    const [draft, setDraft] = useState<PolicyPack>();
    const [selected, setSelected] = useState<string>();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [preview, setPreview] = useState(false);
    const receive = (data: SettingsSection<TeamSettings>) => {
        const current = useServerConfigStore.getState();
        setState({ revision: data.revision, activeVersion: current.serverTeam?.policyPack.version || 0, canManage: current.manageTeam, history: [] });
        const value = data.value || current.serverTeam || captureLocalTeamSettings();
        setDraft(value?.policyPack || activePack);
        setBrands(value?.brands || []);
        setDirty(false);
        setError("");
    };
    const run = async (task: () => Promise<void>) => {
        setBusy(true);
        try {
            await task();
        } catch (e) {
            setError(e instanceof Error ? e.message : "操作失败");
        } finally {
            setBusy(false);
        }
    };
    const refresh = () =>
        run(async () => {
            if (!useServerConfigStore.getState().user) return;
            if (useServerConfigStore.getState().manageTeam) {
                receive(await loadTeamDraft());
                const result = await apiSettingsRequest<{ history: Array<{ version: number; savedAt: string }> }>("/settings/team/history");
                setState((s) => (s ? { ...s, history: result.history.map((entry) => ({ version: entry.version, publishedAt: entry.savedAt })) } : s));
            }
        });
    useEffect(() => {
        setDraft(undefined);
        setState(undefined);
        setDirty(false);
        setBrands([]);
        setError("");
        if (sync.user && sync.manageTeam) void refresh();
    }, [sync.user?.id, sync.manageTeam]);
    const edit = (next: PolicyPack) => {
        setDraft(next);
        setDirty(true);
    };
    useEffect(() => {
        if (sync.teamDraft && state && sync.teamDraft.revision !== state.revision && !dirty) receive(sync.teamDraft);
    }, [sync.teamDraft?.revision, dirty, state?.revision]);
    const nodes = draft?.categories || [];
    const node = nodes.find((item) => item.id === selected);
    const update = (patch: Partial<CommerceCategory>) => {
        if (draft && node) edit({ ...draft, categories: nodes.map((item) => (item.id === node.id ? { ...item, ...patch } : item)) });
    };
    const add = (parentId?: string) => {
        if (!draft) return;
        const id = `category-${nanoid()}`;
        edit({ ...draft, categories: [...nodes, { id, parentId, name: "新类目", aliases: [], active: false, order: nodes.length + 1, rules: [], referenceIds: [], requirementIds: [] }] });
        setSelected(id);
    };
    const copyCategory = () => {
        if (!draft || !node) return;
        const id = `category-${nanoid()}`;
        const resolved = resolveCategory(draft, { category: node.name, categoryId: node.parentId || node.id, subcategoryId: node.parentId ? node.id : undefined });
        const recipes = (resolved?.requirementIds || []).flatMap((recipeId) => {
            const recipe = draft.requirementPresets.find((item) => item.id === recipeId);
            return recipe ? [{ ...structuredClone(recipe), id: `recipe-${nanoid()}`, category: id }] : [];
        });
        let name = `${node.name} 副本`;
        if (nodes.some((item) => item.name === name)) name += ` ${nanoid(4)}`;
        const copied: CommerceCategory = { ...structuredClone(node), id, name, aliases: [], active: false, order: nodes.length + 1, requirementIds: recipes.map((recipe) => recipe.id) };
        edit({ ...draft, categories: [...nodes, copied], requirementPresets: [...draft.requirementPresets, ...recipes] });
        setSelected(id);
    };
    const prepareLatest = async () => {
        if (!draft || !state) throw new Error("请先读取团队草稿");
        const account = useServerConfigStore.getState().user?.id;
        const epoch = getCommerceAccountEpoch();
        const isCurrent = () => useServerConfigStore.getState().user?.id === account && getCommerceAccountEpoch() === epoch;
        return prepareCategoryTeamDraft({ policyPack: draft, brands }, state.revision, {
            load: () => apiSettingsRequest<SettingsEnvelope>("/settings"),
            prepare: (value) => prepareTeamSettingsForServer(value, uploadSettingsAsset, isCurrent),
            isCurrent,
        });
    };
    const save = async () => {
        if (!draft || !state) return;
        const { value, revision } = await prepareLatest();
        receive(await saveTeamDraft(value, revision));
        message.success("团队草稿已保存，发布后其他设备才会使用");
    };
    const upload = async (file: Blob, name: string) => {
        if (!draft || !node) return;
        const asset = await uploadSettingsAsset("team", name, file);
        edit({
            ...draft,
            references: [...draft.references.filter((r) => r.id !== asset.id), { id: asset.id, name, url: asset.url, source: "rule-reference", sheet: "管理员类目", anchor: node.id, kind: "example" }],
            categories: nodes.map((item) => (item.id === node.id ? { ...item, referenceIds: [...new Set([...item.referenceIds, asset.id])] } : item)),
        });
    };
    const addRecipe = (source?: CommerceRequirementPreset) => {
        if (!draft || !node) return;
        const id = `recipe-${nanoid()}`;
        const recipe: CommerceRequirementPreset = source
            ? { ...source, id, category: node.id, title: source.title + " 副本" }
            : {
                  id,
                  category: node.id,
                  order: draft.requirementPresets.length + 1,
                  title: "新场景方案",
                  stage: "scene",
                  enabledByDefault: true,
                  defaultCount: 1,
                  prompt: "真实呈现商品，遵守所选类目规则。",
                  layout: "single-hero",
                  chineseCopy: "",
                  translationSeeds: {},
                  requiredFacts: [],
                  referenceIds: [],
                  variantScope: "per-sku",
                  needsReview: false,
                  recipeRole: "hero",
              };
        edit({ ...draft, requirementPresets: [...draft.requirementPresets, recipe], categories: nodes.map((item) => (item.id === node.id ? { ...item, requirementIds: [...item.requirementIds, id] } : item)) });
    };
    const patchRecipe = (id: string, patch: Partial<CommerceRequirementPreset>) => {
        if (draft) edit({ ...draft, requirementPresets: draft.requirementPresets.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
    };
    return (
        <div className="space-y-4">
            <Alert type="info" showIcon title="平台类目规则" description="使用顶部统一账号登录，服务端授予团队管理权限的账号可编辑发布。草稿不影响现有任务；发布及回滚形成新版本，旧任务保持绑定版本。" />
            {!sync.user ? <Alert type="warning" title="请在顶部「账号与同步」登录后管理团队规则。" /> : null}
            {sync.user && !sync.manageTeam ? <Alert type="info" title="当前账号可查看团队规则；修改与发布需管理员授权。" /> : null}
            {error ? <Alert type="error" showIcon title={error} description="当前草稿修改仍保留。可重试；若提示版本冲突，请先对比服务器草稿。" /> : null}
            {state?.canManage && draft ? (
                <Button
                    disabled={busy}
                    onClick={() =>
                        void run(async () => {
                            const latest = await loadTeamDraft();
                            const localNodes = draft.categories || [];
                            const remoteNodes = latest.value?.policyPack.categories || [];
                            const ids = new Set([...localNodes.map((n) => n.id), ...remoteNodes.map((n) => n.id)]);
                            const changes = [...ids].flatMap((id) => {
                                const a = localNodes.find((n) => n.id === id),
                                    b = remoteNodes.find((n) => n.id === id);
                                return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${a?.name || b?.name}：${!a ? "仅服务器有" : !b ? "仅当前草稿有" : "要求、示例或方案绑定有差异"}`];
                            });
                            modal.info({
                                title: `与服务器草稿修订 ${latest.revision} 对比`,
                                content: (
                                    <div>
                                        <p>品牌与出图默认值：{JSON.stringify(brands) === JSON.stringify(latest.value?.brands) ? "一致" : "存在差异"}</p>
                                        <p>国家规则、模板及方案：{JSON.stringify(draft) === JSON.stringify(latest.value?.policyPack) ? "一致" : "存在差异"}</p>
                                        {changes.map((line) => (
                                            <p key={line}>{line}</p>
                                        ))}
                                        <p>刷新将读取服务器草稿；未确认刷新前保留当前编辑。</p>
                                    </div>
                                ),
                            });
                        })
                    }
                >
                    对比服务器草稿
                </Button>
            ) : null}
            <Space wrap>
                <Button
                    loading={busy}
                    onClick={() => {
                        if (dirty) modal.confirm({ title: "放弃未保存修改并刷新？", onOk: refresh });
                        else void refresh();
                    }}
                >
                    刷新
                </Button>
                <Tag>当前发布版本 {state?.activeVersion ?? "无"}</Tag>
                <Tag>草稿修订 {state?.revision ?? "—"}</Tag>
                {dirty ? <Tag color="orange">未保存</Tag> : null}
            </Space>
            {state && !state.canManage ? <Alert type="warning" title="当前账号为只读，无类目管理权限。请联系平台管理员授权后刷新。" /> : null}
            {state?.canManage && draft?.categories?.some((item) => item.id === "table-mats") && !draft.categories.some((item) => item.id === SMALL_GLASS_MOUSE_PAD_ID) ? (
                <Button onClick={() => edit(addSmallGlassMousePad(draft))}>将小型玻璃鼠标垫加入草稿（保存并发布后生效）</Button>
            ) : null}
            {state?.canManage && !draft?.categories?.length ? (
                <Button
                    disabled={!draft && !activePack}
                    loading={busy}
                    onClick={() => {
                        const base = draft || activePack;
                        if (base) {
                            edit(createCategorySeedPack(base));
                        }
                    }}
                >
                    从当前规则创建类目草稿
                </Button>
            ) : null}
            {state?.canManage && draft ? (
                <>
                    <Space wrap>
                        <Button disabled={busy} onClick={() => add()}>
                            新增大类
                        </Button>
                        <Button loading={busy} onClick={() => void run(save)}>
                            保存草稿
                        </Button>
                        <Button
                            disabled={busy}
                            onClick={() =>
                                void run(async () => {
                                    const { value } = await prepareLatest();
                                    const result = await apiSettingsRequest<{ valid: boolean; errors?: string[] }>("/settings/team/validate", "POST", { value });
                                    if (!result.valid) setError((result.errors || ["校验失败"]).join("；"));
                                    else {
                                        setError("");
                                        message.success("结构化校验通过，请人工校对最终规则");
                                    }
                                })
                            }
                        >
                            校验
                        </Button>
                        <Button onClick={() => setPreview(true)}>最终生效预览</Button>
                        <Button
                            type="primary"
                            disabled={dirty || busy}
                            onClick={() =>
                                modal.confirm({
                                    title: "发布当前已保存草稿？",
                                    content: "请先在最终预览中人工校对自由文字规则。发布只用于新建或升级任务。",
                                    onOk: () =>
                                        run(async () => {
                                            await publishTeamDraft(state.revision);
                                            await refresh();
                                            await onPublished();
                                            message.success("类目规则已发布");
                                        }),
                                })
                            }
                        >
                            发布已保存草稿
                        </Button>
                    </Space>
                    <TeamBrandEditor
                        brands={brands}
                        pack={draft}
                        disabled={busy}
                        onChange={(value) => {
                            setBrands(value);
                            setDirty(true);
                        }}
                    />
                    <div className="grid gap-4 lg:grid-cols-[250px_1fr]">
                        <Card title="类目树">
                            <div className="space-y-2">
                                {nodes
                                    .filter((item) => !item.parentId)
                                    .sort((a, b) => a.order - b.order)
                                    .map((parent) => (
                                        <div key={parent.id}>
                                            <Button block type={selected === parent.id ? "primary" : "default"} onClick={() => setSelected(parent.id)}>
                                                {parent.name}
                                                {!parent.active ? "（停用）" : ""}
                                            </Button>
                                            {nodes
                                                .filter((item) => item.parentId === parent.id)
                                                .sort((a, b) => a.order - b.order)
                                                .map((child) => (
                                                    <Button block className="mt-1" key={child.id} type={selected === child.id ? "primary" : "text"} onClick={() => setSelected(child.id)}>
                                                        ↳ {child.name}
                                                        {!child.active ? "（停用）" : ""}
                                                    </Button>
                                                ))}
                                        </div>
                                    ))}
                            </div>
                        </Card>
                        {node ? (
                            <Card title={node.name}>
                                <div className="space-y-4">
                                    <div className="text-xs text-stone-500">稳定 ID：{node.id}</div>
                                    <Input aria-label="类目名称" value={node.name} onChange={(e) => update({ name: e.target.value })} />
                                    <Select aria-label="精确别名" mode="tags" className="w-full" placeholder="精确别名" value={node.aliases} onChange={(aliases) => update({ aliases })} />
                                    <Select
                                        aria-label="所属大类"
                                        className="w-full"
                                        allowClear
                                        placeholder="无父级（作为大类）"
                                        value={node.parentId}
                                        disabled={nodes.some((item) => item.parentId === node.id)}
                                        options={nodes.filter((item) => !item.parentId && item.id !== node.id).map((item) => ({ value: item.id, label: item.name }))}
                                        onChange={(parentId) => update({ parentId })}
                                    />
                                    {node.source ? (
                                        <Collapse items={[{ key: "source", label: `原始来源：${node.source.fileName} · ${node.source.sheet} ${node.source.range}`, children: <p className="whitespace-pre-wrap">{node.source.originalText}</p> }]} />
                                    ) : null}
                                    <Space wrap>
                                        <Checkbox checked={node.active} onChange={(e) => update({ active: e.target.checked })}>
                                            启用
                                        </Checkbox>
                                        <InputNumber aria-label="类目排序" value={node.order} onChange={(order) => update({ order: order ?? 0 })} />
                                        {!node.parentId ? <Button onClick={() => add(node.id)}>新增子类</Button> : null}
                                        <Button onClick={copyCategory}>复制当前类目</Button>
                                        <Button danger onClick={() => update({ active: false })}>
                                            停用类目（保留历史）
                                        </Button>
                                    </Space>
                                    <h3>类目规则</h3>
                                    <CreativeBriefFields value={node.creativeBrief} onChange={(creativeBrief) => update({ creativeBrief })} />
                                    <p className="text-sm text-stone-500">父级强制规则自动继承，子类不能弱化。结构化条件可自动检测冲突，自由文字需人工校对。</p>
                                    {node.rules.map((rule) => (
                                        <div key={rule.id} className="space-y-2 rounded border p-2">
                                            <Input.TextArea value={rule.text} aria-label="规则内容" onChange={(e) => update({ rules: node.rules.map((r) => (r.id === rule.id ? { ...r, text: e.target.value } : r)) })} />
                                            <Space wrap>
                                                <Select
                                                    value={rule.strength}
                                                    options={[
                                                        { value: "required", label: "强制" },
                                                        { value: "guide", label: "建议" },
                                                    ]}
                                                    onChange={(strength) => update({ rules: node.rules.map((r) => (r.id === rule.id ? { ...r, strength } : r)) })}
                                                />
                                                <Select mode="multiple" className="min-w-60" value={rule.stages} options={stages} onChange={(value) => update({ rules: node.rules.map((r) => (r.id === rule.id ? { ...r, stages: value } : r)) })} />
                                                <Select
                                                    allowClear
                                                    placeholder="结构化条件"
                                                    value={rule.key}
                                                    options={[
                                                        { value: "people", label: "人物" },
                                                        { value: "scene", label: "场景" },
                                                    ]}
                                                    onChange={(key) => update({ rules: node.rules.map((r) => (r.id === rule.id ? { ...r, key, value: key ? r.value : undefined } : r)) })}
                                                />
                                                {rule.key === "people" ? (
                                                    <Select
                                                        aria-label="人物规则"
                                                        value={rule.value}
                                                        options={[
                                                            { value: "none", label: "无人" },
                                                            { value: "adult-partial", label: "成人局部" },
                                                            { value: "adult-half", label: "成人半身" },
                                                            { value: "adult-full", label: "成人全身" },
                                                        ]}
                                                        onChange={(value) => update({ rules: node.rules.map((r) => (r.id === rule.id ? { ...r, value } : r)) })}
                                                    />
                                                ) : rule.key ? (
                                                    <Input aria-label="结构化条件值" value={rule.value} onChange={(e) => update({ rules: node.rules.map((r) => (r.id === rule.id ? { ...r, value: e.target.value } : r)) })} />
                                                ) : null}
                                                <Button danger onClick={() => update({ rules: node.rules.filter((r) => r.id !== rule.id) })}>
                                                    删除规则
                                                </Button>
                                            </Space>
                                        </div>
                                    ))}
                                    <Button onClick={() => update({ rules: [...node.rules, { id: nanoid(), text: "", strength: "required", stages: ["scene", "usage-size"] }] })}>新增规则</Button>
                                    <h3>场景示例（子类优先，父类兜底）</h3>
                                    <div className="flex flex-wrap gap-3">
                                        {node.referenceIds.map((id) => {
                                            const ref = draft.references.find((r) => r.id === id);
                                            return (
                                                <div key={id}>
                                                    {ref ? <Image width={100} src={ref.url} alt={ref.name} /> : <Tag color="red">缺失 {id}</Tag>}
                                                    <Button onClick={() => update({ referenceIds: node.referenceIds.filter((r) => r !== id) })}>移除</Button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <Upload
                                        accept="image/png,image/jpeg,image/webp"
                                        showUploadList={false}
                                        beforeUpload={(file) => {
                                            void run(() => upload(file, file.name));
                                            return false;
                                        }}
                                    >
                                        <Button loading={busy}>上传公共示例</Button>
                                    </Upload>
                                    <h3>推荐方案</h3>
                                    <Select mode="multiple" className="w-full" value={node.requirementIds} options={draft.requirementPresets.map((r) => ({ value: r.id, label: r.title }))} onChange={(requirementIds) => update({ requirementIds })} />
                                    <Space>
                                        <Button onClick={() => addRecipe()}>新增方案</Button>
                                        <Select
                                            value={undefined}
                                            placeholder="复制现有方案"
                                            className="min-w-48"
                                            options={draft.requirementPresets.map((r) => ({ value: r.id, label: r.title }))}
                                            onChange={(id) => addRecipe(draft.requirementPresets.find((r) => r.id === id))}
                                        />
                                    </Space>
                                    <Collapse
                                        items={draft.requirementPresets
                                            .filter((r) => node.requirementIds.includes(r.id))
                                            .map((recipe) => ({
                                                key: recipe.id,
                                                label: recipe.title,
                                                children: (
                                                    <div className="space-y-2">
                                                        <Input value={recipe.title} aria-label="方案名称" onChange={(e) => patchRecipe(recipe.id, { title: e.target.value })} />
                                                        <Select
                                                            value={recipe.stage}
                                                            options={[...stages, { value: "marketing", label: "营销场景" }]}
                                                            onChange={(stage) => patchRecipe(recipe.id, { stage, visualKind: stage === "marketing" ? "scene" : stage, recipeRole: stage === "detail" || stage === "detail-white" ? "detail" : "hero" })}
                                                        />
                                                        <Input.TextArea aria-label="方案提示词" value={recipe.prompt} onChange={(e) => patchRecipe(recipe.id, { prompt: e.target.value })} />
                                                        <InputNumber min={1} max={4} value={recipe.defaultCount} onChange={(defaultCount) => patchRecipe(recipe.id, { defaultCount: defaultCount || 1 })} />
                                                        <Checkbox checked={recipe.enabledByDefault} onChange={(e) => patchRecipe(recipe.id, { enabledByDefault: e.target.checked })}>
                                                            默认启用
                                                        </Checkbox>
                                                        {recipe.stage === "detail" || recipe.stage === "detail-white" ? (
                                                            <Select
                                                                aria-label="细节所需用途"
                                                                placeholder="必须选择实拍用途"
                                                                value={recipe.detailPurpose}
                                                                options={DETAIL_PURPOSES}
                                                                onChange={(detailPurpose) => patchRecipe(recipe.id, { detailPurpose, recipeRole: "detail" })}
                                                            />
                                                        ) : null}
                                                    </div>
                                                ),
                                            }))}
                                    />
                                </div>
                            </Card>
                        ) : (
                            <Card>请选择类目进行编辑</Card>
                        )}
                    </div>
                </>
            ) : null}
            <Card title="发布历史与回滚">
                <div className="space-y-2">
                    {state?.history?.map((entry) => (
                        <div key={entry.version} className="flex items-center justify-between">
                            <span>
                                v{entry.version} · {entry.publishedAt}
                            </span>
                            {state.canManage ? (
                                <Button
                                    disabled={busy || dirty}
                                    onClick={() =>
                                        modal.confirm({
                                            title: `将 v${entry.version} 内容重新发布为新版本？`,
                                            onOk: () =>
                                                run(async () => {
                                                    await apiSettingsRequest("/settings/team/rollback", "POST", { revision: state.revision, version: entry.version });
                                                    await reloadTeamConfiguration();
                                                    await refresh();
                                                    await onPublished();
                                                    message.success("旧内容已重新发布为新版本");
                                                }),
                                        })
                                    }
                                >
                                    回滚至此内容
                                </Button>
                            ) : null}
                        </div>
                    ))}
                </div>
            </Card>
            <Modal title="最终生效预览：请人工校对所有启用类目" open={preview} onCancel={() => setPreview(false)} footer={<Button onClick={() => setPreview(false)}>完成校对</Button>} width={900}>
                <Tabs
                    items={nodes
                        .filter((n) => n.active)
                        .map((n) => {
                            const parent = nodes.find((p) => p.id === n.parentId);
                            const resolved = draft ? resolveCategory(draft, { category: n.name, categoryId: parent?.id || n.id, subcategoryId: n.parentId ? n.id : undefined }) : undefined;
                            const rules = resolved?.rules || [];
                            const references = resolved?.referenceIds || [];
                            return {
                                key: n.id,
                                label: n.name,
                                children: (
                                    <div className="space-y-2">
                                        {rules.map((r) => (
                                            <p key={r.id}>
                                                <Tag color={r.strength === "required" ? "red" : "blue"}>{r.strength === "required" ? "强制" : "建议"}</Tag>
                                                {r.text} <small>适用：{r.stages.map((stage) => stages.find((option) => option.value === stage)?.label || stage).join("、")}</small>
                                            </p>
                                        ))}
                                        {references.map((id) => (
                                            <Image key={id} width={120} src={draft?.references.find((r) => r.id === id)?.url} />
                                        ))}
                                        <p>
                                            方案：
                                            {draft?.requirementPresets
                                                .filter((r) => (n.requirementIds.length ? n.requirementIds : parent?.requirementIds || []).includes(r.id))
                                                .map((r) => r.title)
                                                .join("、")}
                                        </p>
                                    </div>
                                ),
                            };
                        })}
                />
            </Modal>
        </div>
    );
}
