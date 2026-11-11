import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SettingsEnvelope, TeamSettings } from "@/types/settings-sync";
import { prepareCategoryTeamDraft } from "./category-team-draft";
const edits = { policyPack: { name: "edited" }, brands: [] } as unknown as TeamSettings;
const server = () => ({ permissions: { manageTeam: true }, draft: { revision: 4, value: { ...edits, modelConfig: { name: "latest-draft" }, futureField: "draft-field" } }, team: { value: { ...edits, modelConfig: { name: "published" }, publishedOnly: true } } }) as unknown as SettingsEnvelope;
it("preserves fresh server model and unrelated fields while replacing only owned fields", async () => {
    const value = server();const snapshot = JSON.stringify(value);
    const result = await prepareCategoryTeamDraft(edits,4,{load:async()=>value,prepare:async v=>structuredClone(v),isCurrent:()=>true});
    expect(result.value).toMatchObject({ ...edits, modelConfig:{name:"latest-draft"}, futureField:"draft-field",publishedOnly:true });
    expect(JSON.stringify(value)).toBe(snapshot);
});
it("does not upload or prepare a stale draft and explains local edits are retained", async () => {
    const prepare=vi.fn();await expect(prepareCategoryTeamDraft(edits,3,{load:async()=>server(),prepare,isCurrent:()=>true})).rejects.toThrow("本地修改已保留");expect(prepare).not.toHaveBeenCalled();
});
it("supports pre-model legacy data without adding local model settings", async () => {
    const value=server();delete value.draft!.value!.modelConfig;delete value.team.value!.modelConfig;
    const result=await prepareCategoryTeamDraft(edits,4,{load:async()=>value,prepare:async v=>v,isCurrent:()=>true});expect(result.value.modelConfig).toBeUndefined();
});
it("rejects account switches after GET and after attachment preparation", async () => {
    for(const phase of ["load","prepare"]){let current=true;await expect(prepareCategoryTeamDraft(edits,4,{load:async()=>{if(phase==="load")current=false;return server();},prepare:async v=>{current=false;return v;},isCurrent:()=>current})).rejects.toThrow("账号已变化");}
});
it("wires both category save and validate to the fresh-server merge", () => {
    const source=readFileSync(new URL('./category-admin.tsx',import.meta.url),'utf8');
    expect(source.match(/await prepareLatest\(\)/g)).toHaveLength(2);
    expect(source).not.toContain('prepareTeamSettingsForServer({ policyPack: draft, brands }');
    expect(source).toContain('saveTeamDraft(value, revision)');
});
