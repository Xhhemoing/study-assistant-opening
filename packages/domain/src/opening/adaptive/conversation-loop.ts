import {
  conversationLearningPreviewSchema,
  conversationEvidenceReplanInputSchema,
  conversationEvidenceReplanSchema,
  type ConversationDiagnosis,
  type ConversationEvidenceReplan,
  type ConversationEvidenceReplanInput,
  type ConversationLearningIntent,
  type ConversationLearningPreview,
  type ConversationSessionPreview,
  type ConversationSessionStep,
  type ConversationSkillEvidence,
  type PlannedBlock,
  type TaskItem,
  type TimeBlock,
} from "@aistudy/contracts";
import { planDay } from "../day-planner";
import { localDateKeyInZone } from "../daily-draft";
import { shouldOfferReplan } from "./replan-trigger";
import { stableHash } from "./types";

export const CONVERSATION_LEARNING_VERSION = "conversation-learning-v1" as const;
const DIGITS: Record<string, number> = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };

function numberInText(value: string): number | null {
  if (/^\d{1,3}$/.test(value)) return Number(value);
  if (value === "十") return 10;
  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(value);
  if (tens) return (tens[1] ? DIGITS[tens[1]]! : 1) * 10 + (tens[2] ? DIGITS[tens[2]]! : 0);
  return value.length === 1 ? DIGITS[value] ?? null : null;
}
const within = (value: number | null, min: number, max: number) =>
  value !== null && Number.isInteger(value) && value >= min && value <= max ? value : null;

/**
 * Conservative zero-cost fallback. No raw learner claim is classified as a
 * verified skill observation. Unknown details remain null, not hallucinated.
 */
export function extractConversationLearningIntent(message: string, knownTopics: readonly string[]): ConversationLearningIntent {
  const normalized = message.replace(/\s+/g, "").toLocaleLowerCase();
  const topic = [...new Set(knownTopics.map((s) => s.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .find((s) => normalized.includes(s.replace(/\s+/g, "").toLocaleLowerCase())) ?? null;
  const zhExam = /([一二两三四五六七八九十\d]{1,4})\s*天\s*(?:后|内).{0,16}(?:考|考试|测验)/.exec(message)
    ?? /(?:还有|剩下|距离考试)\s*([一二两三四五六七八九十\d]{1,4})\s*天/.exec(message);
  const enExam = /\b(?:in\s+(\d{1,3})\s+days?.{0,16}(?:exam|test)|(\d{1,3})\s+days?\s+(?:until|before)\s+(?:the\s+)?(?:exam|test))\b/i.exec(message);
  const examInDays = within(zhExam ? numberInText(zhExam[1]!) : enExam ? Number(enExam[1] ?? enExam[2]) : null, 0, 365);
  const zhTime = /(?:每天|每日|每晚).{0,24}?([一二两三四五六七八九十\d]{1,4})\s*个?\s*(小时|分钟)/.exec(message);
  const enTime = /\b(?:every|each)\s+day.{0,24}?(\d{1,3})\s*(hours?|minutes?)\b/i.exec(message);
  const rawTime = zhTime ? numberInText(zhTime[1]!) : enTime ? Number(enTime[1]) : null;
  const unit = zhTime?.[2] ?? enTime?.[2] ?? "";
  const dailyMinutes = within(rawTime === null ? null : /小时|hour/i.test(unit) ? rawTime * 60 : rawTime, 10, 240);
  const selfReportedDifficulty = /不懂|不太懂|不太会|不会|很绕|困难|薄弱|struggl|confus|don't understand/i.test(message);
  const preferredStyle = /边讲边练|讲练结合|讲解.*练习|explain.{0,20}practice/i.test(message)
    ? "explain_then_practice" as const : /先做题|先练习|practice first/i.test(message) ? "practice_first" as const : "unspecified" as const;
  const wantsPlan = /计划|安排|排期|规划|每天|备考|schedule|plan/i.test(message);
  const wantsStudy = /学|练|讲|题|不懂|不太会|考试|矩阵|learn|study|practice|understand/i.test(message) || topic !== null;
  const kind = wantsPlan && wantsStudy ? "study_and_plan" : wantsPlan ? "plan_only" : wantsStudy ? "study_only" : "unknown";
  const missing: ConversationLearningIntent["missing"] = [];
  if (topic === null) missing.push("topic");
  if (/考试|测验|考|exam|test/i.test(message) && examInDays === null) missing.push("exam_date");
  if (wantsPlan && dailyMinutes === null) missing.push("time_budget");
  return { version: "conversation-intent-v1", extraction: "rule_fallback", kind, topic,
    examInDays, dailyMinutes, selfReportedDifficulty, preferredStyle, missing };
}

export function diagnoseConversationLearning(input: {
  intent: ConversationLearningIntent;
  skills: readonly ConversationSkillEvidence[];
  summaryComplete: boolean;
  hasUsableMaterials: boolean;
}): ConversationDiagnosis {
  const skill = input.intent.topic ? input.skills.find((s) => s.label === input.intent.topic) : undefined;
  const status = !input.summaryComplete ? "unknown" : skill?.status ?? "unobserved";
  const reasonCodes: ConversationDiagnosis["reasonCodes"] = [];
  if (!input.intent.topic) reasonCodes.push("topic_unmatched");
  if (input.intent.selfReportedDifficulty) reasonCodes.push("self_report_not_evidence");
  if (!input.summaryComplete) reasonCodes.push("summary_updating");
  else if (status === "unobserved") reasonCodes.push("no_qualified_evidence");
  else if (status === "needs_check") reasonCodes.push("evidence_needs_check");
  else if (status === "needs_review") reasonCodes.push("retest_due");
  else if (status === "observed_independent") reasonCodes.push("recent_independence");
  if (!input.hasUsableMaterials) reasonCodes.push("material_unavailable");
  return {
    topic: input.intent.topic, evidenceStatus: status, evidenceCount: skill?.sampleCount ?? 0,
    action: status === "needs_review" ? "delayed_retest" : status === "observed_independent" ? "transfer_check" : "diagnostic",
    reasonCodes, masteryUpdated: false,
  };
}

const STEP_KINDS: Record<ConversationDiagnosis["action"], ConversationSessionStep["kind"][]> = {
  diagnostic: ["diagnostic", "explain", "independent_practice", "transfer_check", "reflection"],
  guided_repair: ["diagnostic", "guided_repair", "independent_practice", "transfer_check", "reflection"],
  delayed_retest: ["delayed_retest", "guided_repair", "independent_practice", "transfer_check", "reflection"],
  transfer_check: ["diagnostic", "independent_practice", "transfer_check", "independent_practice", "reflection"],
};
const STEP_WEIGHTS: Record<ConversationDiagnosis["action"], number[]> = {
  diagnostic: [5, 10, 25, 15, 5], guided_repair: [5, 15, 20, 15, 5],
  delayed_retest: [10, 10, 20, 15, 5], transfer_check: [5, 10, 25, 15, 5],
};

/** Integer allocation that preserves the exact time budget even for short sessions. */
function allocateMinutes(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, value) => acc + value, 0);
  const minutes = weights.map((value) => Math.max(1, Math.floor(total * value / sum)));
  let delta = total - minutes.reduce((acc, value) => acc + value, 0);
  for (let index = 0; delta > 0; index = (index + 1) % minutes.length, delta--) minutes[index]!++;
  for (let index = 0; delta < 0; index = (index + 1) % minutes.length) {
    if (minutes[index]! > 1) { minutes[index]!--; delta++; }
  }
  return minutes;
}

export function buildConversationSession(diagnosis: ConversationDiagnosis, requestedMinutes: number | null): ConversationSessionPreview {
  const totalMinutes = requestedMinutes ?? 45;
  const minutes = allocateMinutes(totalMinutes, STEP_WEIGHTS[diagnosis.action]);
  const steps: ConversationSessionStep[] = STEP_KINDS[diagnosis.action].map((kind, index) => ({
    kind, minutes: minutes[index]!,
    evidenceRequired: kind === "delayed_retest" ? "verified_delayed_attempt" :
      kind === "independent_practice" || kind === "transfer_check" ? "verified_independent_attempt" : "none",
    contingentOnPriorResult: index > 0,
  }));
  return { totalMinutes, steps, conditional: true };
}

export type ConversationLoopPreviewInput = {
  message: string;
  courseId: string;
  courseTitle: string;
  date: string;
  timeZone: string;
  now: Date;
  skills: readonly ConversationSkillEvidence[];
  knownTopics: readonly string[];
  summaryComplete: boolean;
  hasUsableMaterials: boolean;
  freeBlocks: readonly TimeBlock[] | null;
  tasks: readonly TaskItem[];
  acceptedBlocks: readonly PlannedBlock[];
  /** The server supplies a stable workspace-scoped UUID. Never trust model-provided IDs. */
  idFor: (clientKey: string) => string;
};

export function previewConversationLearningLoop(input: ConversationLoopPreviewInput): ConversationLearningPreview {
  const intent = extractConversationLearningIntent(input.message, input.knownTopics);
  const diagnosis = diagnoseConversationLearning({
    intent, skills: input.skills, summaryComplete: input.summaryComplete, hasUsableMaterials: input.hasUsableMaterials,
  });
  const session = buildConversationSession(diagnosis, intent.dailyMinutes);
  const proposedClientKey = "agent-preview:" + input.date + ":" + input.courseId + ":" + stableHash(intent.topic ?? input.message);
  const proposedTask: TaskItem = {
    id: input.idFor(proposedClientKey), title: (input.courseTitle + " · " + (intent.topic ?? "待确认知识点") + " · 诊断与讲练").slice(0, 240),
    minutes: session.totalMinutes, dueAt: null, priority: 1, status: "pending",
    courseId: input.courseId, ...(intent.topic ? { skillLabel: intent.topic } : {}), origin: "agent",
  };
  let proposedBlock: PlannedBlock | null = null;
  let unscheduledReason: string | null = null;
  let status: ConversationLearningPreview["plan"]["status"] = "no_planning_settings";
  if (input.freeBlocks !== null) {
    const confirmedIds = new Set(input.acceptedBlocks.map((block) => block.taskId));
    const remaining = input.tasks.filter((task) => task.status === "pending" && !confirmedIds.has(task.id));
    const locks: TimeBlock[] = input.acceptedBlocks.map((block) => ({ start: block.start, end: block.end, kind: "locked" }));
    const options = {
      localDate: input.date, timeZone: input.timeZone,
      ...(localDateKeyInZone(input.now, input.timeZone) === input.date ? { planningNow: input.now.toISOString() } : {}),
    };
    const planned = planDay([...remaining, proposedTask], [...input.freeBlocks, ...locks], options);
    proposedBlock = planned.blocks.find((block) => block.taskId === proposedTask.id) ?? null;
    const unscheduled = planned.unscheduled.find((entry) => entry.taskId === proposedTask.id);
    status = proposedBlock ? "scheduled" : "unscheduled";
    unscheduledReason = unscheduled?.reason ?? (proposedBlock ? null : "no_available_slot");
  }
  const warnings: string[] = [];
  if (intent.missing.includes("topic")) warnings.push("知识点未匹配到课程知识结构，请确认后再创建任务。");
  if (!input.summaryComplete) warnings.push("学情投影尚未完全就绪，仅提供诊断建议，不判断掌握。");
  if (intent.dailyMinutes === null) warnings.push("没有明确的每日学习时长，先按45分钟模拟。");
  if (!input.hasUsableMaterials) warnings.push("本课程暂无可用材料；AI讲解需进一步核对依据。");
  if (status === "no_planning_settings") warnings.push("学期作息未配置，因此不提供可执行时间。");
  if (status === "unscheduled") warnings.push("现有计划和固定安排占用时间，本建议没有可用时段。");
  return conversationLearningPreviewSchema.parse({
    policyVersion: CONVERSATION_LEARNING_VERSION, courseId: input.courseId,
    intent, diagnosis, session,
    plan: { date: input.date, status, proposedClientKey, proposedTask, proposedBlock,
      retainedAcceptedBlockCount: input.acceptedBlocks.length, unscheduledReason, isCommitted: false },
    warnings, readOnly: true,
  });
}

/** Only server-qualified observation facts are accepted. No answer can directly promote mastery. */
export function replanAfterVerifiedObservation(raw: ConversationEvidenceReplanInput): ConversationEvidenceReplan {
  const input = conversationEvidenceReplanInputSchema.parse(raw);
  const e = input.eligibility;
  const consistent = (input.outcome === "correct" && e.verifiedCorrect === "yes")
    || (input.outcome === "incorrect" && e.verifiedCorrect === "no");
  let action: ConversationEvidenceReplan["action"] = "verify_evidence";
  let reason = "evidence_unverified";
  if (consistent && e.usableForCurrentVersion === "yes") {
    if (e.verifiedCorrect === "no") { action = "guided_repair"; reason = "verified_error"; }
    else if (e.independentAttempt !== "yes" || input.assistance !== "independent") {
      action = "independent_retry"; reason = "assisted_answer";
    } else if (e.usableForDelayedCheck === "yes") {
      action = "consider_next_topic"; reason = "verified_delayed_independence";
    } else { action = "transfer_check"; reason = "independent_but_transfer_unchecked"; }
  }
  const kinds: ConversationSessionStep["kind"][] = action === "verify_evidence" ? ["diagnostic"]
    : action === "guided_repair" ? ["guided_repair", "independent_practice"]
      : action === "independent_retry" ? ["independent_practice", "transfer_check"]
        : action === "transfer_check" ? ["transfer_check", "reflection"] : ["reflection"];
  const selected = kinds.slice(0, Math.min(input.remainingMinutes, kinds.length));
  const minutes = selected.length ? allocateMinutes(input.remainingMinutes, selected.map(() => 1)) : [];
  const nextSteps: ConversationSessionStep[] = selected.map((kind, index) => ({
    kind, minutes: minutes[index]!, contingentOnPriorResult: index > 0,
    evidenceRequired: kind === "independent_practice" || kind === "transfer_check" ? "verified_independent_attempt" : "none",
  }));
  return conversationEvidenceReplanSchema.parse({
    policyVersion: CONVERSATION_LEARNING_VERSION, action, nextSteps,
    reasonCodes: [reason], masteryUpdated: false,
  });
}

/** Prompt a delta draft when evidence or a schedule event changes; do not mutate the accepted plan. */
export function recommendConversationDelta(input: {
  acceptedBlocks: readonly PlannedBlock[];
  tasks: readonly TaskItem[];
  now: Date;
  evidenceReplan?: ConversationEvidenceReplan;
}): { offer: boolean; taskIds: string[]; reason: "learning_evidence" | "missed_block" | "freed_time" | null } {
  const schedule = shouldOfferReplan(input);
  if (schedule.offer) return schedule;
  const action = input.evidenceReplan?.action;
  if (action !== "guided_repair" && action !== "independent_retry" && action !== "transfer_check") {
    return { offer: false, taskIds: [], reason: null };
  }
  const taskIds = input.tasks.filter((task) => task.status === "pending").map((task) => task.id);
  return { offer: taskIds.length > 0, taskIds, reason: taskIds.length > 0 ? "learning_evidence" : null };
}
