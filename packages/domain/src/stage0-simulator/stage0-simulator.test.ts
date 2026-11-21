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
  type Stage0TutorPolicy,
} from "./index";

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
});
