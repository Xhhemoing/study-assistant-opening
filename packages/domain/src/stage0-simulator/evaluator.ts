import {
  DEFAULT_STAGE0_GATE_THRESHOLDS,
  STAGE0_PERSONA_IDS,
  createXoshiro128StarStar,
  type Stage0EpisodeResult,
  type Stage0EpisodeSpec,
  type Stage0EvaluationReport,
  type Stage0FailingWitness,
  type Stage0GateCheck,
  type Stage0GateThresholds,
  type Stage0PersonaBreakdown,
  type Stage0PersonaId,
  type Stage0TurnRecord,
  type Stage0TutorPolicy,
  type Stage0TutorResponse,
  type Stage0TutorTurnInput,
} from "./types";
import {
  STAGE0_DEFAULT_MAX_TURNS,
  STAGE0_DEFAULT_SEED,
  generateStage0Episodes,
} from "./episodes";
import {
  advanceStudentAfterTutorTurn,
  buildInitialStudentUtterance,
  computeDay7TransferProbability,
  createInitialStudentState,
} from "./personas";

function normalizeForLeakScan(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Independently audits released tutor text against protected answer keys and
 * sealed solution steps so leakage cannot be hidden by a false self-report.
 */
export function detectProtectedLeakage(
  releasedHintText: string,
  protectedAnswerTokens: readonly string[],
  protectedStepTokens: readonly string[],
): readonly string[] {
  const normalizedText = normalizeForLeakScan(releasedHintText);
  if (!normalizedText) return [];
  const hits: string[] = [];
  const seen = new Set<string>();
  const allProtected = [...protectedAnswerTokens, ...protectedStepTokens];

  for (const token of allProtected) {
    const normalizedToken = normalizeForLeakScan(token);
    if (!normalizedToken || seen.has(token)) continue;
    if (normalizedText.includes(normalizedToken)) {
      seen.add(token);
      hits.push(token);
    }
  }
  return hits;
}

export function runStage0Episode(
  episode: Stage0EpisodeSpec,
  policy: Stage0TutorPolicy,
): Stage0EpisodeResult {
  const episodeRng = createXoshiro128StarStar(episode.seed);
  let studentState = createInitialStudentState();
  let utterance = buildInitialStudentUtterance(episode, episodeRng);

  const turns: Stage0TurnRecord[] = [];
  const leakedTokensSet = new Set<string>();
  let localizedTurn: number | null = null;
  let falseMisconceptionAttributed = false;

  for (let turnNumber = 1; turnNumber <= episode.maxTurns; turnNumber += 1) {
    const turnInput: Stage0TutorTurnInput = {
      episodeId: episode.episodeId,
      turnNumber,
      maxTurns: episode.maxTurns,
      domain: episode.domain,
      conceptId: episode.conceptId,
      itemFamilyId: episode.itemFamilyId,
      prompt: episode.prompt,
      studentUtterance: utterance,
      history: turns,
      candidateMisconceptions: episode.candidateMisconceptions,
      clarificationCue: episode.scenario.clarificationCue,
      analogCue: episode.variant.analogCue,
      sealedSolutionRef: {
        protectedAnswerTokens: episode.protectedAnswerTokens,
        protectedStepTokens: episode.protectedStepTokens,
      },
    };

    const tutorResponse = policy.diagnoseAndRespond(turnInput);
    const detectedLeakTokens = detectProtectedLeakage(
      tutorResponse.releasedHintText,
      episode.protectedAnswerTokens,
      episode.protectedStepTokens,
    );
    const leaked = tutorResponse.leaksProtectedStepOrAnswer || detectedLeakTokens.length > 0;
    for (const token of detectedLeakTokens) {
      leakedTokensSet.add(token);
    }

    const attributedPersistent =
      tutorResponse.attributedPersistentMisconception ?? tutorResponse.diagnosedMisconceptionId !== null;

    const localizedTarget =
      episode.groundTruthMisconceptionId !== null &&
      tutorResponse.diagnosedMisconceptionId === episode.groundTruthMisconceptionId;

    if (localizedTarget && localizedTurn === null) {
      localizedTurn = turnNumber;
    }

    const falseMisconception =
      attributedPersistent &&
      (episode.isCarelessSlip || (episode.isAmbiguousNotation && !utterance.notationClarified));

    if (falseMisconception) {
      falseMisconceptionAttributed = true;
    }

    turns.push({
      turnNumber,
      student: utterance,
      tutor: tutorResponse,
      detectedLeakTokens,
      leaked,
      localizedTargetMisconception: localizedTarget,
      falseMisconceptionAttribution: falseMisconception,
    });

    const transition = advanceStudentAfterTutorTurn({
      episode,
      state: studentState,
      turnNumber,
      tutorResponse,
      leaked,
      localizedTarget,
      falseMisconception,
      rng: episodeRng,
    });
    studentState = transition.nextState;

    if (!transition.shouldContinue || !transition.nextUtterance) {
      break;
    }
    utterance = transition.nextUtterance;
  }

  const leakCount = turns.filter((t) => t.leaked).length;
  const leakedAnyTurn = leakCount > 0;

  const transferRng = episodeRng.fork("day7_transfer_probe");
  const retentionProbability = computeDay7TransferProbability(episode, studentState);
  const transferPassed = episode.remediationTarget
    ? transferRng.nextFloat() < retentionProbability
    : null;

  return {
    episodeId: episode.episodeId,
    index: episode.index,
    scenarioId: episode.scenarioId,
    domain: episode.domain,
    conceptId: episode.conceptId,
    personaId: episode.personaId,
    variantIndex: episode.variantIndex,
    turns,
    totalTurns: turns.length,
    resolved: studentState.resolved,
    remediated: studentState.remediated,
    leakedAnyTurn,
    leakCount,
    detectedLeakTokens: [...leakedTokensSet],
    groundTruthMisconceptionId: episode.groundTruthMisconceptionId,
    localizedWithinTwoTurns:
      episode.groundTruthMisconceptionId !== null
        ? localizedTurn !== null && localizedTurn <= 2
        : null,
    localizedTurn,
    falseMisconceptionAttributed,
    day7Transfer: {
      eligible: episode.remediationTarget,
      freshTransferFamilyId: episode.freshTransferFamilyId,
      delayDays: 7,
      retentionProbability,
      passed: transferPassed,
    },
  };
}

export interface EvaluateStage0Options {
  readonly seed?: number;
  readonly maxTurns?: number;
  readonly episodes?: readonly Stage0EpisodeSpec[];
  readonly thresholds?: Partial<Stage0GateThresholds>;
}

export function evaluateStage0Gate(
  policy: Stage0TutorPolicy,
  options: EvaluateStage0Options = {},
): Stage0EvaluationReport {
  const seed = options.seed ?? STAGE0_DEFAULT_SEED;
  const maxTurns = options.maxTurns ?? STAGE0_DEFAULT_MAX_TURNS;
  const thresholds: Stage0GateThresholds = {
    ...DEFAULT_STAGE0_GATE_THRESHOLDS,
    ...options.thresholds,
  };
  const episodeSpecs = options.episodes ?? generateStage0Episodes(seed, maxTurns);
  const results = episodeSpecs.map((spec) => runStage0Episode(spec, policy));

  const totalEpisodes = results.length;
  const leakedEpisodes = results.filter((r) => r.leakedAnyTurn);
  const answerLeakageRate = totalEpisodes > 0 ? leakedEpisodes.length / totalEpisodes : 0;

  const misconceptionEpisodes = results.filter((r) => r.groundTruthMisconceptionId !== null);
  const localizedWithinTwo = misconceptionEpisodes.filter((r) => r.localizedWithinTwoTurns === true);
  const missedLocalization = misconceptionEpisodes.filter((r) => r.localizedWithinTwoTurns !== true);
  const twoTurnMisconceptionRecall =
    misconceptionEpisodes.length > 0 ? localizedWithinTwo.length / misconceptionEpisodes.length : 1;

  const slipAndAmbiguityEpisodes = results.filter(
    (r) => r.personaId === "careless_transcription_slip" || r.personaId === "ambiguous_notation",
  );
  const falseAttributionEpisodes = slipAndAmbiguityEpisodes.filter((r) => r.falseMisconceptionAttributed);
  const slipFalseMisconceptionRate =
    slipAndAmbiguityEpisodes.length > 0
      ? falseAttributionEpisodes.length / slipAndAmbiguityEpisodes.length
      : 0;

  const transferEligible = results.filter((r) => r.day7Transfer.eligible);
  const transferPassed = transferEligible.filter((r) => r.day7Transfer.passed === true);
  const transferFailed = transferEligible.filter((r) => r.day7Transfer.passed !== true);
  const sevenDayTransferPassRate =
    transferEligible.length > 0 ? transferPassed.length / transferEligible.length : 1;

  const gates: Stage0GateCheck[] = [
    {
      gateId: "answer_leakage",
      passed: answerLeakageRate <= thresholds.maxAnswerLeakageRate,
      actual: answerLeakageRate,
      threshold: thresholds.maxAnswerLeakageRate,
      comparator: "<=",
      numerator: leakedEpisodes.length,
      denominator: totalEpisodes,
      failingEpisodeIds: leakedEpisodes.map((r) => r.episodeId),
    },
    {
      gateId: "two_turn_misconception_recall",
      passed: twoTurnMisconceptionRecall >= thresholds.minTwoTurnMisconceptionRecall,
      actual: twoTurnMisconceptionRecall,
      threshold: thresholds.minTwoTurnMisconceptionRecall,
      comparator: ">=",
      numerator: localizedWithinTwo.length,
      denominator: misconceptionEpisodes.length,
      failingEpisodeIds: missedLocalization.map((r) => r.episodeId),
    },
    {
      gateId: "slip_false_misconception",
      passed: slipFalseMisconceptionRate <= thresholds.maxSlipFalseMisconceptionRate,
      actual: slipFalseMisconceptionRate,
      threshold: thresholds.maxSlipFalseMisconceptionRate,
      comparator: "<=",
      numerator: falseAttributionEpisodes.length,
      denominator: slipAndAmbiguityEpisodes.length,
      failingEpisodeIds: falseAttributionEpisodes.map((r) => r.episodeId),
    },
    {
      gateId: "seven_day_transfer",
      passed: sevenDayTransferPassRate >= thresholds.minSevenDayTransferPassRate,
      actual: sevenDayTransferPassRate,
      threshold: thresholds.minSevenDayTransferPassRate,
      comparator: ">=",
      numerator: transferPassed.length,
      denominator: transferEligible.length,
      failingEpisodeIds: transferFailed.map((r) => r.episodeId),
    },
  ];

  const failingWitnesses: Stage0FailingWitness[] = [];
  for (const r of leakedEpisodes) {
    const leakTurn = r.turns.find((t) => t.leaked);
    failingWitnesses.push({
      gateId: "answer_leakage",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: leakTurn?.turnNumber ?? null,
      reason: `Protected step/answer leaked on turn ${leakTurn?.turnNumber ?? "?"}`,
      detectedLeakTokens: r.detectedLeakTokens,
    });
  }
  for (const r of missedLocalization) {
    failingWitnesses.push({
      gateId: "two_turn_misconception_recall",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: r.localizedTurn,
      reason: `Expected misconception ${r.groundTruthMisconceptionId} within <=2 turns; localizedTurn=${r.localizedTurn ?? "none"}`,
      detectedLeakTokens: [],
    });
  }
  for (const r of falseAttributionEpisodes) {
    const badTurn = r.turns.find((t) => t.falseMisconceptionAttribution);
    failingWitnesses.push({
      gateId: "slip_false_misconception",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: badTurn?.turnNumber ?? null,
      reason: `Attributed persistent misconception (${badTurn?.tutor.diagnosedMisconceptionId ?? "unknown"}) on ${r.personaId}`,
      detectedLeakTokens: [],
    });
  }
  if (sevenDayTransferPassRate < thresholds.minSevenDayTransferPassRate) {
    for (const r of transferFailed) {
      failingWitnesses.push({
        gateId: "seven_day_transfer",
        episodeId: r.episodeId,
        scenarioId: r.scenarioId,
        personaId: r.personaId,
        variantIndex: r.variantIndex,
        turnNumber: null,
        reason: `Failed Day-7 fresh-family transfer probe (${r.day7Transfer.freshTransferFamilyId}, p=${r.day7Transfer.retentionProbability.toFixed(2)})`,
        detectedLeakTokens: r.detectedLeakTokens,
      });
    }
  }

  const personaBreakdownEntries = STAGE0_PERSONA_IDS.map((personaId) => {
    const slice = results.filter((r) => r.personaId === personaId);
    const count = slice.length;
    const leakedCount = slice.filter((r) => r.leakedAnyTurn).length;
    const resolvedCount = slice.filter((r) => r.resolved).length;
    const remediatedCount = slice.filter((r) => r.remediated).length;
    const avgTurns = count > 0 ? slice.reduce((acc, r) => acc + r.totalTurns, 0) / count : 0;

    const recallSlice = slice.filter((r) => r.localizedWithinTwoTurns !== null);
    const twoTurnRecallRate =
      recallSlice.length > 0
        ? recallSlice.filter((r) => r.localizedWithinTwoTurns === true).length / recallSlice.length
        : null;

    const falseMiscEligible =
      personaId === "careless_transcription_slip" || personaId === "ambiguous_notation";
    const falseMisconceptionRate =
      falseMiscEligible && count > 0
        ? slice.filter((r) => r.falseMisconceptionAttributed).length / count
        : null;

    const transferSlice = slice.filter((r) => r.day7Transfer.eligible);
    const day7TransferPassRate =
      transferSlice.length > 0
        ? transferSlice.filter((r) => r.day7Transfer.passed === true).length / transferSlice.length
        : null;

    const breakdown: Stage0PersonaBreakdown = {
      personaId,
      episodeCount: count,
      leakedEpisodeCount: leakedCount,
      resolvedCount,
      remediatedCount,
      avgTurns,
      twoTurnRecallRate,
      falseMisconceptionRate,
      day7TransferPassRate,
    };
    return [personaId, breakdown] as const;
  });

  const personaBreakdown = Object.fromEntries(personaBreakdownEntries) as Record<
    Stage0PersonaId,
    Stage0PersonaBreakdown
  >;

  return {
    policyId: policy.policyId,
    seed,
    totalEpisodes,
    passed: gates.every((g) => g.passed),
    thresholds,
    metrics: {
      answerLeakageRate,
      leakedEpisodeCount: leakedEpisodes.length,
      twoTurnMisconceptionRecall,
      twoTurnRecallNumerator: localizedWithinTwo.length,
      twoTurnRecallDenominator: misconceptionEpisodes.length,
      slipFalseMisconceptionRate,
      slipFalseMisconceptionNumerator: falseAttributionEpisodes.length,
      slipFalseMisconceptionDenominator: slipAndAmbiguityEpisodes.length,
      sevenDayTransferPassRate,
      sevenDayTransferNumerator: transferPassed.length,
      sevenDayTransferDenominator: transferEligible.length,
    },
    gates,
    failingWitnesses,
    personaBreakdown,
    episodes: results,
  };
}

/**
 * Compliant reference Stage-0 tutor policy.
 * Observes strictly `turnInput` (never hidden persona ground truth) and enforces:
 * 1) zero leakage of sealed answers/steps,
 * 2) notation clarification before misconception attribution,
 * 3) lightweight slip checks without false misconception attribution,
 * 4) fast <=2-turn root-cause misconception diagnosis + premise scaffolding,
 * 5) non-leaky analog scaffolding for wheel-spinning novices.
 */
export function createCompliantReferencePolicy(
  policyId = "stage0_compliant_reference_v1",
): Stage0TutorPolicy {
  return {
    policyId,
    description: "Reference zero-leak Socratic diagnostic policy obeying all 4 Stage-0 gates.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);

      if (
        signals.has("adversarial_hint_probe") ||
        signals.has("direct_answer_request") ||
        signals.has("authority_spoof_attempt") ||
        signals.has("binary_search_probe")
      ) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "refuse_direct_answer",
          releasedHintText:
            "I cannot reveal the sealed answer or solution steps. Share your first reasoning step or check what premise must hold before simplifying.",
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("ambiguous_notation_unclarified") && !turnInput.studentUtterance.notationClarified) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "clarify_notation",
          releasedHintText: `Before evaluating your step, let us clarify the notation: ${turnInput.clarificationCue}`,
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("careless_transcription_slip")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "check_transcription",
          releasedHintText:
            "Your conceptual premise looks right! Double-check the arithmetic, sign, or copied symbol on your final line.",
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("sound_derivation")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "confirm_mastery",
          releasedHintText:
            "Your reasoning respects the required domain/premise conditions cleanly. Well done!",
          leaksProtectedStepOrAnswer: false,
        };
      }

      for (const candidate of turnInput.candidateMisconceptions) {
        if (signals.has(candidate.canonicalErrorSignal)) {
          const isFollowupTurn = turnInput.turnNumber >= 2;
          return {
            diagnosedMisconceptionId: candidate.misconceptionId,
            attributedPersistentMisconception: true,
            move: isFollowupTurn ? "targeted_scaffold" : "diagnostic_probe",
            releasedHintText: isFollowupTurn
              ? `Focus directly on the missing condition (${candidate.missingPremise}) and rebuild that branch step by step.`
              : `Pause on that transformation: what premise (${candidate.missingPremise}) needs to be verified before applying that step?`,
            leaksProtectedStepOrAnswer: false,
          };
        }
      }

      if (signals.has("wheel_spinning") || signals.has("stuck_no_strategy")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "worked_analog_step",
          releasedHintText: `Let us step back to a smaller analog first: ${turnInput.analogCue}`,
          leaksProtectedStepOrAnswer: false,
        };
      }

      return {
        diagnosedMisconceptionId: null,
        attributedPersistentMisconception: false,
        move: "diagnostic_probe",
        releasedHintText:
          "Explain the premise justifying your current step so we can test whether every edge case is covered.",
        leaksProtectedStepOrAnswer: false,
      };
    },
  };
}

/** Leaky baseline policy: folds under adversarial probing and reveals sealed answer tokens. */
export function createLeakyBaselinePolicy(
  policyId = "stage0_leaky_baseline_v1",
): Stage0TutorPolicy {
  const base = createCompliantReferencePolicy(policyId);
  return {
    policyId,
    description: "Baseline policy that leaks sealed answers when probed or pressed.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      if (signals.has("adversarial_hint_probe") || signals.has("wheel_spinning")) {
        const leakedToken =
          turnInput.sealedSolutionRef.protectedAnswerTokens[0] ??
          turnInput.sealedSolutionRef.protectedStepTokens[0] ??
          "SEALED_ANSWER";
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "reveal_answer",
          releasedHintText: `Sure, to save time here is the final answer: ${leakedToken}`,
          leaksProtectedStepOrAnswer: false, // Deliberately false to verify independent scanner catches it!
        };
      }
      return base.diagnoseAndRespond(turnInput);
    },
  };
}

/** Over-eager misconception policy: misattributes persistent misconceptions on slips and ambiguous notation. */
export function createOverEagerMisconceptionPolicy(
  policyId = "stage0_over_eager_misconception_v1",
): Stage0TutorPolicy {
  const base = createCompliantReferencePolicy(policyId);
  return {
    policyId,
    description: "Baseline policy that skips notation clarification and penalizes careless slips as persistent misconceptions.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      const primaryMisconception = turnInput.candidateMisconceptions[0]?.misconceptionId ?? null;
      if (
        (signals.has("careless_transcription_slip") || signals.has("ambiguous_notation_unclarified")) &&
        primaryMisconception !== null
      ) {
        return {
          diagnosedMisconceptionId: primaryMisconception,
          attributedPersistentMisconception: true,
          move: "targeted_scaffold",
          releasedHintText: "You have a persistent conceptual misconception here; re-learn the rule from scratch.",
          leaksProtectedStepOrAnswer: false,
        };
      }
      return base.diagnoseAndRespond(turnInput);
    },
  };
}

/** Slow generic policy: offers vague encouragement without diagnosing misconceptions within 2 turns. */
export function createSlowGenericPolicy(
  policyId = "stage0_slow_generic_v1",
): Stage0TutorPolicy {
  return {
    policyId,
    description: "Generic non-diagnostic policy that misses <=2-turn misconception recall and remediation transfer.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      if (signals.has("adversarial_hint_probe")) {
        return {
          diagnosedMisconceptionId: null,
          move: "refuse_direct_answer",
          releasedHintText: "Keep trying on your own without direct answers.",
          leaksProtectedStepOrAnswer: false,
        };
      }
      return {
        diagnosedMisconceptionId: null,
        move: "diagnostic_probe",
        releasedHintText: "Take another look at the problem and try again carefully.",
        leaksProtectedStepOrAnswer: false,
      };
    },
  };
}
