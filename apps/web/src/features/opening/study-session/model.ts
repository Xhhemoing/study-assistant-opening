/**
 * Study session view model. Components read only these types; adapters own every API shape.
 * A new activity adds one `kind`, one adapter and one renderer; the shell does not change.
 */
import type { SpanDraftAnswer } from "../teaching/span/span-answer";

export type StudyStepKind = "learn" | "question";

/** Rich text uses the shared LearningProse renderer (Markdown + `$…$` math). */
export type LearnStep = { kind: "learn"; id: string; title: string; body: string; focus?: string; estimateMinutes: number | null };
/** `answer` is the structured span answer; the adapter serializes it the same way as the legacy form. */
export type QuestionStep = {
  kind: "question"; id: string; title: string; prompt: string; purpose: "practice" | "retest";
  estimateMinutes: number | null; photo: boolean;
};
export type StudyStep = LearnStep | QuestionStep;

export type HelpState = {
  /** Strongest help actually delivered for this question. */
  level: "none" | "hinted" | "revealed";
  hints: { level: number; label: string; text: string }[];
  /** null: no further help is available right now. */
  next: { level: number; label: string } | null;
  /** Why the next help is held back (e.g. full solution only after the first answer). */
  blockedReason?: string;
};

export type ResultOutcome = "correct" | "incorrect" | "pending" | "needs_manual" | "unknown";
export type ResultAssistance = "independent" | "hinted" | "revealed" | "unknown";
export type StepResult = { outcome: ResultOutcome; assistance: ResultAssistance; detail?: string };

export type PhotoWorkSource = { id: string; version: number; physicalPage: number };
export type PhotoState = { status: "none" | "uploading" | "preparing" | "ready" | "pending" | "unavailable" | "failed"; name?: string; workSource?: PhotoWorkSource; message?: string };

export type NextAction = { href: string; label: string; reason?: string; alternatives: { href: string; label: string }[] };

export type StudySessionView = {
  step: StudyStep;
  /** Ordered position inside this activity, for the progress segments. */
  position: { index: number; total: number };
  help: HelpState;
  answer: Partial<SpanDraftAnswer>;
  /** The first answer is sealed (submitted or being replayed); editing is closed. */
  sealed: boolean;
  /** The session must not submit; a reason is shown instead of the primary action. */
  blocked?: string;
  result: StepResult | null;
  next: NextAction | null;
  photo: PhotoState | null;
};

export type StudySessionPort = {
  load(): Promise<StudySessionView>;
  edit(change: Partial<SpanDraftAnswer>): StudySessionView;
  primary(): Promise<StudySessionView>;
  help(): Promise<StudySessionView>;
  choosePhoto(file: File): Promise<StudySessionView>;
  removePhoto(): StudySessionView;
  pause(): Promise<void>;
};

const correctLabels: Record<ResultAssistance, string> = {
  independent: "独立答对", hinted: "用提示后答对", revealed: "看过完整示范后答对", unknown: "答对了，帮助情况待确认",
};
const statusLabels: Record<Exclude<ResultOutcome, "correct">, string> = {
  incorrect: "还没对，原答案已保留", pending: "已提交，正在核对", needs_manual: "已保存，需要自己核对", unknown: "已保存，暂时无法判定",
};
export function resultLabel(result: StepResult): string {
  return result.outcome === "correct" ? correctLabels[result.assistance] : statusLabels[result.outcome];
}

/** Exactly one primary action per state. The shell renders it; adapters never name buttons. */
export type PrimaryAction = { kind: "submit" | "continue" | "next" | "none"; label: string; disabled: boolean };
export function primaryAction(view: StudySessionView, pending: boolean): PrimaryAction {
  if (view.blocked) return { kind: "none", label: "暂时不能继续", disabled: true };
  if (view.step.kind === "learn") return { kind: "continue", label: "开始做题", disabled: pending };
  if (view.next) return { kind: "next", label: view.next.label, disabled: pending };
  if (view.result) return { kind: "next", label: "看下一步安排", disabled: pending };
  if (view.sealed) return { kind: "submit", label: "重新确认提交", disabled: pending };
  const photoBusy = view.photo && ["uploading", "preparing"].includes(view.photo.status);
  // Same rule as the legacy form: the membership judgement is required; a photo only attaches the work.
  return { kind: "submit", label: "提交", disabled: pending || Boolean(photoBusy) || !view.answer.membership };
}
