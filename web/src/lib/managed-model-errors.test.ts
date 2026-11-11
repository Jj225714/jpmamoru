import { expect, it } from "vitest";
import { managedModelErrorMessage } from "./managed-model-errors";

it("explains quota limits without echoing provider details", () => {
    expect(managedModelErrorMessage({ error: { code: "quota_exceeded", message: "secret" } })).toContain("今日模型请求额度");
    expect(managedModelErrorMessage({ error: { code: "server_configuration", message: "secret" } })).not.toContain("secret");
});
it("distinguishes changed authorization and ambiguous upstream timeouts", () => {
    expect(managedModelErrorMessage({ code: "principal_changed" })).toContain("未扣额度");
    expect(managedModelErrorMessage({ code: "upstream_timeout" })).toContain("可能已计入额度");
});
it("does not interpret unknown payloads", () => {
    expect(managedModelErrorMessage(null)).toBeUndefined();
    expect(managedModelErrorMessage({ error: { code: "unrecognized", message: "secret" } })).toBeUndefined();
});
