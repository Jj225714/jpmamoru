import { describe, expect, it, vi } from "vitest";
import { ReversePromptController } from "./reverse-prompt-controller";
describe("independent prompt extraction", () => {
    it("uploads without analysis, edits output, and only analyzes one image", async () => {
        const controller = new ReversePromptController();
        await controller.select(async () => "image-a");
        expect(controller.getSnapshot()).toMatchObject({ image: "image-a", result: "", status: "idle" });
        const analyze = vi.fn(async () => "description");
        await controller.run(analyze);
        expect(analyze).toHaveBeenCalledWith("image-a", expect.any(AbortSignal));
        controller.setResult("edited");
        expect(controller.getSnapshot().result).toBe("edited");
    });
    it.each(["image change", "unmount", "account ABA", "model config"])("invalidates late responses on %s", async () => {
        const controller = new ReversePromptController();
        await controller.select(async () => "a");
        let resolve!: (value: string) => void;
        let signal!: AbortSignal;
        const pending = controller.run((_, s) => {
            signal = s;
            return new Promise((r) => {
                resolve = r;
            });
        });
        controller.cancel();
        expect(signal.aborted).toBe(true);
        resolve("old secret");
        await pending;
        expect(controller.getSnapshot().result).toBe("");
        expect(controller.getSnapshot().status).toBe("idle");
    });
    it("ignores a late file read and blocks duplicate requests", async () => {
        const c = new ReversePromptController();
        let release!: (s: string) => void;
        const old = c.select(
            () =>
                new Promise((r) => {
                    release = r;
                }),
        );
        await c.select(async () => "new");
        release("old");
        await old;
        expect(c.getSnapshot().image).toBe("new");
        const analyze = vi.fn(
            () =>
                new Promise<string>((r) => {
                    release = r;
                }),
        );
        const pending = c.run(analyze);
        await c.run(analyze);
        expect(analyze).toHaveBeenCalledTimes(1);
        release("done");
        await pending;
    });
});
