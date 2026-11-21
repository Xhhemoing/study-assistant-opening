import {
  PURE_CONTAMINATED_GUIDANCE,
  PURE_COOLDOWN_GUIDANCE,
  PURE_MAX_LEAKAGE_BITS,
  fixedPureGuidance,
  type MinEntropyBudget,
} from "./min-entropy-budget";
import { pureBudgetScope } from "./budget-isolation";
import type {
  LearnerStep,
  MovePlan,
  PublicTeachingBlock,
  PublicTeachingCaps,
  TutorGraphInput,
  TutorGraphResult,
  VerifyOutput,
} from "./types";
export * from "./types";
export * from "./min-entropy-budget";

function isStopped(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function collectStructuredStrings(value: unknown, out: string[], seen = new Set<unknown>(), depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return true;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    out.push(String(value));
    return true;
  }
  if (typeof value !== "object") return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!collectStructuredStrings(item, out, seen, depth + 1)) return false;
    }
    return true;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 0) out.push(key);
    if (!collectStructuredStrings(entry, out, seen, depth + 1)) return false;
  }
  return true;
}

function extractSubmissionCandidateSteps(submission: unknown): LearnerStep[] {
  if (typeof submission !== "object" || submission === null || Array.isArray(submission)) return [];
  const rawSteps = (submission as { steps?: unknown }).steps;
  if (!Array.isArray(rawSteps)) return [];
  const out: LearnerStep[] = [];
  for (let idx = 0; idx < rawSteps.length; idx++) {
    const item = rawSteps[idx];
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const step = item as Record<string, unknown>;
    const id = typeof step.id === "string" || typeof step.id === "number" ? String(step.id) : `s${idx + 1}`;
    const text =
      typeof step.text === "string"
        ? step.text
        : typeof step.expression === "string"
          ? step.expression
          : typeof step.claim === "string"
            ? step.claim
            : "";
    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn.map((dep) => String(dep)) : undefined;
    out.push({
      id,
      text,
      status: "unknown",
      ...(dependsOn ? { dependsOn } : {}),
    });
  }
  return out;
}

function projectLearnerStep(
  step: LearnerStep,
  overrideStatus?: LearnerStep["status"],
  overrideError?: string | null,
): LearnerStep {
  const error = overrideError === null ? undefined : (overrideError ?? step.error);
  return {
    id: String(step.id),
    text: String(step.text),
    status: overrideStatus ?? step.status,
    ...(error !== undefined ? { error: String(error) } : {}),
    ...(Array.isArray(step.dependsOn) ? { dependsOn: step.dependsOn.map((dep) => String(dep)) } : {}),
  };
}

function projectRuleWitnessParams(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (input.origin === "rules") out.origin = "rules";
  if (Array.isArray(input.allowedActions)) out.allowedActions = [];
  if (typeof input.title === "string") out.title = input.title;
  if (typeof input.explanation === "string") out.explanation = input.explanation;
  if (Array.isArray(input.points)) {
    out.points = input.points.flatMap((point) => {
      if (typeof point !== "object" || point === null || Array.isArray(point)) return [];
      const p = point as Record<string, unknown>;
      return [
        {
          ...(typeof p.x === "string" ? { x: p.x } : {}),
          ...(typeof p.student === "string" ? { student: p.student } : {}),
          ...(typeof p.reference === "string" ? { reference: p.reference } : {}),
          ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
        },
      ];
    });
  }
  if (Array.isArray(input.pivots)) {
    out.pivots = input.pivots.flatMap((pivot) => {
      if (typeof pivot !== "object" || pivot === null || Array.isArray(pivot)) return [];
      const pv = pivot as Record<string, unknown>;
      return [
        {
          ...(typeof pv.step === "number" ? { step: pv.step } : {}),
          ...(typeof pv.operation === "string" ? { operation: pv.operation } : {}),
          ...(Array.isArray(pv.matrix)
            ? {
                matrix: pv.matrix.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell)) : [])),
              }
            : {}),
        },
      ];
    });
  }
  if (Array.isArray(input.dependency)) out.dependency = input.dependency.map((item) => String(item));
  const projectNodes = (list: unknown) =>
    Array.isArray(list)
      ? list.flatMap((node) => {
          if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
          const n = node as Record<string, unknown>;
          return [
            {
              ...(typeof n.id === "string" ? { id: n.id } : {}),
              ...(n.next === null || typeof n.next === "string" ? { next: n.next } : {}),
            },
          ];
        })
      : undefined;
  const before = projectNodes(input.before);
  if (before) out.before = before;
  const after = projectNodes(input.after);
  if (after) out.after = after;
  if (Array.isArray(input.severed)) out.severed = input.severed.map((item) => String(item));
  if (Array.isArray(input.dangling)) out.dangling = input.dangling.map((item) => String(item));
  return out;
}

function projectRuleWitness(witness: VerifyOutput["ruleWitness"]): { capability: string; params: Record<string, unknown> } | undefined {
  if (!witness || typeof witness !== "object") return undefined;
  return {
    capability: String(witness.capability),
    params: projectRuleWitnessParams(witness.params),
  };
}

function propagateSteps(steps: readonly LearnerStep[], firstError?: VerifyOutput["firstError"]): LearnerStep[] {
  if (!firstError) return steps.map((step) => projectLearnerStep(step));
  let seen = false;
  return steps.map((step) => {
    if (step.id === firstError.stepId) {
      seen = true;
      return projectLearnerStep(step, "invalid", firstError.message);
    }
    if (seen && step.status !== "unknown") {
      return projectLearnerStep(step, "dependent", null);
    }
    return projectLearnerStep(step);
  });
}

function chooseMove(error?: VerifyOutput["firstError"]): MovePlan {
  const kind = error?.kind.toLowerCase() ?? "";
  const move = kind.includes("notation")
    ? "clarify_notation"
    : kind.includes("counterexample") || kind.includes("domain")
      ? "local_counterexample"
      : kind.includes("dependent") || kind.includes("pointer")
        ? "split_subgoal"
        : kind.includes("proof") || kind.includes("justif")
          ? "ask_justification"
          : error
            ? "concept_cue"
            : "invite_next_step";
  return {
    move,
    targetStepId: error?.stepId,
    rationale: error ? `聚焦首个可验证差错 ${error.stepId}` : "保持下一步由学习者完成",
  };
}

function questionFor(move: MovePlan, error?: VerifyOutput["firstError"]): string {
  if (!error) return "你会如何写出下一步，并说明依据？";
  switch (move.move) {
    case "clarify_notation":
      return `在步骤 ${error.stepId} 中，每个符号的定义域是什么？`;
    case "ask_justification":
      return `步骤 ${error.stepId} 使用这条规则的前提条件是什么？`;
    case "local_counterexample":
      return `能找一个只改变步骤 ${error.stepId} 前提就会暴露问题的具体反例吗？`;
    case "split_subgoal":
      return `先只检查步骤 ${error.stepId}，下一步需要验证哪个局部目标？`;
    case "concept_cue":
      return `回到步骤 ${error.stepId}，哪一个概念可以帮助你重新检查它？`;
    default:
      return "你愿意先写出下一步，并说明依据吗？";
  }
}

const PURE_SAFE_CONSERVATIVE_PROMPT = "请先复查本题条件与已有步骤的推导依据，你会先检查哪一步？";

function toPublicCaps(
  questionStem: string,
  steps: readonly LearnerStep[],
  verification: VerifyOutput,
  options: { coarsened?: boolean; allVerifiedValid?: boolean } = {},
): PublicTeachingCaps {
  const projectedSteps = steps.map((step) => projectLearnerStep(step));
  if (options.coarsened) {
    const allValid = Boolean(options.allVerifiedValid);
    const movePlan: MovePlan = {
      move: allValid ? "invite_next_step" : "concept_cue",
      rationale: allValid ? "保持下一步由学习者完成" : "请先整体复查关键条件与每一步推导依据",
    };
    const text = allValid
      ? "你愿意先写出下一步，并说明依据吗？"
      : PURE_SAFE_CONSERVATIVE_PROMPT;
    return {
      questionStem: String(questionStem),
      learnerSteps: projectedSteps,
      movePlan,
      publicBlocks: [{ kind: "question", text }],
    };
  }
  const rawPlan = chooseMove(verification.firstError);
  const movePlan: MovePlan = {
    move: rawPlan.move,
    ...(rawPlan.targetStepId !== undefined ? { targetStepId: String(rawPlan.targetStepId) } : {}),
    rationale: String(rawPlan.rationale),
  };
  const blocks: PublicTeachingBlock[] = [{ kind: "question", text: questionFor(movePlan, verification.firstError) }];
  const projectedWitness = projectRuleWitness(verification.ruleWitness);
  if (projectedWitness) {
    blocks.push({
      kind: "rule_witness",
      text: "规则见证卡可用于检查局部条件。",
      descriptor: projectedWitness,
    });
  }
  return {
    questionStem: String(questionStem),
    learnerSteps: projectedSteps,
    movePlan,
    publicBlocks: blocks,
  };
}

function guardRelease(
  caps: PublicTeachingCaps,
  verification: VerifyOutput,
  release: TutorGraphInput["releaseCaps"],
): string | undefined {
  release.assertCurrent();
  if (isStopped(release.stopSignal)) return undefined;
  const blocker = release.answerLeakageBlocker;
  if (typeof blocker !== "function") return undefined;
  const proseText = [caps.questionStem, ...caps.publicBlocks.map((block) => block.text)].join("\n");
  if (blocker(proseText)) return undefined;

  const structuredValues: string[] = [];
  if (!collectStructuredStrings(caps, structuredValues) || !collectStructuredStrings(verification, structuredValues)) {
    return undefined;
  }
  if (structuredValues.some((entry) => blocker(entry))) return undefined;
  if (structuredValues.length > 0 && blocker([proseText, ...structuredValues].join("\n"))) return undefined;
  return proseText;
}

function blockedByBudgetResult(
  budget: MinEntropyBudget,
  reason: "cooldown" | "budget_contaminated" | "budget_exhausted",
): TutorGraphResult {
  const isCooldown = reason === "cooldown";
  return {
    state: isCooldown ? "cooldown" : "budget_contaminated",
    providerCalls: 0,
    verification: { steps: [] },
    releasedText: isCooldown ? PURE_COOLDOWN_GUIDANCE : PURE_CONTAMINATED_GUIDANCE,
    leakageBits: budget.leakageBits,
    helpState: budget.state,
    cooldownUntilMs: budget.cooldownUntilMs,
    releaseApproved: false,
    reason,
  };
}

function withheldReleaseResult(
  budget: MinEntropyBudget,
  reason: "cancelled" | "release_guard_rejected",
): TutorGraphResult {
  return {
    state: reason === "cancelled" ? "stopped" : "unverified",
    providerCalls: 0,
    verification: { steps: [] },
    leakageBits: budget.leakageBits,
    helpState: budget.state,
    cooldownUntilMs: budget.cooldownUntilMs,
    releaseApproved: false,
    reason,
  };
}

type PureFallbackChoice =
  | { kind: "approved"; caps: PublicTeachingCaps; text: string }
  | { kind: "stopped" }
  | { kind: "rejected" };

function selectVerifiedPureFallback(
  questionStem: string,
  releaseCaps: TutorGraphInput["releaseCaps"],
  verifyStopSignal?: AbortSignal,
): PureFallbackChoice {
  const neutralPrompts = [
    { text: PURE_SAFE_CONSERVATIVE_PROMPT, rationale: "请先整体复查关键条件与每一步推导依据" },
    { text: "Attempt recorded.", rationale: "Attempt recorded." },
    { text: "Step recorded.", rationale: "Step recorded." },
  ];
  const verification: VerifyOutput = { steps: [] };
  const candidates: Array<{ caps: PublicTeachingCaps; standaloneText?: string }> = neutralPrompts.map(
    ({ text, rationale }) => ({
      caps: {
        questionStem: "",
        learnerSteps: [],
        movePlan: { move: "concept_cue", rationale },
        publicBlocks: [{ kind: "question", text }],
      },
      standaloneText: text,
    }),
  );
  candidates.unshift({
    caps: toPublicCaps(questionStem, [], verification, { coarsened: true, allVerifiedValid: false }),
  });
  for (const { caps, standaloneText } of candidates) {
    const candidateReleased = guardRelease(caps, verification, releaseCaps);
    if (isStopped(releaseCaps.stopSignal) || isStopped(verifyStopSignal)) {
      return { kind: "stopped" };
    }
    if (candidateReleased !== undefined) {
      return { kind: "approved", caps, text: standaloneText ?? candidateReleased };
    }
  }
  return { kind: "rejected" };
}

export function runTutorGraph(input: TutorGraphInput): TutorGraphResult {
  const budget = input.budget;
  if (!budget) {
    return {
      state: "unverified",
      providerCalls: 0,
      verification: { steps: [] },
      leakageBits: 0,
      releaseApproved: false,
      reason: "missing_entropy_budget",
    };
  }
  const nowMs = input.nowMs ?? budget.nowMs();

  // A signal aborted during an earlier verified turn must not change the
  // response for an already exhausted pure budget.
  if (
    (input.assessmentMode ?? "pure") === "pure" &&
    budget.leakageBits > 0
  ) {
    if (budget.cooldownUntilMs !== undefined && nowMs < budget.cooldownUntilMs) {
      return blockedByBudgetResult(budget, "cooldown");
    }
    if (budget.state === "contaminated") {
      return blockedByBudgetResult(budget, "budget_contaminated");
    }
    const rawCap = Number.isFinite(budget.maxBitsPerTurn) ? budget.maxBitsPerTurn : PURE_MAX_LEAKAGE_BITS;
    const turnCap = Math.min(rawCap, PURE_MAX_LEAKAGE_BITS);
    if (turnCap - budget.leakageBits < 1 || budget.leakageBits + 1 >= PURE_MAX_LEAKAGE_BITS) {
      const preCheck = budget.canRelease(1, nowMs);
      return blockedByBudgetResult(budget, preCheck.allowed ? "budget_exhausted" : (preCheck.reason ?? "budget_exhausted"));
    }
  }

  if (isStopped(input.releaseCaps.stopSignal) || isStopped(input.verifyCaps.stopSignal)) {
    return withheldReleaseResult(budget, "cancelled");
  }

  if (budget.cooldownUntilMs !== undefined && nowMs < budget.cooldownUntilMs) {
    return blockedByBudgetResult(budget, "cooldown");
  }
  if (budget.state === "contaminated") {
    return blockedByBudgetResult(budget, "budget_contaminated");
  }

  const assessmentMode = input.assessmentMode ?? "pure";
  const requiresSubmittedAttempt = assessmentMode === "pure" || budget.state === "pure";
  if (input.answerProbe || (requiresSubmittedAttempt && input.attemptSubmitted !== true)) {
    const pure = fixedPureGuidance(input.answerProbe ? "unsubmitted_answer_probe" : "unsubmitted_pure_attempt");
    return {
      state: pure.state,
      providerCalls: 0,
      verification: { steps: [] },
      releasedText: pure.releasedText,
      leakageBits: budget.leakageBits,
      helpState: budget.state,
      releaseApproved: true,
      reason: pure.reason,
    };
  }

  // Enforce release-cap precondition and 0-bit budget ceiling before consulting verifier
  if (typeof input.releaseCaps.answerLeakageBlocker !== "function") {
    input.releaseCaps.assertCurrent();
    const stoppedBeforeVerify = isStopped(input.releaseCaps.stopSignal) || isStopped(input.verifyCaps.stopSignal);
    return withheldReleaseResult(budget, stoppedBeforeVerify ? "cancelled" : "release_guard_rejected");
  }

  const rawTurnCap =
    typeof (budget as { maxBitsPerTurn?: unknown }).maxBitsPerTurn === "number" &&
    Number.isFinite((budget as { maxBitsPerTurn?: number }).maxBitsPerTurn)
      ? (budget as { maxBitsPerTurn: number }).maxBitsPerTurn
      : PURE_MAX_LEAKAGE_BITS;
  const isPureTurn = assessmentMode !== "practice";
  const turnCap = isPureTurn ? Math.min(rawTurnCap, PURE_MAX_LEAKAGE_BITS) : rawTurnCap;

  const remainingBits = turnCap - budget.leakageBits;
  if (remainingBits < 1 || (isPureTurn && budget.leakageBits + 1 >= PURE_MAX_LEAKAGE_BITS)) {
    const preCheck = budget.canRelease(1, nowMs);
    return blockedByBudgetResult(
      budget,
      preCheck.allowed ? "budget_exhausted" : (preCheck.reason ?? "budget_exhausted"),
    );
  }

  const committedPure = isPureTurn
    ? selectVerifiedPureFallback(input.questionStem, input.releaseCaps, input.verifyCaps.stopSignal)
    : undefined;
  if (committedPure && committedPure.kind !== "approved") {
    return withheldReleaseResult(budget, committedPure.kind === "stopped" ? "cancelled" : "release_guard_rejected");
  }

  if (committedPure) {
    const preVerifyCheck = budget.canRelease(1, nowMs);
    if (!preVerifyCheck.allowed) {
      return blockedByBudgetResult(budget, preVerifyCheck.reason ?? "budget_exhausted");
    }

    // Spend the bit and snapshot both public outcomes before running the verifier.
    const { leakageBits, state: helpState, cooldownUntilMs } = budget.commitRelease(1, nowMs);
    const publicVerification: VerifyOutput = { steps: [] };
    const publicFields = { providerCalls: 0 as const, verification: publicVerification, leakageBits, helpState, cooldownUntilMs };
    const pureReleasedOutcome: TutorGraphResult = {
      ...publicFields,
      state: "released",
      publicTeaching: committedPure.caps,
      releasedText: committedPure.text,
      releaseApproved: true,
    };
    const pureWithheldOutcome: TutorGraphResult = {
      ...publicFields,
      state: "unverified",
      releaseApproved: false,
      reason: "release_guard_rejected",
    };
    return budget[pureBudgetScope]((wasTouched) => {
      const shouldWithhold = () =>
        wasTouched() || isStopped(input.verifyCaps.stopSignal) || isStopped(input.releaseCaps.stopSignal);

      try {
        input.verifyCaps.assertCurrent();
        input.verifyCaps.verify(input.submission);
        if (shouldWithhold()) return pureWithheldOutcome;
        const postVerifyText = guardRelease(committedPure.caps, publicVerification, input.releaseCaps);
        return postVerifyText === undefined || shouldWithhold() ? pureWithheldOutcome : pureReleasedOutcome;
      } catch {
        return pureWithheldOutcome;
      }
    });
  }

  input.verifyCaps.assertCurrent();
  let verification: VerifyOutput | undefined;
  try {
    verification = input.verifyCaps.verify(input.submission);
  } catch {
    verification = undefined;
  }

  if (isStopped(input.verifyCaps.stopSignal) || isStopped(input.releaseCaps.stopSignal)) {
    return withheldReleaseResult(budget, "cancelled");
  }

  // A verifier-dependent release or rejection spends at least one bit.
  const minimumReleaseBits = 1;
  const minimumReleaseCheck = budget.canRelease(minimumReleaseBits, nowMs);
  if (!minimumReleaseCheck.allowed) {
    return blockedByBudgetResult(budget, minimumReleaseCheck.reason ?? "budget_exhausted");
  }
  if (!verification) {
    budget.commitRelease(minimumReleaseBits, nowMs);
    return {
      state: "unverified",
      providerCalls: 0,
      verification: { steps: [] },
      leakageBits: budget.leakageBits,
      helpState: budget.state,
      cooldownUntilMs: budget.cooldownUntilMs,
      releaseApproved: false,
      reason: "verifier_execution_failed",
    };
  }

  const propagatedSteps = propagateSteps(verification.steps, verification.firstError);
  const nonNeutralStepCount = propagatedSteps.filter((step) => step.status !== "unknown" || step.error !== undefined).length;
  const hasAnswerDependentStepInfo = nonNeutralStepCount > 0 || Boolean(verification.firstError);
  const disclosedStepCount = hasAnswerDependentStepInfo ? Math.max(nonNeutralStepCount, propagatedSteps.length) : 0;
  const stepOutcomeBits = disclosedStepCount > 0 ? Math.log2(disclosedStepCount + 1) : 0;
  const uncoarsenedBits = Math.max(minimumReleaseBits, stepOutcomeBits);

  const allVerifiedValid =
    propagatedSteps.length > 0 &&
    !verification.firstError &&
    propagatedSteps.every((step) => step.status === "valid" && step.error === undefined);
  const shouldCoarsen = disclosedStepCount >= 2 && uncoarsenedBits > turnCap;

  const requiredBits = shouldCoarsen ? minimumReleaseBits : uncoarsenedBits;
  if (requiredBits > minimumReleaseBits) {
    const releaseCheck = budget.canRelease(requiredBits, nowMs);
    if (!releaseCheck.allowed) {
      return blockedByBudgetResult(budget, releaseCheck.reason ?? "budget_exhausted");
    }
  }

  const candidateSteps = shouldCoarsen ? extractSubmissionCandidateSteps(input.submission) : propagatedSteps;
  let publicTeaching = toPublicCaps(
    input.questionStem,
    candidateSteps,
    verification,
    shouldCoarsen ? { coarsened: true, allVerifiedValid } : {},
  );
  const publicVerification: VerifyOutput = shouldCoarsen
    ? { steps: candidateSteps }
    : {
        steps: candidateSteps,
        ...(verification.deterministic !== undefined ? { deterministic: verification.deterministic } : {}),
        ...(verification.firstError
          ? {
              firstError: {
                stepId: String(verification.firstError.stepId),
                kind: String(verification.firstError.kind),
                message: String(verification.firstError.message),
              },
            }
          : {}),
      };
  // Coarsened practice turns give the guard the public projection of verification.
  let releasedText = guardRelease(
    publicTeaching,
    shouldCoarsen ? publicVerification : verification,
    input.releaseCaps,
  );
  if (releasedText === undefined && shouldCoarsen && allVerifiedValid) {
    publicTeaching = toPublicCaps(input.questionStem, candidateSteps, verification, {
      coarsened: true,
      allVerifiedValid: false,
    });
    releasedText = guardRelease(publicTeaching, publicVerification, input.releaseCaps);
  }
  if (isStopped(input.verifyCaps.stopSignal) || isStopped(input.releaseCaps.stopSignal)) {
    return withheldReleaseResult(budget, "cancelled");
  }
  budget.commitRelease(requiredBits, nowMs);
  if (releasedText === undefined) {
    return withheldReleaseResult(budget, "release_guard_rejected");
  }

  return {
    state: "released",
    providerCalls: 0,
    verification: publicVerification,
    publicTeaching,
    releasedText,
    leakageBits: budget.leakageBits,
    helpState: budget.state,
    cooldownUntilMs: budget.cooldownUntilMs,
    releaseApproved: true,
  };
}

export const runTutorGraphTurn = runTutorGraph;
export const executeTutorGraph = runTutorGraph;
export class TutorGraph {
  run(input: TutorGraphInput): TutorGraphResult {
    return runTutorGraph(input);
  }
}
export function createTutorGraph(): TutorGraph {
  return new TutorGraph();
}
