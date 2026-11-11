import { getServerConfigEnabled } from "@/constant/runtime-config";
import type { AiConfig } from "@/stores/use-config-store";

let capture: ((config?: Partial<AiConfig>) => () => void) | undefined;
export function registerSettingsSessionGuard(factory: (config?: Partial<AiConfig>) => () => void) {
    capture = factory;
}

/** Capture synchronously before reference-image decoding or any other asynchronous work. */
export function ensureSettingsReady(config?: Partial<AiConfig>): () => void {
    if (!getServerConfigEnabled()) return () => {};
    if (!capture) throw new Error("请先登录并完成配置同步，再开始生成。");
    return capture(config);
}
