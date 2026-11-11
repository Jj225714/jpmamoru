export type ManagedSession = {
    authenticated: boolean;
    enabled: boolean;
    principal?: { id: string; name: string };
    models?: { name: string; capability: "image" | "text" }[];
    defaults?: { imageModel?: string; textModel?: string };
    quota?: { day: string; images: { used: number; limit: number }; text: { used: number; limit: number } };
};

export class ManagedModelSessionError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
        this.name = "ManagedModelSessionError";
    }
}

async function request(path: string, code?: string): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(`/api/managed/${path}`, {
            method: path === "session" ? "GET" : "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            ...(code !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) } : {}),
        });
    } catch {
        throw new ManagedModelSessionError(0, "无法连接授权服务，请检查网络后重试。");
    }
    if (!response.ok) {
        throw new ManagedModelSessionError(response.status, response.status === 401 ? "授权已失效或访问码无效，请重新输入访问码。" : response.status === 429 ? "今日额度已用完或请求过于频繁，请稍后重试或联系管理员。" : "授权服务暂时不可用，请稍后重试。");
    }
    return response;
}

async function readSession(response: Response): Promise<ManagedSession> {
    try {
        const data = await response.json();
        if (typeof data.authenticated !== "boolean" || data.enabled !== true) throw new Error();
        if (data.defaults && [data.defaults.imageModel, data.defaults.textModel].some((value) => value !== undefined && typeof value !== "string")) throw new Error();
        if (data.quota && [data.quota.images?.used, data.quota.images?.limit, data.quota.text?.used, data.quota.text?.limit].some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error();
        // Pick only the public wire fields; never retain arbitrary server fields.
        return {
            authenticated: data.authenticated,
            enabled: true,
            ...(data.principal ? { principal: { id: String(data.principal.id), name: String(data.principal.name) } } : {}),
            ...(Array.isArray(data.models)
                ? { models: data.models.filter((m: { capability: string }) => m.capability === "image" || m.capability === "text").map((m: { name: string; capability: "image" | "text" }) => ({ name: String(m.name), capability: m.capability })) }
                : {}),
            ...(data.defaults ? { defaults: { imageModel: data.defaults.imageModel, textModel: data.defaults.textModel } } : {}),
            ...(data.quota ? { quota: { day: String(data.quota.day), images: { used: Number(data.quota.images.used), limit: Number(data.quota.images.limit) }, text: { used: Number(data.quota.text.used), limit: Number(data.quota.text.limit) } } } : {}),
        };
    } catch {
        throw new ManagedModelSessionError(502, "授权服务返回异常，请重试。");
    }
}

export async function getManagedSession() {
    return readSession(await request("session"));
}
export async function loginManagedSession(code: string) {
    return readSession(await request("login", code));
}
export async function logoutManagedSession() {
    await request("logout");
}
