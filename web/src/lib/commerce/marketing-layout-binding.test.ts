import { expect, it } from "vitest";
import { compositionDigest, bindCompositionRaster } from "./marketing-layout-binding";
import type { LayeredComposition } from "@/types/commerce";
const comp = { id: "old", revision: 1, width: 1024, height: 1024, backgroundColor: "white", layoutVersion: 2, layers: [{id:"layer",sourceAssetId:"asset1",type:"text",content:"Colour",fontFamily:"Arial",fontSize:36,x:20,y:700,width:980,height:200}] } as LayeredComposition;
it("binds visual edits and source content but survives bookkeeping rebases", async()=>{
 const hash=await compositionDigest(comp);
 expect(await compositionDigest({...comp,id:"new",revision:2,layers:comp.layers.map(l=>({...l,id:"newlayer",sourceAssetId:"newasset"}))})).toBe(hash);
 expect(await compositionDigest({...comp,layers:comp.layers.map(l=>({...l,letterSpacing:2}))})).not.toBe(hash);
 expect(await compositionDigest({...comp,layers:comp.layers.map(l=>({...l,content:"Color"}))})).not.toBe(hash);
 const a=await bindCompositionRaster(comp,new Blob(["first"]));const b=await bindCompositionRaster(comp,new Blob(["second"]));
 expect(a.layoutDigest).toBe(b.layoutDigest);expect(a.rasterDigest).not.toBe(b.rasterDigest);
});
