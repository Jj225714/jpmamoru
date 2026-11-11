type ReviewRequirement = {
    id: string;
    title: string;
    stage: string;
};

const encoded = (value: string) => encodeURIComponent(value);

export const reviewTargetIds = {
    reviewActions: "commerce-review-actions",
    currentImages: "commerce-current-images",
    requirements: "commerce-requirements",
    requirement: (requirementId: string) => "commerce-requirement-" + encoded(requirementId),
    fact: (fact: string) => "commerce-fact-" + encoded(fact),
    factsConfirmed: "commerce-facts-confirmed",
    marketing: "commerce-marketing",
    marketingCopy: (requirementId: string) => "commerce-marketing-copy-" + encoded(requirementId),
} as const;

export function resolveReviewErrorTarget(message: string, requirements: readonly ReviewRequirement[]): string {
    if (/批准白底/.test(message)) return reviewTargetIds.reviewActions;

    const fact = message.match(/缺少已确认参数“([^”]+)”/)?.[1];
    if (fact) return reviewTargetIds.fact(fact);
    if (/确认产品事实/.test(message)) return reviewTargetIds.factsConfirmed;

    const requirement = requirements.find((item) => message.startsWith(item.title + "："));
    if (requirement) {
        if (/缺少对应场景画面|前后画面必须使用不同素材|成图没有绑定正确的需求画面/.test(message)) return reviewTargetIds.currentImages;
        if (requirement.stage === "marketing" && /文案|中文预览|营销成图|重新渲染/.test(message)) return reviewTargetIds.marketingCopy(requirement.id);
        return reviewTargetIds.requirement(requirement.id);
    }

    if (/营销成图|中文预览|需求矩阵|营销方案/.test(message)) return reviewTargetIds.marketing;
    if (/场景画面|当前版本图片/.test(message)) return reviewTargetIds.currentImages;
    return reviewTargetIds.requirements;
}
