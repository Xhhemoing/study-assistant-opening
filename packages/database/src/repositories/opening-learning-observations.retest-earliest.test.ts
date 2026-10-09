import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  RETEST_SUBMIT_TOO_EARLY_CODE,
  RETEST_SUBMIT_TOO_EARLY_MESSAGE,
  RetestSubmitTooEarlyError,
} from "@aistudy/domain";
import { insertOpeningLearningObservation } from "./opening-learning-observations";

const workspaceId = "00000000-0000-4000-8000-0000000000w1";
const ownerUserId = "00000000-0000-4000-8000-0000000000u1";
const courseId = "00000000-0000-4000-8000-0000000000c1";
const sessionId = "00000000-0000-4000-8000-0000000000s1";
const retestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const scope = { workspaceId, ownerUserId };

function sqlForRetest(recommendedAt: string, opts: { completeInsert?: boolean } = {}) {
  const writes: string[] = [];
  const sql = ((strings: TemplateStringsArray | unknown[], ..._values: unknown[]) => {
    if (!Object.hasOwn(strings, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    if (/INSERT|UPDATE|DELETE/.test(query)) writes.push(query);
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: workspaceId, privacy_epoch: 0 }]);
    if (query.includes("opening_workspace_history_revisions")) {
      if (query.includes("UPDATE") || query.includes("RETURNING revision")) {
        return Promise.resolve([{ revision: 1 }]);
      }
      return Promise.resolve([{ revision: 0 }]);
    }
    if (query.includes("FROM opening_learning_sessions")) {
      return Promise.resolve([{
        id: sessionId,
        course_id: courseId,
        skill_label: "chain rule",
        source_ids: [],
      }]);
    }
    if (query.includes("opening_learning_history_revisions")) {
      if (query.includes("UPDATE") || query.includes("RETURNING revision")) {
        return Promise.resolve([{ revision: 1 }]);
      }
      return Promise.resolve([{ revision: 0 }]);
    }
    if (query.includes("FROM opening_retest_activities")) {
      return Promise.resolve([{
        id: retestId,
        candidate_id: retestId,
        course_id: courseId,
        skill_label: "chain rule",
        requirement_key: "req-1",
        task_id: null,
        status: "accepted",
        not_before_at: null,
        recommended_at: recommendedAt,
        scheduled_start_at: null,
      }]);
    }
    if (query.includes("FROM opening_learning_observations") && query.includes("client_key")) {
      return Promise.resolve([]);
    }
    if (query.includes("clock_timestamp")) {
      return Promise.resolve([{ at: new Date("2026-09-15T12:00:00.000Z") }]);
    }
    if (opts.completeInsert && query.includes("INSERT INTO opening_learning_observations")) {
      return Promise.resolve([{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        workspace_id: workspaceId,
        owner_user_id: ownerUserId,
        session_id: sessionId,
        course_id: courseId,
        skill_label: "chain rule",
        source_ids: [],
        problem_id: null,
        retest_id: retestId,
        answer: "42",
        outcome: "correct",
        assistance: "independent",
        client_key: "obs-retest-earliest-ontime",
        occurred_at: new Date("2026-09-15T12:00:00.000Z"),
        source_turn_ids: [],
        verdict_source: "self_report",
        reference_source_id: null,
        attempt_id: null,
        item_version_id: null,
        requirement_key: null,
        started_at: null,
        submitted_at: null,
        recorded_at: new Date("2026-09-15T12:00:00.000Z"),
        source_versions: null,
        reference_check: null,
        submitted_intent: null,
        history_revision: 1,
        workspace_history_revision: 1,
        root_observation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        effective_head_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        revision_kind: "original",
        actor_id: ownerUserId,
        revises_observation_id: null,
        revision_reason: null,
      }]);
    }
    // refresh eligibility / evidence context follow-ups
    if (opts.completeInsert) return Promise.resolve([]);
    return Promise.resolve([]);
  }) as unknown as Sql;
  (sql as Sql & { begin: Sql["begin"]; json: (value: unknown) => unknown }).begin =
    ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  (sql as Sql & { json: (value: unknown) => unknown }).json = (value: unknown) => value;
  return { sql, writes };
}

const baseInput = {
  sessionId,
  courseId,
  skillLabel: "chain rule",
  sourceIds: [] as string[],
  answer: "42",
  outcome: "correct" as const,
  assistance: "independent" as const,
  clientKey: "obs-retest-earliest-1",
  retestId,
};

describe("insertOpeningLearningObservation retest earliest (DL11)", () => {
  it("rejects early retest-linked observation before INSERT", async () => {
    const { sql, writes } = sqlForRetest("2026-09-15T16:00:00.000Z");
    await expect(insertOpeningLearningObservation(sql, scope, baseInput)).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(RetestSubmitTooEarlyError);
        expect((error as RetestSubmitTooEarlyError).businessCode).toBe(RETEST_SUBMIT_TOO_EARLY_CODE);
        expect((error as Error).message).toBe(RETEST_SUBMIT_TOO_EARLY_MESSAGE);
        return true;
      },
    );
    expect(writes.some((q) => q.includes("opening_learning_observations") && q.includes("INSERT"))).toBe(false);
  });

  it("allows on-time retest-linked observation and reaches INSERT", async () => {
    const { sql, writes } = sqlForRetest("2026-09-15T10:00:00.000Z", { completeInsert: true });
    try {
      await insertOpeningLearningObservation(sql, scope, {
        ...baseInput,
        clientKey: "obs-retest-earliest-ontime",
      });
    } catch (error) {
      // Eligibility/evidence follow-ups may be incomplete in this mock; earliest must not reject.
      expect(error).not.toBeInstanceOf(RetestSubmitTooEarlyError);
    }
    expect(writes.some((q) => q.includes("INSERT INTO opening_learning_observations"))).toBe(true);
  });
});
