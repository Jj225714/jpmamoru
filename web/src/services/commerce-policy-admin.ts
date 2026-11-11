import type { PolicyPack, TemplateReference } from "@/types/commerce";
import { getManagedSession } from "./managed-model-session";

export type PolicyAdminState = { canManage: boolean; revision: number; draft: PolicyPack | null; activeVersion?: number; history: { version: number; publishedAt?: string; name?: string }[] };
export type PolicyAdminResponse = PolicyAdminState & { reference?: TemplateReference; asset?: { id: string; url: string; sha256: string; mimeType: string }; errors?: string[]; valid?: boolean };
export async function commercePolicyAdmin(action?: string, payload: Record<string, unknown> = {}): Promise<PolicyAdminResponse> {
    const principal = action ? (await getManagedSession()).principal?.id : undefined;
    const response = await fetch("/api/managed/commerce-policies", {
        method: action ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        ...(action ? { headers: { "Content-Type": "application/json", "X-Managed-Principal": principal || "" }, body: JSON.stringify({ action, ...payload }) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(
            response.status === 403
                ? "当前服务端账号没有类目管理权限，请联系平台管理员。浏览器 PIN 不授予此权限。"
                : response.status === 401
                  ? "请先登录服务端授权会话。"
                  : response.status === 409
                    ? "草稿已被其他管理员更新，请刷新后重新编辑。"
                    : (typeof data.error === "string" ? data.error : data.error?.message) || data.message || "类目服务暂时不可用",
        );
    return data;
}
export function imageDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(blob);
    });
}
