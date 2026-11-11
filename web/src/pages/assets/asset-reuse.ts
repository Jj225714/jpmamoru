import { restoreGenerationInput, type AssetGenerationInfo } from "./generation-info";
import type { ReferenceReadiness } from "../image/reference-readiness";

/** Each navigation/effect setup owns an attempt. Cleanup must not mark an uncommitted restore as done. */
export function beginAssetReuse(queue: ReferenceReadiness, info: AssetGenerationInfo | undefined, commit: (input: Awaited<ReturnType<typeof restoreGenerationInput>>) => void, read = restoreGenerationInput) {
    queue.reset();
    const snapshot = info ? structuredClone(info) : undefined;
    const id = queue.add("恢复资产生成输入", async () => {
        if (!snapshot) throw new Error("资产不存在或没有生成来源，请返回资产页确认");
        return read(snapshot);
    }, commit);
    return () => queue.remove(id);
}

export function assetReuseLink(id: string) {
    return `/image?${new URLSearchParams({ reuseAsset: id, reuseRequest: crypto.randomUUID() })}`;
}
