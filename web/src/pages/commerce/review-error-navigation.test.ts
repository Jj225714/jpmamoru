import { describe, expect, it } from "vitest";

import { reviewTargetIds, resolveReviewErrorTarget } from "./review-error-navigation";

const requirements = [
    { id: "scene-1", title: "客厅场景", stage: "scene" },
    { id: "marketing-1", title: "尺寸卖点", stage: "marketing" },
] as const;

describe("resolveReviewErrorTarget", () => {
    it("routes missing facts to the exact product fact input", () => {
        expect(resolveReviewErrorTarget("尺寸卖点：缺少已确认参数“产品厚度”", requirements)).toBe(reviewTargetIds.fact("产品厚度"));
    });

    it("routes product confirmation errors to the confirmation checkbox", () => {
        expect(resolveReviewErrorTarget("尺寸卖点：请先确认产品事实", requirements)).toBe(reviewTargetIds.factsConfirmed);
    });

    it("routes copy and preview errors to the matching marketing copy", () => {
        expect(resolveReviewErrorTarget("尺寸卖点：文案已变更，需要重新渲染", requirements)).toBe(reviewTargetIds.marketingCopy("marketing-1"));
        expect(resolveReviewErrorTarget("尺寸卖点：缺少或重复的中文预览", requirements)).toBe(reviewTargetIds.marketingCopy("marketing-1"));
    });

    it("routes requirement validation errors to the matching recipe", () => {
        expect(resolveReviewErrorTarget("客厅场景：请补充明确的画面要求", requirements)).toBe(reviewTargetIds.requirement("scene-1"));
    });

    it("routes missing generated scenes to current images", () => {
        expect(resolveReviewErrorTarget("客厅场景：缺少对应场景画面", requirements)).toBe(reviewTargetIds.currentImages);
        expect(resolveReviewErrorTarget("请先批准白底主图", requirements)).toBe(reviewTargetIds.reviewActions);
    });

    it("uses useful section fallbacks for generic errors", () => {
        expect(resolveReviewErrorTarget("找不到所选需求方案：old-id", requirements)).toBe(reviewTargetIds.requirements);
        expect(resolveReviewErrorTarget("营销成图/预览数量与需求矩阵不一致", requirements)).toBe(reviewTargetIds.marketing);
        expect(resolveReviewErrorTarget("未知审核错误", requirements)).toBe(reviewTargetIds.requirements);
    });
});
