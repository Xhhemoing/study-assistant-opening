import type { HelpExposureKind } from "@aistudy/contracts";

export type TutorHelpMode = "hint" | "explain" | string;

export type ClassifyTutorHelpKindInput = {
  mode: TutorHelpMode;
  attemptId?: string | null;
  problemId?: string | null;
  intent?: "instruction" | "item_help" | "solution";
};

/**
 * Map tutor delivery to ExposureKind (Plan open Q5 defaults).
 * explain ∧ ¬problem → instruction; hint → hint; solution intent → solution.
 */
export function classifyTutorHelpKind(input: ClassifyTutorHelpKindInput): HelpExposureKind {
  if (input.intent === "solution") return "solution";
  if (input.intent === "instruction") return "instruction";
  if (input.intent === "item_help") return "hint";
  if (input.mode === "hint") return "hint";
  if (input.mode === "explain" && !input.problemId) return "instruction";
  if (input.mode === "explain") return "hint";
  return "instruction";
}

/** Legacy / missing kind reads as hint — never as independent credit. */
export function readHelpExposureKind(
  kind: HelpExposureKind | string | null | undefined,
): HelpExposureKind {
  if (kind === "instruction" || kind === "hint" || kind === "solution") return kind;
  return "hint";
}

type KindedExposure = { kind?: HelpExposureKind | string | null };

/** Instruction delivery must not elevate item assistance / independent credit. */
export function exposuresAffectingItemAssistance<T extends KindedExposure>(
  exposures: ReadonlyArray<T>,
): T[] {
  return exposures.filter((exposure) => readHelpExposureKind(exposure.kind) !== "instruction");
}

export function exposureAffectsItemAssistance(exposure: KindedExposure): boolean {
  return readHelpExposureKind(exposure.kind) !== "instruction";
}

/**
 * PM unknown correctness ≡ wire `unverified` (no rename in M1).
 * Documentation / test alias only — does not change course clients.
 */
export function mapPmUnknownOutcome(): "unverified" {
  return "unverified";
}

export type IndependenceEvidence = {
  problemId?: string | null;
  deliveredItemHelp?: boolean;
  eligibilityIndependent?: "yes" | "no" | "unknown";
};

/** Refuse client "independent" claims when server facts do not support them. */
export function assertNoUnevidencedIndependence(
  claim: "independent" | string,
  evidence: IndependenceEvidence,
): void {
  if (claim !== "independent") return;
  if (!evidence.problemId) {
    throw new Error("independent claim requires a server problem id");
  }
  if (evidence.deliveredItemHelp) {
    throw new Error("independent claim erased by delivered item help");
  }
  if (evidence.eligibilityIndependent && evidence.eligibilityIndependent !== "yes") {
    throw new Error("independent claim requires eligibility independentAttempt=yes");
  }
}

export type ReadEvidence = {
  delivered?: boolean | null;
  kind?: HelpExposureKind | string | null;
};

/** Never claim the learner "read" material from undelivered / absent exposures. */
export function assertNoUnevidencedRead(
  claim: "read" | string,
  evidence: ReadEvidence,
): void {
  if (claim !== "read") return;
  if (evidence.delivered !== true) {
    throw new Error("read claim requires delivered=true exposure evidence");
  }
}

export type ActivityCompleteSideEffects = {
  skillEvidenceLink?: boolean;
  observationOutcomeRewrite?: boolean;
  summaryForceIndependent?: boolean;
};

/**
 * Completing a teaching activity is progress only — not mastery / SkillEvidence.
 */
export function assertActivityCompleteDoesNotUpgradeMastery(
  sideEffects: ActivityCompleteSideEffects,
): void {
  if (sideEffects.skillEvidenceLink) {
    throw new Error("activity complete must not link SkillEvidence");
  }
  if (sideEffects.observationOutcomeRewrite) {
    throw new Error("activity complete must not rewrite observation outcomes");
  }
  if (sideEffects.summaryForceIndependent) {
    throw new Error("activity complete must not force observed_independent");
  }
}
