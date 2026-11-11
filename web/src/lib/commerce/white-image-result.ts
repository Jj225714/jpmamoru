import { nanoid } from "nanoid";
import type { WhiteResult } from "@/stores/use-product-white-store";
import { DEFAULT_WHITE_ADJUSTMENTS, normalizeWhiteAdjustments, whiteEditSignature, whiteOutputForImage, type WhiteDraft } from "./white-image-edit";
import { normalizeWhiteImage, renderWhiteImage } from "./white-image-renderer";

export function whiteDraftForResult(record: WhiteResult): WhiteDraft {
    return {
        adjustments: normalizeWhiteAdjustments(record.draft?.adjustments || record.editor?.applied || DEFAULT_WHITE_ADJUSTMENTS),
        output: { ...(record.draft?.output || record.output || whiteOutputForImage(record.image)) },
    };
}

// No store mutations until rendering succeeds and the caller verifies its selection token.
export async function materializeWhiteResult(record: WhiteResult, draft: WhiteDraft, records: WhiteResult[]): Promise<WhiteResult> {
    const adjustments = normalizeWhiteAdjustments(draft.adjustments);
    const output = { ...draft.output };
    const signature = whiteEditSignature(record.editor, adjustments, output);
    const rootId = record.rootId || record.id;
    const existing = records.find((item) => (item.rootId || item.id) === rootId && item.renderSignature === signature);
    if (existing) return existing;
    const oldOutput = record.output || whiteOutputForImage(record.image);
    if (!record.editor && oldOutput.size === output.size && oldOutput.format === output.format) return record;
    const image = record.editor ? await renderWhiteImage(record.editor, adjustments, output) : await normalizeWhiteImage(record.image, output);
    return {
        id: nanoid(),
        rootId,
        source: record.source,
        image,
        createdAt: new Date().toISOString(),
        output,
        ...(record.editor ? { editor: { ...record.editor, applied: adjustments } } : {}),
        renderSignature: signature,
    };
}
