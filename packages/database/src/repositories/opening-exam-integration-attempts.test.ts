import { expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import type { ExamAttempt, ExamPack, ExamRun, ExamSprintState } from "@aistudy/contracts";

const mocks = vi.hoisted(() => ({
  binding: {
    sprintId: "11111111-1111-4111-8111-111111111111",
    courseId: "22222222-2222-4222-8222-222222222222",
    packId: "pack-1",
    packVersion: "1",
    packSourceId: "33333333-3333-4333-8333-333333333333",
    milestoneId: null,
    skills: [{ skillId: "limit-laws", nodeId: "44444444-4444-4444-8444-444444444444", requirementKey: "limit-laws" }],
    boundAt: "2026-11-10T00:00:00Z",
  },
}));

vi.mock("./opening-exam-integration-facts", () => ({
  examSkillLabel: () => "Limit laws",
  readExamBinding: vi.fn(async () => mocks.binding),
  readCurrentExamNodeIds: vi.fn(async () => new Set([mocks.binding.skills[0]!.nodeId])),
  readExamEvidenceState: vi.fn(async () => ({ bktEligibleAttemptIds: [], ruleEvidence: {} })),
}));
vi.mock("./opening-exam-source-exposure", () => ({
  readExamSourceExposure: vi.fn(async () => ({ packSourceId: mocks.binding.packSourceId, sourceVersion: 1, kind: "metadata_only" })),
}));
vi.mock("./opening-learning-facts", async original => {
  const mod = await original<typeof import("./opening-learning-facts")>();
  return { ...mod, nextLearningHistoryRevision: vi.fn(async () => 1), nextWorkspaceLearningHistoryRevision: vi.fn(async () => 1) };
});
vi.mock("./opening-learning-eligibility", () => ({
  invalidateOpeningLearningEligibility: vi.fn(async () => undefined),
}));

import { syncExamIntegration } from "./opening-exam-integration-attempts";

const scope = { workspaceId: "55555555-5555-4555-8555-555555555555", ownerUserId: "66666666-6666-4666-8666-666666666666" };
const sprintId = mocks.binding.sprintId;
const now = "2026-11-10T01:00:00.000Z";

const pack: ExamPack = {
  id: "pack-1", version: "1", title: "Pack", description: "Desc",
  topics: [{ id: "limits", title: "Limits" }],
  lessons: [{ id: "lesson-1", topicId: "limits", title: "Lesson", summary: "Summary", steps: ["Step"], workedExample: "Ex", pitfalls: [] }],
  questions: [{
    id: "q1", topicId: "limits", skillId: "limit-laws", familyId: "fam-1", lessonId: "lesson-1",
    pool: "training", difficulty: "foundation", prompt: "P", options: [{ id: "a", label: "A" }],
    answer: "a", explanation: "E", hint: "H", estimatedMinutes: 5,
  }],
  sourceItems: [], weekPlan: [], limitations: [],
};

function makeState(runs: ExamRun[], attempts: ExamAttempt[]): ExamSprintState {
  return { version: 1, startedAt: now, examDate: null, dailyMinutes: 60, runs, attempts, sourceRecords: [] };
}

function makeAttempt(id: string, runId: string, answeredAt: string | null = null): ExamAttempt {
  return {
    id, questionId: "q1", runId, presentedAt: "2026-11-10T00:00:00Z",
    answeredAt, answer: answeredAt ? "a" : null, correct: answeredAt ? true : null,
    confidence: answeredAt ? 4 : null, durationSeconds: answeredAt ? 10 : null,
    help: [], errorCause: null,
  };
}

function createMockTx() {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    calls.push({ query, values });
    if (query.includes("FROM opening_exam_attempt_links l")) return Promise.resolve([{ id: "link-1", source_ids: [mocks.binding.packSourceId], source_versions: { [mocks.binding.packSourceId]: 1 } }]);
    if (query.includes("FROM opening_sources s")) return Promise.resolve([{ id: mocks.binding.packSourceId, version: 1, upload_state: "uploaded", parse_state: "ready", availability: "available", excluded: false }]);
    if (query.includes("FROM opening_exam_help_receipts")) return Promise.resolve([{ id: "receipt-1" }]);
    return Promise.resolve([]);
  };
  const tx = Object.assign(fn, { json: (v: unknown) => v }) as unknown as TransactionSql;
  return { tx, calls };
}

it("closes unanswered exam-activity rows in scoped workspace/owner/course when a run finishes with zero answers", async () => {
  const runOpen: ExamRun = { id: "run-1", mode: "diagnostic", questionIds: ["q1"], startedAt: now, deadlineAt: null, completedAt: null };
  const runClosed: ExamRun = { ...runOpen, completedAt: now };
  const attempt = makeAttempt("attempt-1-key", "run-1", null);
  const before = makeState([runOpen], [attempt]);
  const after = makeState([runClosed], [attempt]);
  const { tx, calls } = createMockTx();

  await syncExamIntegration(tx, scope, sprintId, pack, before, after, { action: "finish", runId: "run-1", clientKey: "finish-key-1" }, now);

  const closeCall = calls.find(c => c.query.includes("UPDATE opening_teaching_activities") && c.query.includes("status IN ('active','paused')"));
  expect(closeCall).toBeDefined();
  expect(closeCall!.values).toEqual([
    scope.workspaceId,
    scope.ownerUserId,
    mocks.binding.courseId,
    `exam-activity:${sprintId}:%`,
    [`exam-activity:${sprintId}:attempt-1-key`],
  ]);
});

it("closes remaining unanswered attempt rows when a mock run switches to teaching", async () => {
  const runOpen: ExamRun = { id: "run-2", mode: "mock-a", questionIds: ["q1", "q1"], startedAt: now, deadlineAt: null, completedAt: null };
  const runClosed: ExamRun = { ...runOpen, completedAt: now };
  const answered = makeAttempt("attempt-1-answered", "run-2", now);
  const unanswered = makeAttempt("attempt-2-pending", "run-2", null);
  const before = makeState([runOpen], [answered, unanswered]);
  const after = makeState([runClosed], [answered, unanswered]);
  const { tx, calls } = createMockTx();

  await syncExamIntegration(tx, scope, sprintId, pack, before, after, {
    action: "switch_to_teaching", clientKey: "switch-key-1", lessonId: "lesson-1", expectedRunId: "run-2", expectedAttemptId: "attempt-2-pending",
    packVersion: "1", contentFingerprint: "fp", mappingVersion: "mv", confirmedEndScoredMock: true,
  }, now);

  const closeCall = calls.find(c => c.query.includes("UPDATE opening_teaching_activities") && c.query.includes("status IN ('active','paused')"));
  expect(closeCall).toBeDefined();
  expect(closeCall!.values[4]).toEqual([`exam-activity:${sprintId}:attempt-2-pending`]);
});
