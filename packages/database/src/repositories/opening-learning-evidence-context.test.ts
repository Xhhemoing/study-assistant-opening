import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { readOpeningCourseEvidence } from "./opening-learning-read";

/** PostgreSQL is the external boundary; exercise the real repository and evaluator. */
function evidenceDatabase() {
  const sourceId = "10000000-0000-4000-8000-000000000001";
  const rows = Array.from({ length: 8 }, (_, index) => ({
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
  let queries = 0;
  const db = Object.assign((strings: TemplateStringsArray | readonly unknown[]) => {
    if (!("raw" in strings)) return {};
    const query = strings.join("?");
    return { then(resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) {
    queries++;
    try {
    if (query.includes("JOIN opening_learning_observations root")) return Promise.resolve(rows).then(resolve, reject);
    if (query.includes("opening_help_exposures")) return Promise.resolve([]).then(resolve, reject);
    if (query.includes("opening_privacy_exclusions")) return Promise.resolve([]).then(resolve, reject);
    if (query.includes("opening_source_versions")) return Promise.resolve([{ source_id: sourceId, version: 1, availability: "available" }]).then(resolve, reject);
    if (query.includes("opening_sources")) return Promise.resolve([{ id: sourceId, version: 1, upload_state: "uploaded" }]).then(resolve, reject);
    if (query.includes("opening_learning_item_versions")) return Promise.resolve(rows.map(row => ({ id: row.item_version_id, problem_id: row.problem_id }))).then(resolve, reject);
    if (query.includes("opening_learning_observations")) return Promise.resolve(rows).then(resolve, reject);
    if (query.includes("opening_learning_sessions")) return Promise.resolve([{ id: "session", course_id: "course" }]).then(resolve, reject);
    throw new Error(`Unexpected evidence query: ${query}`);
    } catch (error) { return reject(error); }
    } };
  }, { begin: async (_options: string, run: (tx: Sql) => unknown) => run(db as unknown as Sql) });
  return { db: db as unknown as Sql, queries: () => queries };
}

describe("course evidence batch contexts", () => {
  it("qualifies all heads with a bounded number of database reads", async () => {
    const fixture = evidenceDatabase();
    const result = await readOpeningCourseEvidence(fixture.db, { workspaceId: "workspace", ownerUserId: "owner" }, "course");
    expect(result.observations).toHaveLength(8);
    expect(result.observations.map(row => evaluateEvidenceEligibility(
      result.evidenceContexts[row.id]!.observation, result.evidenceContexts[row.id]!.context,
    ).independentAttempt)).toEqual(Array(8).fill("yes"));
    expect(fixture.queries()).toBeLessThanOrEqual(9);
  });
});
