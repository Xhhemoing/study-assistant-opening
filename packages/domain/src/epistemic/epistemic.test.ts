import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  createSkillBelief,
  effectiveRetrievability,
  retrievability,
  type SkillBeliefV1,
} from "./belief";
import {
  applyEvidenceChannel,
  deriveSessionScaffoldingAbility,
  prerequisiteInspectionWeights,
  propagateFireCredit,
} from "./fire-credit";
import {
  logSumExp,
  posteriorMisconceptionMass,
  updateBeliefWithEvidence,
  type SkillItemModel,
} from "./gauss-hermite";
import {
  calibrateItemRevision,
  type CalibrationAttempt,
} from "./calibration";
import {
  explorationWeight,
  mutualInformation,
  planFiniteHorizon,
} from "./bellman-scheduler";
import {
  evaluateShadowV2Holdout,
  type ShadowV2Input,
} from "./shadow-v2";

const baseBelief = (overrides: Partial<SkillBeliefV1> = {}): SkillBeliefV1 => createSkillBelief({
  workspaceId: "w",
  learnerId: "l",
  courseId: "c",
  confirmedSkillVersion: 1,
  lastDirectRecallAtMs: 0,
  ...overrides,
});

describe("hsrs-fire-dcm-v1 belief curve", () => {
  it("hits 0.9 at one stability interval and keeps implicit credit separate", () => {
    const belief = baseBelief({ logStability: Math.log(10), implicitLogCredit: Math.log(1.2) });
    expect(retrievability(belief, 10 * DAY_MS)).toBeCloseTo(0.9, 12);
    expect(effectiveRetrievability(belief, 10 * DAY_MS)).toBeGreaterThan(retrievability({ ...belief, implicitLogCredit: 0 }, 10 * DAY_MS));
  });

  it("uses the family prior before the first direct recall and normalizes sparse mass", () => {
    const belief = createSkillBelief({
      workspaceId: "w", learnerId: "l", courseId: "c", confirmedSkillVersion: "v1",
      lastDirectRecallAtMs: null, misconceptionMass: [["z", 0.1], ["a", 0.2]], otherMass: 0.8,
    });
    expect(retrievability(belief, Date.now())).toBeCloseTo(0.5, 12);
    expect(belief.misconceptionMass.map(([id]) => id)).toEqual(["a", "z"]);
    expect(belief.otherMass + belief.misconceptionMass.reduce((s, [, m]) => s + m, 0)).toBeCloseTo(1, 12);
  });
});

describe("HSRS-IRT-DCM evidence update", () => {
  const item: SkillItemModel = { itemId: "i", a: 1, b: 0, g: 0.2, l: 0.05, misconceptions: [{ id: "sign", delta: 1 }] };

  it("evaluates log-space likelihoods without underflow", () => {
    expect(logSumExp([-1000, -1001])).toBeCloseTo(-999.6867383124818, 10);
  });

  it("updates ability and misconception posterior with three-point quadrature", () => {
    const result = updateBeliefWithEvidence({
      belief: baseBelief({ misconceptionMass: [["sign", 0.05]], otherMass: 0.95 }),
      item,
      observation: { outcome: false, channel: "distractor", misconceptionId: "sign", powerWeight: 1 },
      atMs: DAY_MS,
    });
    expect(result.belief.misconceptionMass.find(([id]) => id === "sign")?.[1]).toBeGreaterThan(0.25);
    expect(result.belief.abilityVariance).toBeGreaterThanOrEqual(0.02);
  });

  it("matches the curated distractor 5% prior and likelihood-ratio-8 diagnostic", () => {
    expect(posteriorMisconceptionMass({ priorMass: 0.05, likelihoodRatio: 8 })).toBeCloseTo(0.296296, 5);
  });

  it("does not refresh direct recall for a non-fresh family or an unlocalized wrong answer", () => {
    const before = baseBelief({ lastDirectRecallAtMs: 0, logStability: Math.log(3) });
    const repeated = updateBeliefWithEvidence({ belief: before, item, observation: { outcome: true, channel: "unassisted", isFreshFamily: false }, atMs: DAY_MS });
    expect(repeated.belief.lastDirectRecallAtMs).toBe(before.lastDirectRecallAtMs);
    expect(prerequisiteInspectionWeights({ localizedFailures: [] })).toEqual([]);
  });

  it("gives channel two no persistent credit and caps session scaffolding across retries", () => {
    const before = baseBelief({ logStability: Math.log(3), implicitLogCredit: 0 });
    const after = applyEvidenceChannel({ belief: before, channel: "hinted", atMs: DAY_MS, item, outcome: true });
    expect(after.belief).toEqual(before);
    const first = deriveSessionScaffoldingAbility({ belief: before, item, atMs: DAY_MS, retryIndex: 0 });
    const third = deriveSessionScaffoldingAbility({ belief: before, item, atMs: DAY_MS, retryIndex: 2 });
    expect(third).toBeGreaterThanOrEqual(first);
    expect(third - before.abilityMean).toBeLessThanOrEqual(0.5);
  });
});

describe("FIRe implicit credit", () => {
  it("requires encompassing edge, coverage, passed step and direct-history gates", () => {
    const target = baseBelief({ lastDirectRecallAtMs: DAY_MS, logStability: Math.log(4) });
    const result = propagateFireCredit({
      sourceSkillId: "u", attemptId: "a", atMs: 2 * DAY_MS,
      source: baseBelief({ lastDirectRecallAtMs: 0 }), targets: {
        trig: { belief: target, edgeWeight: 0.8, covered: false, stepPassed: true },
        parts: { belief: target, edgeWeight: 0.8, covered: true, stepPassed: true },
      },
    });
    expect(result.targets.trig.belief.implicitLogCredit).toBe(0);
    expect(result.targets.parts.belief.implicitLogCredit).toBeGreaterThan(0);
    let capped = target;
    for (let i = 0; i < 100; i++) {
      capped = propagateFireCredit({
        sourceSkillId: "u", attemptId: `a-${i}`, atMs: 2 * DAY_MS,
        source: baseBelief({ lastDirectRecallAtMs: 0 }),
        targets: { parts: { belief: capped, edgeWeight: 1, covered: true, stepPassed: true } },
      }).targets.parts.belief;
    }
    expect(Math.exp(capped.implicitLogCredit)).toBeLessThanOrEqual(1.2 + 1e-12);
    const blocked = propagateFireCredit({
      sourceSkillId: "u", attemptId: "seen", atMs: 2 * DAY_MS, source: baseBelief({ lastDirectRecallAtMs: 0 }),
      seenAttemptIds: ["seen"], targets: { parts: { belief: target, edgeWeight: 1, covered: true, stepPassed: true } },
    });
    expect(blocked.propagatedSkillIds).toEqual([]);
  });
});

describe("three-tier empirical Bayes calibration", () => {
  const attempts: CalibrationAttempt[] = Array.from({ length: 10 }, (_, index) => ({
    learnerId: `l-${index}`, publisherItemRevisionId: "rev-1", outcome: index < 8 ? "correct" : "incorrect",
    independent: true, firstIndependentSubmission: true, abandoned: false, hinted: false, theta: 0,
  }));

  it("keeps tier zero human count at zero and widens uncertainty for blind-solve disagreement", () => {
    const result = calibrateItemRevision({ publisherItemRevisionId: "rev-0", difficultyTag: "hard", choiceCount: 4,
      attempts: [], blindSolveDisagreement: 3 });
    expect(result.tier).toBe(0);
    expect(result.humanCount).toBe(0);
    expect(result.needsHumanKeyReview).toBe(true);
    expect(result.priorStandardDeviation).toBeGreaterThan(1);
  });

  it("clips the tier one MAP serving difficulty to the author prior window", () => {
    const result = calibrateItemRevision({ publisherItemRevisionId: "rev-1", difficultyTag: "medium", choiceCount: 5, attempts });
    expect(result.tier).toBe(1);
    expect(result.servingDifficulty).toBeCloseTo(-0.6, 2);
    expect(result.unclippedDifficulty).toBeLessThan(-0.6);
  });

  it("deduplicates learners and preserves an immutable tier two snapshot", () => {
    const duplicate = { ...attempts[0]!, outcome: "incorrect" as const, attemptedAt: "2026-01-02T00:00:00Z" };
    const tierOne = calibrateItemRevision({ publisherItemRevisionId: "rev-1", difficultyTag: "medium", attempts: [...attempts, duplicate] });
    expect(tierOne.humanCount).toBe(10);
    const snapshot = { schemaVersion: 1 as const, parameterSnapshotVersion: "17", publisherItemRevisionId: "rev-2", discrimination: 1.2, difficulty: 0.3, guessing: 0.25, lapse: 0.05, misconceptionDeltas: [] as ReadonlyArray<readonly [string, number]> };
    const tierTwo = calibrateItemRevision({ publisherItemRevisionId: "rev-2", difficultyTag: "easy", attempts: Array.from({ length: 50 }, (_, index) => ({ ...attempts[index % attempts.length]!, learnerId: `unique-${index}`, publisherItemRevisionId: "rev-2" })), previousParameterSnapshot: snapshot });
    expect(tierTwo.tier).toBe(2);
    expect(tierTwo.parameterSnapshot).toBe(snapshot);
    expect(tierTwo.servingDifficulty).toBe(0.3);
  });
});

describe("72 hour finite-horizon scheduler", () => {
  it("uses smooth cubic deadline exploration and a finite-horizon plan", () => {
    expect(explorationWeight(72, { min: 0.1, max: 0.9 })).toBeCloseTo(0.1, 12);
    expect(explorationWeight(120, { min: 0.1, max: 0.9 })).toBeCloseTo(0.5, 12);
    const plan = planFiniteHorizon({ horizonMinutes: 10, actions: [
      { id: "six", durationMinutes: 6, utility: 6 },
      { id: "five-a", durationMinutes: 5, utility: 5 },
      { id: "five-b", durationMinutes: 5, utility: 5 },
    ] });
    expect(plan.actionIds).toEqual(["five-a", "five-b"]);
    expect(plan.utility).toBe(10);
    expect(planFiniteHorizon({ horizonMinutes: 10, actions: [{ id: "blocked", durationMinutes: 1, utility: 100, available: false }] }).actionIds).toEqual([]);
  });

  it("computes mutual information in nats and returns zero for a non-teaching probe", () => {
    expect(mutualInformation([{ probability: 0.9, outcome: [0.9, 0.1] }, { probability: 0.1, outcome: [0.1, 0.9] }])).toBeCloseTo(0.368064207, 3);
    expect(mutualInformation([{ probability: 0.5, outcome: [0.5, 0.5] }, { probability: 0.5, outcome: [0.5, 0.5] }])).toBeCloseTo(0, 12);
  });
});

describe("paired shadow v2", () => {
  it("keeps strict pre-attempt cutoff and excludes target family plus propagated history", () => {
    const input: ShadowV2Input = {
      cutoff: "2026-01-02T00:00:00Z", targetFamilyKeys: ["heldout"], propagatedFamilyKeys: ["prereq"],
      rows: [
        { observationId: "before", familyKey: "other", attemptedAt: "2026-01-01T00:00:00Z", correct: true, predictions: { "classical-bkt": 0.5, pfa: 0.5, "smoothed-frequency": 0.5, "hsrs-fire-dcm-v1": 0.9 } },
        { observationId: "after", familyKey: "other", attemptedAt: "2026-01-03T00:00:00Z", correct: false, predictions: { "classical-bkt": 0.5, pfa: 0.5, "smoothed-frequency": 0.5, "hsrs-fire-dcm-v1": 0.9 } },
        { observationId: "target", familyKey: "heldout", attemptedAt: "2026-01-01T00:00:00Z", correct: false, predictions: { "classical-bkt": 0.5, pfa: 0.5, "smoothed-frequency": 0.5, "hsrs-fire-dcm-v1": 0.9 } },
        { observationId: "propagated", familyKey: "prereq", attemptedAt: "2026-01-01T00:00:00Z", correct: false, predictions: { "classical-bkt": 0.5, pfa: 0.5, "smoothed-frequency": 0.5, "hsrs-fire-dcm-v1": 0.9 } },
      ],
    };
    const receipt = evaluateShadowV2Holdout(input);
    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.count).toBe(1);
    expect(receipt.models.find(model => model.modelId === "hsrs-fire-dcm-v1")?.brierDelta).toBeLessThan(0);
    expect(receipt.ablation).toEqual(expect.arrayContaining(["no-fire", "no-dcm"]));
    expect(() => evaluateShadowV2Holdout({ ...input, rows: [{ ...input.rows[0]!, predictions: { ...input.rows[0]!.predictions, pfa: 2 } }] })).toThrow(/prediction/);
  });
});
