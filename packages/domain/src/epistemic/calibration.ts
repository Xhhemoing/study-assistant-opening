import { conditionalSuccessProbability, type SkillItemModel } from "./gauss-hermite";

export type CalibrationAttempt = {
  learnerId: string;
  publisherItemRevisionId: string;
  outcome: "correct" | "incorrect";
  independent: boolean;
  firstIndependentSubmission: boolean;
  abandoned: boolean;
  hinted: boolean;
  theta?: number;
  attemptedAt?: string;
};

export type ParameterSnapshotV1 = {
  schemaVersion: 1;
  parameterSnapshotVersion: string;
  publisherItemRevisionId: string;
  discrimination: number;
  difficulty: number;
  guessing: number;
  lapse: number;
  misconceptionDeltas: ReadonlyArray<readonly [string, number]>;
};

export type ItemCalibrationResult = {
  publisherItemRevisionId: string;
  tier: 0 | 1 | 2;
  humanCount: number;
  priorDifficulty: number;
  priorStandardDeviation: number;
  unclippedDifficulty: number;
  servingDifficulty: number;
  discrimination: number;
  guessing: number;
  lapse: number;
  needsHumanKeyReview: boolean;
  parameterSnapshot: ParameterSnapshotV1 | null;
};

const TAG_DIFFICULTY = { easy: -1, medium: 0, hard: 1 } as const;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function posteriorObjective(difficulty: number, input: {
  priorDifficulty: number;
  priorStandardDeviation: number;
  attempts: readonly CalibrationAttempt[];
  guessing: number;
  lapse: number;
}): number {
  const prior = -0.5 * ((difficulty - input.priorDifficulty) / input.priorStandardDeviation) ** 2;
  const likelihood = input.attempts.reduce((sum, attempt) => {
    const item: SkillItemModel = { itemId: "calibration", a: 1, b: difficulty, g: input.guessing, l: input.lapse };
    const probability = conditionalSuccessProbability(item, attempt.theta ?? 0);
    return sum + (attempt.outcome === "correct" ? Math.log(probability) : Math.log1p(-probability));
  }, 0);
  return prior + likelihood;
}

function estimateMap(input: {
  priorDifficulty: number;
  priorStandardDeviation: number;
  attempts: readonly CalibrationAttempt[];
  guessing: number;
  lapse: number;
}): number {
  let mode = input.priorDifficulty;
  for (let iteration = 0; iteration < 32; iteration++) {
    const h = 1e-4;
    const f0 = posteriorObjective(mode, input);
    const fp = posteriorObjective(mode + h, input);
    const fm = posteriorObjective(mode - h, input);
    const gradient = (fp - fm) / (2 * h);
    const hessian = (fp - 2 * f0 + fm) / (h * h);
    if (!Number.isFinite(gradient) || !Number.isFinite(hessian) || hessian >= -1e-10) break;
    const next = clamp(mode - gradient / hessian, input.priorDifficulty - 10, input.priorDifficulty + 10);
    if (Math.abs(next - mode) < 1e-8) { mode = next; break; }
    mode = next;
  }
  return mode;
}

function firstIndependentAttempts(attempts: readonly CalibrationAttempt[], publisherItemRevisionId: string): CalibrationAttempt[] {
  const seen = new Set<string>();
  return [...attempts]
    .filter(attempt => attempt.publisherItemRevisionId === publisherItemRevisionId && attempt.independent && attempt.firstIndependentSubmission && !attempt.abandoned && !attempt.hinted)
    .sort((a, b) => (a.attemptedAt ?? "").localeCompare(b.attemptedAt ?? "") || a.learnerId.localeCompare(b.learnerId))
    .filter(attempt => {
      if (seen.has(attempt.learnerId)) return false;
      seen.add(attempt.learnerId);
      return true;
    });
}

export function calibrateItemRevision(input: {
  publisherItemRevisionId: string;
  difficultyTag: keyof typeof TAG_DIFFICULTY;
  choiceCount?: number;
  attempts: readonly CalibrationAttempt[];
  blindSolveDisagreement?: number;
  previousParameterSnapshot?: ParameterSnapshotV1 | null;
  parameterSnapshotVersion?: string;
}): ItemCalibrationResult {
  if (!input.publisherItemRevisionId) throw new RangeError("publisherItemRevisionId is required");
  const priorDifficulty = TAG_DIFFICULTY[input.difficultyTag];
  const disagreement = Math.max(0, input.blindSolveDisagreement ?? 0);
  const priorStandardDeviation = 1 + disagreement * 0.25;
  const attempts = firstIndependentAttempts(input.attempts, input.publisherItemRevisionId);
  const humanCount = attempts.length;
  const guessing = input.choiceCount && input.choiceCount > 1 ? 1 / input.choiceCount : 0;
  const lapse = 0.05;
  if (humanCount === 0) {
    return { publisherItemRevisionId: input.publisherItemRevisionId, tier: 0, humanCount, priorDifficulty, priorStandardDeviation,
      unclippedDifficulty: priorDifficulty, servingDifficulty: priorDifficulty, discrimination: 1, guessing, lapse,
      needsHumanKeyReview: disagreement > 0, parameterSnapshot: null };
  }
  if (humanCount < 50) {
    const unclippedDifficulty = estimateMap({ priorDifficulty, priorStandardDeviation, attempts, guessing, lapse });
    return { publisherItemRevisionId: input.publisherItemRevisionId, tier: 1, humanCount, priorDifficulty, priorStandardDeviation,
      unclippedDifficulty, servingDifficulty: clamp(unclippedDifficulty, priorDifficulty - 0.6, priorDifficulty + 0.6), discrimination: 1, guessing, lapse,
      needsHumanKeyReview: false, parameterSnapshot: null };
  }
  const previous = input.previousParameterSnapshot;
  const snapshot = previous ?? { schemaVersion: 1 as const, parameterSnapshotVersion: input.parameterSnapshotVersion ?? "1", publisherItemRevisionId: input.publisherItemRevisionId,
    discrimination: 1, difficulty: priorDifficulty, guessing, lapse, misconceptionDeltas: [] as ReadonlyArray<readonly [string, number]> };
  return { publisherItemRevisionId: input.publisherItemRevisionId, tier: 2, humanCount, priorDifficulty, priorStandardDeviation,
    unclippedDifficulty: snapshot.difficulty, servingDifficulty: snapshot.difficulty, discrimination: snapshot.discrimination, guessing: snapshot.guessing, lapse: snapshot.lapse,
    needsHumanKeyReview: false, parameterSnapshot: snapshot };
}

export const calibratePublisherItemRevision = calibrateItemRevision;
