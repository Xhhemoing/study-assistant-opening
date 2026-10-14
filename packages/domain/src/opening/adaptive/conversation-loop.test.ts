import { describe, expect, it } from "vitest";
import type { ConversationSkillEvidence, PlannedBlock, TaskItem, TimeBlock } from "@aistudy/contracts";
import {
  buildConversationSession,
  diagnoseConversationLearning,
  extractConversationLearningIntent,
  previewConversationLearningLoop,
  replanAfterVerifiedObservation,
  recommendConversationDelta,
} from "./conversation-loop";

const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const courseId = id(9);
const topic = "矩阵乘法";
const message = "我十天后要考线性代数，矩阵乘法不太懂，这周每天晚上只有一小时，帮我安排一下，最好边讲边练。";
const confirmed: PlannedBlock[] = [
  { taskId: id(1), start: "2026-10-15T11:00:00.000Z", end: "2026-10-15T11:30:00.000Z", reason: "用户确认" },
];
const free: TimeBlock[] = [
  { kind: "free", start: "2026-10-15T11:00:00.000Z", end: "2026-10-15T12:30:00.000Z" },
];
const task: TaskItem = { id: id(1), title: "已确认作业", status: "pending", minutes: 30, dueAt: null, priority: 1 };
const defaults = {
  message, courseId, courseTitle: "线性代数", date: "2026-10-15", timeZone: "Asia/Shanghai",
  now: new Date("2026-10-15T10:00:00.000Z"),
  skills: [] as ConversationSkillEvidence[], knownTopics: [topic],
  summaryComplete: true, hasUsableMaterials: true,
  freeBlocks: free, tasks: [task], acceptedBlocks: confirmed,
  idFor: () => id(2),
};
const eligibility = {
  independentAttempt: "unknown" as const, verifiedCorrect: "unknown" as const,
  usableForCurrentVersion: "yes" as const, usableForDelayedCheck: "unknown" as const,
  reasonCodes: [], policyVersion: "opening-evidence-v1" as const,
};

describe("conversation intent and diagnostics", () => {
  it("extracts 10 days and 60 minutes; self-report does not become mastery", () => {
    const intent = extractConversationLearningIntent(message, [topic, "矩阵"]);
    expect(intent).toMatchObject({
      kind: "study_and_plan", topic, examInDays: 10, dailyMinutes: 60,
      preferredStyle: "explain_then_practice", selfReportedDifficulty: true, missing: [],
    });
    expect(diagnoseConversationLearning({
      intent, skills: [], summaryComplete: true, hasUsableMaterials: true,
    })).toMatchObject({ evidenceStatus: "unobserved", action: "diagnostic", masteryUpdated: false });
  });
  it("does not invent a topic, exam deadline or ability state", () => {
    const intent = extractConversationLearningIntent("快考试了，帮我安排，但是我不太会。", [topic]);
    expect(intent.topic).toBeNull();
    expect(intent.examInDays).toBeNull();
    expect(intent.missing).toContain("topic");
    expect(intent.missing).toContain("exam_date");
  });
  it("treats an updating summary as unknown even with old success data", () => {
    const intent = extractConversationLearningIntent(message, [topic]);
    const result = diagnoseConversationLearning({
      intent, skills: [{ label: topic, status: "observed_independent", sampleCount: 5,
        verifiedIndependentCount: 5, dueRetest: false }],
      summaryComplete: false, hasUsableMaterials: true,
    });
    expect(result).toMatchObject({ evidenceStatus: "unknown", action: "diagnostic" });
  });
});

describe("conversation plan preview", () => {
  it("uses a 60-minute conditional session while retaining confirmed blocks", () => {
    const result = previewConversationLearningLoop(defaults);
    expect(result.session.steps.map((step) => step.minutes)).toEqual([5, 10, 25, 15, 5]);
    expect(result.session.steps.map((step) => step.kind)).toEqual([
      "diagnostic", "explain", "independent_practice", "transfer_check", "reflection",
    ]);
    expect(result.plan.status).toBe("scheduled");
    expect(result.plan.proposedBlock?.start).toBe("2026-10-15T11:30:00.000Z");
    expect(result.plan.proposedBlock?.end).toBe("2026-10-15T12:30:00.000Z");
    expect(result.plan.retainedAcceptedBlockCount).toBe(1);
    expect(result.plan.isCommitted).toBe(false);
    expect(result.diagnosis.masteryUpdated).toBe(false);
  });
  it("neither fabricates scheduling settings nor moves existing work", () => {
    const missing = previewConversationLearningLoop({ ...defaults, freeBlocks: null });
    expect(missing.plan.status).toBe("no_planning_settings");
    expect(missing.plan.proposedBlock).toBeNull();
    const full = previewConversationLearningLoop({ ...defaults, freeBlocks: [] });
    expect(full.plan.status).toBe("unscheduled");
    expect(full.plan.proposedBlock).toBeNull();
  });
  it("starts with an evidence-linked delayed retest when one is due", () => {
    const result = previewConversationLearningLoop({ ...defaults, skills: [{
      label: topic, status: "needs_review", sampleCount: 3,
      verifiedIndependentCount: 1, dueRetest: true,
    }] });
    expect(result.diagnosis.action).toBe("delayed_retest");
    expect(result.session.steps[0]?.kind).toBe("delayed_retest");
    expect(result.session.steps[0]?.evidenceRequired).toBe("verified_delayed_attempt");
  });
});

describe("verified evidence and delta planning", () => {
  const base = { observationId: id(21), outcome: "correct" as const, assistance: "independent" as const,
    eligibility, remainingMinutes: 20 };
  it("requires verification for unknown outcomes without elevating mastery", () => {
    expect(replanAfterVerifiedObservation(base)).toMatchObject({
      action: "verify_evidence", masteryUpdated: false,
    });
  });
  it("keeps assisted correctness separate from independent performance", () => {
    const plan = replanAfterVerifiedObservation({
      ...base, assistance: "hinted",
      eligibility: { ...eligibility, independentAttempt: "no", verifiedCorrect: "yes" },
    });
    expect(plan.action).toBe("independent_retry");
    expect(plan.masteryUpdated).toBe(false);
  });
  it("repairs verified errors and checks transfer after independent success", () => {
    const wrong = replanAfterVerifiedObservation({
      ...base, outcome: "incorrect", eligibility: { ...eligibility, verifiedCorrect: "no" },
    });
    const right = replanAfterVerifiedObservation({
      ...base, eligibility: { ...eligibility, independentAttempt: "yes", verifiedCorrect: "yes" },
    });
    expect(wrong.action).toBe("guided_repair");
    expect(right.action).toBe("transfer_check");
    expect(buildConversationSession({
      topic, evidenceStatus: "needs_check", evidenceCount: 1,
      action: "guided_repair", reasonCodes: ["evidence_needs_check"], masteryUpdated: false,
    }, 10).steps.reduce((sum, step) => sum + step.minutes, 0)).toBe(10);
  });
  it("offers an explainable delta but does not overwrite accepted blocks", () => {
    const wrong = replanAfterVerifiedObservation({
      ...base, outcome: "incorrect", eligibility: { ...eligibility, verifiedCorrect: "no" },
    });
    const saved = JSON.stringify(confirmed);
    const delta = recommendConversationDelta({
      acceptedBlocks: confirmed, tasks: [task], now: defaults.now, evidenceReplan: wrong,
    });
    expect(delta).toMatchObject({ offer: true, reason: "learning_evidence", taskIds: [id(1)] });
    expect(JSON.stringify(confirmed)).toBe(saved);
  });
});
