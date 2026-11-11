export function blendMaskedPixels(original: Uint8ClampedArray, generated: Uint8ClampedArray, mask: Uint8ClampedArray) {
    if (original.length !== generated.length || original.length !== mask.length || original.length % 4) throw new Error("蒙版尺寸不匹配");
    const output = new Uint8ClampedArray(original);
    for (let i = 0; i < output.length; i += 4) {
        const alpha = ((mask[i] / 255) * mask[i + 3]) / 255;
        for (let c = 0; c < 4; c++) output[i + c] = Math.round(original[i + c] * (1 - alpha) + generated[i + c] * alpha);
    }
    return output;
}
