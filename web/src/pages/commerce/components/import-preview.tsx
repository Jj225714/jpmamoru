import { Alert, App, Button, Card, Checkbox, Image, Input, Select, Space, Upload } from "antd";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import { uploadImage } from "@/services/image-storage";
import { getCommerceAccountEpoch } from "@/lib/commerce/request-session";
import { unassignedImportImages, validateImportPreview, type ImportPreviewRow, type ImportPreviewState } from "@/lib/commerce/importers-preview";
import type { StoredImageRef } from "@/types/commerce";

export function ImportPreview({ value, onChange }: { value: ImportPreviewState; onChange: (value: ImportPreviewState) => void }) {
    const { message } = App.useApp();
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const latest = useRef(value);
    latest.current = value;
    const [uploading, setUploading] = useState(false);
    const update = (next: ImportPreviewState) => {
        latest.current = next;
        onChange(next);
    };
    const patch = (id: string, change: (row: ImportPreviewRow) => ImportPreviewRow) => update({ ...latest.current, rows: latest.current.rows.map((row) => (row.product.id === id ? change(row) : row)), unassignedConfirmed: false });
    const setImages = (id: string, images: StoredImageRef[]) => patch(id, (row) => ({ ...row, mappingConfirmed: false, product: { ...row.product, images } }));
    const validation = validateImportPreview(value);
    const unassigned = unassignedImportImages(value);
    return (
        <Space direction="vertical" style={{ width: "100%" }}>
            <Alert type="info" message="核对 SKU、图片及顺序后逐行确认。缺图可创建，补图后才能生成。" />
            {value.rows.map((row) => (
                <Card key={row.product.id} size="small" title={row.product.name}>
                    <Space direction="vertical" style={{ width: "100%" }}>
                        <Input
                            aria-label={`SKU ${row.product.name}`}
                            addonBefore="SKU"
                            value={row.product.sku}
                            onChange={(event) => patch(row.product.id, (current) => ({ ...current, mappingConfirmed: false, product: { ...current.product, sku: event.target.value } }))}
                        />
                        {!!row.issues.length && <Alert type={row.mappingConfirmed ? "info" : "warning"} message={row.issues.join("；")} description={row.mappingConfirmed ? "已人工核对当前映射" : "请手动纠正，或明确确认当前映射（可保留缺图）"} />}
                        <Select
                            aria-label={`选择 ${row.product.sku} 图片`}
                            mode="multiple"
                            style={{ width: "100%" }}
                            placeholder="选择商品图片（最多 6 张）"
                            value={row.product.images.map((image) => image.id)}
                            options={value.candidates.map((image) => ({ value: image.id, label: image.name, disabled: row.product.images.length >= 6 && !row.product.images.some((selected) => selected.id === image.id) }))}
                            onChange={(ids: string[]) =>
                                setImages(
                                    row.product.id,
                                    ids.slice(0, 6).flatMap((id) => value.candidates.find((image) => image.id === id) || []),
                                )
                            }
                        />
                        <Space wrap align="start">
                            {row.product.images.map((image, index) => (
                                <Space key={image.id} direction="vertical" style={{ width: 130 }}>
                                    <Image src={image.url} width={100} height={90} style={{ objectFit: "contain" }} alt={image.name} />
                                    <span style={{ wordBreak: "break-all" }}>
                                        {index + 1}. {image.name}
                                    </span>
                                    <Space size={4}>
                                        <Button
                                            size="small"
                                            disabled={!index}
                                            onClick={() => {
                                                const images = [...row.product.images];
                                                [images[index - 1], images[index]] = [images[index], images[index - 1]];
                                                setImages(row.product.id, images);
                                            }}
                                        >
                                            前移
                                        </Button>
                                        <Button
                                            size="small"
                                            onClick={() =>
                                                setImages(
                                                    row.product.id,
                                                    row.product.images.filter((item) => item.id !== image.id),
                                                )
                                            }
                                        >
                                            移除
                                        </Button>
                                    </Space>
                                </Space>
                            ))}
                        </Space>
                        <Select
                            allowClear
                            aria-label={`选择 ${row.product.sku} 尺码图`}
                            style={{ width: "100%" }}
                            placeholder="可选尺码图"
                            value={row.product.sizeImage?.id}
                            options={value.candidates.map((image) => ({ value: image.id, label: image.name }))}
                            onChange={(id?: string) => patch(row.product.id, (current) => ({ ...current, mappingConfirmed: false, product: { ...current.product, sizeImage: value.candidates.find((image) => image.id === id) } }))}
                        />
                        <Upload
                            accept="image/png,image/jpeg,image/webp"
                            showUploadList={false}
                            disabled={uploading || row.product.images.length >= 6}
                            beforeUpload={async (file) => {
                                const epoch = getCommerceAccountEpoch();
                                setUploading(true);
                                patch(row.product.id, (current) => ({ ...current, mappingConfirmed: false }));
                                try {
                                    const stored = await uploadImage(file);
                                    if (!mounted.current || getCommerceAccountEpoch() !== epoch || !latest.current.rows.some((item) => item.product.id === row.product.id)) return false;
                                    const image: StoredImageRef = { id: nanoid(), name: file.name, url: stored.url, storageKey: stored.storageKey, source: "upload" };
                                    const state = latest.current;
                                    update({
                                        ...state,
                                        candidates: [...state.candidates, image],
                                        unassignedConfirmed: false,
                                        rows: state.rows.map((item) => (item.product.id === row.product.id ? { ...item, mappingConfirmed: false, product: { ...item.product, images: [...item.product.images, image].slice(0, 6) } } : item)),
                                    });
                                } catch (error) {
                                    void message.error(error instanceof Error ? error.message : "图片上传失败");
                                } finally {
                                    setUploading(false);
                                }
                                return false;
                            }}
                        >
                            <Button loading={uploading} disabled={row.product.images.length >= 6}>
                                上传补图
                            </Button>
                        </Upload>
                        <Checkbox checked={row.mappingConfirmed} disabled={uploading} onChange={(event) => patch(row.product.id, (current) => ({ ...current, mappingConfirmed: event.target.checked }))}>
                            我已核对该 SKU 和当前图片映射{!row.product.images.length ? "，接受暂时缺图" : ""}
                        </Checkbox>
                    </Space>
                </Card>
            ))}
            {!!unassigned.length && (
                <Card size="small" title={`未使用候选图片（${unassigned.length}）`}>
                    <Space wrap>
                        {unassigned.map((image) => (
                            <Space key={image.id} direction="vertical" style={{ width: 140 }}>
                                <Image width={80} height={70} style={{ objectFit: "contain" }} src={image.url} alt={image.name} />
                                <span style={{ wordBreak: "break-all" }}>{image.name}</span>
                            </Space>
                        ))}
                    </Space>
                    <div>
                        <Checkbox checked={value.unassignedConfirmed} onChange={(event) => update({ ...latest.current, unassignedConfirmed: event.target.checked })}>
                            确认这些图片暂不使用（包括根目录或无法匹配的图片）
                        </Checkbox>
                    </div>
                </Card>
            )}
            {!!validation.errors.length && <Alert type="warning" message="创建前请完成核对" description={validation.errors.join("；")} />}
            {!!validation.warnings.length && <Alert type="info" message={validation.warnings.join("；")} />}
        </Space>
    );
}
