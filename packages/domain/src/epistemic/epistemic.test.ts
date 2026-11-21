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
  conditionalSuccessProbability,
  logSumExp,
  posteriorMisconceptionMass,
  updateBeliefWithEvidence,
  type EvidenceObservation,
  type SkillItemModel,
} from "./gauss-hermite";
import {
  calibrateItemRevision,
  type CalibrationAttempt,
  type ParameterSnapshotV1,
} from "./calibration";
import {
  explorationWeight,
  mutualInformation,
  planFiniteHorizon,
} from "./bellman-scheduler";
import {
  evaluateShadowV2Holdout,
  type ShadowV2Input,
  type ShadowV2Row,
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

describe("bounded belief inputs", () => {
  it("keeps retrievability finite at extreme stability and invalid times", () => {
    const belief = { ...baseBelief(), logStability: -1000, implicitLogCredit: Infinity };
    expect(retrievability(belief, 0)).toBe(1);
    expect(retrievability(belief, DAY_MS)).toBe(retrievability({ ...belief, logStability: -6 }, DAY_MS));
    expect(effectiveRetrievability(belief, DAY_MS)).toBe(retrievability(belief, DAY_MS));
    expect(effectiveRetrievability({ ...belief, implicitLogCredit: 1000 }, DAY_MS))
      .toBe(effectiveRetrievability({ ...belief, implicitLogCredit: Math.log(1.2) }, DAY_MS));
    expect(retrievability({ ...belief, logStability: 1000 }, DAY_MS))
      .toBe(retrievability({ ...belief, logStability: 8 }, DAY_MS));
    expect(retrievability({ ...belief, logStability: NaN }, NaN)).toBe(0.5);
    expect(retrievability({ ...belief, logStability: NaN }, DAY_MS))
      .toBe(retrievability({ ...belief, logStability: Math.log(10) }, DAY_MS));
    expect(retrievability({ ...belief, lastDirectRecallAtMs: NaN }, DAY_MS, { familyPrior: NaN })).toBe(0.5);
    expect(retrievability({ ...belief, lastDirectRecallAtMs: null }, DAY_MS, { familyPrior: 0 })).toBe(1e-6);
    expect(retrievability({ ...belief, lastDirectRecallAtMs: null }, DAY_MS, { familyPrior: 1 })).toBe(1 - 1e-6);
  });

  it("preserves zero other mass when misconception mass is positive", () => {
    const misconceptionMass = [["a", 2], ["b", 3]] as const;
    for (const otherMass of [0, undefined]) {
      const belief = baseBelief({ misconceptionMass, otherMass });
      expect(belief.otherMass).toBe(0);
      expect(belief.misconceptionMass).toEqual([["a", 0.4], ["b", 0.6]]);
    }
    expect(baseBelief({ otherMass: 0 }).otherMass).toBe(1);
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

describe("power-weighted evidence", () => {
  const item: SkillItemModel = { itemId: "joint", a: 1, b: 0, g: 0, l: 0, misconceptions: [{ id: "target", delta: 1 }] };
  const belief = baseBelief({ lastDirectRecallAtMs: null, implicitLogCredit: 0.1, misconceptionMass: [["target", 0.2]], otherMass: 0.8 });

  it.each([
    { outcome: false, channel: "hinted", misconceptionId: "target" },
    { outcome: false, channel: "assisted" },
    { outcome: true, channel: "multi-draft", isFreshFamily: true },
    { outcome: false, channel: "distractor", misconceptionId: "target", hintsOrExposures: true },
    { outcome: false, channel: "step-failure", misconceptionId: "target", powerWeight: 0 },
    { outcome: true, channel: "unassisted", isFreshFamily: true, powerWeight: -1 },
  ] satisfies Array<EvidenceObservation & { channel: NonNullable<EvidenceObservation["channel"]> }>)(
    "preserves the complete prior for $channel at zero evidence weight",
    observation => {
      const result = updateBeliefWithEvidence({ belief, item, observation, atMs: DAY_MS });
      expect(result.belief).toBe(belief);
      expect(result.posteriorMass).toEqual([["__none__", 0.8], ["target", 0.2]]);
      expect(result.retrievedProbability).toBe(0.5);
      const applied = applyEvidenceChannel({ belief, item, atMs: DAY_MS, ...observation });
      expect(applied.belief).toBe(belief);
      expect(applied.posteriorMass).toEqual(result.posteriorMass);
    },
  );

  it.each([
    { channel: "distractor", omega: 1, mass: 0.6985014502836692, mean: -0.134218107125985, variance: 0.9500699570808507, rho: 0.4573026105106047 },
    { channel: "distractor", omega: 0.5, mass: 0.4324436232953933, mean: -0.0737828788727207, variance: 0.9790183418025802, rho: 0.428738156825037 },
    { channel: "step-failure", omega: 1, mass: 0.6985014502836692, mean: -0.134218107125985, variance: 0.9500699570808507, rho: 0.4573026105106047 },
  ] as const)("marginalizes the joint $channel posterior at weight $omega", ({ channel, omega, mass, mean, variance, rho }) => {
    // Independently evaluated joint masses with prior retrieval 1/2, guess-failure 3/4,
    // zero IRT slip/guess, node offsets ±sqrt(3), and target likelihood ratio 8.
    const observation = { outcome: false, channel, misconceptionId: "target", powerWeight: omega, misconceptionLikelihoodRatio: 8 };
    const result = updateBeliefWithEvidence({ belief, item, atMs: DAY_MS, observation });
    expect(result.belief.abilityMean).toBeCloseTo(mean, 12);
    expect(result.belief.abilityVariance).toBeCloseTo(variance, 12);
    expect(result.retrievedProbability).toBeCloseTo(rho, 12);
    expect(new Map(result.posteriorMass).get("target")).toBeCloseTo(mass, 12);
    expect(result.belief.misconceptionMass[0]?.[1]).toBeCloseTo(mass, 12);
    expect(result.belief.otherMass).toBeCloseTo(1 - mass, 12);
    expect(result.posteriorMass.reduce((sum, [, p]) => sum + p, 0)).toBeCloseTo(1, 12);
    expect(result.belief.logStability).toBeCloseTo(belief.logStability - 0.25 * omega * (1 - rho), 12);
    expect(result.belief.implicitLogCredit).toBe(0);
    expect(applyEvidenceChannel({ belief, item, atMs: DAY_MS, ...observation }).belief).toEqual(result.belief);
  });

  it("uses posterior retrieval to decay a plain lapse and preserves the direct recall timestamp", () => {
    const result = updateBeliefWithEvidence({ belief, item: { ...item, misconceptions: [] }, atMs: DAY_MS, observation: { outcome: false } });
    // A symmetric ability prior and no IRT deltas give mean P(y=0 | retrieved)=1/2.
    expect(result.retrievedProbability).toBeCloseTo(0.4, 12);
    expect(result.belief.logStability).toBeCloseTo(belief.logStability - 0.15, 12);
    expect(result.belief.implicitLogCredit).toBe(0);
    expect(result.belief.lastDirectRecallAtMs).toBeNull();
  });

  it("treats explicit retrievalProbability as the prior entering the Bayesian posterior update", () => {
    const plainItem = { ...item, misconceptions: [] };
    const omitted = updateBeliefWithEvidence({ belief, item: plainItem, atMs: DAY_MS, observation: { outcome: false } });
    const explicit = updateBeliefWithEvidence({
      belief,
      item: plainItem,
      atMs: DAY_MS,
      observation: { outcome: false, retrievalProbability: 0.5 },
    });
    expect(explicit.directRetrievability).toBeCloseTo(0.5, 12);
    expect(explicit.retrievedProbability).toBeCloseTo(0.4, 12);
    expect(explicit.retrievedProbability).toBe(omitted.retrievedProbability);
    expect(explicit.belief.logStability).toBeCloseTo(belief.logStability - 0.15, 12);
    expect(explicit.belief).toEqual(omitted.belief);
    expect(explicit.posteriorMass).toEqual(omitted.posteriorMass);

    const omittedSuccess = updateBeliefWithEvidence({
      belief,
      item: plainItem,
      atMs: DAY_MS,
      observation: { outcome: true, isFreshFamily: true },
    });
    const explicitSuccess = updateBeliefWithEvidence({
      belief,
      item: plainItem,
      atMs: DAY_MS,
      observation: { outcome: true, isFreshFamily: true, retrievalProbability: omittedSuccess.directRetrievability },
    });
    expect(explicitSuccess.retrievedProbability).toBeCloseTo(2 / 3, 12);
    expect(explicitSuccess.retrievedProbability).toBe(omittedSuccess.retrievedProbability);
    expect(explicitSuccess.belief).toEqual(omittedSuccess.belief);
  });

  it("decays a lapse at certainty, preserves stability on success and weights fresh recall credit", () => {
    const current = baseBelief({ implicitLogCredit: 0.1 });
    const update = (observation: EvidenceObservation) => updateBeliefWithEvidence({ belief: current, item, atMs: DAY_MS, observation });
    expect(update({ outcome: false, retrievalProbability: 1 }).belief.logStability).toBeLessThan(current.logStability);
    expect(update({ outcome: true, channel: "distractor", retrievalProbability: 0 }).belief.logStability).toBe(current.logStability);
    const fresh = update({ outcome: true, isFreshFamily: true, retrievalProbability: 0.8, powerWeight: 0.5 });
    expect(fresh.retrievedProbability).toBeGreaterThan(0.8);
    expect(fresh.retrievedProbability).toBeLessThan(1);
    expect(fresh.belief.lastDirectRecallAtMs).toBe(DAY_MS);
    expect(fresh.belief.logStability).toBeCloseTo(
      current.logStability + 0.25 * 0.5 * fresh.retrievedProbability * (1 - fresh.directRetrievability),
      12,
    );
    const certainFresh = update({ outcome: true, isFreshFamily: true, retrievalProbability: 1, powerWeight: 0.5 });
    expect(certainFresh.retrievedProbability).toBe(1);
    expect(certainFresh.belief.logStability).toBeCloseTo(
      current.logStability + 0.125 * (1 - certainFresh.directRetrievability),
      12,
    );
  });

  it("preserves direct-recall history and blocks FIRe credit on a zero-responsibility fresh-family guess", () => {
    const guessItem: SkillItemModel = { itemId: "guess-only", a: 1, b: 0, g: 0.25, l: 0.05 };
    const unseeded = baseBelief({ lastDirectRecallAtMs: null, implicitLogCredit: 0 });
    const result = updateBeliefWithEvidence({
      belief: unseeded,
      item: guessItem,
      atMs: DAY_MS,
      observation: { outcome: true, channel: "unassisted", isFreshFamily: true, retrievalProbability: 0 },
    });
    expect(result.retrievedProbability).toBe(0);
    expect(result.belief.lastDirectRecallAtMs).toBeNull();
    expect(result.belief.logStability).toBe(unseeded.logStability);
    expect(result.belief.implicitLogCredit).toBe(0);
    expect(retrievability(result.belief, DAY_MS)).toBeCloseTo(0.5, 12);
    expect(retrievability(result.belief, 2 * DAY_MS)).toBeCloseTo(0.5, 12);

    const fire = propagateFireCredit({
      sourceSkillId: "encompassing",
      attemptId: "attempt-after-guess",
      atMs: 2 * DAY_MS,
      source: baseBelief({ lastDirectRecallAtMs: DAY_MS }),
      targets: {
        guessed: { belief: result.belief, edgeWeight: 0.8, covered: true, stepPassed: true },
      },
    });
    expect(fire.propagatedSkillIds).toEqual([]);
    expect(fire.targets.guessed.belief.implicitLogCredit).toBe(0);

    const seeded = baseBelief({ lastDirectRecallAtMs: 0, implicitLogCredit: 0.1 });
    const seededGuess = updateBeliefWithEvidence({
      belief: seeded,
      item: guessItem,
      atMs: DAY_MS,
      observation: { outcome: true, channel: "unassisted", isFreshFamily: true, retrievalProbability: 0 },
    });
    expect(seededGuess.retrievedProbability).toBe(0);
    expect(seededGuess.belief.lastDirectRecallAtMs).toBe(0);
    expect(seededGuess.belief.logStability).toBe(seeded.logStability);
    expect(seededGuess.belief.implicitLogCredit).toBe(0.1);
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

describe("initial tier two MAP snapshot", () => {
  const attempts: CalibrationAttempt[] = Array.from({ length: 50 }, (_, index) => ({
    learnerId: `l-${index}`, publisherItemRevisionId: "rev-2", outcome: "correct",
    independent: true, firstIndependentSubmission: true, abandoned: false, hinted: false, theta: 0,
    attemptedAt: "2026-01-02T00:30:00+02:00",
  }));

  it("fits the first tier two snapshot from chronologically deduplicated human attempts", () => {
    const later = attempts.map(attempt => ({ ...attempt, outcome: "incorrect" as const, attemptedAt: "2026-01-01T23:00:00Z" }));
    const input = { publisherItemRevisionId: "rev-2", difficultyTag: "medium" as const, parameterSnapshotVersion: "19" };
    const result = calibrateItemRevision({ ...input, attempts: [...later, ...attempts] });
    expect(result.humanCount).toBe(50);
    expect(result.tier).toBe(2);
    // MAP solves b + 50 * sigmoid(b) = 0 for all correct, theta=0, guessing=0.
    expect(result.servingDifficulty).toBeCloseTo(-2.817989, 5);
    expect(result.parameterSnapshot).toMatchObject({ parameterSnapshotVersion: "19", publisherItemRevisionId: "rev-2", difficulty: result.servingDifficulty });
  });

  it("refits a foreign revision and moves uphill when the initial posterior is convex", () => {
    const foreign: ParameterSnapshotV1 = {
      schemaVersion: 1, parameterSnapshotVersion: "foreign", publisherItemRevisionId: "rev-1",
      discrimination: 2, difficulty: -3, guessing: 0.25, lapse: 0.15, misconceptionDeltas: [],
    };
    const result = calibrateItemRevision({
      publisherItemRevisionId: "rev-2", difficultyTag: "medium", previousParameterSnapshot: foreign,
      attempts: attempts.map(attempt => ({ ...attempt, theta: 5, outcome: "incorrect" })),
    });
    expect(result.parameterSnapshot).toMatchObject({ publisherItemRevisionId: "rev-2", discrimination: 1, guessing: 0, lapse: 0.05 });
    expect(result.servingDifficulty).toBeGreaterThan(5);
    expect(result.parameterSnapshot?.difficulty).toBe(result.servingDifficulty);
  });

  it("finds the global MAP mode on a bimodal two-choice tier two posterior", () => {
    const bimodalAttempts = attempts.map(attempt => ({ ...attempt, theta: -6.13, outcome: "correct" as const }));
    const result = calibrateItemRevision({
      publisherItemRevisionId: "rev-2",
      difficultyTag: "medium",
      choiceCount: 2,
      attempts: bimodalAttempts,
      parameterSnapshotVersion: "20",
    });
    const logPosterior = (difficulty: number): number => {
      const prior = -0.5 * (difficulty - result.priorDifficulty) ** 2;
      const probability = conditionalSuccessProbability(
        { itemId: "rev-2", a: 1, b: difficulty, g: 0.5, l: 0.05 },
        -6.13,
      );
      return prior + bimodalAttempts.length * Math.log(probability);
    };
    expect(result.tier).toBe(2);
    expect(result.servingDifficulty).toBeCloseTo(-6.67, 2);
    expect(result.parameterSnapshot?.difficulty).toBe(result.servingDifficulty);
    expect(logPosterior(result.servingDifficulty)).toBeGreaterThan(-34.4);
    expect(logPosterior(result.servingDifficulty)).toBeGreaterThan(logPosterior(-0.108396));
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
    expect(mutualInformation([{ probability: 0.9, outcome: [0.9, 0.1] }, { probability: 0.1, outcome: [0.1, 0.9] }])).toBeCloseTo(0.1463105134, 10);
    expect(mutualInformation([{ probability: 0.5, outcome: [1, 0] }, { probability: 0.5, outcome: [0, 1] }])).toBeCloseTo(Math.LN2, 12);
    expect(mutualInformation([{ probability: 5, outcome: [2, 0, 0] }, { probability: 5, outcome: [0, 0, 8] }])).toBeCloseTo(Math.LN2, 12);
    expect(mutualInformation([{ probability: 9, outcome: [1, 2] }, { probability: 1, outcome: [2, 4] }])).toBe(0);
  });

  it("waits for release slots and never fits a late or repeated action", () => {
    const plan = planFiniteHorizon({ horizonMinutes: 5, slotMinutes: 1, actions: [
      { id: "delayed", durationMinutes: 1, utility: 10, earliestSlot: 10 },
      { id: "release", durationMinutes: 2, utility: 5, earliestSlot: 3 },
      { id: "early", durationMinutes: 1, utility: 1 },
    ] });
    expect(plan.actionIds).toEqual(["early", "release"]);
    expect(plan.actionStartSlots).toEqual([0, 3]);
    expect(plan.elapsedMinutes).toBe(5);
    expect(plan.utility).toBe(6);
  });

  it("can choose idle slots over immediate work and consumes each action ID at most once", () => {
    const plan = planFiniteHorizon({ horizonMinutes: 6, slotMinutes: 1, actions: [
      { id: "too-long-now", durationMinutes: 4, utility: 8 },
      { id: "released-later", durationMinutes: 3, utility: 10, earliestSlot: 2 },
      { id: "one-off", durationMinutes: 1, utility: 4 },
      { id: "one-off", durationMinutes: 1, utility: 4 },
    ] });
    expect(plan.actionIds).toEqual(["one-off", "released-later"]);
    expect(plan.actionStartSlots).toEqual([0, 2]);
    expect(plan.utility).toBe(14);
  });

  it("orders probes by the deadline weight inside the Bellman transition", () => {
    const plan = planFiniteHorizon({ horizonMinutes: 120, slotMinutes: 60, deadlineHours: 73, actions: [
      { id: "retention", durationMinutes: 60, retentionGain: 2 },
      { id: "probe", durationMinutes: 60, diagnosticInformationGain: 100, utility: 1 },
    ] });
    expect(plan.actionIds).toEqual(["probe", "retention"]);
    expect(plan.actionStartSlots).toEqual([0, 1]);
    expect(plan.utility).toBeCloseTo(3 + 90 * (3 / 96 ** 2 - 2 / 96 ** 3), 12);
    expect(plan.valueByStep).toEqual([plan.utility, 2, 0]);
  });

  it("advances by rounded slots and can wait when a negative diagnostic gain improves", () => {
    const plan = planFiniteHorizon({ horizonMinutes: 180, slotMinutes: 60, deadlineHours: 74, actions: [
      { id: "retention", durationMinutes: 60.1, utility: 2 },
      { id: "cost", durationMinutes: 5, retentionGain: 1, informationGain: -1000 },
    ] });
    expect(plan.actionIds).toEqual(["retention", "cost"]);
    expect(plan.actionStartSlots).toEqual([0, 2]);
    expect(plan.utility).toBe(3);
  });

  it.each([{ horizonMinutes: NaN }, { horizonMinutes: Infinity }, { horizonMinutes: -1 },
    { slotMinutes: NaN }, { slotMinutes: Infinity }, { slotMinutes: 0 }, { slotMinutes: -1 }])(
    "rejects invalid temporal input %j",
    override => expect(() => planFiniteHorizon({ horizonMinutes: 5, actions: [], ...override })).toThrow(RangeError),
  );

  it("schedules a large action set deterministically with fractional slots and release checks", () => {
    const actions = Array.from({ length: 40 }, (_, i) => ({
      id: `a-${i}`, durationMinutes: 0.5, utility: i + 1, earliestSlot: i === 39 ? 4 : 0,
    }));
    const input = { horizonMinutes: 2.5, slotMinutes: 0.5, actions };
    const plan = planFiniteHorizon(input);
    expect(planFiniteHorizon(input)).toEqual(plan);
    expect(plan.actionIds).toEqual(["a-38", "a-37", "a-36", "a-35", "a-39"]);
    expect(plan.actionStartSlots).toEqual([0, 1, 2, 3, 4]);
    expect(plan.elapsedMinutes).toBe(2.5);
  });
});

it("keeps the median of a representative large-action rollout below five milliseconds", () => {
  const actions = Array.from({ length: 128 }, (_, index) => ({
    id: String(index), durationMinutes: 1 + index % 11,
    retentionGain: 1 + index % 13, diagnosticInformationGain: index % 19,
    earliestSlot: index % 24,
  }));
  const input = { horizonMinutes: 120, slotMinutes: 5, deadlineHours: 74, actions };
  const plan = planFiniteHorizon(input);
  const samples = Array.from({ length: 30 }, () => {
    const start = performance.now();
    planFiniteHorizon(input);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  expect(samples[15]).toBeLessThan(5);
  expect(plan.actionIds.length).toBeGreaterThan(0);
  expect(new Set(plan.actionIds).size).toBe(plan.actionIds.length);
  expect(plan.elapsedMinutes).toBeLessThanOrEqual(input.horizonMinutes);
});

describe("paired shadow v2", () => {
  it("keeps strict pre-attempt cutoff and excludes target family plus propagated history", () => {
    const predictions: ShadowV2Row["predictions"] = {
      "classical-bkt": 0.5, pfa: 0.5, "smoothed-frequency": 0.5, "ts-fsrs": 0.65,
      "hsrs-fire-dcm-v1": 0.9, "no-fire": 0.8, "no-dcm": 0.6,
    };
    const input: ShadowV2Input = {
      cutoff: "2026-01-02T00:00:00Z", targetFamilyKeys: ["heldout"], propagatedFamilyKeys: new Set(["prereq"]),
      rows: [
        { observationId: "before", familyKey: "other", attemptedAt: "2026-01-01T00:00:00Z", correct: true, predictions },
        { observationId: "wrong", familyKey: "other", attemptedAt: "2026-01-01T00:00:00Z", correct: false, predictions: { ...predictions, "hsrs-fire-dcm-v1": 0.1, "no-fire": 0.3, "no-dcm": 0.5 } },
        { observationId: "at-cutoff", familyKey: "other", attemptedAt: "2026-01-02T00:00:00Z", correct: false, predictions },
        { observationId: "after", familyKey: "other", attemptedAt: "2026-01-03T00:00:00Z", correct: false, predictions },
        { observationId: "target", familyKey: "heldout", attemptedAt: "2026-01-01T00:00:00Z", correct: false, predictions },
        { observationId: "propagated", familyKey: "prereq", attemptedAt: "2026-01-01T00:00:00Z", correct: false, predictions },
      ],
    };
    const receipt = evaluateShadowV2Holdout(input);
    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.count).toBe(2);
    expect(receipt.excludedFamilyKeys).toEqual(["heldout", "prereq"]);
    expect(receipt.models.find(model => model.modelId === "hsrs-fire-dcm-v1")?.brierDelta).toBeLessThan(0);
    expect(receipt.models.find(model => model.modelId === "ts-fsrs")?.count).toBe(2);
    expect(receipt.ablation).toEqual(["no-fire", "no-dcm"]);
    expect(receipt.ablationMetrics[0]?.brier).toBeCloseTo(0.065, 12);
    expect(receipt.ablationMetrics[0]?.logLoss).toBeCloseTo(-Math.log(0.56) / 2, 12);
    expect(receipt.ablationMetrics[1]?.brier).toBeCloseTo(0.205, 12);
    expect(receipt.ablationMetrics[1]?.logLoss).toBeCloseTo(-Math.log(0.3) / 2, 12);
    expect(() => evaluateShadowV2Holdout({ ...input, propagatedFamilyKeys: undefined } as unknown as ShadowV2Input)).toThrow(/propagated/i);
    expect(() => evaluateShadowV2Holdout({ ...input, rows: [{ ...input.rows[0]!, predictions: { ...predictions, pfa: 2 } }] })).toThrow(/prediction/);
    expect(() => evaluateShadowV2Holdout({ ...input, rows: [{ ...input.rows[0]!, predictions: { ...predictions, "no-fire": NaN } }] })).toThrow(/prediction/);
  });
});
