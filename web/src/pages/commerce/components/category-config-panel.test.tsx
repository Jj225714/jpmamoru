import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createBuiltInPolicyPack } from "@/lib/commerce/defaults";
import { CategoryConfigPanel } from "./category-config-panel";

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, sync: {} as Record<string, unknown>, online: false }));
vi.mock("@/stores/use-commerce-store", () => ({ useCommerceStore: (select: (state: unknown) => unknown) => select(fixture.state) }));
vi.mock("./team-brand-editor", () => ({ TeamBrandEditor: () => null }));
vi.mock("./policy-editor", () => ({ PolicyEditor: () => null }));
vi.mock("./category-admin", () => ({ CategoryAdmin: () => <div>统一账号团队草稿编辑</div> }));
vi.mock("@/services/server-config", () => ({ useServerConfigStore: () => fixture.sync, reloadTeamConfiguration: vi.fn() }));
vi.mock("@/constant/runtime-config", () => ({ getServerConfigEnabled: () => fixture.online }));

describe("category settings without retired authentication", () => {
    it("shows the current local version and an actionable local editing path", () => {
        const pack = createBuiltInPolicyPack();
        fixture.state = {
            hydrated: true,
            policyPacks: [
                { ...pack, id: "local-current", name: "本地当前版本", version: 9, status: "published" },
                { ...pack, id: "server-aoweisi-old", version: 2, status: "published" },
            ],
            catalogStatus: { phase: "disabled" },
            owner: { name: "负责人" },
            loadServerCatalog: vi.fn(),
        };
        const html = renderToStaticMarkup(
            <MemoryRouter>
                <CategoryConfigPanel />
            </MemoryRouter>,
        );
        expect(html).toContain("本地当前版本");
        expect(html).toContain("编辑本地副本");
        expect(html).toContain("/commerce/settings");
        expect(html).toContain("本地 PIN 不作为团队权限");
        expect(html).not.toContain("登录管理会话");
        expect(html).not.toContain('type="password"');
    });
    it("uses the published team hierarchy before a newer local pack and mounts unified administration", () => {
        fixture.online = true;
        const pack = createBuiltInPolicyPack();
        fixture.state = { hydrated: true, policyPacks: [{ ...pack, name: "不应优先的本地规则", version: 999, status: "published" }], catalogStatus: { phase: "disabled" }, loadServerCatalog: vi.fn() };
        fixture.sync = { user: { id: 1 }, serverTeam: { policyPack: { ...pack, name: "已发布团队版本", categories: [{ id: "root", name: "团队大类", active: true, order: 1, rules: [], referenceIds: [], requirementIds: [], aliases: [] }] } } };
        const html = renderToStaticMarkup(
            <MemoryRouter>
                <CategoryConfigPanel />
            </MemoryRouter>,
        );
        expect(html).toContain("已发布团队版本");
        expect(html).toContain("统一账号团队草稿编辑");
        expect(html).not.toContain("不应优先的本地规则");
        expect(html).not.toContain("管理员服务端访问码");
        fixture.online = false;
        fixture.sync = {};
    });
    it("waits for browser storage before exposing editing", () => {
        fixture.state = { hydrated: false, policyPacks: [], catalogStatus: { phase: "idle" }, loadServerCatalog: vi.fn() };
        const html = renderToStaticMarkup(
            <MemoryRouter>
                <CategoryConfigPanel />
            </MemoryRouter>,
        );
        expect(html).toContain("正在读取本地规则");
        expect(html).not.toContain("编辑本地副本</span>");
    });
});
