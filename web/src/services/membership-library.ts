import { create } from "zustand";
import { useServerConfigStore } from "./server-config";

export type MemberRole = "read" | "write" | "admin";
export type AssetProject = { id: string; teamId: string; name: string; role: MemberRole; members?: Record<string, "read" | "write"> };
export type AssetTeam = { id: string; name: string; role: MemberRole; members?: Record<string, MemberRole>; projects: AssetProject[] };
export const useMembershipLibrary = create<{ teams: AssetTeam[]; loading: boolean; error: string }>(() => ({ teams: [], loading: false, error: "" }));
let generation = 0;
let readSequence = 0;
useServerConfigStore.subscribe((next, previous) => {
    if (next.user?.id !== previous.user?.id || (next.phase === "checking" && previous.phase !== "checking") || next.phase === "signed-out") {
        generation++; readSequence++;
        useMembershipLibrary.setState({ teams: [], loading: false, error: "" });
    }
});
export class LibraryError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export function librarySession() {
    const user = useServerConfigStore.getState().user;
    const version = generation;
    if (!user || ["checking", "signed-out"].includes(useServerConfigStore.getState().phase)) throw new LibraryError(401, "请先登录并完成账号读取");
    return () => {
        if (version !== generation || user.id !== useServerConfigStore.getState().user?.id) throw new LibraryError(409, "账号已切换，请重新操作");
        return user.id;
    };
}
export async function libraryRequest<T>(path: string, method = "GET", body?: unknown, guard = librarySession(), binary = false): Promise<T> {
    const id = guard();
    const response = await fetch(`/api/config-vault${path}`, {
        method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(120000),
        headers: { "X-Config-User": String(id), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    guard();
    if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
            readSequence++;
            if (response.status === 401) generation++;
            useMembershipLibrary.setState({ teams: [], loading: false, error: "权限已变化，请重新读取团队与项目" });
            if (response.status !== 401 && !path.startsWith("/memberships")) await refreshMemberships().catch(() => {});
        }
        throw new LibraryError(response.status, response.status === 403 ? "没有此操作权限，请刷新成员关系" : response.status === 401 ? "登录已失效" : response.status === 409 ? "状态已变化，请重新读取后确认" : "请求失败，请读取服务器状态后确认");
    }
    const result = binary ? await response.blob() : await response.json();
    guard();
    return result as T;
}
export async function refreshMemberships() {
    const guard = librarySession();
    const sequence = ++readSequence;
    useMembershipLibrary.setState({ loading: true });
    try {
        const data = await libraryRequest<{ teams: AssetTeam[] }>("/memberships", "GET", undefined, guard);
        guard();
        if (sequence === readSequence) useMembershipLibrary.setState({ teams: data.teams, error: "", loading: false });
        return data.teams;
    } catch (error) {
        if (sequence === readSequence) useMembershipLibrary.setState({ teams: [], loading: false, error: error instanceof Error ? error.message : "读取失败" });
        throw error;
    }
}
const part = (value: string) => encodeURIComponent(value);
async function mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
    const guard = librarySession();
    try { return await libraryRequest<T>(`/memberships${path}`, method, body, guard); }
    finally { guard(); await refreshMemberships().catch(() => {}); guard(); }
}
export const createAssetTeam = (name: string) => mutate<{ team: AssetTeam }>("/teams", "POST", { name });
export type Invitation = { id: string; token: string; expiresAt: number; targetId: string; role: "read" | "write" };
export const inviteAssetMember = (teamId: string, targetId: string, role: "read" | "write") => mutate<{ invitation: Invitation }>(`/teams/${part(teamId)}/invitations`, "POST", { targetId, role });
export const acceptAssetInvitation = (token: string) => mutate<{ team: AssetTeam }>("/invitations/accept", "POST", { token });
export const cancelAssetInvitation = (teamId: string, id: string) => mutate(`/teams/${part(teamId)}/invitations/${part(id)}`, "DELETE");
export const setAssetMemberRole = (teamId: string, userId: string, role: MemberRole) => mutate(`/teams/${part(teamId)}/members/${part(userId)}`, "PUT", { role });
export const removeAssetMember = (teamId: string, userId: string) => mutate(`/teams/${part(teamId)}/members/${part(userId)}`, "DELETE");
export const createAssetProject = (teamId: string, name: string) => mutate<{ project: AssetProject }>(`/teams/${part(teamId)}/projects`, "POST", { name });
export const setAssetProjectRole = (teamId: string, projectId: string, userId: string, role: "read" | "write") => mutate(`/teams/${part(teamId)}/projects/${part(projectId)}/members/${part(userId)}`, "PUT", { role });
export const removeAssetProjectMember = (teamId: string, projectId: string, userId: string) => mutate(`/teams/${part(teamId)}/projects/${part(projectId)}/members/${part(userId)}`, "DELETE");
