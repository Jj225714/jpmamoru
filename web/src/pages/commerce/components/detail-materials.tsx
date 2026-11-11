import { Button, Card, Checkbox, Image, Input, Select, Upload } from "antd";
import { ReferenceReadiness } from "@/pages/image/reference-readiness";
import { ReferenceReadinessPanel } from "@/pages/image/reference-readiness-panel";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { CommerceDetailImage, DetailImagePurpose, ProductRecord, StoredImageRef } from "@/types/commerce";

export const DETAIL_PURPOSES: { value: DetailImagePurpose; label: string }[] = [
    { value: "front-texture", label: "正面纹理" },
    { value: "back", label: "背面" },
    { value: "edge", label: "边缘" },
    { value: "side", label: "侧面" },
    { value: "accessory", label: "配件" },
    { value: "other", label: "其他" },
];
export async function materialHash(blob: Blob) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
export function DetailMaterials({ product, onChange, queue, disabled = false }: { product: ProductRecord; onChange: (detailImages: CommerceDetailImage[]) => void; queue: ReferenceReadiness; disabled?: boolean }) {
    const busy = disabled || !queue.ready();
    const [previews, setPreviews] = useState<Record<string, string>>({});
    const materials = product.detailImages || [];
    const latest = useRef({ materials, onChange });
    latest.current = { materials, onChange };
    useEffect(() => {
        let cancelled = false;
        void Promise.all(materials.map(async (item) => [item.id, await resolveImageUrl(item.storageKey, item.url)] as const))
            .then((entries) => {
                if (!cancelled) setPreviews(Object.fromEntries(entries));
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [product.detailImages]);
    const save = (id: string, patch: Partial<CommerceDetailImage>) => onChange(materials.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    const add = (input: File | StoredImageRef, replaceId?: string) => {
        if (disabled) return;
        queue.add(input.name, async () => {
            const blob =
                input instanceof File
                    ? input
                    : await fetch(await resolveImageUrl(input.storageKey, input.url)).then((r) => {
                          if (!r.ok) throw new Error("原图不可读取");
                          return r.blob();
                      });
            const stored = await uploadImage(blob);
            const contentHash = await materialHash(blob);
            return { ...stored, name: input.name, contentHash };
        }, (stored) => {
            const next: CommerceDetailImage[] = replaceId
                ? latest.current.materials.map((item) => item.id === replaceId ? { ...item, ...stored } : item)
                : [...latest.current.materials, { ...stored, id: nanoid(), source: "upload", purposes: [], variantKey: "", shared: false }];
            latest.current.materials = next;
            latest.current.onChange(next);
        });
    };
    return (
        <Card title="SKU 细节实拍素材">
            <ReferenceReadinessPanel queue={queue} />
            <p className="mb-3 text-sm text-stone-500">按真实拍摄内容标记用途，再在细节方案中明确绑定。缺少对应照片时，请补图或关闭方案。仅明确勾选通用的素材可跨变体使用。</p>
            <div className="mb-3 flex gap-2">
                <Upload
                    disabled={busy}
                    accept="image/*"
                    showUploadList={false}
                    beforeUpload={(file) => {
                        void add(file);
                        return false;
                    }}
                >
                    <Button loading={busy}>上传实拍</Button>
                </Upload>
                <Select
                    disabled={busy}
                    className="min-w-48"
                    placeholder="复用已有商品实拍"
                    value={undefined}
                    options={product.images.map((image) => ({ value: image.id, label: image.name }))}
                    onChange={(id) => {
                        const image = product.images.find((item) => item.id === id);
                        if (image) void add(image);
                    }}
                />
            </div>
            <div className="space-y-3">
                {materials.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-3 rounded border p-3">
                        <Image width={80} height={80} style={{ objectFit: "contain" }} src={previews[item.id] || item.url} alt={item.name} />
                        <span>{item.name}</span>
                        <Select disabled={busy} aria-label="素材用途" mode="multiple" className="min-w-56" value={item.purposes} options={DETAIL_PURPOSES} onChange={(purposes) => save(item.id, { purposes })} />
                        <Input disabled={busy} aria-label="素材变体" className="!w-36" placeholder="留空：当前商品" value={item.variantKey} onChange={(e) => save(item.id, { variantKey: e.target.value })} />
                        <Checkbox disabled={busy} checked={item.shared} onChange={(e) => save(item.id, { shared: e.target.checked })}>
                            所有变体通用
                        </Checkbox>
                        <Upload
                            disabled={busy}
                            accept="image/*"
                            showUploadList={false}
                            beforeUpload={(file) => {
                                void add(file, item.id);
                                return false;
                            }}
                        >
                            <Button disabled={busy}>替换</Button>
                        </Upload>
                        <Button disabled={busy} danger onClick={() => onChange(materials.filter((image) => image.id !== item.id))}>
                            移除
                        </Button>
                    </div>
                ))}
            </div>
        </Card>
    );
}
