import { fixedPureGuidance, createMinEntropyBudget, type MinEntropyBudget } from "./min-entropy-budget";
import type { LearnerStep, MovePlan, PublicTeachingBlock, PublicTeachingCaps, TutorGraphInput, TutorGraphResult, VerifyOutput } from "./types";
export * from "./types";
export * from "./min-entropy-budget";

function isStopped(signal?: AbortSignal): boolean { return signal?.aborted === true; }
function propagateSteps(steps: readonly LearnerStep[], firstError?: VerifyOutput["firstError"]): LearnerStep[] {
  if (!firstError) return steps.map((step) => ({ ...step }));
  let seen = false;
  return steps.map((step) => {
    if (step.id === firstError.stepId) { seen = true; return { ...step, status: "invalid", error: firstError.message }; }
    if (seen && step.status !== "unknown") return { ...step, status: "dependent", error: undefined };
    return { ...step };
  });
}
function chooseMove(error?: VerifyOutput["firstError"]): MovePlan {
  const kind = error?.kind.toLowerCase() ?? "";
  const move = kind.includes("notation") ? "clarify_notation" : kind.includes("counterexample") || kind.includes("domain") ? "local_counterexample" : kind.includes("dependent") || kind.includes("pointer") ? "split_subgoal" : kind.includes("proof") || kind.includes("justif") ? "ask_justification" : error ? "concept_cue" : "invite_next_step";
  return { move, targetStepId: error?.stepId, rationale: error ? `聚焦首个可验证差错 ${error.stepId}` : "保持下一步由学习者完成" };
}
function questionFor(move: MovePlan, error?: VerifyOutput["firstError"]): string {
  if (!error) return "你会如何写出下一步，并说明依据？";
  switch (move.move) {
    case "clarify_notation": return `在步骤 ${error.stepId} 中，每个符号的定义域是什么？`;
    case "ask_justification": return `步骤 ${error.stepId} 使用这条规则的前提条件是什么？`;
    case "local_counterexample": return `能找一个只改变步骤 ${error.stepId} 前提就会暴露问题的具体反例吗？`;
    case "split_subgoal": return `先只检查步骤 ${error.stepId}，下一步需要验证哪个局部目标？`;
    case "concept_cue": return `回到步骤 ${error.stepId}，哪一个概念可以帮助你重新检查它？`;
    default: return "你愿意先写出下一步，并说明依据吗？";
  }
}
function toPublicCaps(questionStem: string, steps: readonly LearnerStep[], verification: VerifyOutput): PublicTeachingCaps {
  const movePlan = chooseMove(verification.firstError); const blocks: PublicTeachingBlock[] = [{ kind: "question", text: questionFor(movePlan, verification.firstError) }];
  if (verification.ruleWitness) blocks.push({ kind: "rule_witness", text: "规则见证卡可用于检查局部条件。", descriptor: { ...verification.ruleWitness } });
  return { questionStem, learnerSteps: steps.map((step) => ({ ...step })), movePlan, publicBlocks: blocks };
}
function guardText(caps: PublicTeachingCaps, release: TutorGraphInput["releaseCaps"]): string | undefined {
  release.assertCurrent(); if (isStopped(release.stopSignal)) return undefined;
  const text = [caps.questionStem, ...caps.publicBlocks.map((block) => block.text)].join("\n");
  if (release.answerLeakageBlocker?.(text)) return undefined;
  return text;
}

export function runTutorGraph(input: TutorGraphInput): TutorGraphResult {
  const budget: MinEntropyBudget = input.budget ?? createMinEntropyBudget({ scaffoldBitBudget: 8 });
  if (input.answerProbe) return { ...fixedPureGuidance(), verification: { steps: [] }, helpState: budget.state };
  if (isStopped(input.releaseCaps.stopSignal) || isStopped(input.verifyCaps.stopSignal)) return { state: "stopped", providerCalls: 0, verification: { steps: [] }, leakageBits: budget.leakageBits, helpState: budget.state, reason: "cancelled" };
  input.verifyCaps.assertCurrent();
  let verification: VerifyOutput;
  try { verification = input.verifyCaps.verify(input.submission); } catch (error) { return { state: "unverified", providerCalls: 0, verification: { steps: [] }, leakageBits: budget.leakageBits, helpState: budget.state, reason: error instanceof Error ? error.message : "verification_failed" }; }
  const steps = propagateSteps(verification.steps, verification.firstError); const publicTeaching = toPublicCaps(input.questionStem, steps, verification);
  const worstBranchBits = verification.firstError ? 1 : 0;
  budget.beforeRelease(worstBranchBits);
  const releasedText = guardText(publicTeaching, input.releaseCaps);
  if (releasedText === undefined) return { state: isStopped(input.releaseCaps.stopSignal) ? "stopped" : "unverified", providerCalls: 0, verification: { ...verification, steps }, publicTeaching, leakageBits: budget.leakageBits, helpState: budget.state, reason: isStopped(input.releaseCaps.stopSignal) ? "cancelled" : "release_guard_rejected" };
  return { state: "released", providerCalls: 0, verification: { ...verification, steps }, publicTeaching, releasedText, leakageBits: budget.leakageBits, helpState: budget.state };
}
export const executeTutorGraph = runTutorGraph;
export class TutorGraph {
  run(input: TutorGraphInput): TutorGraphResult { return runTutorGraph(input); }
}
export function createTutorGraph(): TutorGraph { return new TutorGraph(); }
