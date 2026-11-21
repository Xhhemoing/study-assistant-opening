import {
  PURE_CONTAMINATED_GUIDANCE,
  PURE_COOLDOWN_GUIDANCE,
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

function propagateSteps(steps: readonly LearnerStep[], firstError?: VerifyOutput["firstError"]): LearnerStep[] {
  if (!firstError) return steps.map((step) => ({ ...step }));
  let seen = false;
  return steps.map((step) => {
    if (step.id === firstError.stepId) {
      seen = true;
      return { ...step, status: "invalid", error: firstError.message };
    }
    if (seen && step.status !== "unknown") {
      return { ...step, status: "dependent", error: undefined };
    }
    return { ...step };
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

function toPublicCaps(questionStem: string, steps: readonly LearnerStep[], verification: VerifyOutput): PublicTeachingCaps {
  const movePlan = chooseMove(verification.firstError);
  const blocks: PublicTeachingBlock[] = [{ kind: "question", text: questionFor(movePlan, verification.firstError) }];
  if (verification.ruleWitness) {
    blocks.push({
      kind: "rule_witness",
      text: "规则见证卡可用于检查局部条件。",
      descriptor: { ...verification.ruleWitness },
    });
  }
  return {
    questionStem,
    learnerSteps: steps.map((step) => ({ ...step })),
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
  } catch (error) {
    return {
      state: "unverified",
      providerCalls: 0,
      verification: { steps: [] },
      leakageBits: budget.leakageBits,
      helpState: budget.state,
      cooldownUntilMs: budget.cooldownUntilMs,
      releaseApproved: false,
      reason: error instanceof Error ? error.message : "verification_failed",
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

  const steps = propagateSteps(verification.steps, verification.firstError);
  const disclosesAnswerDependentInfo = Boolean(
    verification.firstError ||
      verification.ruleWitness ||
      steps.some((step) => step.status !== "unknown" || step.error !== undefined),
  );
  const worstBranchBits = disclosesAnswerDependentInfo ? 1 : 0;
  const releaseCheck = budget.canRelease(worstBranchBits, nowMs);
  if (!releaseCheck.allowed) {
    return blockedByBudgetResult(budget, releaseCheck.reason ?? "budget_exhausted");
  }

  const publicTeaching = toPublicCaps(input.questionStem, steps, verification);

  const releasedText = guardRelease(publicTeaching, { ...verification, steps }, input.releaseCaps);
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

  budget.commitRelease(worstBranchBits, nowMs);
  const publicVerification: VerifyOutput = {
    steps: steps.map((step) => ({
      id: step.id,
      text: step.text,
      status: step.status,
      ...(step.error !== undefined ? { error: step.error } : {}),
      ...(step.dependsOn !== undefined ? { dependsOn: [...step.dependsOn] } : {}),
    })),
    ...(verification.deterministic !== undefined ? { deterministic: verification.deterministic } : {}),
    ...(verification.firstError
      ? {
          firstError: {
            stepId: verification.firstError.stepId,
            kind: verification.firstError.kind,
            message: verification.firstError.message,
          },
        }
      : {}),
  };
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
