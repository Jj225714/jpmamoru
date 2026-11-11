import { Alert, Button, Card, Empty, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useCommerceStore } from "@/stores/use-commerce-store";
import type { PolicyPack } from "@/types/commerce";
import { PolicyEditor } from "./policy-editor";
import { createCategorySeedPack } from "@/lib/commerce/category-seed";
import { CategoryHierarchy } from "./category-hierarchy";
import { TeamBrandEditor } from "./team-brand-editor";
import { CategoryAdmin } from "./category-admin";
import { useServerConfigStore, reloadTeamConfiguration } from "@/services/server-config";
import { getServerConfigEnabled } from "@/constant/runtime-config";

/** The same web editor is available from global configuration and commerce settings. */
export function CategoryConfigPanel() {
    const sync = useServerConfigStore();
    const online = getServerConfigEnabled();
    const packs = useCommerceStore((state) => state.policyPacks);
    const hydrated = useCommerceStore((state) => state.hydrated);
    const catalog = useCommerceStore((state) => state.catalogStatus);
    const owner = useCommerceStore((state) => state.owner);
    const [editing, setEditing] = useState<PolicyPack>();
    const loadServerCatalog = useCommerceStore((state) => state.loadServerCatalog);
    const published = packs.filter((pack) => pack.status === "published").sort((a, b) => b.version - a.version);
    const activePack = sync.serverTeam?.policyPack || published.find((pack) => pack.id.startsWith("server-aoweisi-") && pack.categories?.length) || published[0];
    const hasHierarchy = Boolean(activePack?.categories?.length);
    const hierarchyPack = activePack ? (hasHierarchy ? activePack : createCategorySeedPack(activePack)) : undefined;
    useEffect(() => {
        if (hydrated && !online) void loadServerCatalog(true);
    }, [hydrated, loadServerCatalog, online]);
    return (
        <div className="space-y-3">
            <Alert type="info" showIcon title="大类与细分子类" description="团队规则由管理员在网页中编辑、保存草稿并发布。换电脑登录后自动读取同一团队的类目、品牌与示例图；本地 PIN 不作为团队权限。" />
            <p className="text-sm text-stone-500">新任务优先使用已发布团队规则。下方原文件预览需由管理员创建草稿并发布，才会跨设备生效。</p>
            {!hydrated ? (
                <p role="status">正在读取本地规则…</p>
            ) : (
                <>
                    {catalog.phase === "error" ? <Alert type="warning" showIcon title="共享规则加载失败，以下显示已保存的规则" description={catalog.error} /> : null}
                    <Space wrap>
                        <Button loading={catalog.phase === "loading"} onClick={() => void (online ? reloadTeamConfiguration() : loadServerCatalog(true))}>
                            刷新共享规则
                        </Button>
                        <Button disabled={!activePack || !owner} onClick={() => setEditing(activePack)}>
                            编辑本地副本
                        </Button>
                        <Link to="/commerce/settings">负责人设置与本地草稿</Link>
                    </Space>
                    {!owner ? <p className="text-sm text-stone-500">编辑前请在「负责人设置与本地草稿」页面设置负责人及 PIN。该 PIN 仅保护本地编辑。</p> : null}
                    {activePack && hierarchyPack ? (
                        <Card title={hasHierarchy ? `${activePack.name} · v${activePack.version}` : `奥维斯文件类目标准 · ${activePack.name}`}>
                            <Tag>{hasHierarchy ? (activePack.id.startsWith("server-aoweisi-") ? "共享规则副本" : "本地规则") : "原文件标准预览"}</Tag>
                            {!hasHierarchy ? <p className="my-3 text-sm text-stone-500">当前规则 v{activePack.version} 尚未启用细分类目，下面按原文件展示分类及要求；预览不会改写已有任务或自动发布规则。</p> : null}
                            <CategoryHierarchy pack={hierarchyPack} />
                        </Card>
                    ) : (
                        <Empty description="暂无已发布规则，请在国家规则与模板中导入规则" />
                    )}
                </>
            )}
            {online && sync.serverTeam && !sync.manageTeam ? <TeamBrandEditor brands={sync.serverTeam.brands} pack={sync.serverTeam.policyPack} disabled onChange={() => {}} /> : null}
            {online && hydrated ? <CategoryAdmin key={sync.user?.id || "signed-out"} activePack={activePack} onPublished={reloadTeamConfiguration} /> : null}
            {editing ? <PolicyEditor key={editing.id} pack={editing} onClose={() => setEditing(undefined)} /> : null}
        </div>
    );
}
