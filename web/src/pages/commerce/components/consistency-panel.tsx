import { Alert, App, Button, Card, Checkbox, Collapse, Input, InputNumber, Select, Space, Table, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { CommerceJob, CommerceSku } from "@/types/commerce";
import type { ConsistencyConstraint, ConsistencyObservations, ConsistencyPoint, ConsistencyUnit } from "@/lib/commerce/consistency-types";
import { createConsistencyDraft, createConsistencyRepairRevision, decideConsistencyReport, saveConsistencyConstraints, saveConsistencyObservations } from "@/lib/commerce/consistency-service";
import { validateConsistencyConstraint } from "@/lib/commerce/consistency-check";
import { imageToDataUrl } from "@/services/image-storage";
import { useServerConfigStore } from "@/services/server-config";

const statuses = { pass: "通过", deviation: "偏差", "not-measurable": "不可量测", "needs-review": "待人工复核" };
const corners = ["左上", "右上", "右下", "左下"];
const units = ["mm", "cm", "in"].map((value) => ({ value, label: value }));
function safeDraft(value: ConsistencyConstraint | undefined) {
    if (!value || validateConsistencyConstraint(value).some((error) => error.includes("结构损坏"))) return undefined;
    return structuredClone(value);
}
function ImagePoints({
    image,
    width,
    height,
    points,
    onPoint,
    label,
}: {
    image?: { url: string; storageKey?: string };
    width: number;
    height: number;
    points: Array<ConsistencyPoint & { name: string }>;
    onPoint: (point: ConsistencyPoint) => void;
    label: string;
}) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let active = true;
        setUrl("");
        if (image)
            void imageToDataUrl(image)
                .then((value) => {
                    if (active) setUrl(value);
                })
                .catch(() => {
                    if (active) setUrl("");
                });
        return () => {
            active = false;
        };
    }, [image?.url, image?.storageKey]);
    return url ? (
        <div style={{ position: "relative", width: "100%", maxWidth: 640, cursor: "crosshair", border: "1px solid #aaa" }}>
            <img
                src={url}
                alt={label}
                style={{ display: "block", width: "100%" }}
                onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    onPoint({ x: Math.round(((event.clientX - rect.left) / rect.width) * width * 100) / 100, y: Math.round(((event.clientY - rect.top) / rect.height) * height * 100) / 100 });
                }}
            />
            <svg aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} viewBox={`0 0 ${width} ${height}`}>
                {points.map((point, index) => (
                    <g key={index}>
                        <circle cx={point.x} cy={point.y} r={Math.max(width / 150, 2)} fill="#eb2f96" stroke="white" />
                        <text x={point.x + width / 100} y={point.y - width / 100} fill="#eb2f96" stroke="white" strokeWidth={width / 600} paintOrder="stroke" fontSize={width / 35}>
                            {point.name}
                        </text>
                    </g>
                ))}
            </svg>
        </div>
    ) : (
        <p>图像尚未读取或不可用。</p>
    );
}

export function ConsistencyPanel({ job, sku, reviewer }: { job: CommerceJob; sku: CommerceSku; reviewer: string }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState(() => safeDraft(sku.consistency?.constraints));
    const [sourceId, setSourceId] = useState(sku.consistency?.constraints?.sourceImageId || sku.product.images[0]?.id);
    const [sourcePoint, setSourcePoint] = useState<string>();
    const [assetId, setAssetId] = useState<string>();
    const [observation, setObservation] = useState<ConsistencyObservations>();
    const [resultPoint, setResultPoint] = useState("corner-0");
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const epoch = useRef(0);
    const saved = safeDraft(sku.consistency?.constraints);
    const assets = sku.assets.filter((asset) => asset.revision === sku.activeRevision);
    const asset = assets.find((item) => item.id === assetId);
    const reports = Array.isArray(sku.consistency?.reports) ? sku.consistency.reports.filter((report) => report && Array.isArray(report.metrics) && report.metrics.every(metric => metric && typeof metric.label === "string") && Array.isArray(report.reasons) && report.reasons.every(reason => typeof reason === "string")) : [];
    const report = reports.filter((item) => item.assetId === assetId).at(-1);
    useEffect(() => {
        epoch.current++;
        setBusy(false);
        setDraft(safeDraft(sku.consistency?.constraints));
        setSourceId(sku.consistency?.constraints?.sourceImageId || sku.product.images[0]?.id);
        setSourcePoint(undefined);
        setAssetId(undefined);
        setObservation(undefined);
        setReason("");
    }, [job.id, sku.id]);
    useEffect(
        () =>
            useServerConfigStore.subscribe((next, previous) => {
                if (next.user?.id !== previous.user?.id || (next.phase === "signed-out" && previous.phase !== "signed-out")) {
                    epoch.current++;
                    setBusy(false);
                    setDraft(undefined);
                    setObservation(undefined);
                    setAssetId(undefined);
                }
            }),
        [],
    );
    const run = async (action: () => Promise<unknown> | unknown, success: string) => {
        const token = epoch.current;
        setBusy(true);
        try {
            await action();
            if (token === epoch.current) message.success(success);
        } catch (error) {
            if (token === epoch.current) message.error(error instanceof Error ? error.message : "操作失败");
        } finally {
            if (token === epoch.current) setBusy(false);
        }
    };
    const edit = (action: (current: ConsistencyConstraint) => ConsistencyConstraint) => setDraft((current) => current && action(current));
    const number = (label: string, value: number | undefined, change: (value: number) => void, min = 0, step = 1) => (
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "4px 8px 4px 0" }}>
            {label}
            <InputNumber aria-label={label} value={value} min={min} step={step} onChange={(value) => value !== null && change(value)} />
        </label>
    );
    const pointOptions = (draft?.points || []).filter((point) => point.role === "measurement").map((point) => ({ label: point.name || point.id, value: point.id }));
    const endpointSelect = (label: string, values: [string, string], update: (values: [string, string]) => void) => (
        <Space wrap>
            {[0, 1].map((index) => (
                <label key={index}>
                    {label}
                    {index + 1}
                    <Select
                        aria-label={label + (index + 1)}
                        style={{ width: 160 }}
                        value={values[index] || undefined}
                        options={pointOptions}
                        placeholder="量测点"
                        onChange={(value) => {
                            const next: [string, string] = [...values];
                            next[index] = value;
                            update(next);
                        }}
                    />
                </label>
            ))}
        </Space>
    );
    const selectAsset = (id: string) => {
        setAssetId(id);
        const selected = assets.find((item) => item.id === id);
        if (!selected || !saved) {
            setObservation(undefined);
            return;
        }
        const previous = reports.filter((item) => item.assetId === id && item.constraintRevision === saved.revision).at(-1)?.observations;
        setObservation(
            previous && Array.isArray(previous.corners) && previous.corners.length === 4 && previous.corners.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y)) && Array.isArray(previous.points) && previous.points.every(point => point && typeof point.id === "string" && (!point.outputPx || Number.isFinite(point.outputPx.x) && Number.isFinite(point.outputPx.y)))
                ? structuredClone(previous)
                : {
                      id: "",
                      savedAt: "",
                      assetId: id,
                      resultContentHash: "",
                      width: selected.width,
                      height: selected.height,
                      corners: [
                          { x: 0, y: 0 },
                          { x: selected.width, y: 0 },
                          { x: selected.width, y: selected.height },
                          { x: 0, y: selected.height },
                      ],
                      points: saved.points.map((point) => ({ id: point.id, state: "occluded" })),
                      planeConfirmed: false,
                      independentConfirmed: false,
                      mirrored: false,
                      observer: reviewer,
                  },
        );
    };
    const setOutputPoint = (target: string, point: ConsistencyPoint) =>
        setObservation((current) => {
            if (!current) return current;
            if (target.startsWith("corner-")) {
                const next = [...current.corners] as ConsistencyObservations["corners"];
                next[Number(target.slice(7))] = point;
                return { ...current, corners: next, planeConfirmed: false };
            }
            return { ...current, points: current.points.map((item) => (item.id === target ? { ...item, outputPx: point, state: "visible" } : item)), independentConfirmed: false };
        });
    return (
        <Card title="尺寸与图案一致性" data-testid="consistency-panel">
            <Alert
                type="info"
                showIcon
                message="人工标注与独立检查"
                description="配准平面用于建立同一平面的映射，不等于商品主体矩形。主体/图案区域另行标注；独立标尺可以在主体外，但须位于配准平面内。四个配准角不能兼作验证点或量测端点。没有实物资料时只检查图案，不推算实物尺寸。"
            />
            {sku.consistency && !saved && <Alert type="error" message="已保存约束字段损坏，无法量测；请重新读取参考图并确认。已有结果不能因此跳过检查。" />}
            <Collapse
                className="mt-3"
                defaultActiveKey={["reference"]}
                items={[
                    {
                        key: "reference",
                        label: `参考约束${saved ? ` · 已确认版本 ${saved.revision}` : " · 尚未确认"}`,
                        children: (
                            <Space direction="vertical" style={{ width: "100%" }}>
                                <Space wrap>
                                    <Select aria-label="一致性参考图" style={{ width: 250 }} value={sourceId} onChange={setSourceId} options={sku.product.images.map((image) => ({ value: image.id, label: image.name || image.id }))} />
                                    <Button
                                        disabled={!sourceId || busy}
                                        onClick={() =>
                                            void run(async () => {
                                                const token = epoch.current;
                                                const value = await createConsistencyDraft(sku, sourceId!);
                                                if (token === epoch.current) {
                                                    setDraft(value);
                                                    setSourcePoint(undefined);
                                                }
                                            }, "参考像素已读取，请标注并确认")
                                        }
                                    >
                                        读取参考图
                                    </Button>
                                </Space>
                                {draft && (
                                    <>
                                        <Space wrap>
                                            <label>
                                                检查范围
                                                <Select
                                                    aria-label="一致性检查范围"
                                                    style={{ width: 180 }}
                                                    value={draft.scope}
                                                    options={[
                                                        { value: "pattern", label: "仅图案（不推测尺寸）" },
                                                        { value: "dimension-pattern", label: "尺寸与图案" },
                                                    ]}
                                                    onChange={(scope) => edit((current) => ({ ...current, scope }))}
                                                />
                                            </label>
                                            <label>
                                                证据来源
                                                <Select
                                                    aria-label="一致性证据来源"
                                                    style={{ width: 180 }}
                                                    value={draft.provenance}
                                                    options={[
                                                        { value: "manual", label: "人工确认资料" },
                                                        { value: "synthetic", label: "合成测试假定" },
                                                    ]}
                                                    onChange={(provenance) => edit((current) => ({ ...current, provenance }))}
                                                />
                                            </label>
                                        </Space>
                                        {draft.provenance === "synthetic" && <Alert type="warning" message="合成测试尺寸不能作为真实商品毫米精度声明。" />}
                                        <div>
                                            <strong>配准平面矩形（参考像素坐标）</strong>
                                            <div>
                                                {(["x", "y", "width", "height"] as const).map((key) => (
                                                    <span key={key}>{number("平面 " + key, draft.plane[key], (value) => edit((current) => ({ ...current, plane: { ...current.plane, [key]: value, frontViewConfirmed: false } })))}</span>
                                                ))}
                                            </div>
                                            <Checkbox checked={draft.plane.frontViewConfirmed} onChange={(event) => edit((current) => ({ ...current, plane: { ...current.plane, frontViewConfirmed: event.target.checked } }))}>
                                                确认参考图为正视同一平面
                                            </Checkbox>
                                        </div>
                                        <p>先添加点并选择，再点击参考图定位；数字坐标也可直接填写。至少三个独立验证点。尺寸和标尺使用不同的量测点。</p>
                                        <Select
                                            aria-label="参考图点击目标"
                                            style={{ width: 260 }}
                                            value={sourcePoint}
                                            onChange={setSourcePoint}
                                            placeholder="选择待定位点"
                                            options={draft.points.map((point) => ({ value: point.id, label: point.name || point.id }))}
                                        />
                                        <ImagePoints
                                            label="一致性参考图标注"
                                            image={sku.product.images.find((item) => item.id === draft.sourceImageId)}
                                            width={draft.sourceWidth}
                                            height={draft.sourceHeight}
                                            points={draft.points.map((point) => ({ ...point.sourcePx, name: point.name }))}
                                            onPoint={(sourcePx) => {
                                                if (!sourcePoint) {
                                                    message.info("请先添加并选择待定位点");
                                                    return;
                                                }
                                                edit((current) => ({ ...current, points: current.points.map((point) => (point.id === sourcePoint ? { ...point, sourcePx } : point)) }));
                                            }}
                                        />
                                        {draft.points.map((point, index) => (
                                            <Space key={point.id} wrap>
                                                <Input
                                                    aria-label={`点${index + 1}名称`}
                                                    style={{ width: 130 }}
                                                    value={point.name}
                                                    onChange={(event) => edit((current) => ({ ...current, points: current.points.map((item) => (item.id === point.id ? { ...item, name: event.target.value } : item)) }))}
                                                />
                                                <Select
                                                    aria-label={`点${index + 1}角色`}
                                                    style={{ width: 140 }}
                                                    value={point.role}
                                                    options={[
                                                        { value: "validation", label: "独立验证点" },
                                                        { value: "measurement", label: "尺寸/标尺量测点" },
                                                    ]}
                                                    onChange={(role) => edit((current) => ({ ...current, points: current.points.map((item) => (item.id === point.id ? { ...item, role } : item)) }))}
                                                />
                                                {(["x", "y"] as const).map((key) => (
                                                    <span key={key}>
                                                        {number(`参考点${index + 1} ${key}`, point.sourcePx[key], (value) =>
                                                            edit((current) => ({ ...current, points: current.points.map((item) => (item.id === point.id ? { ...item, sourcePx: { ...item.sourcePx, [key]: value } } : item)) })),
                                                        )}
                                                    </span>
                                                ))}
                                                <Button onClick={() => setSourcePoint(point.id)}>定位此点</Button>
                                                <Button danger onClick={() => edit((current) => ({ ...current, points: current.points.filter((item) => item.id !== point.id) }))}>
                                                    删除点{index + 1}
                                                </Button>
                                            </Space>
                                        ))}
                                        <Button
                                            disabled={draft.points.length >= 128}
                                            onClick={() => {
                                                const id = nanoid();
                                                edit((current) => ({ ...current, points: [...current.points, { id, name: `点${current.points.length + 1}`, role: "validation", sourcePx: { x: 0, y: 0 } }] }));
                                                setSourcePoint(id);
                                            }}
                                        >
                                            添加标注点
                                        </Button>
                                        <strong>已确认尺寸（没有资料请留空）</strong>
                                        {draft.dimensions.map((dimension, index) => (
                                            <Card key={dimension.id} size="small">
                                                <Space wrap>
                                                    <Input
                                                        aria-label={`尺寸${index + 1}名称`}
                                                        style={{ width: 160 }}
                                                        value={dimension.label}
                                                        onChange={(event) => edit((current) => ({ ...current, dimensions: current.dimensions.map((item) => (item.id === dimension.id ? { ...item, label: event.target.value } : item)) }))}
                                                    />
                                                    {endpointSelect(`尺寸${index + 1}端点`, dimension.endpoints, (endpoints) =>
                                                        edit((current) => ({ ...current, dimensions: current.dimensions.map((item) => (item.id === dimension.id ? { ...item, endpoints } : item)) })),
                                                    )}
                                                    {number(
                                                        `尺寸${index + 1}数值`,
                                                        dimension.value,
                                                        (value) => edit((current) => ({ ...current, dimensions: current.dimensions.map((item) => (item.id === dimension.id ? { ...item, value } : item)) })),
                                                        0,
                                                        0.1,
                                                    )}
                                                    <Select
                                                        aria-label={`尺寸${index + 1}单位`}
                                                        value={dimension.unit}
                                                        options={units}
                                                        onChange={(unit: ConsistencyUnit) => edit((current) => ({ ...current, dimensions: current.dimensions.map((item) => (item.id === dimension.id ? { ...item, unit } : item)) }))}
                                                    />
                                                    <Button danger onClick={() => edit((current) => ({ ...current, dimensions: current.dimensions.filter((item) => item.id !== dimension.id) }))}>
                                                        删除尺寸{index + 1}
                                                    </Button>
                                                </Space>
                                                <Input
                                                    className="mt-2"
                                                    aria-label={`尺寸${index + 1}证据`}
                                                    placeholder="尺寸资料来源和端点定义，例如包装标注/人工测量记录"
                                                    value={dimension.evidence}
                                                    onChange={(event) => edit((current) => ({ ...current, dimensions: current.dimensions.map((item) => (item.id === dimension.id ? { ...item, evidence: event.target.value } : item)) }))}
                                                />
                                            </Card>
                                        ))}
                                        <Button
                                            disabled={draft.dimensions.length >= 16}
                                            onClick={() => edit((current) => ({ ...current, dimensions: [...current.dimensions, { id: nanoid(), label: `尺寸${current.dimensions.length + 1}`, endpoints: ["", ""], value: 0, unit: "mm", evidence: "" }] }))}
                                        >
                                            添加确认尺寸
                                        </Button>
                                        <strong>独立同平面标尺</strong>
                                        {!draft.ruler ? (
                                            <Button onClick={() => edit((current) => ({ ...current, ruler: { endpoints: ["", ""], value: 0, unit: "mm", evidence: "", independentConfirmed: false } }))}>添加独立标尺</Button>
                                        ) : (
                                            <Card size="small">
                                                <Space wrap>
                                                    {endpointSelect("标尺端点", draft.ruler.endpoints, (endpoints) => edit((current) => ({ ...current, ruler: { ...current.ruler!, endpoints } })))}
                                                    {number("标尺数值", draft.ruler.value, (value) => edit((current) => ({ ...current, ruler: { ...current.ruler!, value } })), 0, 0.1)}
                                                    <Select aria-label="标尺单位" value={draft.ruler.unit} options={units} onChange={(unit: ConsistencyUnit) => edit((current) => ({ ...current, ruler: { ...current.ruler!, unit } }))} />
                                                    <Button onClick={() => edit((current) => ({ ...current, ruler: undefined }))}>移除标尺</Button>
                                                </Space>
                                                <Input
                                                    className="mt-2"
                                                    aria-label="标尺证据"
                                                    placeholder="独立标尺的实际长度、资料及端点证据"
                                                    value={draft.ruler.evidence}
                                                    onChange={(event) => edit((current) => ({ ...current, ruler: { ...current.ruler!, evidence: event.target.value } }))}
                                                />
                                                <Checkbox checked={draft.ruler.independentConfirmed} onChange={(event) => edit((current) => ({ ...current, ruler: { ...current.ruler!, independentConfirmed: event.target.checked } }))}>
                                                    确认标尺与被测尺寸独立且在同一平面
                                                </Checkbox>
                                            </Card>
                                        )}
                                        <strong>商品主体/图案检查区域（不是配准平面）</strong>
                                        {draft.regions.map((region, index) => (
                                            <Card key={region.id} size="small">
                                                <Input
                                                    aria-label={`区域${index + 1}名称`}
                                                    value={region.name}
                                                    onChange={(event) => edit((current) => ({ ...current, regions: current.regions.map((item) => (item.id === region.id ? { ...item, name: event.target.value } : item)) }))}
                                                />
                                                {(["x", "y", "width", "height"] as const).map((key) => (
                                                    <span key={key}>
                                                        {number(`区域${index + 1} ${key}`, region[key], (value) => edit((current) => ({ ...current, regions: current.regions.map((item) => (item.id === region.id ? { ...item, [key]: value } : item)) })))}
                                                    </span>
                                                ))}
                                                <Select
                                                    mode="multiple"
                                                    aria-label={`区域${index + 1}验证点`}
                                                    style={{ width: "100%" }}
                                                    placeholder="选择本区域内独立验证点"
                                                    options={draft.points.filter((point) => point.role === "validation").map((point) => ({ value: point.id, label: point.name }))}
                                                    value={region.anchorIds}
                                                    onChange={(anchorIds) => edit((current) => ({ ...current, regions: current.regions.map((item) => (item.id === region.id ? { ...item, anchorIds } : item)) }))}
                                                />
                                                <Button danger onClick={() => edit((current) => ({ ...current, regions: current.regions.filter((item) => item.id !== region.id) }))}>
                                                    删除区域{index + 1}
                                                </Button>
                                            </Card>
                                        ))}
                                        <Button
                                            disabled={draft.regions.length >= 32}
                                            onClick={() =>
                                                edit((current) => ({
                                                    ...current,
                                                    regions: [
                                                        ...current.regions,
                                                        { id: nanoid(), name: `区域${current.regions.length + 1}`, x: current.plane.x, y: current.plane.y, width: current.plane.width, height: current.plane.height, anchorIds: [] },
                                                    ],
                                                }))
                                            }
                                        >
                                            添加图案区域
                                        </Button>
                                        <div>
                                            <strong>版本化误差阈值</strong>
                                            <div>
                                                {number("最大点误差 px", draft.thresholds.maxPx, (maxPx) => edit((current) => ({ ...current, thresholds: { ...current.thresholds, maxPx } })), 0, 0.1)}
                                                {number("点误差 RMSE px", draft.thresholds.rmsePx, (rmsePx) => edit((current) => ({ ...current, thresholds: { ...current.thresholds, rmsePx } })), 0, 0.1)}
                                                {number("相对误差比例", draft.thresholds.relative, (relative) => edit((current) => ({ ...current, thresholds: { ...current.thresholds, relative } })), 0, 0.01)}
                                            </div>
                                            <p>0.01 表示 1%。修改阈值或事实后须重新确认；原结果不能按新约束直接放行。</p>
                                        </div>
                                        <Button type="primary" loading={busy} onClick={() => void run(() => saveConsistencyConstraints(job.id, sku.id, draft, reviewer), "约束已确认并保存，已有结果需按当前请求重新检查")}>
                                            确认保存一致性约束
                                        </Button>
                                    </>
                                )}
                            </Space>
                        ),
                    },
                    {
                        key: "result",
                        label: "结果标注与独立报告",
                        children: (
                            <Space direction="vertical" style={{ width: "100%" }}>
                                <p>按参考平面的左上、右上、右下、左下顺序标注结果四角。随后独立标注每个验证点、尺寸端点和标尺端点；不要复制预测坐标作为观察值。</p>
                                <Select
                                    aria-label="一致性结果图"
                                    style={{ width: "100%" }}
                                    value={assetId}
                                    disabled={!saved}
                                    placeholder="选择当前版本结果"
                                    options={assets.map((item) => ({ value: item.id, label: `${item.title} · ${item.stage}` }))}
                                    onChange={selectAsset}
                                />
                                {saved && asset && observation && (
                                    <>
                                        <Select
                                            aria-label="结果图点击目标"
                                            style={{ width: 280 }}
                                            value={resultPoint}
                                            options={[...corners.map((name, index) => ({ value: "corner-" + index, label: "配准角 · " + name })), ...saved.points.map((point) => ({ value: point.id, label: point.name }))]}
                                            onChange={setResultPoint}
                                        />
                                        <ImagePoints
                                            label="一致性结果图标注"
                                            image={asset}
                                            width={asset.width}
                                            height={asset.height}
                                            points={[
                                                ...observation.corners.map((point, index) => ({ ...point, name: corners[index] })),
                                                ...observation.points.filter((point) => point.state === "visible" && point.outputPx).map((point) => ({ ...point.outputPx!, name: saved.points.find((item) => item.id === point.id)?.name || point.id })),
                                            ]}
                                            onPoint={(point) => setOutputPoint(resultPoint, point)}
                                        />
                                        {observation.corners.map((point, index) => (
                                            <div key={index}>
                                                <strong>配准角 {corners[index]}</strong>
                                                {(["x", "y"] as const).map((key) => (
                                                    <span key={key}>{number(`结果${corners[index]} ${key}`, point[key], (value) => setOutputPoint("corner-" + index, { ...point, [key]: value }))}</span>
                                                ))}
                                            </div>
                                        ))}
                                        {observation.points.map((point, index) => (
                                            <Space wrap key={point.id}>
                                                <strong>{saved.points.find((item) => item.id === point.id)?.name || point.id}</strong>
                                                <Select
                                                    aria-label={`结果点${index + 1}状态`}
                                                    style={{ width: 140 }}
                                                    value={point.state}
                                                    options={[
                                                        { value: "visible", label: "可见可标注" },
                                                        { value: "missing", label: "明确缺失" },
                                                        { value: "occluded", label: "遮挡/不可量测" },
                                                    ]}
                                                    onChange={(state) => setObservation((current) => current && { ...current, points: current.points.map((item) => (item.id === point.id ? { ...item, state } : item)), independentConfirmed: false })}
                                                />
                                                {(["x", "y"] as const).map((key) => (
                                                    <span key={key}>{number(`结果点${index + 1} ${key}`, point.outputPx?.[key], (value) => setOutputPoint(point.id, { ...(point.outputPx || { x: 0, y: 0 }), [key]: value }))}</span>
                                                ))}
                                                <Button onClick={() => setResultPoint(point.id)}>定位结果点{index + 1}</Button>
                                            </Space>
                                        ))}
                                        <Checkbox checked={observation.mirrored} onChange={(event) => setObservation((current) => current && { ...current, mirrored: event.target.checked })}>
                                            结果存在镜像
                                        </Checkbox>
                                        <Checkbox checked={observation.planeConfirmed} onChange={(event) => setObservation((current) => current && { ...current, planeConfirmed: event.target.checked })}>
                                            已独立确认结果配准四角
                                        </Checkbox>
                                        <Checkbox checked={observation.independentConfirmed} onChange={(event) => setObservation((current) => current && { ...current, independentConfirmed: event.target.checked })}>
                                            验证点及量测端点独立观察，未用于拟合配准
                                        </Checkbox>
                                        <label>
                                            标注人
                                            <Input aria-label="一致性标注人" value={observation.observer} onChange={(event) => setObservation((current) => current && { ...current, observer: event.target.value })} />
                                        </label>
                                        <Button type="primary" loading={busy} onClick={() => void run(() => saveConsistencyObservations(job.id, sku.id, asset.id, observation), "检查报告已保存；数值通过仍需人工复核")}>
                                            保存观察并检查
                                        </Button>
                                    </>
                                )}
                                {report && (
                                    <Card
                                        size="small"
                                        title={
                                            <Space>
                                                最新报告<Tag color={report.status === "pass" ? "green" : report.status === "deviation" ? "red" : "orange"}>{statuses[report.status]}</Tag>
                                            </Space>
                                        }
                                    >
                                        <p>
                                            约束版本 {report.constraintRevision} · {report.createdAt}
                                        </p>
                                        <p>{report.boundary}</p>
                                        {report.reasons.length > 0 && <Alert type="warning" message={report.reasons.join("；")} />}
                                        <Table
                                            size="small"
                                            rowKey="id"
                                            pagination={false}
                                            scroll={{ x: 700 }}
                                            dataSource={report.metrics}
                                            columns={[
                                                { title: "项目", dataIndex: "label", render: (label: string, metric: { id: string }) => { const name = typeof metric.id === "string" && metric.id.startsWith("anchor:") ? saved?.points.find(point => point.id === metric.id.slice(7))?.name : undefined; return name ? "验证点 " + name : label; } },
                                                { title: "状态", dataIndex: "status", render: (value: keyof typeof statuses) => statuses[value] },
                                                { title: "实际值", dataIndex: "actual", render: (value: number | null) => (typeof value !== "number" || !Number.isFinite(value) ? "—" : Number(value.toFixed(5))) },
                                                { title: "期望值", dataIndex: "expected" },
                                                { title: "阈值", dataIndex: "threshold" },
                                                { title: "单位", dataIndex: "unit" },
                                                { title: "原因", dataIndex: "reason" },
                                            ]}
                                        />
                                        {report.decision && (
                                            <p>
                                                人工决定：{report.decision.action === "accept" ? "接受" : "拒绝"} · {report.decision.reviewer} · {report.decision.reason}
                                            </p>
                                        )}
                                        <Input.TextArea aria-label="一致性复核说明" className="my-2" placeholder="填写检查依据或返修原因" value={reason} onChange={(event) => setReason(event.target.value)} />
                                        <Space wrap>
                                            <Button disabled={busy || report.numericStatus !== "pass" || !reason.trim()} onClick={() => void run(() => decideConsistencyReport(job.id, sku.id, report.id, "accept", reviewer, reason), "人工复核已接受")}>
                                                接受一致性报告
                                            </Button>
                                            <Button danger disabled={busy || !reason.trim()} onClick={() => void run(() => decideConsistencyReport(job.id, sku.id, report.id, "reject", reviewer, reason), "已拒绝，审批已清除")}>
                                                拒绝并要求返修
                                            </Button>
                                        </Space>
                                    </Card>
                                )}
                                {saved && (
                                    <Button
                                        disabled={busy}
                                        onClick={() =>
                                            void run(async () => {
                                                await createConsistencyRepairRevision(job.id, sku.id);
                                                setAssetId(undefined);
                                                setObservation(undefined);
                                            }, "返修版本已创建，历史结果保留；尚未发送生成请求")
                                        }
                                    >
                                        创建返修版本（不调用模型）
                                    </Button>
                                )}
                            </Space>
                        ),
                    },
                ]}
            />
        </Card>
    );
}
