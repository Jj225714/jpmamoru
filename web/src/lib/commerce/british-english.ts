/** Reviewed spelling guidance, not blind replacement of brands or product identifiers. */
export const BRITISH_ENGLISH_TERMS = { color: "colour", colors: "colours", organize: "organise", organizing: "organising", organized: "organised", center: "centre", favorite: "favourite" } as const;
export const BRITISH_ENGLISH_GUIDANCE = "en-GB 使用英式英语：" + Object.entries(BRITISH_ENGLISH_TERMS).map(([us, gb]) => `${us} → ${gb}`).join("；")
    + "。en-US 保持美式英语。两种英语分别返回各自 locale 的内容，不合并键、不互相复制兜底。保留品牌名、SKU、已确认尺寸、数字和单位，不推测英国认证、币种或性能。品牌专用术语优先于通用拼写；最终文案需人工校对。";
