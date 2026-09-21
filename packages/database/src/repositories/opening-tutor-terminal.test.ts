import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningConversationRepository, type StoredTurn } from "./opening-conversations";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";

const scope = { workspaceId: "workspace-1", ownerUserId: "owner-1" };

function fakeSql(handler: (query: string) => unknown[] = () => []) {
  const calls: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    calls.push(query);
    return handler(query);
  }) as unknown as Sql & { calls: string[] };
  sql.calls = calls;
  sql.json = ((value: unknown) => value) as Sql["json"];
  sql.begin = async (callback: (tx: Sql) => Promise<unknown>) => callback(sql);
  return sql;
}

describe("opening conversation repository", () => {
  it("accepts outcome_unknown as a persisted turn status", () => {
    const turn: StoredTurn = {
      id: "turn-1",
      conversationId: "conversation-1",
      role: "assistant",
      text: "provider outcome unknown",
      mode: "explain",
      status: "outcome_unknown",
      clientKey: null,
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
      sourceIds: [],
      createdAt: new Date().toISOString(),
    };

    expect(turn.status).toBe("outcome_unknown");
  });

  it("returns the persisted assistant turn id for a canonical client-key replay", async () => {
    let replayLookups = 0;
    let inserts = 0;
    const sourceVersions = {};
    const intentHash = createHash("sha256").update(JSON.stringify({
      conversationId: "conversation-1",
      text: "same request",
      mode: "explain",
      privacy: "saved",
      sourceIds: [],
      sourceVersions,
      currentPage: null,
      chunkId: null,
      learningSessionId: null,
    })).digest("hex");
    const sql = fakeSql((query) => {
      if (query.includes("FROM opening_conversations")) {
        return [{ id: "conversation-1", title: "Replay", course_id: null, updated_at: new Date() }];
      }
      if (query.includes("SELECT t.id AS turn_id")) {
        replayLookups += 1;
        return replayLookups === 1 ? [] : [{
          turn_id: "user-turn-1",
          job_id: "job-1",
          assistant_turn_id: "assistant-turn-1",
          intent_hash: intentHash,
          source_versions: sourceVersions,
        }];
      }
      if (query.includes("INSERT INTO opening_turns")) {
        inserts += 1;
        return inserts === 1 ? [{ id: "user-turn-1" }] : [];
      }
      return [];
    });
    const repository = createOpeningConversationRepository(sql);
    const input = {
      scope,
      conversationId: "conversation-1",
      text: "same request",
      mode: "explain" as const,
      clientKey: "client-key-1",
      sourceIds: [],
      learningSessionId: null,
      currentPage: null,
      chunkId: null,
    };

    const first = await repository.appendSavedTurn(input);
    const replay = await repository.appendSavedTurn(input);

    expect(first.jobId).toEqual(expect.any(String));
    expect(first.assistantTurnId).toEqual(expect.any(String));
    expect(replay).toEqual({ turnId: "user-turn-1", jobId: "job-1", assistantTurnId: "assistant-turn-1" });
  });

  it("rejects a client-key replay when the intent changes", async () => {
    const intentHash = createHash("sha256").update(JSON.stringify({
      conversationId: "conversation-1", text: "same request", mode: "explain", privacy: "saved",
      sourceIds: [], sourceVersions: {}, currentPage: null, chunkId: null, learningSessionId: null,
    })).digest("hex");
    let replayLookups = 0;
    const sql = fakeSql((query) => {
      if (query.includes("FROM opening_conversations")) return [{ id: "conversation-1" }];
      if (query.includes("SELECT t.id AS turn_id")) {
        replayLookups += 1;
        return replayLookups === 1 ? [] : [{ turn_id: "user-turn-1", job_id: "job-1", assistant_turn_id: "assistant-turn-1", intent_hash: intentHash, source_versions: {} }];
      }
      if (query.includes("INSERT INTO opening_turns")) return [{ id: "user-turn-1" }];
      return [];
    });
    const repository = createOpeningConversationRepository(sql);
    const input = { scope, conversationId: "conversation-1", text: "same request", mode: "explain" as const, clientKey: "client-key-1", sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null };
    await repository.appendSavedTurn(input);
    await expect(repository.appendSavedTurn({ ...input, text: "changed request" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("opening tutor jobs repository", () => {
  it("marks the associated assistant turn failed with the definitive message", async () => {
    const sql = fakeSql((query) =>
      query.includes("RETURNING assistant_turn_id")
        ? [{ assistant_turn_id: "assistant-turn-1" }]
        : [],
    );
    const repository = createOpeningTutorJobsRepository(sql);

    await repository.fail(scope, "job-1", "provider rejected the request");

    expect(sql.calls).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE opening_turns SET text"),
    ]));
    expect(sql.calls).toEqual(expect.arrayContaining([
      expect.stringContaining("status = 'failed'"),
    ]));
  });

  it("marks the associated assistant turn as outcome_unknown with the explanation", async () => {
    const sql = fakeSql((query) =>
      query.includes("RETURNING assistant_turn_id")
        ? [{ assistant_turn_id: "assistant-turn-1" }]
        : [],
    );
    const repository = createOpeningTutorJobsRepository(sql);

    await repository.markUnknown(scope, "job-1", "provider outcome unknown; usage reconciliation pending");

    const assistantUpdate = sql.calls.find((query) => query.includes("UPDATE opening_turns SET text"));
    expect(assistantUpdate).toContain("status = 'outcome_unknown'");
  });

  it("keeps an ordinary failure distinct from outcome_unknown", async () => {
    const sql = fakeSql((query) =>
      query.includes("RETURNING assistant_turn_id")
        ? [{ assistant_turn_id: "assistant-turn-1" }]
        : [],
    );
    const repository = createOpeningTutorJobsRepository(sql);

    await repository.fail(scope, "job-1", "provider rejected the request");

    const assistantUpdate = sql.calls.find((query) => query.includes("UPDATE opening_turns SET text"));
    expect(assistantUpdate).toContain("status = 'failed'");
  });

  it("writes help exposure only after the assistant turn update succeeds", async () => {
    const sql = fakeSql((query) => {
      if (query.includes("UPDATE opening_tutor_jobs SET status = 'succeeded'")) {
        return [{ id: "job-1" }];
      }
      if (query.includes("UPDATE opening_turns SET text")) {
        return [{ id: "assistant-turn-1" }];
      }
      if (query.includes("SELECT id FROM opening_learning_sessions")) {
        return [{ id: "session-1" }];
      }
      return [];
    });
    const repository = createOpeningTutorJobsRepository(sql);

    await repository.completeTurn({
      scope,
      jobId: "job-1",
      assistantTurnId: "assistant-turn-1",
      text: "hint",
      citations: [],
      candidates: [],
      helpExposure: {
        id: "exposure-1",
        sessionId: "session-1",
        problemId: null,
        turnId: "assistant-turn-1",
        level: "hinted",
        delivered: true,
      },
    });

    const assistantUpdate = sql.calls.findIndex((query) => query.includes("UPDATE opening_turns SET text"));
    const exposureInsert = sql.calls.findIndex((query) => query.includes("INSERT INTO opening_help_exposures"));
    expect(assistantUpdate).toBeGreaterThanOrEqual(0);
    expect(exposureInsert).toBeGreaterThan(assistantUpdate);
  });

  it("does not write help exposure when the assistant turn was not persisted", async () => {
    const sql = fakeSql((query) => {
      if (query.includes("UPDATE opening_tutor_jobs SET status = 'succeeded'")) {
        return [{ id: "job-1" }];
      }
      if (query.includes("UPDATE opening_turns SET text")) return [];
      return [];
    });
    const repository = createOpeningTutorJobsRepository(sql);

    await expect(repository.completeTurn({
      scope,
      jobId: "job-1",
      assistantTurnId: "assistant-turn-1",
      text: "hint",
      citations: [],
      candidates: [],
      helpExposure: {
        id: "exposure-1",
        sessionId: "session-1",
        problemId: null,
        turnId: "assistant-turn-1",
        level: "hinted",
        delivered: true,
      },
    })).rejects.toThrow("assistant turn was not persisted");

    expect(sql.calls).not.toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO opening_help_exposures"),
    ]));
  });
});
