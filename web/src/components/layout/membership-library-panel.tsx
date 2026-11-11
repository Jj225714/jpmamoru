import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Select, Space } from "antd";
import { useServerConfigStore } from "@/services/server-config";
import { acceptAssetInvitation, cancelAssetInvitation, createAssetProject, createAssetTeam, inviteAssetMember, librarySession, refreshMemberships, removeAssetMember, removeAssetProjectMember, setAssetMemberRole, setAssetProjectRole, useMembershipLibrary, type Invitation, type MemberRole } from "@/services/membership-library";

export function MembershipLibraryPanel() {
    const user = useServerConfigStore(state => state.user);
    const { teams, error } = useMembershipLibrary();
    const [teamId, setTeamId] = useState("");
    const [name, setName] = useState("");
    const [token, setToken] = useState("");
    const [targetId, setTargetId] = useState("");
    const [role, setRole] = useState<"read" | "write">("read");
    const [projectName, setProjectName] = useState("");
    const [invitation, setInvitation] = useState<Invitation>();
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const team = teams.find(item => item.id === teamId);
    useEffect(() => {
        const refresh = () => { void refreshMemberships().catch(() => {}); };
        refresh(); window.addEventListener("focus", refresh);
        const timer = setInterval(refresh, 30000);
        return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
    }, [user?.id]);
    useEffect(() => { setInvitation(undefined); }, [teamId, team?.role]);
    useEffect(() => { if (!teams.some(item => item.id === teamId)) setTeamId(""); }, [teams, teamId]);
    const run = async (work: () => Promise<unknown>) => {
        let guard: ReturnType<typeof librarySession>;
        try { guard = librarySession(); } catch { return; }
        setBusy(true); setNotice("");
        try { await work(); guard(); setNotice("操作完成，成员与项目已重新读取。"); }
        catch (e) { try { guard(); setNotice(e instanceof Error ? e.message : "操作失败，请刷新确认状态"); } catch { /* Old account results must not enter the new view. */ } }
        finally { setBusy(false); }
    };
    const roles = [{ value: "read", label: "只读" }, { value: "write", label: "读写" }];
    return <Card title="资产团队与项目成员" size="small">
        <p>当前账号 ID：{user?.id}。这里的资产团队独立于配置保险库的规则管理员权限。</p>
        {error || notice ? <Alert className="my-2" type={error ? "warning" : "info"} title={error || notice} /> : null}
        <Space wrap className="my-2">
            <Input aria-label="新团队名称" placeholder="新团队名称" value={name} onChange={e => setName(e.target.value)} />
            <Button disabled={busy || !name.trim()} onClick={() => void run(async () => { const result = await createAssetTeam(name.trim()); setTeamId(result.team.id); setName(""); })}>创建团队</Button>
            <Button disabled={busy} onClick={() => void run(refreshMemberships)}>刷新成员关系</Button>
        </Space>
        <Space wrap className="my-2">
            <Input.Password aria-label="定向邀请码" placeholder="粘贴发给本账号的邀请码" value={token} onChange={e => setToken(e.target.value)} />
            <Button disabled={busy || !token.trim()} onClick={() => { const value = token.trim(); setToken(""); void run(() => acceptAssetInvitation(value)); }}>接受邀请</Button>
        </Space>
        <Select aria-label="资产团队" className="my-2 w-full" placeholder="选择已加入的团队" value={team?.id} options={teams.map(item => ({ value: item.id, label: `${item.name} · ${item.role}` }))} onChange={setTeamId} />
        {team ? <>
            <p>团队角色：{team.role}。项目读写权限以服务器返回的有效角色为准。</p>
            {team.role === "admin" ? <>
                <Space wrap className="my-2">
                    <Input aria-label="受邀账号ID" placeholder="对方账号页面显示的账号 ID" value={targetId} onChange={e => setTargetId(e.target.value)} />
                    <Select aria-label="邀请角色" value={role} options={roles} onChange={setRole} />
                    <Button disabled={busy || !targetId.trim()} onClick={() => void run(async () => { const result = await inviteAssetMember(team.id, targetId.trim(), role); setInvitation(result.invitation); })}>生成定向邀请</Button>
                </Space>
                {invitation ? <div><p>仅指定账号可接受，有效期至 {new Date(invitation.expiresAt).toLocaleString()}。请自行私下传递；刷新后不再显示。</p><Input.Password aria-label="新邀请码" readOnly value={invitation.token} /><Button disabled={busy} onClick={() => void run(() => cancelAssetInvitation(team.id, invitation.id))}>撤销此邀请</Button></div> : null}
                {Object.entries(team.members || {}).map(([id, memberRole]) => <Space wrap key={id} className="my-2 flex">
                    <span>成员 {id}</span><Select aria-label={`成员 ${id} 角色`} disabled={busy} value={memberRole} options={[...roles, {value:"admin",label:"管理员"}]} onChange={(value: MemberRole) => void run(() => setAssetMemberRole(team.id,id,value))} />
                    <Button disabled={busy} danger onClick={() => void run(() => removeAssetMember(team.id,id))}>移除成员 {id}</Button>
                </Space>)}
                <Space wrap><Input aria-label="新项目名称" value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="新项目名称" /><Button disabled={busy || !projectName.trim()} onClick={() => void run(async () => { await createAssetProject(team.id,projectName.trim()); setProjectName(""); })}>创建项目</Button></Space>
            </> : null}
            {team.projects.map(project => <Card key={project.id} size="small" className="mt-2" title={`${project.name} · ${project.role}`}>
                {team.role === "admin" ? Object.keys(team.members || {}).filter(id => team.members?.[id] !== "admin").map(id => <Space wrap key={id} className="my-2 flex"><span>成员 {id}</span><Select aria-label={`${project.name} 成员 ${id} 权限`} disabled={busy} value={project.members?.[id] || "none"} options={[{value:"none",label:"无项目授权"},...roles]} onChange={value => void run(() => value === "none" ? removeAssetProjectMember(team.id,project.id,id) : setAssetProjectRole(team.id,project.id,id,value as "read" | "write"))} /></Space>) : <p>有效权限：{project.role}</p>}
            </Card>)}
        </> : null}
    </Card>;
}
