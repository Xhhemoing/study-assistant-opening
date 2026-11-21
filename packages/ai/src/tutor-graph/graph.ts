import {
  PURE_CONTAMINATED_GUIDANCE,
  PURE_COOLDOWN_GUIDANCE,
  PURE_MAX_LEAKAGE_BITS,
  fixedPureGuidance,
  type MinEntropyBudget,
} from "./min-entropy-budget";
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

function toPublicCaps(
  questionStem: string,
  steps: readonly LearnerStep[],
  verification: VerifyOutput,
  options: { coarsenedHasError?: boolean } = {},
): PublicTeachingCaps {
  const projectedSteps = steps.map((step) => projectLearnerStep(step));
  if (options.coarsenedHasError !== undefined) {
    const movePlan: MovePlan = {
      move: options.coarsenedHasError ? "concept_cue" : "invite_next_step",
      rationale: options.coarsenedHasError ? "已检测到步骤存在可疑前提或推导，请先整体复查关键条件" : "保持下一步由学习者完成",
    };
    const text = options.coarsenedHasError
      ? "解答中存在一处需要复查的前提或推导，你会先检查哪一步的依据？"
      : "你愿意先写出下一步，并说明依据吗？";
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

  if (isStopped(input.releaseCaps.stopSignal) || isStopped(input.verifyCaps.stopSignal)) {
    return {
      state: "stopped",
      providerCalls: 0,
      verification: { steps: [] },
      leakageBits: budget.leakageBits,
      helpState: budget.state,
      cooldownUntilMs: budget.cooldownUntilMs,
      releaseApproved: false,
      reason: "cancelled",
    };
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

  input.verifyCaps.assertCurrent();
  let verification: VerifyOutput;
  try {
    verification = input.verifyCaps.verify(input.submission);
  } catch {
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

  if (isStopped(input.verifyCaps.stopSignal) || isStopped(input.releaseCaps.stopSignal)) {
    return {
      state: "stopped",
      providerCalls: 0,
      verification: { steps: [] },
      leakageBits: budget.leakageBits,
      helpState: budget.state,
      cooldownUntilMs: budget.cooldownUntilMs,
      releaseApproved: false,
      reason: "cancelled",
    };
  }

  const propagatedSteps = propagateSteps(verification.steps, verification.firstError);
  const nonNeutralStepCount = propagatedSteps.filter((step) => step.status !== "unknown" || step.error !== undefined).length;
  const hasAnswerDependentStepInfo = nonNeutralStepCount > 0 || Boolean(verification.firstError);
  const disclosedStepCount = hasAnswerDependentStepInfo ? Math.max(nonNeutralStepCount, propagatedSteps.length) : 0;
  const stepOutcomeBits = disclosedStepCount > 0 ? Math.log2(disclosedStepCount + 1) : 0;
  const disclosesAnswerDependentInfo = Boolean(verification.firstError || verification.ruleWitness || disclosedStepCount > 0);
  const uncoarsenedBits = Math.max(disclosesAnswerDependentInfo ? 1 : 0, stepOutcomeBits);

  const rawTurnCap =
    typeof (budget as { maxBitsPerTurn?: unknown }).maxBitsPerTurn === "number" &&
    Number.isFinite((budget as { maxBitsPerTurn?: number }).maxBitsPerTurn)
      ? (budget as { maxBitsPerTurn: number }).maxBitsPerTurn
      : PURE_MAX_LEAKAGE_BITS;
  const turnCap = assessmentMode === "practice" ? rawTurnCap : Math.min(rawTurnCap, PURE_MAX_LEAKAGE_BITS);
  const uncoarsenedFits =
    uncoarsenedBits <= turnCap &&
    (assessmentMode === "practice" || uncoarsenedBits === 0 || budget.leakageBits + uncoarsenedBits < PURE_MAX_LEAKAGE_BITS);
  const shouldCoarsen = disclosedStepCount >= 2 && !uncoarsenedFits;

  const requiredBits = shouldCoarsen ? 1 : uncoarsenedBits;
  if (assessmentMode !== "practice" && requiredBits > 0 && budget.leakageBits + requiredBits >= PURE_MAX_LEAKAGE_BITS) {
    const pureCheck = budget.canRelease(requiredBits, nowMs);
    return blockedByBudgetResult(
      budget,
      pureCheck.allowed ? "budget_exhausted" : (pureCheck.reason ?? "budget_exhausted"),
    );
  }
  const releaseCheck = budget.canRelease(requiredBits, nowMs);
  if (!releaseCheck.allowed) {
    return blockedByBudgetResult(budget, releaseCheck.reason ?? "budget_exhausted");
  }

  const coarsenedHasError = shouldCoarsen
    ? Boolean(verification.firstError || propagatedSteps.some((step) => step.status === "invalid" || step.error !== undefined))
    : undefined;
  const releasedSteps = shouldCoarsen
    ? propagatedSteps.map((step) => projectLearnerStep(step, "unknown", null))
    : propagatedSteps;
  const publicTeaching = toPublicCaps(input.questionStem, releasedSteps, verification, { coarsenedHasError });
  const publicVerification: VerifyOutput = shouldCoarsen
    ? { steps: releasedSteps }
    : {
        steps: releasedSteps,
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
  const releasedText = guardRelease(publicTeaching, verification, input.releaseCaps);
  if (releasedText === undefined || isStopped(input.verifyCaps.stopSignal) || isStopped(input.releaseCaps.stopSignal)) {
    const stopped = isStopped(input.releaseCaps.stopSignal) || isStopped(input.verifyCaps.stopSignal);
    return {
      state: stopped ? "stopped" : "unverified",
      providerCalls: 0,
      verification: { steps: [] },
      leakageBits: budget.leakageBits,
      helpState: budget.state,
      cooldownUntilMs: budget.cooldownUntilMs,
      releaseApproved: false,
      reason: stopped ? "cancelled" : "release_guard_rejected",
    };
  }

  budget.commitRelease(requiredBits, nowMs);
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
