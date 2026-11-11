import { afterEach, expect, it, vi } from "vitest";

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({ withLocalProxy: (url: string) => url }));
vi.mock("@/lib/managed-model-config", () => ({ managedResponseStatus: notify }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { imageToDataUrl, uploadImage } from "./image-storage";

afterEach(() => { vi.unstubAllGlobals(); notify.mockClear(); });
it.each([imageToDataUrl, (input: { url: string }) => uploadImage(input.url)])("reports inaccessible legacy media without restarting access-code authorization", async (read) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(read({ url: "/api/managed/media/private-token" })).rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
});
