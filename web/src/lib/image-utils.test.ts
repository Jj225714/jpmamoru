import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import { dataUrlToFile, detectRasterMimeType, detectRasterMimeTypeFromBase64 } from "./image-utils";

const bytes = (...values: number[]) => new Uint8Array(values);
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));

describe("raster MIME detection", () => {
    it.each([
        [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/png"],
        [bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg"],
        [bytes(...Array.from("RIFF0000WEBP", (value) => value.charCodeAt(0))), "image/webp"],
        [bytes(...Array.from("GIF89a", (value) => value.charCodeAt(0))), "image/gif"],
    ] as const)("recognizes image signature %#", (input, expected) => {
        expect(detectRasterMimeType(input)).toBe(expected);
        expect(detectRasterMimeTypeFromBase64(base64(input))).toBe(expected);
    });

    it("repairs a JPEG that was historically declared as PNG", () => {
        const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
        const file = dataUrlToFile({ id: "legacy", name: "legacy.png", type: "image/png", dataUrl: `data:image/png;base64,${base64(jpeg)}` });
        expect(file.type).toBe("image/jpeg");
        expect(file.size).toBe(jpeg.length);
    });

    it("normalizes the image/jpg alias when bytes are unavailable", () => {
        const file = dataUrlToFile({ id: "alias", name: "alias.jpg", type: "image/jpg", dataUrl: "data:image/jpg;base64,AQ==" });
        expect(file.type).toBe("image/jpeg");
    });
});
