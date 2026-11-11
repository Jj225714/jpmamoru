import { expect, it } from "vitest";
import { computeMediaSize, computeCustomImageSize, inferMediaRatio, parseAspectRatio, validateCustomImageRatio } from "./media-size";
it.each(["1.9:1", "2.5:1", "2:1", "3:1", "1:3"])("preserves %s and aligns pixels", (ratio) => {
    expect(inferMediaRatio(ratio)).toBe(ratio);
    for (const scale of ["1k", "2k", "4k"]) {
        const size = computeMediaSize(scale, ratio);
        expect(size).toBe(computeCustomImageSize(scale, ratio));
        const [w,h] = size.split("x").map(Number);
        expect(w % 16).toBe(0); expect(h % 16).toBe(0); expect(Math.max(w,h)).toBeLessThanOrEqual(3840);
        expect(w*h).toBeGreaterThanOrEqual(655360); expect(w*h).toBeLessThanOrEqual(8294400);
        const reopened = parseAspectRatio(inferMediaRatio(size))!;
        expect(reopened.width/reopened.height).toBeCloseTo(w/h, 8);
    }
});
it.each(["", "-1:1", "NaN:1", "0:1", "Infinity:1", "3.1:1", "1:3.1"])("rejects %s", (value) => expect(validateCustomImageRatio(value)).not.toBe(""));
it("switches presets/custom without an undefined size", () => {
    expect(computeMediaSize("1k", "1:1")).toBe("1024x1024");
    expect(computeMediaSize("auto", "1.9:1")).toBe("1.9:1");
    expect(inferMediaRatio(computeMediaSize("2k", "2.5:1"))).not.toBe("21:9");
});
