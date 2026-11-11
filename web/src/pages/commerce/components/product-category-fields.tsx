import { Image, Select, Tag } from "antd";
import { resolveCategory } from "@/lib/commerce/category-rules";
import type { PolicyPack, ProductRecord } from "@/types/commerce";
export function ProductCategoryFields({ pack, product, onChange }: { pack: PolicyPack; product: ProductRecord; onChange: (product: ProductRecord) => void }) {
    const nodes = pack.categories || [];
    const resolved = resolveCategory(pack, product);
    const parentId = product.categoryId || (resolved?.node.parentId ? resolved.node.parentId : resolved?.node.id);
    const children = nodes.filter((item) => item.parentId === parentId && item.active).sort((a, b) => a.order - b.order);
    return (
        <div className="space-y-3">
            <Select
                aria-label="商品大类"
                className="w-full"
                placeholder="请选择大类"
                value={parentId}
                options={nodes
                    .filter((item) => !item.parentId && item.active)
                    .sort((a, b) => a.order - b.order)
                    .map((item) => ({ value: item.id, label: item.name }))}
                onChange={(categoryId) => onChange({ ...product, categoryId, subcategoryId: undefined, category: nodes.find((item) => item.id === categoryId)!.name })}
            />
            {children.length ? (
                <Select
                    aria-label="商品细分类目"
                    className="w-full"
                    placeholder="请选择一个细类"
                    value={product.subcategoryId}
                    options={children.map((item) => ({ value: item.id, label: item.name }))}
                    onChange={(subcategoryId) => onChange({ ...product, categoryId: parentId, subcategoryId })}
                />
            ) : null}
            <p className="text-sm text-stone-500">类目规则优先于补充提示词。场景自动携带对应示例；细节仅使用所绑定的商品实拍。</p>
            {resolved?.rules.map((rule) => (
                <p key={rule.id}>
                    <Tag color={rule.strength === "required" ? "red" : "blue"}>{rule.strength === "required" ? "必须" : "建议"}</Tag>
                    {rule.text}
                </p>
            ))}
            <div className="flex gap-2">
                {resolved?.referenceIds.map((id) => {
                    const reference = pack.references.find((item) => item.id === id);
                    return reference ? <Image key={id} width={110} height={90} style={{ objectFit: "contain" }} src={reference.url} alt={reference.name} /> : null;
                })}
            </div>
        </div>
    );
}
