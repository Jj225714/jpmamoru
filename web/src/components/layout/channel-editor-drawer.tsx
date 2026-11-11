import { Button, Drawer, Input, Segmented, Select, Space } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { editorPresets, editorOperationNames, type ChannelProvider } from "@/lib/editor-providers";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    useEffect(() => {
        if (open && channel) setDraft(channel);
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => map.get(name) || { name, capability: guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => {
        if (model.name !== name) return model;
        const { supportsImageInput: _previous, ...rest } = model;
        return capability === model.capability ? model : { ...rest, capability };
    }));
    const setImageInput = (name: string, value: "unknown" | "yes" | "no") => setModels(draft.models.map((model) => {
        if (model.name !== name || model.capability !== "text") return model;
        const { supportsImageInput: _previous, ...rest } = model;
        return value === "unknown" ? rest : { ...rest, supportsImageInput: value === "yes" };
    }));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        onSave({ ...draft, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models).map((model) => {
            if (model.capability === "text" && (!draft.provider || draft.provider === "general")) return model;
            const { supportsImageInput: _unused, ...rest } = model;
            return rest;
        }) });
        onClose();
    };

    return (
        <Drawer
            open={open}
            zIndex={1400}
            width={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">服务类型</span>
                    <Select
                        aria-label="服务类型"
                        className="w-full"
                        value={draft.provider || "general"}
                        options={[
                            { value: "general", label: "通用模型（OpenAI / Gemini）" },
                            { value: "fal", label: "fal 图片工具" },
                            { value: "azure-vision", label: "Azure Vision 文字识别" },
                        ]}
                        onChange={(provider: ChannelProvider) =>
                            patch({
                                provider,
                                apiKey: "",
                                baseUrl: provider === "fal" ? "https://queue.fal.run" : provider === "azure-vision" ? "" : defaultBaseUrlForApiFormat(draft.apiFormat),
                                models: provider === "general" ? [] : structuredClone(editorPresets[provider]),
                            })
                        }
                    />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input aria-label="渠道名称" value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                {(!draft.provider || draft.provider === "general") && (
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                        <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                    </label>
                )}
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input
                        aria-label="接口地址"
                        value={draft.baseUrl}
                        onChange={(event) => patch({ baseUrl: event.target.value })}
                        placeholder={draft.provider === "azure-vision" ? "https://资源名.cognitiveservices.azure.com" : "https://api.example.com"}
                    />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password aria-label="渠道 API Key" value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                {!draft.provider || draft.provider === "general" ? (
                    <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                        {t("config.channelEditor.selectModels")}
                    </Button>
                ) : (
                    <Button onClick={() => setModels(structuredClone(editorPresets[draft.provider as "fal" | "azure-vision"]))}>恢复预设模型</Button>
                )}
            </div>

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                {model.name}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                                {!draft.provider || draft.provider === "general" ? (
                                    <>
                                        <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                        <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                            {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                        </Button>
                                    </>
                                ) : (
                                    <span className="text-xs text-stone-500">{model.editorOperations?.map((op) => editorOperationNames[op]).join(" / ")}</span>
                                )}
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                            {model.capability === "text" && (!draft.provider || draft.provider === "general") ? (
                                <div className="w-full space-y-1 pb-1">
                                    <label className="flex flex-wrap items-center gap-2 text-sm">
                                        <span>支持图片输入</span>
                                        <Select
                                            aria-label={`${model.name} 支持图片输入`}
                                            className="min-w-40"
                                            value={model.supportsImageInput === true ? "yes" : model.supportsImageInput === false ? "no" : "unknown"}
                                            options={[{ value: "unknown", label: "未确认" }, { value: "yes", label: "支持" }, { value: "no", label: "不支持" }]}
                                            onChange={(value: "unknown" | "yes" | "no") => setImageInput(model.name, value)}
                                        />
                                    </label>
                                    <p className="text-xs text-stone-500">用于商品图片识别。请根据服务商说明或实际验证确认；文本模型不一定支持图片输入。</p>
                                </div>
                            ) : null}
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            {draft.models.some((model) => model.capability === "text") && (!draft.provider || draft.provider === "general") ? <p className="mt-3 text-xs text-stone-500">保存渠道后，团队管理员需在「账号与同步」保存当前渠道与模型为草稿并发布，成员重新读取团队配置后生效。</p> : null}

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}
