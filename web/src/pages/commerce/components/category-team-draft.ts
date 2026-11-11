import type { SettingsEnvelope, TeamSettings } from "@/types/settings-sync";

/** Only policy/brand fields belong to this editor; all other fields come from fresh server state. */
export async function prepareCategoryTeamDraft(
    edits: Pick<TeamSettings, "policyPack" | "brands">,
    revision: number,
    dependencies: {
        load: () => Promise<SettingsEnvelope>;
        prepare: (value: TeamSettings) => Promise<TeamSettings>;
        isCurrent: () => boolean;
    },
): Promise<{ value: TeamSettings; revision: number }> {
    const assertCurrent = () => { if (!dependencies.isCurrent()) throw new Error("账号已变化，类目草稿操作已停止"); };
    assertCurrent();
    const server = await dependencies.load();
    assertCurrent();
    if (!server.permissions.manageTeam) throw new Error("没有团队草稿管理权限");
    const currentRevision = server.draft?.revision ?? 0;
    if (currentRevision !== revision) throw new Error(`团队草稿版本冲突：当前编辑基于修订 ${revision}，服务器已是 ${currentRevision}。本地修改已保留，请对比服务器草稿后刷新，未覆盖服务器配置。`);
    // Legacy drafts may predate modelConfig; preserve published fields absent in that draft.
    // Explicit fields in the current server draft take precedence; never read a local model snapshot.
    const value = await dependencies.prepare({ ...server.team.value, ...server.draft?.value, ...edits });
    assertCurrent();
    return { value, revision: currentRevision };
}
