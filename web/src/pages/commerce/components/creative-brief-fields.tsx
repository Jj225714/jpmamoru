import { Input, Select } from "antd";
import type { CommerceCreativeBrief } from "@/types/commerce";

export type CreativeBriefFieldsProps = { value?: CommerceCreativeBrief; onChange: (value: CommerceCreativeBrief) => void };

export function CreativeBriefFields({ value = {}, onChange }: CreativeBriefFieldsProps) {
    const patch = (key: keyof CommerceCreativeBrief, next: string | undefined) => onChange({ ...value, [key]: next || undefined });
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            <label>
                场景
                <Input value={value.scene || ""} placeholder="自动 / 继承方案场景" onChange={(event) => patch("scene", event.target.value)} />
            </label>
            <label>
                目标受众
                <Input value={value.audience || ""} placeholder="自动 / 继承商品受众" onChange={(event) => patch("audience", event.target.value)} />
            </label>
            <label>
                光线
                <Select
                    className="w-full"
                    value={value.lighting || ""}
                    options={[
                        { value: "", label: "自动 / 继承" },
                        { value: "natural-window", label: "自然窗光" },
                        { value: "soft-studio", label: "柔和棚光" },
                        { value: "warm-indoor", label: "暖色室内" },
                        { value: "side-light", label: "侧光" },
                    ]}
                    onChange={(next) => patch("lighting", next)}
                />
            </label>
            <label>
                人物
                <Select
                    className="w-full"
                    value={value.people || ""}
                    options={[
                        { value: "", label: "自动 / 继承" },
                        { value: "none", label: "无人" },
                        { value: "adult-partial", label: "成人手部 / 局部" },
                        { value: "adult-half", label: "成人半身" },
                        { value: "adult-full", label: "成人全身" },
                    ]}
                    onChange={(next) => patch("people", next)}
                />
                <span className="text-xs text-stone-500">人物不得遮挡商品关键结构；自动会参考方案建议。</span>
            </label>
            <label>
                取景
                <Select
                    className="w-full"
                    value={value.framing || ""}
                    options={[
                        { value: "", label: "继承" },
                        { value: "auto", label: "自动取景" },
                        { value: "close", label: "近景" },
                        { value: "medium", label: "中景" },
                        { value: "wide", label: "全景" },
                    ]}
                    onChange={(next) => patch("framing", next)}
                />
            </label>
        </div>
    );
}
