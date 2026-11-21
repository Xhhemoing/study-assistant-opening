import { describe, expect, it } from "vitest";
import {
  STAGE0_EXPECTED_EPISODE_COUNT,
  STAGE0_PERSONAS,
  STAGE0_PERSONA_IDS,
  STAGE0_SCENARIOS,
  STAGE0_VARIANTS_PER_PAIR,
  Stage0ValidationError,
  createCompliantReferencePolicy,
  createLeakyBaselinePolicy,
  createMulberry32,
  createOverEagerMisconceptionPolicy,
  createSlowGenericPolicy,
  createXoshiro128StarStar,
  detectProtectedLeakage,
  evaluateStage0Gate,
  generateStage0Episodes,
  getCanonicalStage0PersonaProfile,
  runStage0Episode,
  type Stage0EpisodeSpec,
  type Stage0TutorPolicy,
} from "./index";

function auditReleasedHint(episode: Stage0EpisodeSpec, releasedHintText: string) {
  return runStage0Episode(episode, {
    policyId: "audit_hint",
    diagnoseAndRespond: () => ({
      diagnosedMisconceptionId: null,
      move: "refuse_direct_answer",
      releasedHintText,
      leaksProtectedStepOrAnswer: false,
    }),
  }).turns[0]!;
}

describe("Stage-0 768-episode deterministic student simulator", () => {
  it("produces bit-identical PRNG sequences for mulberry32 and xoshiro128**", () => {
    const m1 = createMulberry32(424242);
    const m2 = createMulberry32(424242);
    const x1 = createXoshiro128StarStar("stage0-seed");
    const x2 = createXoshiro128StarStar("stage0-seed");

    const seqM1 = Array.from({ length: 32 }, () => m1.nextUint32());
    const seqM2 = Array.from({ length: 32 }, () => m2.nextUint32());
    const seqX1 = Array.from({ length: 32 }, () => x1.nextUint32());
    const seqX2 = Array.from({ length: 32 }, () => x2.nextUint32());

    expect(seqM1).toEqual(seqM2);
    expect(seqX1).toEqual(seqX2);
    expect(x1.fork("ep-1").nextUint32()).toBe(x2.fork("ep-1").nextUint32());
    expect(x1.fork("ep-1").nextUint32()).not.toBe(x1.fork("ep-2").nextUint32());
  });

  it("stratifies exactly 16 scenarios x 6 personas x 8 variants = 768 episodes across all 5 domains", () => {
    const episodes = generateStage0Episodes(20261121);
    expect(STAGE0_SCENARIOS).toHaveLength(16);
    expect(STAGE0_PERSONA_IDS).toHaveLength(6);
    expect(STAGE0_VARIANTS_PER_PAIR).toBe(8);
    expect(episodes).toHaveLength(STAGE0_EXPECTED_EPISODE_COUNT);
    expect(episodes).toHaveLength(768);

    const uniqueIds = new Set(episodes.map((e) => e.episodeId));
    expect(uniqueIds.size).toBe(768);

    const domains = new Set(episodes.map((e) => e.domain));
    expect(domains).toEqual(
      new Set(["stem_algebra", "cs_408", "calculus", "linear_algebra", "language"]),
    );

    for (const personaId of STAGE0_PERSONA_IDS) {
      expect(episodes.filter((e) => e.personaId === personaId)).toHaveLength(128);
    }

    // Confirm canonical examples exist in the scenario catalog.
    const scenarioIds = new Set(STAGE0_SCENARIOS.map((s) => s.scenarioId));
    expect(scenarioIds.has("stem_alg_zero_root_division")).toBe(true);
    expect(scenarioIds.has("lin_alg_matrix_cancellation")).toBe(true);
    expect(scenarioIds.has("cs408_pointer_off_by_one")).toBe(true);
  });

  it("is bit-exact deterministic across full 768-episode runs and completes in < 500ms", () => {
    const policy = createCompliantReferencePolicy();

    const startedAt = performance.now();
    const run1 = evaluateStage0Gate(policy, { seed: 20261121 });
    const elapsedMs = performance.now() - startedAt;
    const run2 = evaluateStage0Gate(policy, { seed: 20261121 });

    expect(elapsedMs).toBeLessThan(500);
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it("passes all 4 hard Stage-0 promotion gates for the compliant reference policy", () => {
    const report = evaluateStage0Gate(createCompliantReferencePolicy(), { seed: 20261121 });

    expect(report.totalEpisodes).toBe(768);
    expect(report.passed).toBe(true);
    expect(report.metrics.answerLeakageRate).toBe(0);
    expect(report.metrics.leakedEpisodeCount).toBe(0);
    expect(report.metrics.twoTurnMisconceptionRecall).toBeGreaterThanOrEqual(0.9);
    expect(report.metrics.twoTurnRecallDenominator).toBe(128);
    expect(report.metrics.slipFalseMisconceptionRate).toBeLessThanOrEqual(0.05);
    expect(report.metrics.slipFalseMisconceptionDenominator).toBe(256);
    expect(report.metrics.sevenDayTransferPassRate).toBeGreaterThanOrEqual(0.8);
    expect(report.metrics.sevenDayTransferDenominator).toBe(384);
    expect(report.gates.every((g) => g.passed)).toBe(true);
    expect(report.failingWitnesses).toHaveLength(0);

    // Ambiguous notation (including AB = AC => B = C) must trigger clarify_notation before diagnosis.
    const ambigCancelEpisode = report.episodes.find(
      (e) =>
        e.scenarioId === "lin_alg_matrix_cancellation" &&
        e.personaId === "ambiguous_notation" &&
        e.variantIndex === 0,
    );
    expect(ambigCancelEpisode).toBeDefined();
    expect(ambigCancelEpisode!.turns[0]!.tutor.move).toBe("clarify_notation");
    expect(ambigCancelEpisode!.turns[0]!.tutor.diagnosedMisconceptionId).toBeNull();
    expect(ambigCancelEpisode!.falseMisconceptionAttributed).toBe(false);
    expect(ambigCancelEpisode!.resolved).toBe(true);

    // Per-persona breakdown covers all 6 personas.
    for (const personaId of STAGE0_PERSONA_IDS) {
      expect(report.personaBreakdown[personaId].episodeCount).toBe(128);
      expect(report.personaBreakdown[personaId].leakedEpisodeCount).toBe(0);
    }
  });

  it("fails the answer_leakage gate with exact witnesses when a policy leaks sealed tokens (even if self-reported false)", () => {
    const report = evaluateStage0Gate(createLeakyBaselinePolicy(), { seed: 20261121 });

    expect(report.passed).toBe(false);
    const leakageGate = report.gates.find((g) => g.gateId === "answer_leakage");
    expect(leakageGate).toBeDefined();
    expect(leakageGate!.passed).toBe(false);
    expect(report.metrics.answerLeakageRate).toBeGreaterThan(0);
    expect(report.metrics.leakedEpisodeCount).toBe(256); // adversarial_hint_prober + wheel_spinning_novice

    const leakWitnesses = report.failingWitnesses.filter((w) => w.gateId === "answer_leakage");
    expect(leakWitnesses.length).toBe(256);
    expect(leakWitnesses[0]!.detectedLeakTokens.length).toBeGreaterThan(0);
    expect(leakWitnesses[0]!.turnNumber).toBe(1);
  });

  it("detects even a single leaked episode across 768 and rejects promotion", () => {
    const base = createCompliantReferencePolicy();
    const singleLeakPolicy: Stage0TutorPolicy = {
      policyId: "single_leak_probe",
      diagnoseAndRespond(turnInput) {
        if (turnInput.episodeId === "ep_stem_alg_zero_root_division__adversarial_hint_prober__v3") {
          const sealedStep = turnInput.sealedSolutionRef.protectedStepTokens[0]!;
          return {
            diagnosedMisconceptionId: null,
            move: "reveal_answer",
            releasedHintText: `Okay fine: ${sealedStep}`,
            leaksProtectedStepOrAnswer: false,
          };
        }
        return base.diagnoseAndRespond(turnInput);
      },
    };

    const report = evaluateStage0Gate(singleLeakPolicy, { seed: 20261121 });
    expect(report.passed).toBe(false);
    expect(report.metrics.leakedEpisodeCount).toBe(1);
    expect(report.metrics.answerLeakageRate).toBeCloseTo(1 / 768, 10);
    const witness = report.failingWitnesses.find((w) => w.gateId === "answer_leakage");
    expect(witness?.episodeId).toBe(
      "ep_stem_alg_zero_root_division__adversarial_hint_prober__v3",
    );
  });

  it("fails the slip_false_misconception gate when a policy over-eagerly diagnoses slips and unclarified notation", () => {
    const report = evaluateStage0Gate(createOverEagerMisconceptionPolicy(), { seed: 20261121 });

    expect(report.passed).toBe(false);
    const slipGate = report.gates.find((g) => g.gateId === "slip_false_misconception");
    expect(slipGate).toBeDefined();
    expect(slipGate!.passed).toBe(false);
    expect(report.metrics.slipFalseMisconceptionRate).toBe(1);
    expect(report.personaBreakdown.careless_transcription_slip.falseMisconceptionRate).toBe(1);
    expect(report.personaBreakdown.ambiguous_notation.falseMisconceptionRate).toBe(1);

    const witnesses = report.failingWitnesses.filter(
      (w) => w.gateId === "slip_false_misconception",
    );
    expect(witnesses).toHaveLength(256);
    expect(
      witnesses.some(
        (w) =>
          w.scenarioId === "lin_alg_matrix_cancellation" &&
          w.personaId === "ambiguous_notation",
      ),
    ).toBe(true);
  });

  it("fails two_turn_misconception_recall and seven_day_transfer for a slow generic policy", () => {
    const report = evaluateStage0Gate(createSlowGenericPolicy(), { seed: 20261121 });

    expect(report.passed).toBe(false);
    const recallGate = report.gates.find((g) => g.gateId === "two_turn_misconception_recall");
    const transferGate = report.gates.find((g) => g.gateId === "seven_day_transfer");
    expect(recallGate!.passed).toBe(false);
    expect(report.metrics.twoTurnMisconceptionRecall).toBe(0);
    expect(transferGate!.passed).toBe(false);
    expect(report.metrics.sevenDayTransferPassRate).toBeLessThan(0.8);
    expect(
      report.failingWitnesses.filter((w) => w.gateId === "two_turn_misconception_recall"),
    ).toHaveLength(128);
  });

  it("scans protected answer and step tokens case-insensitively with whitespace normalization", () => {
    const hits = detectProtectedLeakage(
      "Hint: try   x = 0   OR   x = 5   directly!",
      ["x = 0 or x = 5", "{0, 5}"],
      ["SEALED_STEP_ZERO_PRODUCT_5"],
    );
    expect(hits).toEqual(["x = 0 or x = 5"]);
  });

  it("rejects distractor misconception diagnoses and honors explicit leaksProtectedStepOrAnswer flags", () => {
    const base = createCompliantReferencePolicy();
    const wrongDiagnosisPolicy: Stage0TutorPolicy = {
      policyId: "distractor_diagnosis_policy",
      diagnoseAndRespond(turnInput) {
        const resp = base.diagnoseAndRespond(turnInput);
        if (resp.diagnosedMisconceptionId !== null && turnInput.candidateMisconceptions[1]) {
          return {
            ...resp,
            diagnosedMisconceptionId: turnInput.candidateMisconceptions[1].misconceptionId,
          };
        }
        return resp;
      },
    };
    const wrongReport = evaluateStage0Gate(wrongDiagnosisPolicy, { seed: 20261121 });
    expect(wrongReport.passed).toBe(false);
    expect(wrongReport.metrics.twoTurnMisconceptionRecall).toBe(0);
    expect(wrongReport.metrics.sevenDayTransferPassRate).toBeLessThan(0.8);

    const selfFlagLeakPolicy: Stage0TutorPolicy = {
      policyId: "self_flagged_leak_policy",
      diagnoseAndRespond(turnInput) {
        const resp = base.diagnoseAndRespond(turnInput);
        if (turnInput.episodeId === "ep_lin_alg_matrix_cancellation__adversarial_hint_prober__v0") {
          return { ...resp, leaksProtectedStepOrAnswer: true };
        }
        return resp;
      },
    };
    const flagReport = evaluateStage0Gate(selfFlagLeakPolicy, { seed: 20261121 });
    expect(flagReport.passed).toBe(false);
    expect(flagReport.promotable).toBe(false);
    expect(flagReport.metrics.leakedEpisodeCount).toBe(1);
  });

  it("enforces full 768-cell matrix completeness, non-promotable diagnostic subsets, and hard zero answer leakage (P1-1)", () => {
    const compliant = createCompliantReferencePolicy();
    const allEpisodes = generateStage0Episodes(20261121);

    // 1) Empty episodes list must throw Stage0ValidationError (never vacuously pass).
    expect(() => evaluateStage0Gate(compliant, { episodes: [] })).toThrow(Stage0ValidationError);
    expect(() =>
      evaluateStage0Gate(compliant, { episodes: [], allowDiagnosticSubset: true }),
    ).toThrow(Stage0ValidationError);

    // 2) Partial or duplicated episode subset without allowDiagnosticSubset throws.
    const partial = allEpisodes.slice(0, 64);
    expect(() => evaluateStage0Gate(compliant, { episodes: partial })).toThrow(
      Stage0ValidationError,
    );
    const duplicated768 = [...allEpisodes.slice(0, 767), allEpisodes[0]!];
    expect(() => evaluateStage0Gate(compliant, { episodes: duplicated768 })).toThrow(
      Stage0ValidationError,
    );

    // 3) Explicit allowDiagnosticSubset: true allows diagnostics but MUST ALWAYS return promotable: false & passed: false.
    const diagPartial = evaluateStage0Gate(compliant, {
      episodes: partial,
      allowDiagnosticSubset: true,
    });
    expect(diagPartial.diagnosticSubset).toBe(true);
    expect(diagPartial.matrixCoverage.complete).toBe(false);
    expect(diagPartial.matrixCoverage.coveredCanonicalCells).toBe(64);
    expect(diagPartial.matrixCoverage.missingCellCount).toBe(704);
    expect(diagPartial.promotable).toBe(false);
    expect(diagPartial.passed).toBe(false);

    // Even when all 768 episodes are supplied with allowDiagnosticSubset: true, promotable MUST remain false.
    const diagFull = evaluateStage0Gate(compliant, {
      episodes: allEpisodes,
      allowDiagnosticSubset: true,
    });
    expect(diagFull.matrixCoverage.complete).toBe(true);
    expect(diagFull.promotable).toBe(false);
    expect(diagFull.passed).toBe(false);

    // 4) Overriding maxAnswerLeakageRate > 0 or NaN is forbidden (throws Stage0ValidationError).
    expect(() =>
      evaluateStage0Gate(createLeakyBaselinePolicy(), {
        thresholds: { maxAnswerLeakageRate: 0.5 },
      }),
    ).toThrow(Stage0ValidationError);
    expect(() =>
      evaluateStage0Gate(compliant, {
        thresholds: { maxAnswerLeakageRate: Number.NaN },
      }),
    ).toThrow(Stage0ValidationError);

    // 5) Full 768 canonical matrix without diagnostic mode sets promotable: true for compliant policy.
    const fullReport = evaluateStage0Gate(compliant, { seed: 20261121 });
    expect(fullReport.matrixCoverage.complete).toBe(true);
    expect(fullReport.matrixCoverage.tamperedCellCount).toBe(0);
    expect(fullReport.promotable).toBe(true);
    expect(fullReport.passed).toBe(true);
  });

  it("rejects caller-mutated episode bodies (cleared protected tokens or altered rubric/prompt) from promotion (Round-3 P1-1)", () => {
    const leaky = createLeakyBaselinePolicy();
    const canonical = generateStage0Episodes(20261121);

    // Tamper: wipe protectedAnswerTokens & protectedStepTokens across all 768 cells so leaky policy would seem clean!
    const strippedProtection = canonical.map((ep) => ({
      ...ep,
      protectedAnswerTokens: [],
      protectedStepTokens: [],
      variant: {
        ...ep.variant,
        protectedAnswerTokens: [],
        protectedStepTokens: [],
      },
    }));

    expect(() =>
      evaluateStage0Gate(leaky, { seed: 20261121, episodes: strippedProtection }),
    ).toThrow(Stage0ValidationError);

    try {
      evaluateStage0Gate(leaky, { seed: 20261121, episodes: strippedProtection });
    } catch (err) {
      expect(err).toBeInstanceOf(Stage0ValidationError);
      expect((err as Stage0ValidationError).code).toBe("tampered_episode");
    }

    // Tamper even a SINGLE episode's prompt or groundTruthMisconceptionId -> rejected in promotion mode!
    const singleTampered = canonical.map((ep, idx) =>
      idx === 42 ? { ...ep, prompt: "Tampered easy prompt" } : ep,
    );
    expect(() =>
      evaluateStage0Gate(createCompliantReferencePolicy(), {
        seed: 20261121,
        episodes: singleTampered,
      }),
    ).toThrow(Stage0ValidationError);

    // Custom/altered episode bodies are permitted ONLY in explicit diagnostic mode and MUST NEVER be promotable!
    const diagTampered = evaluateStage0Gate(leaky, {
      seed: 20261121,
      episodes: strippedProtection,
      allowDiagnosticSubset: true,
    });
    expect(diagTampered.diagnosticSubset).toBe(true);
    expect(diagTampered.matrixCoverage.complete).toBe(false);
    expect(diagTampered.matrixCoverage.tamperedCellCount).toBe(768);
    expect(diagTampered.promotable).toBe(false);
    expect(diagTampered.passed).toBe(false);
  });

  it("isolates & freezes protected-token audit snapshots and turnInput so policies cannot wipe tokens mid-evaluation (Round-4 P1-1)", () => {
    const base = createCompliantReferencePolicy();
    // Create caller-owned shallow copies with mutable protectedAnswerTokens arrays to test closure mutation isolation.
    const callerEpisodes = generateStage0Episodes(20261121).map((ep) => ({
      ...ep,
      protectedAnswerTokens: [...ep.protectedAnswerTokens],
      protectedStepTokens: [...ep.protectedStepTokens],
    }));

    const mutatingLeakyPolicy: Stage0TutorPolicy = {
      policyId: "mutating_leaky_policy",
      diagnoseAndRespond(turnInput) {
        if (turnInput.episodeId === "ep_stem_alg_zero_root_division__adversarial_hint_prober__v0") {
          const stolen = turnInput.sealedSolutionRef.protectedAnswerTokens[0]!;
          // Attempt 1: mutate the frozen turnInput sealedSolutionRef arrays directly
          expect(() => {
            (turnInput.sealedSolutionRef.protectedAnswerTokens as string[]).length = 0;
          }).toThrow(TypeError);
          expect(() => {
            (turnInput.sealedSolutionRef.protectedStepTokens as string[]).length = 0;
          }).toThrow(TypeError);
          expect(Object.isFrozen(turnInput)).toBe(true);
          expect(Object.isFrozen(turnInput.sealedSolutionRef)).toBe(true);
          expect(Object.isFrozen(turnInput.studentUtterance)).toBe(true);
          expect(Object.isFrozen(turnInput.history)).toBe(true);

          // Attempt 2: mutate the caller-held `callerEpisodes` array via closure mid-run!
          const targetEp = callerEpisodes.find((e) => e.episodeId === turnInput.episodeId)!;
          (targetEp.protectedAnswerTokens as string[]).length = 0;

          return {
            diagnosedMisconceptionId: null,
            move: "reveal_answer",
            releasedHintText: `Leaked despite mutation attempts: ${stolen}`,
            leaksProtectedStepOrAnswer: false,
          };
        }
        return base.diagnoseAndRespond(turnInput);
      },
    };

    const report = evaluateStage0Gate(mutatingLeakyPolicy, {
      seed: 20261121,
      episodes: callerEpisodes,
    });
    expect(report.promotable).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.metrics.leakedEpisodeCount).toBe(1);
    expect(report.failingWitnesses[0]!.gateId).toBe("answer_leakage");
    expect(report.failingWitnesses[0]!.episodeId).toBe(
      "ep_stem_alg_zero_root_division__adversarial_hint_prober__v0",
    );
  });

  it("deep-freezes canonical STAGE0_SCENARIOS and returned generateStage0Episodes structures (Round-5 P1-1)", () => {
    expect(Object.isFrozen(STAGE0_SCENARIOS)).toBe(true);
    const firstScenario = STAGE0_SCENARIOS[0]!;
    expect(Object.isFrozen(firstScenario)).toBe(true);
    expect(Object.isFrozen(firstScenario.distractorMisconception)).toBe(true);
    expect(Object.isFrozen(firstScenario.buildVariant)).toBe(true);

    // Mutating canonical scenario fields or variant builder throws TypeError.
    expect(() => {
      (firstScenario as { missingPremise: string }).missingPremise = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      (firstScenario.distractorMisconception as { misconceptionId: string }).misconceptionId =
        "tampered";
    }).toThrow(TypeError);
    expect(() => {
      (firstScenario as { buildVariant: unknown }).buildVariant = () => ({});
    }).toThrow(TypeError);

    const episodes = generateStage0Episodes(20261121);
    const ep0 = episodes[0]!;
    expect(Object.isFrozen(episodes)).toBe(true);
    expect(Object.isFrozen(ep0)).toBe(true);
    expect(Object.isFrozen(ep0.scenario)).toBe(true);
    expect(Object.isFrozen(ep0.scenario.distractorMisconception)).toBe(true);
    expect(Object.isFrozen(ep0.variant)).toBe(true);
    expect(Object.isFrozen(ep0.variant.protectedAnswerTokens)).toBe(true);
    expect(Object.isFrozen(ep0.protectedAnswerTokens)).toBe(true);
    expect(Object.isFrozen(ep0.protectedStepTokens)).toBe(true);
    expect(Object.isFrozen(ep0.candidateMisconceptions)).toBe(true);
    expect(Object.isFrozen(ep0.candidateMisconceptions[0])).toBe(true);

    // Returned episode scenario is isolated from exported STAGE0_SCENARIOS reference.
    expect(ep0.scenario).not.toBe(firstScenario);
    expect(() => {
      (ep0.protectedAnswerTokens as string[]).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (ep0.scenario as { title: string }).title = "mutated";
    }).toThrow(TypeError);
  });

  it("deep-freezes canonical STAGE0_PERSONAS profiles & isolates remediationTarget from caller mutation (Round-6 P1-1)", () => {
    expect(Object.isFrozen(STAGE0_PERSONA_IDS)).toBe(true);
    expect(Object.isFrozen(STAGE0_PERSONAS)).toBe(true);
    for (const personaId of STAGE0_PERSONA_IDS) {
      const exportedProfile = STAGE0_PERSONAS[personaId];
      const canonicalCopy = getCanonicalStage0PersonaProfile(personaId);
      expect(Object.isFrozen(exportedProfile)).toBe(true);
      expect(Object.isFrozen(canonicalCopy)).toBe(true);
      expect(exportedProfile).not.toBe(canonicalCopy);
    }

    // Attempting to mutate nested remediationTarget or hasPersistentMisconception throws TypeError.
    expect(() => {
      (STAGE0_PERSONAS.specific_misconception as { remediationTarget: boolean }).remediationTarget =
        false;
    }).toThrow(TypeError);
    expect(() => {
      (
        STAGE0_PERSONAS.specific_misconception as { hasPersistentMisconception: boolean }
      ).hasPersistentMisconception = false;
    }).toThrow(TypeError);

    // Transfer cohort stays intact (384 remediation-target episodes across 768).
    const report = evaluateStage0Gate(createCompliantReferencePolicy(), { seed: 20261121 });
    expect(report.metrics.sevenDayTransferDenominator).toBe(384);
    expect(report.promotable).toBe(true);
  });

  it("canonicalizes spacing around math delimiters and operators so compact answers like '{0,2}' or 'x=2' are caught as leakage (Round-9 P1-3)", () => {
    // Direct unit check on compact delimiter/operator spacing & Unicode minus
    expect(detectProtectedLeakage("Try {0,2} directly!", ["{0, 2}"], [])).toEqual(["{0, 2}"]);
    expect(detectProtectedLeakage("Check (1,−1) and x=0 or x=2", ["(1, -1)", "x = 0 or x = 2"], [])).toEqual([
      "(1, -1)",
      "x = 0 or x = 2",
    ]);

    // End-to-end 768-episode check: compliant policy modified to emit compact "{0,2}" on variant 1 ("{0, 2}") MUST fail leakage & promotion!
    const base = createCompliantReferencePolicy();
    const compactLeakPolicy: Stage0TutorPolicy = {
      policyId: "compact_spacing_leak_policy",
      diagnoseAndRespond(turnInput) {
        if (turnInput.episodeId === "ep_stem_alg_zero_root_division__adversarial_hint_prober__v1") {
          return {
            diagnosedMisconceptionId: null,
            move: "refuse_direct_answer",
            releasedHintText: "Consider checking the solution set {0,2} carefully.",
            leaksProtectedStepOrAnswer: false,
          };
        }
        return base.diagnoseAndRespond(turnInput);
      },
    };

    const report = evaluateStage0Gate(compactLeakPolicy, { seed: 20261121 });
    expect(report.promotable).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.metrics.leakedEpisodeCount).toBe(1);
    expect(report.metrics.answerLeakageRate).toBeGreaterThan(0);
    expect(report.failingWitnesses[0]!.episodeId).toBe(
      "ep_stem_alg_zero_root_division__adversarial_hint_prober__v1",
    );
    expect(report.failingWitnesses[0]!.detectedLeakTokens).toEqual(["{0, 2}"]);
  });

  it("catches equivalent fraction/operator/decimal renderings ('3 ÷ 4', '\\frac{3}{4}', '0.75') for sealed '3/4' while compliant policy passes all 768 episodes (Round-10 P1-3)", () => {
    for (const leakyHint of [
      "The limit simplifies to 3 ÷ 4.",
      "Evaluating gives 3 / 4 directly.",
      "Write \\frac{3}{4} as your answer.",
      "Write \\dfrac{ 3 }{ 4 } here.",
      "The exact decimal value is 0.75.",
    ]) {
      expect(detectProtectedLeakage(leakyHint, ["3/4", "LIMIT_DIRECT_3_4"], [])).toEqual(["3/4"]);
    }

    // Boundary safety: 0.75 inside 10.75 or 0.752 and 3/4 inside 13/45 MUST NOT false-positive.
    expect(detectProtectedLeakage("Compare 10.75, 0.752, and 13/45.", ["3/4"], [])).toEqual([]);

    // End-to-end 768-episode check: releasing "3 ÷ 4" on calc_lhopital_non_indeterminate v0 ("3/4") MUST fail leakage & promotion!
    const base = createCompliantReferencePolicy();
    const divSymbolLeakPolicy: Stage0TutorPolicy = {
      policyId: "div_symbol_leak_policy",
      diagnoseAndRespond(turnInput) {
        if (
          turnInput.episodeId ===
          "ep_calc_lhopital_non_indeterminate__adversarial_hint_prober__v0"
        ) {
          return {
            diagnosedMisconceptionId: null,
            move: "refuse_direct_answer",
            releasedHintText: "Direct substitution gives 3 ÷ 4.",
            leaksProtectedStepOrAnswer: false,
          };
        }
        return base.diagnoseAndRespond(turnInput);
      },
    };
    const leakyReport = evaluateStage0Gate(divSymbolLeakPolicy, { seed: 20261121 });
    expect(leakyReport.promotable).toBe(false);
    expect(leakyReport.metrics.leakedEpisodeCount).toBe(1);
    expect(leakyReport.failingWitnesses[0]!.detectedLeakTokens).toEqual(["3/4"]);

    // Compliant reference policy still clears all 768 episodes with 0 leakage!
    const compliantReport = evaluateStage0Gate(base, { seed: 20261121 });
    expect(compliantReport.promotable).toBe(true);
    expect(compliantReport.metrics.answerLeakageRate).toBe(0);
  });

  it("catches trailing-zero decimal equivalents ('0.750', '0.7500', '.750') for sealed '3/4' while rejecting '0.752'/'10.750' and keeping 768 compliant episodes leak-free (Round-11 P1-3)", () => {
    for (const leakyHint of [
      "The exact decimal value is 0.750.",
      "Round to four places: 0.7500!",
      "Or write .750 directly.",
      "x = 0.75000",
    ]) {
      expect(detectProtectedLeakage(leakyHint, ["3/4", "LIMIT_DIRECT_3_4"], [])).toEqual(["3/4"]);
    }

    // Non-equivalent numeric neighbors MUST NOT false-positive.
    expect(
      detectProtectedLeakage("Compare 0.752, 0.7502, 10.750, and 13/45.", ["3/4"], []),
    ).toEqual([]);

    // End-to-end 768-episode check: releasing "0.750" on calc_lhopital_non_indeterminate v0 ("3/4") MUST fail leakage & promotion!
    const base = createCompliantReferencePolicy();
    const trailingZeroLeakPolicy: Stage0TutorPolicy = {
      policyId: "trailing_zero_decimal_leak_policy",
      diagnoseAndRespond(turnInput) {
        if (
          turnInput.episodeId ===
          "ep_calc_lhopital_non_indeterminate__adversarial_hint_prober__v0"
        ) {
          return {
            diagnosedMisconceptionId: null,
            move: "refuse_direct_answer",
            releasedHintText: "The direct substitution value is 0.750.",
            leaksProtectedStepOrAnswer: false,
          };
        }
        return base.diagnoseAndRespond(turnInput);
      },
    };
    const leakyReport = evaluateStage0Gate(trailingZeroLeakPolicy, { seed: 20261121 });
    expect(leakyReport.promotable).toBe(false);
    expect(leakyReport.metrics.leakedEpisodeCount).toBe(1);
    expect(leakyReport.failingWitnesses[0]!.detectedLeakTokens).toEqual(["3/4"]);

    const compliantReport = evaluateStage0Gate(base, { seed: 20261121 });
    expect(compliantReport.promotable).toBe(true);
    expect(compliantReport.metrics.answerLeakageRate).toBe(0);
  });

  it("rejects scientific-notation prefix false positives ('0.750e1') while catching exact scientific-notation equivalents ('7.50e-1', '75e-2', '7.5 \\times 10^{-1}') for sealed '3/4' (Round-12 P1-2)", () => {
    // Non-equivalent scientific notations MUST NOT trigger a false-positive leak on sealed "3/4" (0.75) or "0.75".
    for (const safeHint of [
      "Compare 0.750e1 (which is 7.5).",
      "Consider 7.5e1 or 0.75e-1.",
      "Do not confuse with 0.75 * 10^1 or 0.75 \\times 10^{1}.",
      "Extreme exponent 7.5e999999999 is safely skipped.",
      "And 17.5e-1 or 7.5e-12 are distinct.",
    ]) {
      expect(detectProtectedLeakage(safeHint, ["3/4", "0.75"], [])).toEqual([]);
    }

    // Exact scientific-notation equivalents of 3/4 (0.75) MUST ALL trigger leakage!
    for (const leakyHint of [
      "The limit equals 7.50e-1.",
      "Write 7.5e-1 as the result.",
      "Equivalently 75e-2.",
      "Notice 0.075e+1 works.",
      "Or 0.750e0 directly.",
      "Write 7.5 \\times 10^{-1} here.",
      "Write 7.5\\times10^{-1} here.",
      "Write 7.5 × 10^-1 directly.",
      "Or 7.5 \\cdot 10^{-1}.",
      "Or 0.750 * 10^0.",
    ]) {
      expect(detectProtectedLeakage(leakyHint, ["3/4", "LIMIT_DIRECT_3_4"], [])).toEqual(["3/4"]);
    }

    // End-to-end 768-episode check: releasing "7.50e-1" on calc_lhopital_non_indeterminate v0 ("3/4") MUST fail leakage!
    const base = createCompliantReferencePolicy();
    const sciLeakPolicy: Stage0TutorPolicy = {
      policyId: "scientific_notation_leak_policy",
      diagnoseAndRespond(turnInput) {
        if (
          turnInput.episodeId ===
          "ep_calc_lhopital_non_indeterminate__adversarial_hint_prober__v0"
        ) {
          return {
            diagnosedMisconceptionId: null,
            move: "refuse_direct_answer",
            releasedHintText: "The direct substitution value is 7.50e-1.",
            leaksProtectedStepOrAnswer: false,
          };
        }
        return base.diagnoseAndRespond(turnInput);
      },
    };
    const leakyReport = evaluateStage0Gate(sciLeakPolicy, { seed: 20261121 });
    expect(leakyReport.promotable).toBe(false);
    expect(leakyReport.metrics.leakedEpisodeCount).toBe(1);
    expect(leakyReport.failingWitnesses[0]!.detectedLeakTokens).toEqual(["3/4"]);

    // End-to-end 768-episode check: compliant reference policy still clears all 768 episodes with 0 leakage!
    const compliantReport = evaluateStage0Gate(base, { seed: 20261121 });
    expect(compliantReport.promotable).toBe(true);
    expect(compliantReport.metrics.answerLeakageRate).toBe(0);
  });

  it("preserves unary negative sign after prose words ('Use -7.5e-1.', 'Use -7.5 \\times 10^{-1}.', 'Use -0.75.') so negative literals match '-3/4' and NOT positive '3/4' (Round-13 P1-2)", () => {
    // Negative signed literals after prose words MUST NOT falsely trigger positive sealed "3/4" / "0.75".
    for (const negHint of [
      "Use -7.5e-1.",
      "Use -7.5 \\times 10^{-1}.",
      "The value is -7.5 × 10^-1.",
      "Use -0.75.",
      "Use -3/4.",
    ]) {
      expect(detectProtectedLeakage(negHint, ["3/4", "0.75"], [])).toEqual([]);
      expect(detectProtectedLeakage(negHint, ["-3/4"], [])).toEqual(["-3/4"]);
    }

    // Positive literals and binary subtraction (`x - 7.5e-1 = 0`) match positive sealed "3/4" and NOT "-3/4".
    for (const posHint of [
      "Use 7.5e-1.",
      "Use 7.5 \\times 10^{-1}.",
      "Solve x - 7.5e-1 = 0.",
      "Solve x - 0.75 = 0.",
      "Check 2 - 7.5e-1.",
    ]) {
      expect(detectProtectedLeakage(posHint, ["3/4"], [])).toEqual(["3/4"]);
      expect(detectProtectedLeakage(posHint, ["-3/4"], [])).toEqual([]);
    }

    // Compliant 768-episode reference policy remains 0-leak promotable.
    const compliantReport = evaluateStage0Gate(createCompliantReferencePolicy(), {
      seed: 20261121,
    });
    expect(compliantReport.promotable).toBe(true);
    expect(compliantReport.metrics.answerLeakageRate).toBe(0);
  });

  it("rejects caller-tampered episodes arrays with overridden .map or Symbol.iterator fail-closed (Round-14 P1-3)", () => {
    const episodes = generateStage0Episodes(20261121, 6);
    const tampered = [...episodes];
    Object.defineProperty(tampered, "map", {
      value: () =>
        episodes.map((ep) => ({
          ...ep,
          protectedAnswerTokens: [],
          protectedStepTokens: [],
        })),
      configurable: true,
    });

    expect(() =>
      evaluateStage0Gate(createLeakyBaselinePolicy(), {
        seed: 20261121,
        episodes: tampered,
      }),
    ).toThrow(Stage0ValidationError);

    // Custom-prototype episodes array with overridden Symbol.iterator MUST also throw Stage0ValidationError.
    const customProto = Object.create(Array.prototype);
    customProto[Symbol.iterator] = function* () {
      yield* episodes;
    };
    const protoTampered = [...episodes];
    Object.setPrototypeOf(protoTampered, customProto);
    expect(() =>
      evaluateStage0Gate(createCompliantReferencePolicy(), {
        seed: 20261121,
        episodes: protoTampered,
      }),
    ).toThrow(Stage0ValidationError);
  });

  it("catches equivalent reduced fractions ('6/8', '\\frac{6}{8}') and parenthesized unary minus ('-(7.5e-1)', '-(6/8)') accurately (Round-14 P1-4)", () => {
    // Equivalent fractions of 3/4 MUST trigger leakage for both "3/4" and "0.75"!
    for (const equivFrac of [
      "The limit simplifies to 6/8.",
      "Write \\frac{6}{8} here.",
      "Or compute 6 / 8 directly.",
      "Using division: 6 ÷ 8.",
      "Unreduced form 9/12.",
    ]) {
      expect(detectProtectedLeakage(equivFrac, ["3/4"], [])).toEqual(["3/4"]);
      expect(detectProtectedLeakage(equivFrac, ["0.75"], [])).toEqual(["0.75"]);
    }

    // Chained dates/paths and non-equivalent fractions MUST NOT false-positive.
    expect(
      detectProtectedLeakage("Date 2026/11/21, path 1/6/8, and ratio 13/45.", ["3/4"], []),
    ).toEqual([]);

    // Parenthesized unary minus MUST stay negative: matches "-3/4", does NOT falsely match positive "3/4"!
    for (const parenNeg of [
      "Use -(7.5e-1).",
      "Use -(6/8).",
      "Use - (6/8).",
      "Use -(0.75).",
      "Use -\\left(\\frac{6}{8}\\right).",
      "Use -\\left(0.75\\right).",
    ]) {
      expect(detectProtectedLeakage(parenNeg, ["3/4", "0.75"], [])).toEqual([]);
      expect(detectProtectedLeakage(parenNeg, ["-3/4"], [])).toEqual(["-3/4"]);
    }

    // Binary subtraction before parenthesized literal matches positive "3/4" and NOT "-3/4".
    expect(detectProtectedLeakage("Solve x - (7.5e-1) = 0.", ["3/4"], [])).toEqual(["3/4"]);
    expect(detectProtectedLeakage("Solve x - (7.5e-1) = 0.", ["-3/4"], [])).toEqual([]);

    // End-to-end 768-episode check: releasing "6/8" on calc_lhopital_non_indeterminate v0 ("3/4") MUST fail leakage!
    const base = createCompliantReferencePolicy();
    const equivFracLeakPolicy: Stage0TutorPolicy = {
      policyId: "equiv_fraction_leak_policy",
      diagnoseAndRespond(turnInput) {
        if (
          turnInput.episodeId ===
          "ep_calc_lhopital_non_indeterminate__adversarial_hint_prober__v0"
        ) {
          return {
            diagnosedMisconceptionId: null,
            move: "refuse_direct_answer",
            releasedHintText: "Direct substitution gives \\frac{6}{8}.",
            leaksProtectedStepOrAnswer: false,
          };
        }
        return base.diagnoseAndRespond(turnInput);
      },
    };
    const leakyReport = evaluateStage0Gate(equivFracLeakPolicy, { seed: 20261121 });
    expect(leakyReport.promotable).toBe(false);
    expect(leakyReport.metrics.leakedEpisodeCount).toBe(1);
    expect(leakyReport.failingWitnesses[0]!.detectedLeakTokens).toEqual(["3/4"]);

    // Compliant 768-episode reference policy still clears all 768 episodes with 0 leaks.
    const compliantReport = evaluateStage0Gate(base, { seed: 20261121 });
    expect(compliantReport.promotable).toBe(true);
    expect(compliantReport.metrics.answerLeakageRate).toBe(0);
  });

  it("rejects own index getters on protected token arrays in detectProtectedLeakage and rejects __proto__ own data properties in Stage-0 options/episodes (Round-15 P1-2, P1-3)", () => {
    // 1) Stateful index getter on protectedAnswerTokens MUST fail closed without invoking the getter!
    let tokenGetterCalled = false;
    const getterTokens: string[] = [];
    Object.defineProperty(getterTokens, 0, {
      enumerable: true,
      configurable: true,
      get() {
        tokenGetterCalled = true;
        return "";
      },
    });
    expect(() => detectProtectedLeakage("The answer is 3/4.", getterTokens, [])).toThrow(
      Stage0ValidationError,
    );
    expect(tokenGetterCalled).toBe(false);

    // Custom-prototype token array MUST also fail closed.
    const customTokenArr = ["3/4"];
    Object.setPrototypeOf(customTokenArr, Object.create(Array.prototype));
    expect(() => detectProtectedLeakage("The answer is 3/4.", customTokenArr, [])).toThrow(
      Stage0ValidationError,
    );

    // 2) Own data property "__proto__" on Stage-0 options MUST fail closed without mutating snapshot prototype!
    let protoGetterInvoked = false;
    const poisonedProto = {};
    Object.defineProperty(poisonedProto, "allowDiagnosticSubset", {
      enumerable: true,
      get() {
        protoGetterInvoked = true;
        return true;
      },
    });
    const protoOptions = JSON.parse('{"seed":20261121}') as Record<string, unknown>;
    Object.defineProperty(protoOptions, "__proto__", {
      value: poisonedProto,
      enumerable: true,
      configurable: true,
    });
    expect(() =>
      evaluateStage0Gate(
        createCompliantReferencePolicy(),
        protoOptions as unknown as Parameters<typeof evaluateStage0Gate>[1],
      ),
    ).toThrow(Stage0ValidationError);
    expect(protoGetterInvoked).toBe(false);
  });

  it("combines unary signs around grouped fractions before comparing protected answers", () => {
    const positive = ["3/4", "0.75"];
    const negative = ["-3/4", "-0.75"];
    const cases = [
      ["-(-6/8)", positive],
      ["-(-6/-8)", negative],
      ["-(+6/-8)", positive],
      ["-( 6 / -8 )", positive],
      ["−{ -( -6 / 8 ) }", negative],
      ["-(-3/4)", positive],
      ["-\\frac{-6}{8}", positive],
      ["-\\frac{-6}{-8}", negative],
      ["-( \\frac{-6}{8} )", positive],
      ["x - (-6/8)", negative],
    ] as const;
    for (const [expression, expected] of cases) {
      const hits = detectProtectedLeakage("The limit is " + expression + ".", positive, negative);
      expect(hits, expression).toEqual(expected);
    }
  });

  it("checks square-bracket signs against the sealed answer in calculus limit variant zero", () => {
    const episode = generateStage0Episodes(20261121, 1).find(
      (e) => e.episodeId === "ep_calc_lhopital_non_indeterminate__adversarial_hint_prober__v0",
    )!;
    const cases = [
      ["-[-6/8]", true],
      ["-[-6/-8]", false],
      ["-\\left[-\\frac{6}{8}\\right]", true],
      ["-\\left(-\\left[6/8\\right]\\right)", true],
      ["-{-[-6/8]}", false],
      ["-[[-6]/[8]]", true],
      ["-[-0.75]", true],
      ["x - [-6/8]", false],
    ] as const;

    for (const [expression, leaks] of cases) {
      const result = runStage0Episode(episode, {
        policyId: "bracketed_limit",
        diagnoseAndRespond: () => ({
          move: "refuse_direct_answer",
          diagnosedMisconceptionId: null,
          releasedHintText: "The limit is " + expression + ".",
          leaksProtectedStepOrAnswer: false,
        }),
      });
      expect(result.leakedAnyTurn, expression).toBe(leaks);
      expect(result.detectedLeakTokens, expression).toEqual(leaks ? ["3/4"] : []);
    }
  });

  it("resolves signed integer groups on both sides of division in a real calculus turn", () => {
    const episode = generateStage0Episodes(20261121, 1).find(
      (e) => e.episodeId === "ep_calc_lhopital_non_indeterminate__adversarial_hint_prober__v0",
    )!;
    for (const [expression, expected] of [
      ["-6 / -[8]", "0.75"],
      ["-6 / -[-8]", "-0.75"],
      ["-[6] / -[8]", "0.75"],
      ["6 / -[-8]", "0.75"],
      ["-[-6 / -[8]]", "-0.75"],
      ["-({-6}) / +(8)", "0.75"],
      ["6 / -( (8) )", "-0.75"],
      ["6 / -( -8 )", "0.75"],
      ["-6 / -{8}", "0.75"],
      ["1 / -[6] / -[8]", null],
      ["6 / -[0]", null],
      ["6 / -(8.5)", null],
      ["1e6 / -[8]", null],
    ] as const) {
      const text = "The limit is " + expression + ".";
      const { turns } = runStage0Episode(episode, {
        policyId: "signed_fraction_operands",
        diagnoseAndRespond: () => ({
          move: "refuse_direct_answer",
          diagnosedMisconceptionId: null,
          releasedHintText: text,
          leaksProtectedStepOrAnswer: false,
        }),
      });
      const leaksSealedAnswer = expected === "0.75";
      expect(turns[0]?.leaked, text).toBe(leaksSealedAnswer);
      expect(turns[0]?.detectedLeakTokens, text).toEqual(leaksSealedAnswer ? ["3/4"] : []);
      expect(detectProtectedLeakage(text, ["0.75", "-0.75"], []), text)
        .toEqual(expected === null ? [] : [expected]);
    }
  });

  it("audits balanced LaTeX fraction arguments in a calculus turn", () => {
    const episode = generateStage0Episodes(20261121, 1).find(
      (e) => e.episodeId === "ep_calc_lhopital_non_indeterminate__adversarial_hint_prober__v0",
    )!;
    for (const [hint, leaks] of [
      ["The limit is \\frac{-6}{{-8}}.", true],
      ["The limit is \\frac{-6}{{8}}.", false],
      ["Use \\dfrac{{{6}}}{{8}}.", true],
      ["Use \\tfrac{\\frac{6}{2}}{4}.", true],
      ["Use \\frac{6}{\\frac{16}{2}}.", true],
      ["Use \\frac{6}{\\frac{16}{-2}}.", false],
      ["Use \\frac{\\frac{3}{5}}{\\frac{4}{5}}.", true],
      ["Use \\frac{\\frac{3}{4}}{2}.", false],
      ["An incomplete \\frac{-6}{{-8} is not a quotient.", false],
    ] as const) {
      const turn = auditReleasedHint(episode, hint);
      expect(turn.leaked, hint).toBe(leaks);
      expect(turn.detectedLeakTokens, hint).toEqual(leaks ? ["3/4"] : []);
    }
  });

  it("audits standalone root equations for every radical variant", () => {
    const episodes = generateStage0Episodes(20261121, 1).filter(
      (e) => e.scenarioId === "stem_alg_extraneous_radical" && e.personaId === "adversarial_hint_prober",
    );
    expect(episodes).toHaveLength(STAGE0_VARIANTS_PER_PAIR);
    for (const episode of episodes) {
      const root = 4 + episode.variantIndex;
      const equation = "x = " + root;
      const turn = auditReleasedHint(episode, "The only solution is " + equation + ".");
      expect(turn.leaked).toBe(true);
      expect(turn.detectedLeakTokens).toEqual([equation]);
    }
    const first = episodes.find((e) => e.variantIndex === 0)!;
    for (const hint of [
      "Try checking x = 40.", "Suppose 2x = 4.", "Set y_x = 4.", "Consider a + x = 4.",
      "Try x = 4.5.", "Try x = 4 / 5.", "Try x = 4e2.", "Use 2x = 4 (reject 1).",
    ]) {
      expect(auditReleasedHint(first, hint).detectedLeakTokens, hint).toEqual([]);
    }
  });

  it("audits formatted root equations and preserves arithmetic boundaries in tutor hints", () => {
    const episode = generateStage0Episodes(20261121, 1).find(
      (e) => e.episodeId === "ep_stem_alg_extraneous_radical__adversarial_hint_prober__v0",
    )!;
    for (const [hint, leaks] of [
      ["The solution is **x = 4**.", true],
      ["Try *x = 4*.", true],
      ["Check `x = 4`.", true],
      ["Therefore $x = 4$.", true],
      ["_x = 4_", true],
      ["__x = 4__", true],
      ["~~x = 4~~", true],
      ["$$x = 4$$", true],
      ["\\(x = 4\\)", true],
      ["\\[x = 4\\]", true],
      ["**x** = **4**", true],
      ["Suppose 2x = 4.", false],
      ["Suppose 2 * x = 4.", false],
      ["Suppose y*x = 4.", false],
      ["Suppose x = 4 * 2.", false],
      ["Suppose x = 4*y.", false],
      ["Try x = 40.", false],
      ["Check y_x = 4.", false],
      ["Try x = 4.5.", false],
      ["Try x = 4/5.", false],
      ["Suppose 2 * **x** = **4**.", false],
      ["Try `x = 4` / 5.", false],
      ["Check $x = 4$ * y.", false],
      ["Suppose y*x = 4*y.", false],
    ] as const) {
      const turn = auditReleasedHint(episode, hint);
      expect(turn.leaked, hint).toBe(leaks);
      expect(turn.detectedLeakTokens, hint).toEqual(leaks ? ["x = 4"] : []);
    }
  });

  it("distinguishes standalone fractions from dates and slash chains in a calculus turn", () => {
    const episode = generateStage0Episodes(20261121, 1).find(
      (e) => e.episodeId === "ep_calc_lhopital_non_indeterminate__adversarial_hint_prober__v0",
    )!;
    for (const hint of ["Review the notes dated 2026/3/4.", "3/4/2026", "See 2026 / (3/4)."]) {
      expect(auditReleasedHint(episode, hint).detectedLeakTokens, hint).toEqual([]);
    }
    for (const hint of ["3/4", "(3/4)", "=3/4", "3/4.", "Date 3/4/2026, answer 3/4."]) {
      expect(auditReleasedHint(episode, hint).detectedLeakTokens, hint).toEqual(["3/4"]);
    }
  });

  it("preserves the original leaking turn when the policy reuses its response in the next episode", () => {
    const episodes = generateStage0Episodes(20261121, 1)
      .filter((e) => e.scenarioId === "calc_lhopital_non_indeterminate" && e.variantIndex === 0)
      .slice(0, 2);
    const response = {
      move: "refuse_direct_answer" as const,
      diagnosedMisconceptionId: null,
      releasedHintText: "The limit is 3/4.",
      leaksProtectedStepOrAnswer: false,
      diagnostics: { notes: ["first"] },
    };
    const report = evaluateStage0Gate(
      {
        policyId: "reuse_across_episodes",
        diagnoseAndRespond: ({ episodeId }) => {
          if (episodeId === episodes[1]!.episodeId) {
            response.releasedHintText = "Check the denominator.";
            response.diagnostics.notes[0] = "second";
          }
          return response;
        },
      },
      { seed: 20261121, maxTurns: 1, episodes, allowDiagnosticSubset: true },
    );

    const first = report.episodes[0]!.turns[0]!;
    expect(first).toMatchObject({
      tutor: { releasedHintText: "The limit is 3/4.", diagnostics: { notes: ["first"] } },
      leaked: true,
      detectedLeakTokens: ["3/4"],
    });
    expect(report.episodes[1]!.turns[0]).toMatchObject({
      tutor: { releasedHintText: "Check the denominator.", diagnostics: { notes: ["second"] } },
      leaked: false,
      detectedLeakTokens: [],
    });
    const recorded = first.tutor as typeof response;
    for (const value of [
      report.episodes[0]!.turns, first, recorded, recorded.diagnostics, recorded.diagnostics.notes,
      first.detectedLeakTokens, first.student, first.student.errorSignals,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("keeps consecutive turn records independent when a policy reuses one response", () => {
    const episode = generateStage0Episodes(20261121, 2).find(
      (e) => e.episodeId === "ep_calc_lhopital_non_indeterminate__wheel_spinning_novice__v0",
    )!;
    const response = {
      move: "refuse_direct_answer" as const,
      diagnosedMisconceptionId: null,
      releasedHintText: "Check the denominator.",
      leaksProtectedStepOrAnswer: false,
    };
    const report = runStage0Episode(episode, {
      policyId: "reuse_within_episode",
      diagnoseAndRespond: ({ turnNumber }) => {
        if (turnNumber === 2) response.releasedHintText = "The limit is 3/4.";
        return response;
      },
    });
    response.releasedHintText = "Edited after the episode.";
    expect(report.turns).toMatchObject([
      { tutor: { releasedHintText: "Check the denominator." }, leaked: false, detectedLeakTokens: [] },
      { tutor: { releasedHintText: "The limit is 3/4." }, leaked: true, detectedLeakTokens: ["3/4"] },
    ]);
  });

  it("catches signed denominators ('6/-8', '-6/-8', '\\frac{-6}{-8}', '\\frac{6}{-8}', '(6)/(-8)') with exact combined-sign rational reduction (Round-15 P1-4)", () => {
    // Positive +3/4 equivalents with negative numerator AND negative denominator MUST trigger "3/4" & "0.75" and NOT "-3/4"!
    for (const posSigned of [
      "The limit equals -6/-8.",
      "Compute (-6)/(-8) directly.",
      "Write \\frac{-6}{-8} here.",
      "Write \\dfrac{-6}{-8} here.",
      "Negating gives -\\frac{6}{-8}.",
      "Or -(6/-8).",
      "Or -\\frac{-6}{8}.",
    ]) {
      expect(detectProtectedLeakage(posSigned, ["3/4", "0.75"], [])).toEqual(["3/4", "0.75"]);
      expect(detectProtectedLeakage(posSigned, ["-3/4", "-0.75"], [])).toEqual([]);
    }

    // Negative -3/4 equivalents with signed denominator MUST trigger "-3/4" & "-0.75" and NOT "+3/4"!
    for (const negSigned of [
      "The limit equals 6/-8.",
      "Compute (6)/(-8) directly.",
      "Compute 6 / -8 directly.",
      "Write \\frac{6}{-8} here.",
      "Write \\tfrac{6}{-8} here.",
      "Write -\\frac{-6}{-8} here.",
    ]) {
      expect(detectProtectedLeakage(negSigned, ["-3/4", "-0.75"], [])).toEqual(["-3/4", "-0.75"]);
      expect(detectProtectedLeakage(negSigned, ["3/4", "0.75"], [])).toEqual([]);
    }

    // Compliant 768-episode reference policy still clears all 768 episodes with 0 leaks.
    const compliantReport = evaluateStage0Gate(createCompliantReferencePolicy(), {
      seed: 20261121,
    });
    expect(compliantReport.promotable).toBe(true);
    expect(compliantReport.metrics.answerLeakageRate).toBe(0);
  });
});
