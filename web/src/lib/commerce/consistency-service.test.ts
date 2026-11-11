import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommerceJob, CommerceSku } from "@/types/commerce";
import type { ConsistencyConstraint, ConsistencyObservations } from "./consistency-types";
const m = vi.hoisted(() => ({ state: {} as any, valid: true, set: vi.fn(), decode: vi.fn(), evaluate: vi.fn(), validate: vi.fn(), zip: vi.fn(), blob: vi.fn(), fit: vi.fn(), source: new Uint8ClampedArray(16), result: new Uint8ClampedArray(16) }));
vi.mock("@/stores/use-commerce-store", () => ({ useCommerceStore: { getState: () => m.state, setState: (patch: unknown) => m.set(patch) } }));
vi.mock("@/services/image-storage", () => ({ imageToDataUrl: (ref: {url:string}) => m.decode(ref), getImageBlob: m.blob }));
vi.mock("./marketing-typography", () => ({ inspectCompositionLayout: async () => ({errors:[],warnings:[]}) }));
vi.mock("@/lib/zip", () => ({createZip:m.zip}));
vi.mock("./export-image", () => ({fitExportImage:m.fit}));
vi.mock("@/lib/commerce/template-renderer", () => ({renderCompositionLayerPng:vi.fn()}));
vi.mock("@/lib/commerce/policy-engine", () => ({canExportSku:() => true,retainManualDecisions:(checks:unknown) => checks,runAssetContentChecks:async () => [],runDeterministicChecks:() => []}));
vi.mock("@/lib/commerce/generation-config", () => ({expectedAssetCount:() => 1}));
import { exportCommerceJob } from "./export";
vi.mock("./request-session", () => ({ captureCommerceRequestSession: () => ({ assertCurrent: () => { if (!m.valid) throw Error("账号已变化"); }, dispose: vi.fn() }) }));
vi.mock("./consistency-check", () => ({ evaluateConsistency: (...args: unknown[]) => m.evaluate(...args), validateConsistencyConstraint: (c: unknown) => m.validate(c) }));
import { assertConsistencyCurrent, captureConsistencyRequest, consistencyBlockReason, createConsistencyRepairRevision, decideConsistencyReport, hashConsistencyPixels, saveConsistencyConstraints, saveConsistencyObservations } from "./consistency-service";
import { createWhiteGeometrySnapshot } from "./white-geometry-snapshot";
import { DEFAULT_WHITE_ADJUSTMENTS } from "./white-image-edit";
import { consistencyBlockReason as pureConsistencyBlockReason } from "./consistency-state";
const job = (): CommerceJob => m.state.jobs[0];
const sku = (): CommerceSku => job().skus[0];
const observations = { observer: "observer", planeConfirmed: true, independentConfirmed: true, mirrored: false, corners: [{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}], points: [] } as unknown as ConsistencyObservations;
beforeEach(async () => {
    vi.clearAllMocks(); m.valid = true; m.source = new Uint8ClampedArray(16).fill(255); m.result = m.source.slice();
    m.decode.mockImplementation(async ref => ref.url);
    vi.stubGlobal("fetch", async (url: string) => ({ ok: true, blob: async () => ({url}) }));
    vi.stubGlobal("createImageBitmap", async ({url}: {url:string}) => ({ width:2,height:2,data:(url === "source" ? m.source : m.result).slice(),close:vi.fn() }));
    vi.stubGlobal("document", { createElement: () => { let pixels: Uint8ClampedArray; return { getContext: () => ({drawImage: (b: {data:Uint8ClampedArray}) => { pixels=b.data; },getImageData: () => ({data:pixels})}) }; } });
    m.validate.mockImplementation(c => c?.plane ? [] : ["约束结构损坏"]);
    m.evaluate.mockResolvedValue({ numericStatus:"pass",metrics:[],reasons:[],boundary:"synthetic test" });
    const constraints = { version:1,revision:1,sourceImageId:"source",sourceContentHash:await hashConsistencyPixels({width:2,height:2,data:m.source}),sourceWidth:2,sourceHeight:2,scope:"pattern",provenance:"synthetic",plane:{id:"plane",x:0,y:0,width:2,height:2,frontViewConfirmed:true},points:[],dimensions:[],regions:[],thresholds:{maxPx:2,rmsePx:1,relative:.01},confirmedBy:"r",confirmedAt:"old" } as ConsistencyConstraint;
    m.state = { jobs:[{id:"job",generationConfig:{size:2},locales:["en-US"],skus:[{id:"sku",activeRevision:1,product:{id:"p",images:[{id:"source",url:"source"}]},assets:[{id:"a",revision:1,title:"result",stage:"main-white",url:"result",width:2,height:2}],compositions:[],approvals:[{approved:true}],checks:[{}],consistency:{constraints,reports:[]}}]}],brands:[],policyPacks:[] };
    m.set.mockImplementation(patch => { m.state = {...m.state,...patch}; });
    m.blob.mockResolvedValue(new Blob(["image"],{type:"image/png"})); m.zip.mockResolvedValue(new Blob());
    m.fit.mockImplementation(async (b: Blob) => b);
});
async function boundReport() { sku().assets[0].consistencyRequest = await captureConsistencyRequest(job(),sku()); return saveConsistencyObservations("job","sku","a",observations); }
async function accepted() { const report = await boundReport(); await decideConsistencyReport("job","sku",report.id,"accept","r","independently checked"); return report; }
describe("consistency service state and pixel binding", () => {
    it("matches the public white snapshot RGBA hash and detects byte changes", async () => {
        const pixels = {width:2,height:2,data:m.source};
        const record = {id:"r",createdAt:"old",source:{id:"source"},editor:{version:1 as const,layer:{url:"source",width:2,height:2,bytes:16,mimeType:"image/png"},base:{width:2,height:2,bounds:{x:0,y:0,width:2,height:2}},applied:DEFAULT_WHITE_ADJUSTMENTS},output:{size:1024 as const,format:"png" as const}};
        const result = await createWhiteGeometrySnapshot({record,sourcePixels:pixels,layerPixels:pixels,sourceToLayer:{kind:"identity"}});
        expect(result.status).toBe("ready"); if (result.status !== "ready") throw Error(result.reason); const snapshot = result.snapshot;
        expect(await hashConsistencyPixels(pixels)).toBe(snapshot.sourceContentHash);
        m.source[0] = 0; expect(await hashConsistencyPixels(pixels)).not.toBe(snapshot.sourceContentHash);
    });
    it("deep freezes a captured request and rejects unconfirmed or same-URL changed pixels", async () => {
        const request = await captureConsistencyRequest(job(),sku()); expect(Object.isFrozen(request!.constraints.plane)).toBe(true);
        m.source[0]=0; await expect(captureConsistencyRequest(job(),sku())).rejects.toThrow("内容已变化");
        sku().consistency!.constraints.confirmedAt=undefined; await expect(captureConsistencyRequest(job(),sku())).rejects.toThrow("尚未确认");
    });
    it.each(["account","sku","config"])("rejects stale %s during request capture", async kind => {
        m.decode.mockImplementationOnce(async ref => { if(kind === "account")m.valid=false; if(kind === "sku") job().skus=[{...sku()}]; if(kind === "config") job().generationConfig={...job().generationConfig,size:4} as any; return ref.url; });
        await expect(captureConsistencyRequest(job(),sku())).rejects.toThrow(/变化|改变/);
    });
    it("requires explicit acceptance; undefined job lookup matches and byte changes invalidate", async () => {
        const report=await boundReport(); expect(report.status).toBe("needs-review"); expect(consistencyBlockReason(job(),sku())).toBeTruthy();
        await decideConsistencyReport("job","sku",report.id,"accept","r","checked");
        expect(consistencyBlockReason(undefined,sku())).toBeUndefined(); await assertConsistencyCurrent(job(),sku());
        m.result[0]=0; await expect(assertConsistencyCurrent(job(),sku())).rejects.toThrow("像素内容变化");
    });
    it.each(["deviation","not-measurable"])("cannot accept %s", async numericStatus => { m.evaluate.mockResolvedValue({numericStatus,metrics:[],reasons:[],boundary:"test"}); const report=await boundReport(); await expect(decideConsistencyReport("job","sku",report.id,"accept","r","checked")).rejects.toThrow("仅能接受"); });
    it("cannot accept a report without original request binding", async () => { const report=await saveConsistencyObservations("job","sku","a",observations); await expect(decideConsistencyReport("job","sku",report.id,"accept","r","checked")).rejects.toThrow("原请求"); });
    it("invalidates config and layout changes and rejects stale object arguments", async () => {
        await accepted(); const oldJob=job(),oldSku=sku(); m.state={...m.state,jobs:[{...job(),skus:[{...sku()}]}]};
        await expect(assertConsistencyCurrent(oldJob,oldSku)).rejects.toThrow("变化");
        job().generationConfig={...job().generationConfig,size:4} as any; expect(consistencyBlockReason(job(),sku())).toContain("过期");
    });
    it("saving constraints clears gates and leaves prior reports as history", async () => { await accepted(); await saveConsistencyConstraints("job","sku",sku().consistency!.constraints,"r"); expect(sku().consistency!.constraints.revision).toBe(2); expect(sku().consistency!.reports).toHaveLength(1); expect(sku().approvals).toEqual([]); expect(consistencyBlockReason(job(),sku())).toContain("返修"); });
    it("same-URL source pixel changes invalidate an accepted report", async () => { await accepted(); m.source[0]=0; await expect(assertConsistencyCurrent(job(),sku())).rejects.toThrow("像素内容变化"); });
    it("same-ID composition edits invalidate the accepted report", async () => { sku().assets[0].compositionId="layout"; sku().compositions=[{id:"layout",revision:1,layers:[{content:"old"}]}] as any; await accepted(); sku().compositions[0].layers[0].content="new"; expect(consistencyBlockReason(undefined,sku())).toContain("过期"); });
    it("pure SKU gate needs no store and the full job gate also verifies configuration", async () => { await accepted(); const currentSku=sku(),currentJob=job(); m.state={}; expect(pureConsistencyBlockReason(undefined,currentSku)).toBeUndefined(); currentJob.locales=["en-GB"]; expect(pureConsistencyBlockReason(currentJob,currentSku)).toContain("过期"); currentSku.activeRevision=2; expect(pureConsistencyBlockReason(undefined,currentSku)).toBeTruthy(); });
    it("does not save an observation if the original SKU is mutated in place during evaluation", async () => { sku().assets[0].consistencyRequest=await captureConsistencyRequest(job(),sku()); m.evaluate.mockImplementationOnce(async () => { sku().stageMessage="concurrent"; return {numericStatus:"pass",metrics:[],reasons:[],boundary:"test"}; }); await expect(saveConsistencyObservations("job","sku","a",observations)).rejects.toThrow("变化"); expect(m.set).not.toHaveBeenCalled(); });
    it("a damaged reports array fails closed", async () => { await accepted(); (sku().consistency as any).reports=null; expect(consistencyBlockReason(undefined,sku())).toContain("尚未通过"); });
    it("reject and repair preserve history without dispatching generation", async () => { const report=await boundReport(); await decideConsistencyReport("job","sku",report.id,"reject","r","wrong pattern"); expect(sku().stage).toBe("failed"); await createConsistencyRepairRevision("job","sku"); expect(sku().activeRevision).toBe(2); expect(sku().assets).toHaveLength(1); expect(sku().consistency!.reports).toHaveLength(1); expect(sku().approvals).toEqual([]); });
    it("cannot delete constraints to bypass historical request binding", async () => { await accepted(); sku().consistency=undefined; expect(consistencyBlockReason(job(),sku())).toContain("缺少约束"); await expect(captureConsistencyRequest(job(),sku())).rejects.toThrow("删除约束"); });
    it("handles damaged constraints and report arrays without crashing the guard", async () => { (sku().consistency!.constraints as any).plane=null; expect(consistencyBlockReason(job(),sku())).toContain("无效"); await expect(captureConsistencyRequest(job(),sku())).rejects.toThrow("尚未确认"); await expect(saveConsistencyObservations("job","sku","a",observations)).rejects.toThrow("约束数据无效"); });
    it("rolls back failed persistence and reports failure", async () => { const previous=sku(); m.set.mockImplementationOnce(patch => { m.state={...m.state,...patch}; return Promise.reject(Error("disk failure")); }); await expect(createConsistencyRepairRevision("job","sku")).rejects.toThrow("disk failure"); expect(sku()).toBe(previous); });
    it("does not roll back concurrent changes on persistence failure", async () => { m.set.mockImplementationOnce(patch => { m.state={...m.state,...patch}; return Promise.resolve().then(() => { m.state={...m.state,jobs:[{...job(),name:"concurrent"}]}; throw Error("disk failure"); }); }); await expect(createConsistencyRepairRevision("job","sku")).rejects.toThrow("disk failure"); expect(job().name).toBe("concurrent"); });
    it("exports exact constraint, immutable request and accepted report evidence together", async () => {
        job().name="test"; sku().product.sku="SKU"; job().generationConfig={...job().generationConfig,outputSpec:{maxBytes:1000},delivery:"flattenedOnly"} as any; sku().assets[0].storageKey="result"; sku().assets[0].sequence=1;
        await accepted(); await exportCommerceJob(job());
        const files=m.zip.mock.calls[0][0] as Array<{name:string,data:string}>;
        const evidence=JSON.parse(files.find(f => f.name.endsWith("consistency-evidence.json"))!.data);
        expect(evidence.constraints).toEqual(sku().consistency!.constraints); expect(evidence.reports).toEqual(sku().consistency!.reports); expect(evidence.requests).toEqual([{assetId:"a",request:sku().assets[0].consistencyRequest}]);
        expect(evidence.reports[0].constraintHash).toBe(evidence.requests[0].request.hash); expect(evidence.reports[0].decision.action).toBe("accept");
    });
    it("real export blocks changed result bytes before creating a ZIP", async () => { job().generationConfig={...job().generationConfig,outputSpec:{maxBytes:1000}} as any; await accepted(); m.result[0]=0; await expect(exportCommerceJob(job())).rejects.toThrow("像素内容变化"); expect(m.zip).not.toHaveBeenCalled(); expect(m.blob).not.toHaveBeenCalled(); });
    it("cannot silently compress an accepted result into different export bytes", async () => {
        job().name="test"; sku().product.sku="SKU"; job().generationConfig={...job().generationConfig,outputSpec:{maxBytes:1000},delivery:"flattenedOnly"} as any; sku().assets[0].storageKey="result";
        await accepted(); m.fit.mockResolvedValue(new Blob(["re-encoded pixels"]));
        await expect(exportCommerceJob(job())).rejects.toThrow("导出压缩会改变已复核图片"); expect(m.zip).not.toHaveBeenCalled();
    });
    it("rechecks after asynchronous export file reads", async () => {
        job().name="test"; sku().product.sku="SKU"; job().generationConfig={...job().generationConfig,outputSpec:{maxBytes:1000},delivery:"flattenedOnly"} as any; sku().assets[0].storageKey="result";
        await accepted(); m.fit.mockImplementation(async (b: Blob) => { m.source[0]=0; return b; });
        await expect(exportCommerceJob(job())).rejects.toThrow("像素内容变化"); expect(m.zip).not.toHaveBeenCalled();
    });
});
