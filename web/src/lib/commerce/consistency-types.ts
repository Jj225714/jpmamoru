export type ConsistencyPoint = { x: number; y: number };
export type ConsistencyUnit = "mm" | "cm" | "in";
export type ConsistencyStatus = "pass" | "deviation" | "not-measurable" | "needs-review";
export type ConsistencyConstraint = {
    version: 1; revision: number; sourceImageId: string; sourceContentHash: string; sourceWidth: number; sourceHeight: number;
    scope: "pattern" | "dimension-pattern"; provenance: "manual" | "synthetic";
    /** Registration surface, potentially the whole frame; subject bounds belong in regions. */
    plane: { id: string; x: number; y: number; width: number; height: number; frontViewConfirmed: boolean };
    points: Array<{ id: string; name: string; sourcePx: ConsistencyPoint; role: "validation" | "measurement" }>;
    dimensions: Array<{ id: string; label: string; endpoints: [string,string]; value: number; unit: ConsistencyUnit; evidence: string }>;
    ruler?: { endpoints: [string,string]; value: number; unit: ConsistencyUnit; evidence: string; independentConfirmed: boolean };
    regions: Array<{ id: string; name: string; x: number; y: number; width: number; height: number; anchorIds: string[] }>;
    thresholds: { maxPx: number; rmsePx: number; relative: number };
    confirmedBy?: string; confirmedAt?: string;
};
export type ConsistencyRequestSnapshot = { version: 1; hash: string; capturedAt: string; constraints: ConsistencyConstraint; sourceContentHash: string; sourceImageId: string };
export type ConsistencyObservations = {
    id: string; savedAt: string; assetId: string; resultContentHash: string; width: number; height: number;
    corners: [ConsistencyPoint,ConsistencyPoint,ConsistencyPoint,ConsistencyPoint];
    points: Array<{ id: string; outputPx?: ConsistencyPoint; state: "visible" | "missing" | "occluded" }>;
    planeConfirmed: boolean; independentConfirmed: boolean; mirrored: boolean; observer: string;
};
export type ConsistencyMetric = { id: string; label: string; status: "pass" | "deviation" | "not-measurable"; actual: number | null; expected?: number; threshold: number | null; unit: string; reason?: string };
export type ConsistencyReport = {
    id: string; createdAt: string; assetId: string; constraintRevision: number; constraintHash: string; sourceContentHash: string; resultContentHash: string; layoutHash: string; stateSignature: string; requestHash?: string; snapshotHash?: string;
    status: ConsistencyStatus; numericStatus: "pass" | "deviation" | "not-measurable"; metrics: ConsistencyMetric[]; reasons: string[];
    observations: ConsistencyObservations; decision?: { action: "accept" | "reject"; reviewer: string; at: string; reason: string };
    boundary: string;
};
export type SkuConsistencyState = { constraints: ConsistencyConstraint; reports: ConsistencyReport[] };
