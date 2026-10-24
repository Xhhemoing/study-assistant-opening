import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningSkillEvidenceRepository } from "./opening-skill-evidence";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const courseId = "00000000-0000-4000-8000-000000000003";
const nodeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const observationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const scope = { workspaceId, ownerUserId };

function db(handler: (query: string, values: unknown[]) => unknown[]) {
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings as object, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    return Promise.resolve(handler(query, values));
  }) as unknown as Sql;
  sql.unsafe = ((query: string) => query) as unknown as Sql["unsafe"];
  sql.begin = ((options: string | ((tx: Sql) => unknown), callback?: (tx: Sql) => unknown) =>
    (typeof options === "function" ? options : callback!)(sql)) as Sql["begin"];
  return sql;
}

describe("opening skill evidence repository (unit)", () => {
  it("rejects link when workspace is missing", async () => {
    const sql = db((query) => {
      if (query.includes("FROM workspaces")) return [];
      return [];
    });
    await expect(
      createOpeningSkillEvidenceRepository(sql).link(scope, {
        nodeId,
        observationId,
        dimension: "transfer",
        courseId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects link when observation is outside the scope", async () => {
    const sql = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_learning_observations")) return [];
      return [];
    });
    await expect(
      createOpeningSkillEvidenceRepository(sql).link(scope, {
        nodeId,
        observationId,
        dimension: "recall",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects courseId that does not match the observation", async () => {
    const sql = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_learning_observations")) {
        return [{ id: observationId, course_id: courseId, assistance: "independent" }];
      }
      return [];
    });
    await expect(
      createOpeningSkillEvidenceRepository(sql).link(scope, {
        nodeId,
        observationId,
        dimension: "explain",
        courseId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects nodeId missing from an existing knowledge snapshot", async () => {
    const sql = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_learning_observations")) {
        return [{ id: observationId, course_id: courseId, assistance: "independent" }];
      }
      if (query.includes("FROM courses")) return [{ id: courseId }];
      if (query.includes("FROM opening_course_knowledge")) {
        return [{
          snapshot: {
            courseId,
            version: 1,
            nodes: [{
              id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
              courseId,
              label: "other",
              kind: "concept",
              evidenceChunkIds: [],
              status: "suggested",
            }],
            edges: [],
          },
        }];
      }
      return [];
    });
    await expect(
      createOpeningSkillEvidenceRepository(sql).link(scope, {
        nodeId,
        observationId,
        dimension: "procedure",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("nodeId") });
  });
});

function flagsDatabase(options: { version?: number; excluded?: boolean; help?: boolean; selfReport?: boolean } = {}) {
  const sourceId = "00000000-0000-4000-8000-000000000010", attemptId = "00000000-0000-4000-8000-000000000011";
  const problemId = "00000000-0000-4000-8000-000000000012", itemId = "00000000-0000-4000-8000-000000000013";
  const sessionId = "00000000-0000-4000-8000-000000000014", evidenceId = "00000000-0000-4000-8000-000000000015";
  const at = "2026-10-17T10:01:00Z";
  const row = { id: observationId, root_observation_id: observationId, effective_head_id: observationId,
    evidence_id: evidenceId, workspace_id: workspaceId, owner_user_id: ownerUserId, course_id: courseId, session_id: sessionId,
    attempt_id: attemptId, problem_id: problemId, item_version_id: itemId, skill_label: "Matrix dimensions", requirement_key: "matrix-dimensions",
    source_ids: [sourceId], source_versions: { [sourceId]: 1 }, answer: "[2,3]", outcome: "correct", assistance: "independent",
    occurred_at: at, submitted_at: at, recorded_at: at, started_at: "2026-10-17T10:00:00Z", verdict_source: options.selfReport ? "self_report" : "deterministic",
    // A cached yes row must never override the current canonical facts.
    independent_attempt: "yes", verified_correct: "yes", usable_for_current_version: "yes",
    server_evaluation: options.selfReport ? null : { observationId, attemptId, problemId, itemVersionId: itemId,
      requirementKey: "matrix-dimensions", evaluatorVersion: "matrix-exact-v1", specVersion: "matrix-arithmetic-v1",
      decision: "correct", outcome: "correct", reasonCodes: ["matrix_compared"], evaluatedAt: at },
  };
  const sql = db(query => {
    if (query.includes("SELECT o.id,material.state")) return [{ id: observationId, state: {
      materialSourceRefs: [{ sourceId, sourceVersion: options.version ?? 1, manifestRevision: 0 }],
      materialAnswerRefs: [], disputed: false,
    } }];
    if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
    if (query.includes("FROM opening_skill_evidence")) return [row];
    if (query.includes("FROM opening_learning_sessions")) return [{ id: sessionId, course_id: courseId }];
    if (query.includes("FROM opening_help_exposures")) return options.help ? [{ id: "help", session_id: sessionId, course_id: courseId,
      attempt_id: attemptId, problem_id: problemId, level: "hinted", kind: "hint", delivered: true, delivered_at: "2026-10-17T10:00:30Z", history_revision: 1 }] : [];
    if (query.includes("FROM opening_exam_attempt_links") || query.includes("WITH current_nodes AS")
      || query.includes("SELECT * FROM (?) identity") || query.includes("FROM opening_course_knowledge")) return [];
    if (query.includes("FROM opening_privacy_exclusions")) return options.excluded ? [{ source_id: sourceId }] : [];
    if (query.includes("FROM opening_source_versions")) return [{ source_id: sourceId, version: 1, availability: "available" }];
    if (query.includes("FROM opening_sources")) return [{ id: sourceId, version: options.version ?? 1, upload_state: "uploaded" }];
    if (query.includes("FROM opening_learning_item_versions")) return [{ id: itemId, problem_id: problemId, course_id: courseId, evaluation_spec: null }];
    if (query.includes("o.attempt_id IS NOT NULL")) return [];
    if (query.includes("FROM opening_learning_observations")) return [row];
    return [];
  });
  return { sql, evidenceId };
}

describe("live node evidence flags", () => {
  it("qualifies an independent server-scored effective answer", async () => {
    const { sql, evidenceId } = flagsDatabase();
    expect(await createOpeningSkillEvidenceRepository(sql).flagsForNode(scope, nodeId))
      .toEqual({ nodeId, hasCheckedIndependent: true, hasAssistance: false, evidenceIds: [evidenceId] });
  });
  it.each([{ version: 2 }, { excluded: true }])("ignores a cached yes when current source facts disagree: %j", async options => {
    const { sql } = flagsDatabase(options);
    expect(await createOpeningSkillEvidenceRepository(sql).flagsForNode(scope, nodeId))
      .toEqual({ nodeId, hasCheckedIndependent: false, hasAssistance: false, evidenceIds: [] });
  });
  it("uses delivered help instead of an independent assistance claim", async () => {
    const { sql, evidenceId } = flagsDatabase({ help: true });
    expect(await createOpeningSkillEvidenceRepository(sql).flagsForNode(scope, nodeId))
      .toEqual({ nodeId, hasCheckedIndependent: false, hasAssistance: true, evidenceIds: [evidenceId] });
  });
  it("never upgrades a current learner self-report from cached yes values", async () => {
    const { sql } = flagsDatabase({ selfReport: true });
    expect((await createOpeningSkillEvidenceRepository(sql).flagsForNode(scope, nodeId)).hasCheckedIndependent).toBe(false);
  });
});
