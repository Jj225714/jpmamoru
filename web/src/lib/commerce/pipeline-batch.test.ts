import { beforeEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { CommerceJob } from "@/types/commerce";
const m=vi.hoisted(()=>({jobs:[] as CommerceJob[],config:{},white:vi.fn(),content:vi.fn(),text:vi.fn(),epoch:0}));
vi.mock("@/stores/use-commerce-store",()=>({useCommerceStore:{getState:()=>({jobs:m.jobs})}}));
vi.mock("@/stores/use-config-store",()=>({useConfigStore:{getState:()=>({config:m.config})},resolveModelRequestConfig:vi.fn()}));
vi.mock("@/services/server-config",()=>({useServerConfigStore:createStore(()=>({user:null as {id:number}|null}))}));
vi.mock("./request-session",()=>({getCommerceAccountEpoch:()=>m.epoch}));
vi.mock("./pipeline",()=>({prepareWhiteBackground:m.white,generateContent:m.content}));
vi.mock("@/services/api/image",()=>({requestImageQuestion:m.text}));
vi.mock("@/services/image-storage",()=>({imageToDataUrl:vi.fn()}));
import { runCommerceBatch } from "./pipeline-batch";
import { readBatchJournal } from "./pipeline-batch-task";
import { useServerConfigStore } from "@/services/server-config";
beforeEach(()=>{
 vi.clearAllMocks();m.epoch=0;useServerConfigStore.setState({user:{id:101} as never});
 const storage=new Map<string,string>();vi.stubGlobal("localStorage",{getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v)});
 let locked=false;vi.stubGlobal("navigator",{locks:{request:async(_name:string,_options:unknown,run:(lock:object|null)=>Promise<unknown>)=>{if(locked)return run(null);locked=true;try{return await run({});}finally{locked=false;}}}});
 m.jobs=[{id:"job",skus:["A","B","C"].map(id=>({id,activeRevision:1,stage:"draft",assets:[],approvals:[],product:{images:id==="C"?[]:[{}],imageStatus:id==="C"?"missing":"ready"}}))} as unknown as CommerceJob];
 m.white.mockImplementation(async(_j,id,_mode,runtime)=>{runtime.assertCurrent();if(id==="B")throw new Error("synthetic failure");m.jobs[0].skus.find(s=>s.id===id)!.stage="white-review";});
});
it("keeps success, records missing/failed rows and retries only failed SKU",async()=>{
 await runCommerceBatch("job");expect(m.white.mock.calls.map(c=>c[1])).toEqual(["A","B"]);
 expect(readBatchJournal("job","101").skus).toMatchObject({A:{status:"review"},B:{status:"failed"},C:{status:"failed"}});
 m.white.mockImplementation(async(_j,id)=>{m.jobs[0].skus.find(s=>s.id===id)!.stage="white-review";});
 await runCommerceBatch("job",{retryFailed:true});expect(m.white.mock.calls.map(c=>c[1])).toEqual(["A","B","B"]);
});
it("rejects another page while the batch lock is held",async()=>{
 let release!:()=>void;const pending=new Promise<void>(r=>release=r);m.white.mockImplementationOnce(async()=>pending);
 const first=runCommerceBatch("job");await Promise.resolve();await expect(runCommerceBatch("job")).rejects.toThrow("其他页面");release();await first;
});
it("drops a delayed response after account changes, including A-B-A epoch",async()=>{
 m.white.mockImplementationOnce(async(_j,_s,_mode,runtime)=>{m.epoch++;runtime.assertCurrent();});
 await expect(runCommerceBatch("job")).rejects.toThrow("账号或配置");expect(m.jobs[0].skus[0].assets).toEqual([]);expect(m.white).toHaveBeenCalledOnce();
});
it("never repeats an uncertain paid text request after refresh-like resume",async()=>{
 m.jobs[0].skus=m.jobs[0].skus.slice(0,1);m.jobs[0].skus[0].approvals=[{gate:"white-background",approved:true,assetRevision:1} as never];
 m.text.mockRejectedValueOnce(new Error("connection lost"));
 m.content.mockImplementation(async(_job,_sku,runtime)=>runtime.text("copy",{textModel:"text"},[{role:"user",content:"known facts"}]));
 await runCommerceBatch("job");await runCommerceBatch("job",{retryFailed:true});expect(m.text).toHaveBeenCalledOnce();expect(readBatchJournal("job","101").skus.A.message).toContain("禁止重复付费");
});

it("rejects unsigned sessions before any model work",async()=>{useServerConfigStore.setState({user:null});await expect(runCommerceBatch("job")).rejects.toThrow("先登录");expect(m.white).not.toHaveBeenCalled();});
