import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningRetestRepository } from "./opening-retests";

vi.mock("./opening-learning-facts", async importOriginal => ({
  ...await importOriginal<typeof import("./opening-learning-facts")>(),
  lockWorkspaceLearningHistory: vi.fn(), lockLearningOwner: vi.fn(), lockLearningHistory: vi.fn(),
  nextWorkspaceLearningHistoryRevision: vi.fn().mockResolvedValue(1),
}));
vi.mock("./opening-learning-preferences", () => ({
  lockLearningPreferences: vi.fn(),
  readLearningAutomationState: vi.fn().mockResolvedValue({ preferences: { retestSuggestionsEnabled: true } }),
}));
vi.mock("./opening-learning-evidence-context", () => ({
  readOpeningLearningEvidenceContext: vi.fn().mockResolvedValue({ context: { version: { applicability: "exact" } } }),
}));

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};
const courseId = "33333333-3333-4333-8333-333333333333";

const baselineId = "77777777-7777-4777-8777-777777777777";
const otherRootId = "88888888-8888-4888-8888-888888888888";
function terminalCycleDatabase(protocol: unknown, rootId = baselineId, legacyRoots?: string[]) {
  const statements: string[] = [];
  const sql = Object.assign(async (parts: TemplateStringsArray) => {
    if (!parts.raw) return [];
    const query = parts.join(" "); statements.push(query);
    if (query.includes("SELECT o.*,COALESCE")) return [{ id: rootId, root_id: rootId, occurred_at: "2026-10-01T00:00:00Z" }];
    if (query.includes("SELECT id, status, reason")) return [{ id: "terminal", status: "completed", reason: null, learning_protocol: protocol }];
    if (query.includes("SELECT payload FROM opening_jobs")) return legacyRoots ? [{ payload: { evidenceRootIds: legacyRoots } }] : [];
    if (query.includes("INSERT INTO opening_jobs") || query.includes("INSERT INTO opening_retest_activities")) return [{ id: "created" }];
    return [];
  }, { json: (value: unknown) => value, begin: async (run: (tx: Sql) => unknown) => run(sql as unknown as Sql) });
  return { sql: sql as unknown as Sql, statements, candidate: { id: "99999999-9999-4999-8999-999999999999", courseId,
    skillLabel: SPAN_SKILL_LABEL, requirementKey: SPAN_REQUIREMENT_KEY, prompt: "Independent span check", sourceIds: [],
    dueAt: "2026-10-10T00:00:00Z", accepted: false, kind: "task" as const,
    evidenceObservationIds: [rootId], evidenceRootIds: [rootId] } };
}

describe("opening retest due identities", () => {
  it("maps due activity rows to worker evidence identities", async () => {
    const sql = (async () => [{
      id: "44444444-4444-4444-8444-444444444444",
      evidence_cycle_id: "55555555-5555-4555-8555-555555555555",
      course_id: courseId,
      skill_label: "fractions",
      requirement_key: "requirement-a",
      purpose: "retest",
      status: "accepted",
      result: null,
      task_id: "66666666-6666-4666-8666-666666666666",
      candidate_id: null,
      version: 2,
      snoozed_until: null,
      proposed_at: "2026-09-28T10:00:00.000Z",
      accepted_at: "2026-09-28T10:05:00.000Z",
      started_at: null,
      completed_at: null,
      declined_at: null,
      cancelled_at: null,
      invalidated_at: null,
      superseded_at: null,
      not_before_at: null,
      recommended_at: "2026-09-29T10:00:00.000Z",
      scheduled_start_at: null,
      deadline_at: null,
      reason: null,
      reopened_from_activity_id: null,
    }]) as unknown as Sql;
    const repository = createOpeningRetestRepository(sql);

    await expect(repository.listDueEvidence(scope, courseId, "2026-09-29T12:00:00.000Z")).resolves.toEqual([{
      courseId,
      skillLabel: "fractions",
      requirementKey: "requirement-a",
    }]);
  });
});

describe("restored terminal span cycles", () => {
  const protocol = { protocolId: "span-delayed-3d-v1", baselineObservationId: baselineId,
    baselineRootId: baselineId, priorAnswerPolicy: "require_unseen_problem" };

  it("does not regenerate a completed protocol for the same baseline when jobs were not restored", async () => {
    const db = terminalCycleDatabase(protocol);
    expect(await createOpeningRetestRepository(db.sql).saveCandidates(scope, [db.candidate])).toEqual([]);
    expect(db.statements.some(query => query.includes("INSERT INTO opening_jobs"))).toBe(false);
    expect(db.statements.some(query => query.includes("SELECT payload FROM opening_jobs"))).toBe(false);
  });

  it("allows a new evidence root without reopening the restored terminal cycle", async () => {
    const db = terminalCycleDatabase(protocol, otherRootId);
    expect(await createOpeningRetestRepository(db.sql).saveCandidates(scope, [db.candidate])).toEqual([db.candidate]);
    expect(db.statements.some(query => query.includes("UPDATE opening_retest_activities"))).toBe(false);
  });

  it("retains legacy job evidence suppression without inferring a formal protocol", async () => {
    const db = terminalCycleDatabase(null, baselineId, [baselineId]);
    expect(await createOpeningRetestRepository(db.sql).saveCandidates(scope, [db.candidate])).toEqual([]);
    expect(db.statements.some(query => query.includes("SELECT payload FROM opening_jobs"))).toBe(true);
  });
});
