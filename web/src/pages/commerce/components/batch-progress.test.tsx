import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import type { CommerceJob } from "@/types/commerce";

const m = vi.hoisted(() => ({ confirm: vi.fn(), error: vi.fn(), white: vi.fn(), content: vi.fn(), run: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: () => [undefined, vi.fn()], useRef: (current: unknown) => ({ current }), useEffect: vi.fn(), useSyncExternalStore: vi.fn() }));
vi.mock("antd", () => ({ App: { useApp: () => ({ message: { error: m.error }, modal: { confirm: m.confirm } }) }, Alert: "alert", Button: "button", Card: "section", Space: "div", Table: "table", Tag: "span", Modal: "dialog" }));
vi.mock("@/lib/commerce/request-session", () => ({ getCommerceAccountEpoch: () => 0 }));
vi.mock("./import-preview", () => ({ ImportPreview: "div" }));
vi.mock("@/lib/commerce/importers-preview", () => ({ createImportPreview: vi.fn(), buildImportProducts: vi.fn() }));
vi.mock("@/stores/use-commerce-store", () => ({ useCommerceStore: { getState: vi.fn() } }));
vi.mock("@/services/server-config", () => ({ useServerConfigStore: () => "account" }));
vi.mock("@/lib/commerce/pipeline", () => ({ approveContent: m.content, approveWhiteBackground: m.white }));
vi.mock("@/lib/commerce/pipeline-batch", () => ({ batchAccount: () => "account", batchSnapshot: vi.fn(), batchSubscribe: vi.fn(), isBatchRunning: () => false, runCommerceBatch: m.run, stopCommerceBatch: vi.fn() }));
vi.mock("@/lib/commerce/pipeline-batch-task", () => ({ readBatchJournal: () => undefined }));
import { BatchProgress } from "./batch-progress";

function findButton(node: ReactNode, label: string): { onClick: () => void } | undefined {
    for (const child of Children.toArray(node)) {
        if (!isValidElement<{ children?: ReactNode; onClick: () => void }>(child)) continue;
        if (child.type === "button" && child.props.children === label) return child.props;
        const nested = findButton(child.props.children, label);
        if (nested) return nested;
    }
}
beforeEach(() => { vi.clearAllMocks(); m.white.mockReset().mockResolvedValue(undefined); m.content.mockReset().mockResolvedValue(undefined); m.run.mockReset().mockResolvedValue(undefined); });
describe.each(["white", "content"] as const)("batch %s confirmation", gate => {
    const open = () => {
        const stage = gate === "white" ? "white-review" : "content-review";
        const job = { id: "job", skus: ["a", "b"].map(id => ({ id, stage, product: { images: [] }, assets: [] })) } as unknown as CommerceJob;
        const label = gate === "white" ? "批准已检查白底并继续方案" : "批准已检查内容并继续交付";
        findButton(BatchProgress({ job }), label)!.onClick();
        return m.confirm.mock.calls[0][0].onOk as () => Promise<void>;
    };
    const approve = () => gate === "white" ? m.white : m.content;
    it("handles approval rejection with its real reason and no continuation", async () => {
        approve().mockRejectedValueOnce(new Error("参考图或结果像素内容变化，一致性报告已过期"));
        await expect(open()()).resolves.toBeUndefined();
        expect(m.error).toHaveBeenCalledWith("参考图或结果像素内容变化，一致性报告已过期");
        expect(approve()).toHaveBeenCalledTimes(1); expect(m.run).not.toHaveBeenCalled();
    });
    it("waits for all approvals then continues normally", async () => {
        let release!: () => void;
        approve().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
        const pending = open()(); expect(m.run).not.toHaveBeenCalled(); expect(approve()).toHaveBeenCalledTimes(1);
        release(); await pending;
        expect(approve().mock.calls).toEqual([["job", "a", "batch-review"], ["job", "b", "batch-review"]]);
        expect(m.run).toHaveBeenCalledExactlyOnceWith("job"); expect(m.error).not.toHaveBeenCalled();
    });
    it("also handles continuation errors without rejecting the modal callback", async () => {
        m.run.mockRejectedValueOnce(new Error("后续批次失败"));
        await expect(open()()).resolves.toBeUndefined(); expect(m.error).toHaveBeenCalledWith("后续批次失败");
    });
});
