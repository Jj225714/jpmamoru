import { CanvasNode } from "@/components/canvas/canvas-node";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasGenerationGate } from "@/components/canvas/canvas-generation-gate";
import { useReferenceReadiness, ReferenceReadinessPanel } from "./reference-readiness-panel";
import { useServerConfigStore } from "@/services/server-config";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
export function mount() {
 const testWindow = window as unknown as Record<string, any>;
 testWindow.accountStore = useServerConfigStore;
 document.getElementById("root")!.style.display = "none";
 const host = document.createElement("div"); document.body.append(host);
 testWindow.requests = 0; testWindow.commits = 0; testWindow.resolvers = [];
 const noop = () => {};
 const node: CanvasNodeData = {id:"node",type:CanvasNodeType.Image,title:"test",position:{x:0,y:0},width:300,height:300,metadata:{prompt:"test image"}};
 function Harness() {
  const [project,setProject] = useState("A"); testWindow.setProject=setProject;
  const queue=useReferenceReadiness(project); testWindow.queue=queue;
  return <CanvasGenerationGate.Provider value={!queue.ready()}><div data-harness style={{padding:24,width:600}}>
   <ReferenceReadinessPanel queue={queue}/>
   <CanvasNode data={{...node,id:"error",position:{x:650,y:100},metadata:{status:"error",errorDetails:"fixture"}}} scale={1} isSelected={false} isRelated={false} isFocusRelated={false} isConnectionTarget={false} isConnecting={false} showPanel={false} showImageInfo={false} onMouseDown={noop} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResizeStart={noop} onResize={noop} onResizeEnd={noop} onContentChange={noop} onTitleChange={noop} onContextMenu={noop} onRetry={()=>testWindow.requests++}/>
   <CanvasNodePromptPanel node={node} nodes={[node]} isRunning={false} onPromptChange={noop} onConfigChange={noop} onGenerate={()=>testWindow.requests++} onStop={noop}/>
   <CanvasConfigNodePanel node={{...node,type:CanvasNodeType.Config}} isRunning={false} inputSummary={{textCount:1,imageCount:0,videoCount:0,audioCount:0}} onConfigChange={noop} onComposerToggle={noop} onGenerate={()=>testWindow.requests++} onStop={noop}/>
  </div></CanvasGenerationGate.Provider>;
 }
 createRoot(host).render(<QueryClientProvider client={new QueryClient()}><App><Harness/></App></QueryClientProvider>);
}

