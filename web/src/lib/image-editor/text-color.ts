/** Estimate lettering color against the dominant surface color; user can override. */
export function estimateTextColor(pixels: Uint8ClampedArray): string {
    const colors = new Map<number, { count: number; r: number; g: number; b: number }>();
    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 128) continue;
        const r = pixels[i],
            g = pixels[i + 1],
            b = pixels[i + 2];
        const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
        const current = colors.get(key) || { count: 0, r: 0, g: 0, b: 0 };
        current.count++;
        current.r += r;
        current.g += g;
        current.b += b;
        colors.set(key, current);
    }
    const groups = [...colors.values()].sort((a, b) => b.count - a.count).map((v) => ({ ...v, r: v.r / v.count, g: v.g / v.count, b: v.b / v.count }));
    if (!groups.length) return "#222222";
    const background = groups[0];
    const foreground = groups
        .slice(1)
        .filter((v) => v.count >= Math.max(2, (pixels.length / 4) * 0.005))
        .sort((a, b) => {
            const score = (v: typeof a) => Math.hypot(v.r - background.r, v.g - background.g, v.b - background.b) * Math.sqrt(v.count);
            return score(b) - score(a);
        })[0];
    return foreground ? "#" + [foreground.r, foreground.g, foreground.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "#222222";
}
