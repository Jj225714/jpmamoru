import { beforeEach, expect, it, vi } from "vitest";
import { create } from "zustand";
vi.mock("./server-config", () => ({ useServerConfigStore: create(() => ({ user: { id: 1 }, phase: "ready" })) }));
import { useServerConfigStore } from "./server-config";
import { useMembershipLibrary, refreshMemberships, createAssetTeam, inviteAssetMember, acceptAssetInvitation, removeAssetMember, setAssetProjectRole } from "./membership-library";
import { listLibraryAssets, getLibraryAsset, getLibraryAssetContent, trashLibraryAsset, restoreLibraryAsset, setLibraryThumbnail, getLibraryQuota, getLibraryAudit, uploadLibraryAsset, type AssetScope } from "./asset-library";
const team = {id:"team-a",name:"Team",role:"admin",members:{"1":"admin"},projects:[]};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
beforeEach(() => {
    useServerConfigStore.setState({user:{id:1,email:"test@example.test"},phase:"ready"});
    useMembershipLibrary.setState({teams:[],error:"",loading:false});
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/memberships") ? {teams:[team]} : {ok:true})));
});
it("binds every membership mutation to Cookie and current account, then reloads authority", async () => {
    await createAssetTeam("Team"); await inviteAssetMember("team-a","2","read"); await acceptAssetInvitation("one-use-token"); await removeAssetMember("team-a","2"); await setAssetProjectRole("team-a","project-a","2","write");
    const calls = vi.mocked(fetch).mock.calls;
    const writes = calls.filter(([,options]) => options?.method !== "GET");
    expect(writes).toHaveLength(5);
    for(const [,options] of writes) { expect(options?.credentials).toBe("same-origin"); expect(options?.headers).toMatchObject({"X-Config-User":"1"}); }
    expect(JSON.parse(writes[1][1]!.body as string)).toEqual({targetId:"2",role:"read"});
    expect(writes[4][0]).toBe("/api/config-vault/memberships/teams/team-a/projects/project-a/members/2");
    expect(calls.filter(([url]) => String(url).endsWith("/memberships"))).toHaveLength(5);
});
it("clears selections immediately and ignores old responses including switch away and back", async () => {
    await refreshMemberships(); expect(useMembershipLibrary.getState().teams).toHaveLength(1);
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    const reading = refreshMemberships();
    useServerConfigStore.setState({user:{id:2,email:"other@example.test"}});
    expect(useMembershipLibrary.getState().teams).toEqual([]);
    useServerConfigStore.setState({user:{id:1,email:"test@example.test"}});
    finish(json({teams:[team]}));
    await expect(reading).rejects.toThrow("账号已切换");
    expect(useMembershipLibrary.getState().teams).toEqual([]);
});
it.each<AssetScope>([{scope:"personal"},{scope:"team",teamId:"team-a"},{scope:"project",teamId:"team-a",projectId:"project-a"}])("keeps every asset endpoint in the selected container: %j", async target => {
    await listLibraryAssets(target,true); await getLibraryAsset(target,"asset"); await getLibraryAssetContent(target,"asset"); await trashLibraryAsset(target,"asset"); await restoreLibraryAsset(target,"asset"); await setLibraryThumbnail(target,"asset","thumb"); await getLibraryQuota(target); await getLibraryAudit(target);
    for(const [raw,options] of vi.mocked(fetch).mock.calls) {
        const url=new URL(String(raw),"https://local.test");
        expect(url.searchParams.get("scope")).toBe(target.scope === "personal" ? null : target.scope);
        expect(url.searchParams.get("teamId")).toBe("teamId" in target ? target.teamId : null);
        expect(url.searchParams.get("projectId")).toBe("projectId" in target ? target.projectId : null);
        expect(options?.credentials).toBe("same-origin");
    }
});
it("refreshes membership after shared access is revoked without falling back to personal scope", async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith("/memberships") ? json({teams:[]}) : json({},403));
    await expect(listLibraryAssets({scope:"team",teamId:"team-a"})).rejects.toMatchObject({status:403});
    expect(useMembershipLibrary.getState().teams).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["/api/config-vault/asset-library?scope=team&teamId=team-a","/api/config-vault/memberships"]);
});
it("confirms indeterminate upload with a same-scope GET and never retries the POST", async () => {
    const blob=new Blob(["test"],{type:"text/plain"});
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join("");
    vi.mocked(fetch).mockImplementation(async (_url,options) => {
        if(options?.method === "POST") throw new TypeError("connection lost");
        return json({assets:[{id:"confirmed",sha256:digest,bytes:4,deletedAt:null}]});
    });
    const result=await uploadLibraryAsset({scope:"project",teamId:"team-a",projectId:"project-a"},"test",blob);
    expect(result).toMatchObject({asset:{id:"confirmed"},confirmedAfterError:true});
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    const [url,options]=vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(vi.mocked(fetch).mock.calls[1][0]);
    expect(JSON.parse(options!.body as string)).toEqual({scope:"project",name:"test",mimeType:"text/plain",data:"dGVzdA=="});
});
it("does not repeat or assume success when a membership mutation response is lost", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "POST" ? Promise.reject(new TypeError("lost")) : json({teams:[team]}));
    await expect(acceptAssetInvitation("token")).rejects.toThrow("lost");
    expect(useMembershipLibrary.getState().teams).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
});
it("does not retry or confirm a forbidden upload", async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith("/memberships") ? json({teams:[]}) : json({},403));
    await expect(uploadLibraryAsset({scope:"team",teamId:"team-a"},"test",new Blob(["test"]))).rejects.toMatchObject({status:403});
    expect(vi.mocked(fetch).mock.calls.filter(([,o])=>o?.method==="POST")).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.filter(([u,o])=>String(u).includes("asset-library")&&o?.method==="GET")).toHaveLength(0);
});
it("does not claim upload success when confirmation contains no matching active content", async () => {
    vi.mocked(fetch).mockImplementation(async (_url,o)=>o?.method==="POST"?json({},503):json({assets:[]}));
    await expect(uploadLibraryAsset({scope:"personal"},"test",new Blob(["test"]))).rejects.toThrow("上传结果未确认");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
});
it("stops upload before sending if the account changes during file reading", async () => {
    const blob=new Blob(["test"]);let finish!: (b:ArrayBuffer)=>void;
    vi.spyOn(blob,"arrayBuffer").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const work=uploadLibraryAsset({scope:"team",teamId:"team-a"},"test",blob);
    useServerConfigStore.setState({user:{id:2,email:"other@example.test"}});
    finish(new TextEncoder().encode("test").buffer);
    await expect(work).rejects.toThrow("账号已切换");expect(fetch).not.toHaveBeenCalled();
});
