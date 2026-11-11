import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ teams: [] as unknown[], error: "" }));
vi.mock("@/services/server-config", () => ({ useServerConfigStore: (select: (s: unknown) => unknown) => select({user:{id:42}}) }));
vi.mock("@/services/membership-library", () => ({ useMembershipLibrary: () => fixture, refreshMemberships:vi.fn() }));
import { MembershipLibraryPanel } from "./membership-library-panel";
it("shows the authenticated recipient ID and targeted acceptance without a global-admin shortcut", () => {
    const html=renderToStaticMarkup(<MembershipLibraryPanel />);
    expect(html).toContain("42"); expect(html).toContain("定向邀请码"); expect(html).toContain("接受邀请");
    expect(html).toContain("创建团队"); expect(html).toContain("资产团队");
    expect(html).not.toContain("生成定向邀请"); expect(html).not.toContain("移除成员");
});
