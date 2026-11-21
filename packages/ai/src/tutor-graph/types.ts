export type StepStatus = "valid" | "invalid" | "dependent" | "unknown";
export type PedagogicalMove =
  | "clarify_notation"
  | "ask_justification"
  | "local_counterexample"
  | "split_subgoal"
  | "concept_cue"
  | "invite_next_step";
export type LearnerStep = { id: string; text: string; status: StepStatus; error?: string; dependsOn?: string[] };
export type MovePlan = { move: PedagogicalMove; targetStepId?: string; rationale: string };
export type PublicTeachingBlock = {
  kind: "question" | "cue" | "rule_witness" | "step";
  text: string;
  descriptor?: Record<string, unknown>;
};
export type VerifyCaps = {
  readonly verify: (submission: unknown) => VerifyOutput;
  readonly assertCurrent: () => void;
  readonly stopSignal?: AbortSignal;
  readonly answer_key?: never;
  readonly rawSql?: never;
  readonly clientReleaseSink?: never;
};
export type VerifyOutput = {
  steps: readonly LearnerStep[];
  firstError?: { stepId: string; kind: string; message: string; witness?: Record<string, unknown> };
  deterministic?: boolean;
  ruleWitness?: { capability: string; params: Record<string, unknown> };
};
export type PublicTeachingCaps = {
  readonly questionStem: string;
  readonly learnerSteps: readonly LearnerStep[];
  readonly movePlan: MovePlan;
  readonly publicBlocks: readonly PublicTeachingBlock[];
};
export type RespondCaps = PublicTeachingCaps;
export type ReleaseCaps = {
  readonly assertCurrent: () => void;
  readonly stopSignal?: AbortSignal;
  readonly answerLeakageBlocker?: (text: string) => boolean;
};
export type AssessmentMode = "pure" | "practice";
export type TutorGraphInput = {
  questionStem: string;
  submission: unknown;
  verifyCaps: VerifyCaps;
  releaseCaps: ReleaseCaps;
  budget?: import("./min-entropy-budget").MinEntropyBudget;
  assessmentMode?: AssessmentMode;
  attemptSubmitted?: boolean;
  answerProbe?: boolean;
  nowMs?: number;
  provider?: never;
};
export type TutorGraphResult = {
  state: "released" | "stopped" | "unverified" | "budget_contaminated" | "cooldown";
  providerCalls: 0;
  verification: VerifyOutput | { steps: readonly LearnerStep[]; firstError?: undefined };
  publicTeaching?: PublicTeachingCaps;
  releasedText?: string;
  leakageBits: number;
  helpState?: "pure" | "scaffolded" | "contaminated";
  cooldownUntilMs?: number;
  releaseApproved?: boolean;
  reason?: string;
};
