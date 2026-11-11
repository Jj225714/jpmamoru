import { afterEach, describe, expect, it, vi } from "vitest";
import { commercePolicyAdmin } from "./commerce-policy-admin";
const session = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./managed-model-session", () => ({ getManagedSession: session.get }));
afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});
describe("platform category administration", () => {
    it("sends the authenticated server principal and optimistic revision on writes", async () => {
        session.get.mockResolvedValue({ principal: { id: "admin-7" } });
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ canManage: true, revision: 4, draft: null, history: [] })));
        vi.stubGlobal("fetch", fetch);
        await commercePolicyAdmin("publish", { revision: 3 });
        expect(fetch).toHaveBeenCalledWith(
            "/api/managed/commerce-policies",
            expect.objectContaining({ credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Managed-Principal": "admin-7" }, body: JSON.stringify({ action: "publish", revision: 3 }) }),
        );
    });
    it("reads capabilities without mutation or a browser PIN", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ canManage: false, revision: 0, draft: null, history: [] })));
        vi.stubGlobal("fetch", fetch);
        expect((await commercePolicyAdmin()).canManage).toBe(false);
        expect(session.get).not.toHaveBeenCalled();
        expect(fetch.mock.calls[0][1].method).toBe("GET");
    });
    it.each([
        [403, "服务端账号"],
        [409, "其他管理员"],
    ])("reports actionable status %s instead of pretending a save succeeded", async (status, text) => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
        await expect(commercePolicyAdmin()).rejects.toThrow(text);
    });
    it("preserves structured gateway validation messages", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "validation", message: "启用场景必须有示例图" } }), { status: 422 })));
        await expect(commercePolicyAdmin()).rejects.toThrow("启用场景必须有示例图");
    });
});
