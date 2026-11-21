import {
  confidenceToProbability,
  type ConfidenceRouteDecision,
  type ConfidenceRouteInput,
  type MetacognitiveRoute,
  type PedagogicalDirective,
} from "./types";

function buildDirective(
  overrides: Partial<PedagogicalDirective>,
  acknowledgeValidIntermediateSteps: boolean,
): PedagogicalDirective {
  return Object.freeze({
    includeMinimalCounterexample: overrides.includeMinimalCounterexample ?? false,
    includeImmediateMicroCheck: overrides.includeImmediateMicroCheck ?? false,
    includeFadedWorkedExample: overrides.includeFadedWorkedExample ?? false,
    singleFadedCompletionSlot: overrides.singleFadedCompletionSlot ?? false,
    includeSocraticSubgoalSplit: overrides.includeSocraticSubgoalSplit ?? false,
    requireJustificationProbe: overrides.requireJustificationProbe ?? false,
    requireIndependentTransferCheck: overrides.requireIndependentTransferCheck ?? false,
    acknowledgeValidIntermediateSteps,
  });
}

/**
 * Deterministic 3-state metacognitive confidence calibration & hypercorrection router.
 *
 * Routes learner submissions based on pre-answer confidence (`guessing`, `unsure`, `sure`),
 * outcome correctness, assistance status, and productive intermediate derivation steps:
 * - `sure` + wrong -> `hypercorrection_counterexample` (minimal concrete counterexample + micro-check)
 * - `guessing` + wrong -> `faded_worked_example` (structured worked steps + single faded slot)
 * - `unsure` + wrong -> `targeted_subgoal_cue` (Socratic cue / subgoal split)
 * - `guessing` + correct (unassisted) -> `lucky_guess_verification_probe` (no false mastery advance)
 * - `sure` / `unsure` + correct (unassisted) -> `calibrated_advance`
 * - any confidence + correct (assisted) -> `assisted_consolidation_check` (requires independent recheck)
 *
 * Productive Failure Interruption:
 * Whenever `hasValidIntermediateSteps === true` on an incorrect/incomplete attempt,
 * the frustration failure streak resets (`effectiveFrustrationStreak = 0`,
 * `productiveFailureRecognized = true`) so productive exploration is never misclassified
 * as wheel-spinning.
 */
export function routeMetacognitiveConfidence(
  input: ConfidenceRouteInput,
): ConfidenceRouteDecision {
  const confidenceProbability = confidenceToProbability(input.preAnswerConfidence);

  if (
    !Number.isInteger(input.priorConsecutiveErrors) ||
    input.priorConsecutiveErrors < 0
  ) {
    throw new RangeError(
      `priorConsecutiveErrors must be a non-negative integer, received: ${String(input.priorConsecutiveErrors)}`,
    );
  }

  const {
    preAnswerConfidence,
    isCorrect,
    hasValidIntermediateSteps,
    priorConsecutiveErrors,
    assisted,
  } = input;

  const calibrationEligible = !assisted;

  if (!isCorrect) {
    const productiveFailureRecognized = hasValidIntermediateSteps;
    const effectiveFrustrationStreak = productiveFailureRecognized
      ? 0
      : priorConsecutiveErrors + 1;

    let route: MetacognitiveRoute;
    let directive: PedagogicalDirective;
    let rationaleCode: string;
    let flagsOverconfidentMisconception = false;

    if (preAnswerConfidence === "sure") {
      route = "hypercorrection_counterexample";
      flagsOverconfidentMisconception = true;
      directive = buildDirective(
        {
          includeMinimalCounterexample: true,
          includeImmediateMicroCheck: true,
        },
        hasValidIntermediateSteps,
      );
      rationaleCode = productiveFailureRecognized
        ? "hypercorrection_with_productive_steps"
        : "hypercorrection_overconfident_error";
    } else if (preAnswerConfidence === "guessing") {
      route = "faded_worked_example";
      directive = buildDirective(
        {
          includeFadedWorkedExample: true,
          singleFadedCompletionSlot: true,
        },
        hasValidIntermediateSteps,
      );
      rationaleCode = productiveFailureRecognized
        ? "faded_worked_example_with_productive_steps"
        : "faded_worked_example_low_confidence_error";
    } else {
      route = "targeted_subgoal_cue";
      directive = buildDirective(
        {
          includeSocraticSubgoalSplit: true,
        },
        hasValidIntermediateSteps,
      );
      rationaleCode = productiveFailureRecognized
        ? "targeted_subgoal_cue_with_productive_steps"
        : "targeted_subgoal_cue_moderate_confidence_error";
    }

    return Object.freeze({
      schemaVersion: 1,
      route,
      preAnswerConfidence,
      confidenceProbability,
      isCorrect: false,
      assisted,
      calibrationEligible,
      allowMasteryAdvance: false,
      flagsLuckyGuess: false,
      flagsOverconfidentMisconception,
      productiveFailureRecognized,
      effectiveFrustrationStreak,
      directive,
      rationaleCode,
    });
  }

  // Correct outcome: breaks frustration streak; route depends on assistance & confidence.
  if (assisted) {
    return Object.freeze({
      schemaVersion: 1,
      route: "assisted_consolidation_check",
      preAnswerConfidence,
      confidenceProbability,
      isCorrect: true,
      assisted: true,
      calibrationEligible: false,
      allowMasteryAdvance: false,
      flagsLuckyGuess: false,
      flagsOverconfidentMisconception: false,
      productiveFailureRecognized: false,
      effectiveFrustrationStreak: 0,
      directive: buildDirective(
        { requireIndependentTransferCheck: true },
        hasValidIntermediateSteps,
      ),
      rationaleCode: "assisted_correct_requires_independent_check",
    });
  }

  if (preAnswerConfidence === "guessing") {
    return Object.freeze({
      schemaVersion: 1,
      route: "lucky_guess_verification_probe",
      preAnswerConfidence,
      confidenceProbability,
      isCorrect: true,
      assisted: false,
      calibrationEligible: true,
      allowMasteryAdvance: false,
      flagsLuckyGuess: true,
      flagsOverconfidentMisconception: false,
      productiveFailureRecognized: false,
      effectiveFrustrationStreak: 0,
      directive: buildDirective(
        { requireJustificationProbe: true },
        hasValidIntermediateSteps,
      ),
      rationaleCode: "lucky_guess_justification_probe",
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    route: "calibrated_advance",
    preAnswerConfidence,
    confidenceProbability,
    isCorrect: true,
    assisted: false,
    calibrationEligible: true,
    allowMasteryAdvance: true,
    flagsLuckyGuess: false,
    flagsOverconfidentMisconception: false,
    productiveFailureRecognized: false,
    effectiveFrustrationStreak: 0,
    directive: buildDirective({}, hasValidIntermediateSteps),
    rationaleCode:
      preAnswerConfidence === "sure"
        ? "calibrated_high_confidence_advance"
        : "calibrated_moderate_confidence_advance",
  });
}
