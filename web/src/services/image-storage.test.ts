import { beforeAll, describe, expect, it, vi } from "vitest";

let selectImageReadUrl: typeof import("@/services/image-storage")["selectImageReadUrl"];

beforeAll(async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    ({ selectImageReadUrl } = await import("@/services/image-storage"));
});

describe("image storage source selection", () => {
    it("prefers the current persisted object URL over a stale blob URL", () => {
        expect(selectImageReadUrl({ dataUrl: "blob:http://localhost/old" }, "blob:http://localhost/current")).toBe("blob:http://localhost/current");
    });

    it("keeps an inline data URL without consulting persisted storage", () => {
        expect(selectImageReadUrl({ dataUrl: "data:image/png;base64,abc" }, "blob:http://localhost/current")).toBe("data:image/png;base64,abc");
    });

    it("falls back to the supplied URL when no stored image is available", () => {
        expect(selectImageReadUrl({ url: "https://example.com/reference.png" })).toBe("https://example.com/reference.png");
    });
});
