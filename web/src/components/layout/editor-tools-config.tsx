import { Alert, Button, Select } from "antd";
import { useConfigStore } from "@/stores/use-config-store";
import { editorModels, editorChannel, editorOperationNames } from "@/lib/editor-providers";
import type { EditOperation } from "@/types/image-editor";

export function EditorToolsConfig() {
    const config = useConfigStore((s) => s.config);
    const update = useConfigStore((s) => s.updateConfig);
    const open = useConfigStore((s) => s.openConfigDialog);
    return (
        <div className="space-y-5">
            <Alert type="info" title="先在渠道中添加 fal 或 Azure Vision，再为下列工具选择模型。密钥只在渠道中填写一次。" />
            {(Object.entries(editorOperationNames) as Array<[EditOperation, string]>).map(([operation, label]) => {
                const options = editorModels(config, operation).map(({ value, label }) => ({ value, label }));
                let error = "";
                try {
                    editorChannel(config, operation);
                } catch (e) {
                    error = e instanceof Error ? e.message : "配置无效";
                }
                return (
                    <div key={operation}>
                        <label className="mb-2 block font-medium">{label}</label>
                        <Select
                            aria-label={`${label}模型`}
                            className="w-full"
                            allowClear
                            placeholder="选择渠道与模型"
                            options={options}
                            value={options.some((o) => o.value === config.editorBindings?.[operation]) ? config.editorBindings?.[operation] : undefined}
                            onChange={(value) => update("editorBindings", { ...config.editorBindings, [operation]: value || "" })}
                        />
                        {error && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{error}</p>}
                    </div>
                );
            })}
            <Button onClick={() => open(false, "channels")}>管理渠道</Button>
        </div>
    );
}
