import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { readOpeningCourseEvidence } from "./opening-learning-read";

const teachingRevisionId = "30000000-0000-4000-8000-000000000001";
const teachingBlockId = "30000000-0000-4000-8000-000000000002";

/** PostgreSQL is the external boundary; exercise the real repository and evaluator. */
function evidenceDatabase(teachingVerdicts?: Record<string, unknown>[], headCount = 8) {
  const sourceId = "10000000-0000-4000-8000-000000000001";
  const rows = Array.from({ length: headCount }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    workspace_id: "workspace", owner_user_id: "owner", session_id: "session", course_id: "course",
    root_observation_id: null, revises_observation_id: null, effective_head_id: null, revision_kind: "original",
    skill_label: "fractions", requirement_key: "addition", source_ids: [sourceId], source_versions: { [sourceId]: 1 },
    problem_id: `problem-${index}`, item_version_id: `item-${index}`, attempt_id: `attempt-${index}`,
    answer: "1", outcome: "correct", assistance: "independent", client_key: `submission-${index}`,
    occurred_at: "2026-01-01T10:01:00Z", started_at: "2026-01-01T10:00:00Z", submitted_at: "2026-01-01T10:01:00Z",
    recorded_at: "2026-01-01T10:01:00Z", source_turn_ids: [], verdict_source: "reference_checked", reference_source_id: sourceId,
    reference_check: { status: "checked", checkedAt: "2026-01-01T10:01:00Z", referenceId: sourceId }, history_revision: index + 1,
  }));
  const teachingItem = teachingVerdicts ? { teaching_revision_id: teachingRevisionId, teaching_block_id: teachingBlockId,
    evaluation_spec: { kind: "teaching_question", specVersion: "teaching-question-v1", revisionId: teachingRevisionId, blockId: teachingBlockId } } : {};
  let queries = 0, answerConditionQueries = 0;
  const queryCounts: Record<string, number> = {};
  const read = (kind: string, result: unknown, resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) => {
    queryCounts[kind] = (queryCounts[kind] ?? 0) + 1;
    return Promise.resolve(result).then(resolve, reject);
  };
  const db = Object.assign((strings: TemplateStringsArray | readonly unknown[]) => {
    if (!("raw" in strings)) return {};
    const query = strings.join("?");
    return { then(resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) {
    queries++;
    try {
    if (query.includes("SELECT * FROM (?) identity")) return read("examIdentity", [], resolve, reject);
    if (query.includes("teaching-key-exact-v1")) return read("teachingFeedback", teachingVerdicts ?? [], resolve, reject);
    if (query.includes("JOIN opening_learning_attempts a ON a.activity_id")) return read("legacyTeachingFeedback", [], resolve, reject);
    if (query.includes("FROM opening_study_intent_events")) {
      answerConditionQueries++;
      return read("answerConditions", [], resolve, reject);
    }
    if (query.includes("JOIN opening_learning_observations root")) return read("heads", rows, resolve, reject);
    if (query.includes("opening_exam_attempt_links")) return read("examLinks", [], resolve, reject);
    if (query.includes("opening_help_exposures")) return read("help", [], resolve, reject);
    if (query.includes("opening_privacy_exclusions")) return read("privacy", [], resolve, reject);
    if (query.includes("opening_source_versions")) return read("sourceVersions", [{ source_id: sourceId, version: 1, availability: "available" }], resolve, reject);
    if (query.includes("opening_sources")) return read("sources", [{ id: sourceId, version: 1, upload_state: "uploaded" }], resolve, reject);
    if (query.includes("opening_learning_item_versions")) return read("items", rows.map((row, index) => ({ id: row.item_version_id, problem_id: row.problem_id, ...(index ? {} : teachingItem) })), resolve, reject);
    if (query.includes("opening_learning_observations")) return read(query.includes("COALESCE(root_observation_id,id)") ? "answerChain" : "priorReference", rows, resolve, reject);
    if (query.includes("opening_learning_sessions")) return read("sessions", [{ id: "session", course_id: "course" }], resolve, reject);
    throw new Error(`Unexpected evidence query: ${query}`);
    } catch (error) { return reject(error); }
    } };
  }, { begin: async (_options: string, run: (tx: Sql) => unknown) => run(db as unknown as Sql) });
  return { db: db as unknown as Sql, queries: () => queries, answerConditionQueries: () => answerConditionQueries, queryCounts: () => queryCounts };
}

function teachingVerdict(attemptId: string, courseId = "course") {
  return { id: "40000000-0000-4000-8000-000000000001", attempt_id: attemptId, problem_id: "problem-0",
    recorded_at: "2026-01-01T09:00:00Z", course_id: courseId, teaching_revision_id: teachingRevisionId, teaching_block_id: teachingBlockId };
}

async function eligibilityByItem(db: Sql) {
  const result = await readOpeningCourseEvidence(db, { workspaceId: "workspace", ownerUserId: "owner" }, "course");
  return new Map(result.observations.map(row => [row.itemVersionId, evaluateEvidenceEligibility(
    result.evidenceContexts[row.id]!.observation, result.evidenceContexts[row.id]!.context,
  )]));
}

describe("course evidence batch contexts", () => {
  it("qualifies all heads with a bounded number of database reads", async () => {
    const fixture = evidenceDatabase();
    const result = await readOpeningCourseEvidence(fixture.db, { workspaceId: "workspace", ownerUserId: "owner" }, "course");
    expect(result.observations).toHaveLength(8);
    expect(result.observations.map(row => evaluateEvidenceEligibility(
      result.evidenceContexts[row.id]!.observation, result.evidenceContexts[row.id]!.context,
    ).independentAttempt)).toEqual(Array(8).fill("yes"));
    // Answer-condition declarations add one batch read, never one per head.
    expect(fixture.answerConditionQueries()).toBe(1);
    expect(fixture.queries()).toBeLessThanOrEqual(12);
  });

  it.each([8, 64, 256])("keeps all read categories constant for %i heads", async headCount => {
    const fixture = evidenceDatabase(undefined, headCount);
    const result = await readOpeningCourseEvidence(fixture.db, { workspaceId: "workspace", ownerUserId: "owner" }, "course");
    expect(result.observations).toHaveLength(headCount);
    expect(Object.keys(result.evidenceContexts)).toHaveLength(headCount);
    expect(result.observations.every(row => evaluateEvidenceEligibility(
      result.evidenceContexts[row.id]!.observation, result.evidenceContexts[row.id]!.context,
    ).independentAttempt === "yes")).toBe(true);
    expect(fixture.queryCounts()).toEqual({
      heads: 1, answerConditions: 1, sessions: 1, help: 1, examLinks: 1, examIdentity: 1,
      answerChain: 1, privacy: 1, sources: 1, sourceVersions: 1, items: 1, priorReference: 1,
    });
    expect(Object.values(fixture.queryCounts()).reduce((total, count) => total + count, 0)).toBe(fixture.queries());
    expect(fixture.answerConditionQueries()).toBe(1);
    expect(fixture.queries()).toBeLessThanOrEqual(12);
  });

  it("counts another attempt's controlled verdict on the same teaching question as prior feedback", async () => {
    const eligibility = await eligibilityByItem(evidenceDatabase([teachingVerdict("attempt-earlier")]).db);
    expect(eligibility.get("item-0")!.independentAttempt).not.toBe("yes");
    expect(eligibility.get("item-0")!.reasonCodes).toContain("prior_evaluation_feedback");
    expect([...eligibility.values()].filter(row => row.independentAttempt === "yes")).toHaveLength(7);
  });

  it("does not count the same attempt's controlled teaching verdict as prior feedback", async () => {
    const eligibility = await eligibilityByItem(evidenceDatabase([teachingVerdict("attempt-0")]).db);
    expect(eligibility.get("item-0")!.independentAttempt).toBe("yes");
  });

  it("does not import teaching feedback from another course", async () => {
    const eligibility = await eligibilityByItem(evidenceDatabase([teachingVerdict("attempt-earlier", "another-course")]).db);
    expect(eligibility.get("item-0")).toMatchObject({ independentAttempt: "yes" });
    expect(eligibility.get("item-0")!.reasonCodes).not.toContain("prior_evaluation_feedback");
    expect([...eligibility.values()]).toHaveLength(8);
    expect([...eligibility.values()].every(row => row.independentAttempt === "yes")).toBe(true);
  });
});
