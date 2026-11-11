import { afterEach, describe, expect, it, vi } from "vitest";
import { getManagedSession, loginManagedSession, logoutManagedSession, ManagedModelSessionError } from "./managed-model-session";

afterEach(() => vi.unstubAllGlobals());
describe("managed session transport", () => {
    it("uses same-origin cookies and sends only the code in JSON", async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true, enabled: true, apiKey: "never-retain" })));
        vi.stubGlobal("fetch", fetcher);
        expect(await loginManagedSession("test-code")).toEqual({ authenticated: true, enabled: true });
        expect(fetcher).toHaveBeenCalledWith("/api/managed/login", expect.objectContaining({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", body: '{"code":"test-code"}' }));
    });
    it.each([401, 429, 503])("maps %s without exposing response secrets", async (status) => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret upstream message", { status })));
        await expect(getManagedSession()).rejects.toBeInstanceOf(ManagedModelSessionError);
        await expect(getManagedSession()).rejects.toMatchObject({ status });
        await expect(getManagedSession()).rejects.not.toThrow("secret");
    });
    it("accepts an empty logout response", async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal("fetch", fetcher);
        await logoutManagedSession();
        expect(fetcher).toHaveBeenCalledWith("/api/managed/logout", expect.objectContaining({ method: "POST" }));
    });
    it("rejects malformed status and sanitizes network errors", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
        await expect(getManagedSession()).rejects.toMatchObject({ status: 502 });
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private details")));
        await expect(getManagedSession()).rejects.toMatchObject({ status: 0 });
    });
});
