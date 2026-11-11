export type Point = { x: number; y: number };
export type Quad = { topLeft: Point; topRight: Point; bottomRight: Point; bottomLeft: Point };
export const QUAD_KEYS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
export type Matrix = [number, number, number, number, number, number, number, number, number];

/** Unit square to a convex, ordered quadrilateral. All four corners participate. */
export function quadMatrix(quad: Quad): Matrix {
    const p = QUAD_KEYS.map((key) => quad[key]);
    let sign = 0;
    for (let i = 0; i < 4; i++) {
        const a = p[i],
            b = p[(i + 1) % 4],
            c = p[(i + 2) % 4];
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (!Number.isFinite(cross) || Math.abs(cross) < 1e-7 || (sign && Math.sign(cross) !== sign)) throw new Error("四角不能交叉或重合，请保持凸四边形");
        sign = Math.sign(cross);
    }
    const [a, b, c, d] = p;
    const dx1 = b.x - c.x,
        dx2 = d.x - c.x,
        dx3 = a.x - b.x + c.x - d.x;
    const dy1 = b.y - c.y,
        dy2 = d.y - c.y,
        dy3 = a.y - b.y + c.y - d.y;
    const det = dx1 * dy2 - dx2 * dy1;
    const g = (dx3 * dy2 - dx2 * dy3) / det,
        h = (dx1 * dy3 - dx3 * dy1) / det;
    const m: Matrix = [b.x - a.x + g * b.x, d.x - a.x + h * d.x, a.x, b.y - a.y + g * b.y, d.y - a.y + h * d.y, a.y, g, h, 1];
    if (!m.every(Number.isFinite) || Math.min(1, g + 1, h + 1, g + h + 1) < 1e-7) throw new Error("透视过于极端，请拉开四角");
    return m;
}
export function mapPoint(m: Matrix, x: number, y: number): Point {
    const w = m[6] * x + m[7] * y + m[8];
    return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}
export function inverseMatrix(m: Matrix): Matrix {
    const [a, b, c, d, e, f, g, h, i] = m;
    const adj: Matrix = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
    const det = a * adj[0] + b * adj[3] + c * adj[6];
    if (Math.abs(det) < 1e-12) throw new Error("透视范围太小，请拉开四角");
    return adj.map((v) => v / det) as Matrix;
}
export function snapWhitePoint(point: Point, step: number, tolerance: number, guides: Point): Point {
    const snap = (value: number, guide: number) => {
        const candidates = [0, 1, guide, ...(step > 0 ? [Math.round(value / step) * step] : [])];
        const closest = candidates.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a));
        return Math.abs(closest - value) <= tolerance ? closest : value;
    };
    return { x: snap(point.x, guides.x), y: snap(point.y, guides.y) };
}
/** Inverse mapping and premultiplied-alpha bilinear filtering avoid mesh seams and white halos. */
export function projectWhitePixels(source: { data: Uint8ClampedArray; width: number; height: number }, quad: Quad, size: number) {
    const inverse = inverseMatrix(quadMatrix(quad));
    const data = new Uint8ClampedArray(size * size * 4),
        points = Object.values(quad);
    const left = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) * size));
    const right = Math.min(size, Math.ceil(Math.max(...points.map((p) => p.x)) * size));
    const top = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) * size));
    const bottom = Math.min(size, Math.ceil(Math.max(...points.map((p) => p.y)) * size));
    for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) {
            const uv = mapPoint(inverse, (x + 0.5) / size, (y + 0.5) / size);
            if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) continue;
            const sx = Math.max(0, Math.min(source.width - 1, uv.x * source.width - 0.5));
            const sy = Math.max(0, Math.min(source.height - 1, uv.y * source.height - 0.5));
            const ix = Math.floor(sx),
                iy = Math.floor(sy),
                fx = sx - ix,
                fy = sy - iy;
            let alpha = 0,
                red = 0,
                green = 0,
                blue = 0;
            for (let j = 0; j < 2; j++)
                for (let k = 0; k < 2; k++) {
                    const offset = (Math.min(source.height - 1, iy + j) * source.width + Math.min(source.width - 1, ix + k)) * 4;
                    const weight = (k ? fx : 1 - fx) * (j ? fy : 1 - fy) * source.data[offset + 3];
                    alpha += weight;
                    red += source.data[offset] * weight;
                    green += source.data[offset + 1] * weight;
                    blue += source.data[offset + 2] * weight;
                }
            const offset = (y * size + x) * 4;
            if (alpha > 0) {
                data[offset] = red / alpha;
                data[offset + 1] = green / alpha;
                data[offset + 2] = blue / alpha;
                data[offset + 3] = alpha;
            }
        }
    return data;
}
