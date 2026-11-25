import { runTutorGraph } from "./graph";
import { createMinEntropyBudget, PURE_ANSWER_PROBE_GUIDANCE } from "./min-entropy-budget";
import type { PedagogicalMove, ReleaseCaps, StepStatus, VerifyCaps } from "./types";

type AnswerIdentity = { observationId: string; answerRevision: number };
type TutorGraphTurnInput = {
  originalQuestion: string;
  currentAnswer: (AnswerIdentity & { answer: string }) | null;
  effectiveGrading: (AnswerIdentity & { outcome: string; verdictSource: string }) | null;
  anchorPurpose: string;
  tutorMode: string;
};

type TutorGraphTurnResult =
  | { kind: "pure_short_circuit"; text: string; providerCalls: 0 }
  | { kind: "practice"; instructionSuffix: string; providerCalls: 0 };

const learnerStepId = "作答";
const guidance: Partial<Record<PedagogicalMove, string>> = {
  concept_cue: "\n教学引导：请用一个相关概念引导学习者复核自己的作答。",
  invite_next_step: "\n教学引导：请邀请学习者写出下一步并说明依据。",
};

export function matchTutorAnswerGrading<T extends AnswerIdentity>(
  currentAnswer: AnswerIdentity | null, grading: T | null,
): T | null {
  return currentAnswer && grading && grading.observationId === currentAnswer.observationId
    && grading.answerRevision === currentAnswer.answerRevision ? grading : null;
}

export function runTutorGraphForTurn(input: TutorGraphTurnInput): TutorGraphTurnResult {
  const { anchorPurpose, tutorMode } = input;
  const assertCurrent = () => {}; // The worker owns asynchronous persistence checks.
  if (anchorPurpose === "exam_help") {
    const result = runTutorGraph({
      assessmentMode: "pure", attemptSubmitted: false, answerProbe: tutorMode === "explain",
      budget: createMinEntropyBudget({ assessmentMode: "pure" }),
      questionStem: "", submission: null,
      verifyCaps: { assertCurrent, verify: () => ({ steps: [] }) },
      releaseCaps: { assertCurrent },
    });
    return { kind: "pure_short_circuit", text: result.releasedText ?? PURE_ANSWER_PROBE_GUIDANCE, providerCalls: 0 };
  }

  const { originalQuestion, currentAnswer, effectiveGrading } = input;
  const grading = matchTutorAnswerGrading(currentAnswer, effectiveGrading);
  const verdictSource = grading?.verdictSource;
  const graded = verdictSource === "deterministic" || verdictSource === "ai_graded";
  const status: StepStatus = !graded ? "unknown" : grading?.outcome === "correct" ? "valid"
    : grading?.outcome === "incorrect" ? "invalid" : "unknown";
  const verifyCaps: VerifyCaps = {
    assertCurrent,
    verify: submission => ({
      steps: currentAnswer && submission === currentAnswer
        ? [{ id: learnerStepId, text: currentAnswer.answer, status }] : [],
      ...(graded ? { deterministic: verdictSource === "deterministic" } : {}),
      ...(status === "invalid" ? {
        firstError: { stepId: learnerStepId, kind: "graded_outcome", message: "请复核作答。" },
      } : {}),
    }),
  };
  // The graph inspects both its prose and its structured projection. Allow the
  // learner's own data there, and only the fixed fields and phrases this adapter can produce.
  const allowedLines = new Set([
    "questionStem", "learnerSteps", "movePlan", "publicBlocks", "move", "rationale", "targetStepId",
    "kind", "text", "question", "steps", "id", "status", "error", "firstError", "stepId", "message", "deterministic", "true", "false",
    "invite_next_step", "concept_cue", learnerStepId, "valid", "invalid", "unknown", "graded_outcome",
    "保持下一步由学习者完成", `聚焦首个可验证差错 ${learnerStepId}`, "请复核作答。",
    "你会如何写出下一步，并说明依据？", `回到步骤 ${learnerStepId}，哪一个概念可以帮助你重新检查它？`,
    "请先整体复查关键条件与每一步推导依据", "请先复查本题条件与已有步骤的推导依据，你会先检查哪一步？",
    "你愿意先写出下一步，并说明依据吗？",
    ...originalQuestion.split("\n"), ...(currentAnswer?.answer.split("\n") ?? []),
  ]);
  const releaseCaps: ReleaseCaps = {
    assertCurrent,
    answerLeakageBlocker: text => text.split("\n").some(line => !allowedLines.has(line)),
  };
  const result = runTutorGraph({
    questionStem: originalQuestion, submission: currentAnswer, verifyCaps, releaseCaps,
    assessmentMode: "practice", attemptSubmitted: Boolean(currentAnswer),
    budget: createMinEntropyBudget({ assessmentMode: "practice" }),
  });
  return {
    kind: "practice", providerCalls: 0,
    instructionSuffix: result.releaseApproved && result.publicTeaching ? guidance[result.publicTeaching.movePlan.move] ?? "" : "",
  };
}
