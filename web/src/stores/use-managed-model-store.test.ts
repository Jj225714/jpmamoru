import { beforeEach, describe, expect, it, vi } from "vitest";
import { getManagedSession, loginManagedSession, logoutManagedSession, ManagedModelSessionError } from "@/services/managed-model-session";
import { useManagedModelStore as store } from "./use-managed-model-store";

vi.mock("@/services/managed-model-session", async (original) => ({ ...(await original<typeof import("@/services/managed-model-session")>()), getManagedSession: vi.fn(), loginManagedSession: vi.fn(), logoutManagedSession: vi.fn() }));
const authenticated = { authenticated: true, enabled: true, principal: { id: "1", name: "Test" } };
beforeEach(() => {
    vi.resetAllMocks();
    store.getState().expire();
    store.setState({ session: null, phase: "checking", error: null, logoutPending: false });
});
describe("memory-only managed session", () => {
    it("replays refresh after invalidation without reusing the stale pending request", async () => {
        let resolve!: (value: typeof authenticated) => void;
        vi.mocked(getManagedSession)
            .mockReturnValueOnce(
                new Promise((done) => {
                    resolve = done;
                }),
            )
            .mockResolvedValueOnce(authenticated);
        const first = store.getState().refresh();
        store.getState().expire();
        await store.getState().refresh();
        expect(store.getState().phase).toBe("authenticated");
        resolve({ ...authenticated, authenticated: false });
        await first;
        expect(store.getState().phase).toBe("authenticated");
        expect(getManagedSession).toHaveBeenCalledTimes(2);
    });
    it("logs in without retaining the code", async () => {
        vi.mocked(loginManagedSession).mockResolvedValue(authenticated);
        expect(await store.getState().login("private-code")).toBe(true);
        expect(store.getState().phase).toBe("authenticated");
        expect(JSON.stringify(store.getState())).not.toContain("private-code");
    });
    it("does not restore authentication from a stale login", async () => {
        let resolve!: (value: typeof authenticated) => void;
        vi.mocked(loginManagedSession).mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const pending = store.getState().login("code");
        store.getState().expire();
        resolve(authenticated);
        expect(await pending).toBe(false);
        expect(store.getState().phase).toBe("anonymous");
    });
    it("ignores a refresh that finishes after logout", async () => {
        let resolve!: (value: typeof authenticated) => void;
        vi.mocked(getManagedSession).mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const pending = store.getState().refresh();
        vi.mocked(logoutManagedSession).mockResolvedValue();
        await store.getState().logout();
        resolve(authenticated);
        await pending;
        expect(store.getState().phase).toBe("anonymous");
    });
    it("blocks session refresh/login until failed logout is retried", async () => {
        vi.mocked(logoutManagedSession).mockRejectedValueOnce(new Error()).mockResolvedValueOnce();
        await store.getState().logout();
        expect(store.getState()).toMatchObject({ session: null, phase: "error", logoutPending: true });
        await store.getState().refresh();
        expect(await store.getState().login("other")).toBe(false);
        expect(getManagedSession).not.toHaveBeenCalled();
        await store.getState().logout();
        expect(store.getState()).toMatchObject({ phase: "anonymous", logoutPending: false });
    });
    it("expires on 401 and preserves quota errors as Chinese messages", async () => {
        vi.mocked(getManagedSession).mockRejectedValue(new ManagedModelSessionError(401, "失效"));
        await store.getState().refresh();
        expect(store.getState().phase).toBe("anonymous");
        vi.mocked(loginManagedSession).mockRejectedValue(new ManagedModelSessionError(429, "今日额度已用完"));
        await store.getState().login("code");
        expect(store.getState().error).toContain("额度");
    });
});
