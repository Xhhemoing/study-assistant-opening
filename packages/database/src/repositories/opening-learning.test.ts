import { describe, expect, it, vi } from "vitest";
import { createOpeningLearningRepository } from "./opening-learning";

const W = "00000000-0000-4000-8000-000000000001";
const U = "00000000-0000-4000-8000-000000000002";
const S = "00000000-0000-4000-8000-000000000003";
const scope = { workspaceId: W, ownerUserId: U };
const source = "11111111-1111-4111-8111-111111111111";
const session = "22222222-2222-4222-8222-222222222222";

function db(handler: (sql: string, params?: unknown[]) => unknown) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params) ?? []),
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      handler(sql, params);
    }),
  };
}

describe("opening learning source snapshots", () => {
  it("rejects a session source that is not an uploaded workspace snapshot", async () => {
    const store = db((sql) => {
      if (sql.includes("FROM opening_sources")) return [];
      throw new Error(`unexpected ${sql}`);
    });
    const repo = createOpeningLearningRepository(store);
    await expect(repo.createSession(scope, {
      courseId: S, skillLabel: "fractions", sourceIds: [source],
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(store.execute).not.toHaveBeenCalled();
  });

  it("conflicts when the same clientKey changes the observation payload", async () => {
    const store = db((sql) => {
      if (sql.includes("FROM opening_learning_sessions")) {
        return [{ id: session, course_id: S, skill_label: "fractions", source_ids: [] }];
      }
      if (sql.includes("FROM opening_help_exposures")) return [];
      if (sql.startsWith("INSERT INTO opening_learning_observations")) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      if (sql.includes("FROM opening_learning_observations")) {
        return [{
          id: "33333333-3333-4333-8333-333333333333", session_id: session, course_id: S,
          skill_label: "fractions", source_ids: [], problem_id: null, retest_id: null,
          answer: "1/2", outcome: "unverified", assistance: "unknown", client_key: "obs-key-01",
          occurred_at: "2026-09-14T00:00:00.000Z", source_turn_ids: [],
          verdict_source: "unknown", reference_source_id: null,
          evidence_verdict: "MASTERY_NOT_ESTABLISHED",
        }];
      }
      return [];
    });
    await expect(createOpeningLearningRepository(store).insertObservation(scope, {
      sessionId: session, courseId: S, skillLabel: "fractions", sourceIds: [],
      answer: "changed", outcome: "correct", assistance: "independent", clientKey: "obs-key-01",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("replays the same clientKey payload without inserting a second observation", async () => {
    const stored = {
      id: "33333333-3333-4333-8333-333333333333", session_id: session, course_id: S,
      skill_label: "fractions", source_ids: [] as string[], problem_id: null, retest_id: null,
      answer: "1/2", outcome: "unverified" as const, assistance: "unknown" as const,
      client_key: "obs-key-01", occurred_at: "2026-09-14T00:00:00.000Z", source_turn_ids: [],
      verdict_source: "unknown" as const, reference_source_id: null,
      evidence_verdict: "MASTERY_NOT_ESTABLISHED" as const,
    };
    const store = db((sql) => {
      if (sql.includes("FROM opening_learning_sessions")) {
        return [{ id: session, course_id: S, skill_label: "fractions", source_ids: [] }];
      }
      if (sql.includes("FROM opening_help_exposures")) return [];
      if (sql.startsWith("INSERT INTO opening_learning_observations")) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      if (sql.includes("FROM opening_learning_observations")) return [stored];
      return [];
    });
    const replay = await createOpeningLearningRepository(store).insertObservation(scope, {
      sessionId: session, courseId: S, skillLabel: "fractions", sourceIds: [],
      answer: "1/2", outcome: "unverified", assistance: "unknown", clientKey: "obs-key-01",
      verdictSource: "unknown",
    });
    expect(replay.id).toBe(stored.id);
    expect(store.execute).toHaveBeenCalledTimes(1);
  });

  it("does not persist a revision parent the current observation table cannot store", async () => {
    const parentId = "33333333-3333-4333-8333-333333333333";
    const inserts: string[] = [];
    const store = db((sql) => {
      if (sql.includes("FROM opening_learning_sessions")) {
        return [{ id: session, course_id: S, skill_label: "fractions", source_ids: [] }];
      }
      if (sql.includes("FROM opening_help_exposures")) return [];
      if (sql.includes("FROM opening_learning_observations")) return [{ id: parentId }];
      if (sql.startsWith("INSERT INTO opening_learning_observations")) {
        inserts.push(sql);
        return [];
      }
      return [];
    });
    await expect(createOpeningLearningRepository(store).insertObservation(scope, {
      sessionId: session, courseId: S, skillLabel: "fractions", sourceIds: [],
      answer: "2/4", outcome: "unverified", assistance: "unknown", clientKey: "obs-key-02",
      revisesObservationId: parentId,
    })).rejects.toThrow(/revision column or table is not in the applied schema/);
    expect(inserts).toHaveLength(0);
  });

  it("uses only this session's delivered exposures and ignores another session", async () => {
    const store = db((sql, params) => {
      if (sql.includes("FROM opening_learning_sessions")) {
        return [{ id: session, course_id: S, skill_label: "fractions", source_ids: [] }];
      }
      if (sql.includes("FROM opening_help_exposures")) {
        expect(params?.[1]).toBe(session);
        return [{ level: "hinted" }];
      }
      if (sql.startsWith("INSERT INTO opening_learning_observations")) {
        expect(params?.[11]).toBe("hinted");
        return [];
      }
      return [];
    });
    const created = await createOpeningLearningRepository(store).insertObservation(scope, {
      sessionId: session, courseId: S, skillLabel: "fractions", sourceIds: [],
      answer: "1/2", outcome: "correct", assistance: "independent", clientKey: "obs-key-03",
    });
    expect(created.assistance).toBe("hinted");
    expect(created.allowsIndependent).toBe(false);
  });

  it("404s unless the course belongs to this workspace owner", async () => {
    const store = db((sql, params) => {
      expect(sql).toContain("FROM courses c");
      expect(sql).toContain("JOIN workspaces w");
      expect(sql).toContain("w.owner_user_id = $3");
      expect(params).toEqual([S, W, U]);
      return [];
    });
    await expect(createOpeningLearningRepository(store).assertOwnedCourse(scope, S))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
