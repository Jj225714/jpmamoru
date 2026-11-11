import { createContext, useContext } from "react";

export const CanvasGenerationGate = createContext(false);
export const useCanvasGenerationBlocked = () => useContext(CanvasGenerationGate);
export const referenceWaitMessage = "参考图读取/上传未完成，请等待，或重试/移除失败图片";
