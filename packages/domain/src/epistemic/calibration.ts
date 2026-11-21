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
const MAP_SEARCH_RADIUS = 10;
const MAP_GRID_STEP = 0.25;
const MAP_TIE_TOLERANCE = 1e-12;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

type MapInput = {
  priorDifficulty: number;
  priorStandardDeviation: number;
  attempts: readonly CalibrationAttempt[];
  guessing: number;
  lapse: number;
};

function posteriorObjective(difficulty: number, input: MapInput): number {
  const prior = -0.5 * ((difficulty - input.priorDifficulty) / input.priorStandardDeviation) ** 2;
  const item: SkillItemModel = { itemId: "calibration", a: 1, b: difficulty, g: input.guessing, l: input.lapse };
  const likelihood = input.attempts.reduce((sum, attempt) => {
    const theta = attempt.theta ?? 0;
    const probability = conditionalSuccessProbability(item, Number.isFinite(theta) ? theta : 0);
    return sum + (attempt.outcome === "correct" ? Math.log(probability) : Math.log1p(-probability));
  }, 0);
  return prior + likelihood;
}

function refineMapCandidate(
  start: number,
  startObjective: number,
  minimum: number,
  maximum: number,
  input: MapInput,
): { mode: number; objective: number } {
  let mode = start;
  let objective = startObjective;

  for (let iteration = 0; iteration < 64; iteration++) {
    const h = 1e-4;
    const fp = posteriorObjective(mode + h, input);
    const fm = posteriorObjective(mode - h, input);
    const gradient = (fp - fm) / (2 * h);
    const hessian = (fp - 2 * objective + fm) / (h * h);
    if (!Number.isFinite(gradient) || Math.abs(gradient) < 1e-10) break;

    let step = clamp(Number.isFinite(hessian) && hessian < -1e-10 ? -gradient / hessian : gradient, -2, 2);
    let improved = false;
    while (Math.abs(step) >= 1e-10) {
      const candidate = clamp(mode + step, minimum, maximum);
      if (candidate === mode) break;
      const value = posteriorObjective(candidate, input);
      if (value > objective) {
        mode = candidate;
        objective = value;
        improved = true;
        break;
      }
      step /= 2;
    }
    if (!improved) break;
  }

  return { mode, objective };
}

function estimateMap(input: MapInput): number {
  const minimum = input.priorDifficulty - MAP_SEARCH_RADIUS;
  const maximum = input.priorDifficulty + MAP_SEARCH_RADIUS;
  const steps = Math.round((maximum - minimum) / MAP_GRID_STEP);
  const grid = Array.from({ length: steps + 1 }, (_, index) => {
    const mode = index === steps ? maximum : minimum + index * MAP_GRID_STEP;
    return { mode, objective: posteriorObjective(mode, input) };
  });

  // Guessing and lapse asymptotes can make the posterior multimodal; refine
  // every grid local maximum plus endpoints and the prior mean.
  const seeds: Array<{ mode: number; objective: number }> = [];
  for (let index = 0; index < grid.length; index++) {
    const current = grid[index]!;
    const isEndpoint = index === 0 || index === grid.length - 1;
    const isPrior = current.mode === input.priorDifficulty;
    const isLocalMax = !isEndpoint
      && current.objective >= grid[index - 1]!.objective
      && current.objective >= grid[index + 1]!.objective;
    if (isEndpoint || isPrior || isLocalMax) {
      seeds.push(current);
    }
  }
  if (!seeds.some(seed => seed.mode === input.priorDifficulty)) {
    seeds.push({ mode: input.priorDifficulty, objective: posteriorObjective(input.priorDifficulty, input) });
  }

  const refined = seeds.map(seed => refineMapCandidate(seed.mode, seed.objective, minimum, maximum, input));
  const bestObjective = refined.reduce((max, candidate) => Math.max(max, candidate.objective), -Infinity);
  const tieTolerance = MAP_TIE_TOLERANCE * Math.max(1, Math.abs(bestObjective));

  let best: { mode: number; objective: number } | undefined;
  for (const candidate of refined) {
    if (candidate.objective < bestObjective - tieTolerance) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const candidateDistance = Math.abs(candidate.mode - input.priorDifficulty);
    const bestDistance = Math.abs(best.mode - input.priorDifficulty);
    if (
      candidateDistance < bestDistance - MAP_TIE_TOLERANCE
      || (Math.abs(candidateDistance - bestDistance) <= MAP_TIE_TOLERANCE
        && (candidate.objective > best.objective
          || (candidate.objective === best.objective && candidate.mode < best.mode)))
    ) {
      best = candidate;
    }
  }

  return best?.mode ?? input.priorDifficulty;
}

function firstIndependentAttempts(attempts: readonly CalibrationAttempt[], publisherItemRevisionId: string): CalibrationAttempt[] {
  const seen = new Set<string>();
  return attempts
    .filter(attempt => attempt.publisherItemRevisionId === publisherItemRevisionId && attempt.independent && attempt.firstIndependentSubmission && !attempt.abandoned && !attempt.hinted)
    .map(attempt => {
      const timestamp = Date.parse(attempt.attemptedAt ?? "");
      return { attempt, timestamp: Number.isFinite(timestamp) ? timestamp : -Infinity };
    })
    .sort((a, b) => a.timestamp - b.timestamp || a.attempt.learnerId.localeCompare(b.attempt.learnerId))
    .map(({ attempt }) => attempt)
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
  const snapshot: ParameterSnapshotV1 = previous?.publisherItemRevisionId === input.publisherItemRevisionId
    ? previous
    : {
      schemaVersion: 1,
      parameterSnapshotVersion: input.parameterSnapshotVersion ?? "1",
      publisherItemRevisionId: input.publisherItemRevisionId,
      discrimination: 1,
      difficulty: estimateMap({ priorDifficulty, priorStandardDeviation, attempts, guessing, lapse }),
      guessing,
      lapse,
      misconceptionDeltas: [],
    };
  return { publisherItemRevisionId: input.publisherItemRevisionId, tier: 2, humanCount, priorDifficulty, priorStandardDeviation,
    unclippedDifficulty: snapshot.difficulty, servingDifficulty: snapshot.difficulty, discrimination: snapshot.discrimination, guessing: snapshot.guessing, lapse: snapshot.lapse,
    needsHumanKeyReview: false, parameterSnapshot: snapshot };
}

export const calibratePublisherItemRevision = calibrateItemRevision;
