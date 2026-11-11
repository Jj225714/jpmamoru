import { normalizeWhiteAdjustments, type WhiteAdjustments } from "./white-image-edit";

export type WhiteEditHistory = { past: WhiteAdjustments[]; future: WhiteAdjustments[] };
export function rememberWhiteEdit(history: WhiteEditHistory, value: WhiteAdjustments): WhiteEditHistory {
    return { past: [...history.past.slice(-99), normalizeWhiteAdjustments(value)], future: [] };
}
export function travelWhiteEdit(history: WhiteEditHistory, value: WhiteAdjustments, direction: "undo" | "redo") {
    const source = direction === "undo" ? history.past : history.future;
    if (!source.length) return undefined;
    const snapshot = normalizeWhiteAdjustments(value);
    return {
        value: normalizeWhiteAdjustments(source[source.length - 1]),
        history: direction === "undo"
            ? { past: source.slice(0, -1), future: [...history.future, snapshot] }
            : { past: [...history.past, snapshot], future: source.slice(0, -1) },
    };
}
