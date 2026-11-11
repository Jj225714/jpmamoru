import { Card, Collapse, Image, Tag } from "antd";
import { resolveCategory } from "@/lib/commerce/category-rules";
import type { CommerceCategory, PolicyPack } from "@/types/commerce";

const DOCUMENT_ROOTS = ["rugs", "floor-mats", "table-mats"];

/** Keep source-workbook categories visibly separate from legacy or custom categories. */
export function CategoryHierarchy({ pack }: { pack: PolicyPack }) {
    const nodes = pack.categories || [];
    const roots = nodes.filter((node) => !node.parentId).sort((a, b) => a.order - b.order);
    const documentRoots = roots.filter((root) => DOCUMENT_ROOTS.includes(root.id));
    const otherRoots = roots.filter((root) => !DOCUMENT_ROOTS.includes(root.id));
    const childrenOf = (root: CommerceCategory) => nodes.filter((node) => node.parentId === root.id).sort((a, b) => a.order - b.order);
    const detail = (node: CommerceCategory) => {
        const resolved = resolveCategory(pack, { category: node.name, categoryId: node.parentId || node.id, subcategoryId: node.parentId ? node.id : undefined });
        return (
            <div className="space-y-3">
                {resolved?.rules.map((rule) => (
                    <p key={rule.id}>
                        <Tag color={rule.strength === "required" ? "red" : "blue"}>{rule.strength === "required" ? "必须" : "建议"}</Tag>
                        {rule.text}
                    </p>
                ))}
                <div className="flex flex-wrap gap-3">
                    {resolved?.referenceIds.map((id) => {
                        const ref = pack.references.find((item) => item.id === id);
                        return ref ? <Image key={id} width={150} height={120} style={{ objectFit: "contain" }} src={ref.url} alt={`${node.name}示例图`} /> : null;
                    })}
                </div>
                {node.source ? (
                    <p className="text-xs text-stone-500">
                        来源：{node.source.fileName} · {node.source.sheet} {node.source.range}
                        {node.name === "餐桌垫" ? "（原文件名称：餐桌）" : ""}
                    </p>
                ) : null}
                <p className="text-sm text-stone-500">
                    适用作图方案 {resolved?.requirementIds.length || 0} 项 · 示例图 {resolved?.referenceIds.length || 0} 张
                </p>
            </div>
        );
    };
    const group = (root: CommerceCategory) => {
        const children = childrenOf(root);
        return (
            <Card key={root.id} size="small" title={<h3 className="font-semibold">{root.name}</h3>} extra={<Tag>{children.length ? `${children.length} 个子类` : "未细分"}</Tag>}>
                {children.length ? (
                    <Collapse
                        items={children.map((child) => ({
                            key: child.id,
                            label: (
                                <span>
                                    <Tag>子类</Tag>
                                    {child.name}
                                    {child.active ? "" : "（已停用）"}
                                </span>
                            ),
                            children: detail(child),
                        }))}
                    />
                ) : (
                    detail(root)
                )}
            </Card>
        );
    };
    return (
        <div className="space-y-4">
            {documentRoots.length ? (
                <>
                    <p className="text-sm text-stone-500">
                        原文件分类：{documentRoots.length} 个大类、{documentRoots.reduce((count, root) => count + childrenOf(root).length, 0)} 个子类。展开子类查看对应要求和示例图。
                    </p>
                    {documentRoots.map(group)}
                </>
            ) : null}
            {otherRoots.length ? <Collapse items={[{ key: "other", label: `其他已有类目（${otherRoots.length} 个大类，不在本次文件中）`, children: <div className="space-y-3">{otherRoots.map(group)}</div> }]} /> : null}
        </div>
    );
}
