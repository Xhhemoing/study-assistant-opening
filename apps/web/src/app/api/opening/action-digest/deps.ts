import type {
  ActionCandidateStore,
  ExtractedActionCandidateSource,
} from "../../../../features/opening/planning/action-service";

let decisionStoreOverride: ActionCandidateStore | null = null;
let extractedOverride: ExtractedActionCandidateSource | null = null;

/** Test seam — swap decision overlay / extract source without a live DB. */
export function setActionDigestDepsForTests(deps: {
  store?: ActionCandidateStore | null;
  extracted?: ExtractedActionCandidateSource | null;
} | null): void {
  decisionStoreOverride = deps?.store ?? null;
  extractedOverride = deps?.extracted ?? null;
}

export function getActionDigestOverrides(): {
  store: ActionCandidateStore | null;
  extracted: ExtractedActionCandidateSource | null;
} {
  return { store: decisionStoreOverride, extracted: extractedOverride };
}
