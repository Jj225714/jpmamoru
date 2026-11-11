import { useSyncExternalStore } from "react";
import { useServerConfigStore } from "@/services/server-config";
import type { AssetScope } from "@/services/asset-library";
import type { AssetTeam, MemberRole } from "@/services/membership-library";
let epoch = 0;
const listeners = new Set<() => void>();
useServerConfigStore.subscribe((next, previous) => {
    if (next.user?.id !== previous.user?.id || (next.phase === "checking" && previous.phase !== "checking") || (next.phase === "signed-out" && previous.phase !== "signed-out")) { epoch++; listeners.forEach(fn => fn()); }
});
export function useAssetAccountEpoch() { return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => epoch); }
export type LibraryScopeOption = { value: string; label: string; scope: AssetScope; role: MemberRole };
export function libraryScopes(teams: AssetTeam[]): LibraryScopeOption[] {
    return [{ value: "personal", label: "个人资产", scope: { scope: "personal" }, role: "write" }, ...teams.flatMap(team => [
        { value: `team:${team.id}`, label: `团队 · ${team.name}`, scope: { scope: "team", teamId: team.id } as AssetScope, role: team.role },
        ...team.projects.map(project => ({ value: `project:${team.id}:${project.id}`, label: `项目 · ${team.name} / ${project.name}`, scope: { scope: "project", teamId: team.id, projectId: project.id } as AssetScope, role: project.role })),
    ])];
}
