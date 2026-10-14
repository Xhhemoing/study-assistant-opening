/**
 * Conversation-to-learning bridge (pure and fail-closed).
 * A model may extract facts, but never creates tasks, asserts mastery, or confirms a plan.
 * Callers must supply an owned course identity and server-derived evidence.
 */
import type { TaskItem, TimeBlock } from "@aistudy/contracts";
import { planDay, type DayPlanResult, type PlanDayOptions } from "../day-planner";
import { shouldOfferReplan, type ReplanOffer } from "./replan-trigger";

export type ConversationStudyIntent = {
  courseId: string | null;
  topic: string | null;
  examDate: string | null; // YYYY-MM-DD, never a guessed relative date
  dailyMinutes: number | null;
  preferences: ("explanation" | "practice" | "review")[];
  selfReportedDifficulty: boolean;
};

export type IntentCandidate = Partial<ConversationStudyIntent>;
export type IntentIssue = "unknown_course" | "ambiguous_exam_date" | "invalid_time_budget" | "unsupported_topic" | "invalid_preferences";
export type IntentResolution = { intent: ConversationStudyIntent; issues: IntentIssue[]; needsConfirmation: boolean };

const PREFERENCES = new Set(["explanation", "practice", "review"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function validLocalDate(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const stamp = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}

/** Untrusted LLM candidate -> validated draft. The server must resolve courseId ownership separately. */
export function resolveConversationIntent(
  candidate: IntentCandidate,
  context: { ownedCourseIds: readonly string[]; supportedTopics: readonly string[] },
): IntentResolution {
  const issues: IntentIssue[] = [];
  const courseId = candidate.courseId && context.ownedCourseIds.includes(candidate.courseId) ? candidate.courseId : null;
  if (candidate.courseId && !courseId) issues.push("unknown_course");
  const topic = typeof candidate.topic === "string" && context.supportedTopics.includes(candidate.topic)
    ? candidate.topic : null;
  if (candidate.topic && !topic) issues.push("unsupported_topic");
  const examDate = candidate.examDate && validLocalDate(candidate.examDate) ? candidate.examDate : null;
  if (candidate.examDate && !examDate) issues.push("ambiguous_exam_date");
  const minutes = candidate.dailyMinutes;
  const dailyMinutes = typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 10 && minutes <= 600
    ? minutes : null;
  if (minutes !== null && minutes !== undefined && dailyMinutes === null) issues.push("invalid_time_budget");
  const prefs = candidate.preferences;
  const preferences = Array.isArray(prefs) && prefs.every(p => typeof p === "string" && PREFERENCES.has(p))
    ? [...new Set(prefs)] as ConversationStudyIntent["preferences"] : [];
  if (prefs !== undefined && (!Array.isArray(prefs) || preferences.length !== new Set(prefs).size || prefs.some(p => !PREFERENCES.has(p)))) {
    if (!Array.isArray(prefs) || prefs.some(p => !PREFERENCES.has(p))) issues.push("invalid_preferences");
  }
  const intent: ConversationStudyIntent = {
    courseId, topic, examDate, dailyMinutes, preferences,
    selfReportedDifficulty: candidate.selfReportedDifficulty === true,
  };
  return { intent, issues, needsConfirmation: issues.length > 0 || !courseId || !topic || !dailyMinutes || !examDate };
}

export type LearningEvidenceSnapshot = {
  /** All supplied by the server, not extracted from the user's claims. */
  independentVerifiedCurrent: boolean;
  needsDelayedRetest: boolean;
  hasAssistedAttempts: boolean;
  independentTransferVerified: boolean;
  evidencePending: boolean;
};

export type LearningStepKind = "diagnostic" | "explain" | "independent_practice" | "transfer" | "delayed_retest" | "review";
export type LearningStep = {
  kind: LearningStepKind;
  title: string;
  minutes: number;
  reasonCode: string;
  /** Never submitted as a formal task before acceptance. */
  proposedOnly: true;
};
export type LearningSessionProposal = {
  status: "draft";
  courseId: string;
  topic: string;
  steps: LearningStep[];
  totalMinutes: number;
  /** Explicitly distinguishes self-report from verified evidence. */
  basis: "self_report_and_server_evidence";
  requiresAcceptance: true;
};

type TemplateStep = { kind: LearningStepKind; weight: number; reasonCode: string; label: string };

function stepWeights(e: LearningEvidenceSnapshot, p: ConversationStudyIntent["preferences"]): TemplateStep[] {
  if (e.evidencePending) return [{ kind: "diagnostic", weight: 1, reasonCode: "evidence_pending", label: "核实当前学习证据" }];
  if (e.needsDelayedRetest) return [
    { kind: "delayed_retest", weight: 2, reasonCode: "retest_due", label: "延迟独立复测" },
    { kind: "review", weight: 1, reasonCode: "post_retest_review", label: "复测后纠错" },
  ];
  if (e.independentVerifiedCurrent) return [
    { kind: e.independentTransferVerified ? "review" : "transfer", weight: 4, reasonCode: "transfer_check", label: "迁移与综合练习" },
    { kind: "review", weight: 1, reasonCode: "retention_check", label: "总结与复习安排" },
  ];
  const explainWeight = p.includes("explanation") ? 2 : 1;
  return [
    { kind: "diagnostic", weight: 1, reasonCode: "self_report_not_evidence", label: "独立诊断" },
    { kind: "explain", weight: explainWeight, reasonCode: e.hasAssistedAttempts ? "assistance_detected" : "guided_explanation", label: "针对性讲解" },
    { kind: "independent_practice", weight: 4, reasonCode: "independent_evidence_needed", label: "独立练习" },
    { kind: "transfer", weight: 2, reasonCode: "transfer_evidence_needed", label: "变式检验" },
    { kind: "review", weight: 1, reasonCode: "retention_plan", label: "错因回顾与复测安排" },
  ];
}

/** Generates a proposal only. The existing plan-draft accept flow owns all writes. */
export function proposeLearningSession(
  resolution: IntentResolution,
  evidence: LearningEvidenceSnapshot,
  availableMinutes: number,
): LearningSessionProposal | null {
  const { intent } = resolution;
  if (!intent.courseId || !intent.topic || !intent.dailyMinutes) return null;
  if (!Number.isFinite(availableMinutes) || availableMinutes < 10) return null;
  const minutes = Math.min(intent.dailyMinutes, Math.floor(availableMinutes));
  if (minutes < 10) return null;
  const template = stepWeights(evidence, intent.preferences);
  const totalWeight = template.reduce((sum, s) => sum + s.weight, 0);
  let remainder = minutes;
  const steps = template.map((s, i) => {
    const allocated = i === template.length - 1 ? remainder : Math.floor((minutes * s.weight) / totalWeight);
    remainder -= allocated;
    return { kind: s.kind, title: intent.topic + " · " + s.label, minutes: allocated, reasonCode: s.reasonCode, proposedOnly: true as const };
  }).filter(s => s.minutes > 0);
  return { status: "draft", courseId: intent.courseId, topic: intent.topic, steps, totalMinutes: minutes, basis: "self_report_and_server_evidence", requiresAcceptance: true };
}

/** Pure plan preview after a confirmed change, preserving the existing scheduler's constraints. */
export function previewEvidenceTriggeredReplan(input: {
  acceptedBlocks: readonly { taskId: string; start: string; end: string; reason: string }[];
  tasks: readonly TaskItem[];
  free: readonly TimeBlock[];
  now: Date;
  options: PlanDayOptions;
}): { trigger: ReplanOffer; preview: DayPlanResult | null; requiresAcceptance: true } {
  const trigger = shouldOfferReplan({ acceptedBlocks: input.acceptedBlocks, tasks: input.tasks, now: input.now });
  if (!trigger.offer) return { trigger, preview: null, requiresAcceptance: true };
  const selected = new Set(trigger.taskIds);
  const nextTasks = input.tasks.filter(t => selected.has(t.id) && t.status === "pending");
  return {
    trigger,
    preview: planDay(nextTasks, input.free, { ...input.options, planningNow: input.now.toISOString() }),
    requiresAcceptance: true,
  };
}
