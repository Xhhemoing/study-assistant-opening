import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { TUTOR_CANCELLED_MESSAGE, TUTOR_UNKNOWN_MESSAGE, turnSourceReferences } from "@aistudy/domain";
import { parseContextSourceRefs } from "./opening-context-provenance";
import { createOpeningConversationRepository, type StoredTurn } from "./opening-conversations";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";

const scope = { workspaceId: "workspace-1", ownerUserId: "owner-1" };

function unclaimedTerminalJobUpdate(query: string) {
  if (!/UPDATE opening_tutor_jobs SET status = '(failed|outcome_unknown)'/.test(query)) return [];
  return [{ id: "job-1", workspace_id: scope.workspaceId, assistant_turn_id: "assistant-turn-1", timing_execution_id: null }];
}

function fakeSql(handler: (query: string, values: unknown[]) => unknown[] = () => []) {
  const calls: string[] = [];
  let terminal = false;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    calls.push(query);
    if (query.includes("SELECT owner_user_id FROM workspaces")) terminal = true;
    if (terminal && query.includes("FROM workspaces")) return [{ id: scope.workspaceId, owner_user_id: scope.ownerUserId }];
    return handler(query, values);
  }) as unknown as Sql & { calls: string[] };
  sql.calls = calls;
  sql.json = ((value: unknown) => value) as Sql["json"];
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];
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
      if (query.includes("SELECT id FROM workspaces WHERE id=") && query.includes("owner_user_id=")) return [{ id: scope.workspaceId }];
      if (query.includes("SELECT revision FROM opening_workspace_history_revisions") && query.includes("FOR UPDATE")) return [{ revision: 0 }];
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
    const beforeReplay = sql.calls.length;
    const replay = await repository.appendSavedTurn(input);

    expect(first.jobId).toEqual(expect.any(String));
    expect(first.assistantTurnId).toEqual(expect.any(String));
    expect(replay).toEqual({ turnId: "user-turn-1", jobId: "job-1", assistantTurnId: "assistant-turn-1" });
    expect(inserts).toBe(2);
    expect(sql.calls.slice(beforeReplay).filter(query => /^\s*(INSERT|UPDATE|DELETE)\b/.test(query)
      && !query.includes("INSERT INTO opening_workspace_history_revisions"))).toEqual([]);
  });

  it("rejects a client-key replay when the intent changes", async () => {
    const intentHash = createHash("sha256").update(JSON.stringify({
      conversationId: "conversation-1", text: "same request", mode: "explain", privacy: "saved",
      sourceIds: [], sourceVersions: {}, currentPage: null, chunkId: null, learningSessionId: null,
    })).digest("hex");
    let replayLookups = 0;
    const sql = fakeSql((query) => {
      if (query.includes("SELECT id FROM workspaces WHERE id=") && query.includes("owner_user_id=")) return [{ id: scope.workspaceId }];
      if (query.includes("SELECT revision FROM opening_workspace_history_revisions") && query.includes("FOR UPDATE")) return [{ revision: 0 }];
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
    const beforeReplay = sql.calls.length;
    await expect(repository.appendSavedTurn({ ...input, text: "changed request" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(sql.calls.slice(beforeReplay).filter(query => /^\s*(INSERT|UPDATE|DELETE)\b/.test(query)
      && !query.includes("INSERT INTO opening_workspace_history_revisions"))).toEqual([]);
  });

  it.each([["plan", false], ["query", true], ["explain_state", true], ["query", false], ["explain_state", false]] as const)(
    "returns the legacy exam %s with querySystem=%s after an insert collision", async (purpose, requestedQuerySystem) => {
    const contextAnchor = { purpose: "exam_help" as const };
    const querySystem = purpose !== "plan";
    const request = { conversationId: "conversation-1", text: "exam request", mode: "explain" as const, privacy: "saved" as const,
      sourceIds: [], sourceVersions: {}, currentPage: null, chunkId: null, learningSessionId: null };
    const intentHash = createHash("sha256").update(JSON.stringify({ ...request,
      ...(querySystem ? { querySystem: true } : {}), contextAnchor, purpose })).digest("hex");
    const input = { ...request, scope, contextAnchor, clientKey: "legacy-exam-key", examHelpReplay: {
      requested: { purpose, querySystem: requestedQuerySystem }, legacyPurpose: purpose,
      ...(purpose !== "plan" ? { legacyQuery: { ...request, purpose } } : {}),
    } };
    let replayLookups = 0;
    const sql = fakeSql(query => {
      if (query.includes("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("FROM opening_conversations")) return [{ id: input.conversationId, course_id: null }];
      if (query.includes("SELECT t.id AS turn_id")) return ++replayLookups === 1 ? [] : [{
        turn_id: "user-turn-1", job_id: "job-1", assistant_turn_id: "assistant-turn-1", intent_hash: intentHash, source_versions: {},
      }];
      if (query.includes("INSERT INTO opening_turns")) return [];
      return [];
    });
    const repository = createOpeningConversationRepository(sql);
    await expect(repository.appendSavedTurn(input)).resolves.toMatchObject({ turnId: "user-turn-1", replayed: true });
    expect(replayLookups).toBe(2);
    expect(sql.calls.filter(query => query.includes("INSERT INTO opening_turns"))).toHaveLength(1);
    await expect(repository.appendSavedTurn({ ...input, text: "changed request", examHelpReplay: {
      ...input.examHelpReplay, legacyQuery: undefined,
    } })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("saves a new exam plan as fixed guidance and rejects changes to the original composer flags on replay", async () => {
    const contextAnchor = { purpose: "exam_help" as const };
    const input = { scope, conversationId: "conversation-1", text: "我是猜的", mode: "explain" as const, purpose: "plan" as const,
      clientKey: "new-exam-key", sourceIds: [], currentPage: null, chunkId: null, learningSessionId: null,
      contextAnchor, examHelpReplay: { requested: { purpose: "plan" as const }, legacyPurpose: "plan" as const } };
    let insertedHash: string | undefined;
    const sql = fakeSql((query, values) => {
      if (query.includes("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("FROM opening_conversations")) return [{ id: input.conversationId, course_id: null }];
      if (query.includes("SELECT t.id AS turn_id")) return insertedHash ? [{ turn_id: "user-turn-1", job_id: "job-1",
        assistant_turn_id: "assistant-turn-1", intent_hash: insertedHash, source_versions: {} }] : [];
      if (query.includes("INSERT INTO opening_turns") && query.includes("'user'")) {
        insertedHash = values.find((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
        expect(values.slice(-3)).toEqual([false, expect.objectContaining(contextAnchor), "plan"]);
        return [{ id: "user-turn-1" }];
      }
      return [];
    });
    const repository = createOpeningConversationRepository(sql);
    await expect(repository.appendSavedTurn(input)).resolves.toMatchObject({ jobId: expect.any(String) });
    expect(insertedHash).toBeDefined();
    await expect(repository.appendSavedTurn(input)).resolves.toMatchObject({ jobId: "job-1", replayed: true });
    await expect(repository.appendSavedTurn({ ...input, examHelpReplay: { requested: {} } })).rejects.toMatchObject({ code: "CONFLICT" });
    insertedHash = createHash("sha256").update(JSON.stringify({
      conversationId: input.conversationId, text: input.text, mode: input.mode, privacy: "saved",
      sourceIds: [], sourceVersions: {}, currentPage: null, chunkId: null, learningSessionId: null,
      contextAnchor, strategyTemplateId: null, examRequest: { purpose: "plan" },
    })).digest("hex");
    await expect(repository.appendSavedTurn(input)).resolves.toMatchObject({ jobId: "job-1", replayed: true });
  });

  it("inserts a verified retry with the original legacy exam purpose", async () => {
    const contextAnchor = { purpose: "exam_help" as const };
    const original = { text: "exam request", mode: "explain" as const, sourceIds: [], sourceVersions: {},
      currentPage: null, chunkId: null, learningSessionId: null, attemptId: null, contextAnchor,
      strategyTemplateId: null, purpose: "plan" as const };
    const sql = fakeSql((query, values) => {
      if (query.includes("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes('u.source_versions AS "sourceVersions"')) return [original];
      if (query.includes("FROM opening_conversations")) return [{ id: "conversation-1", course_id: null }];
      if (query.includes("INSERT INTO opening_turns")) {
        expect(values.slice(-3)).toEqual([false, expect.objectContaining(contextAnchor), "plan"]);
        return [{ id: "retried-turn" }];
      }
      return [];
    });
    const repository = createOpeningConversationRepository(sql);
    const input = { ...original, scope, conversationId: "conversation-1", clientKey: "retry-11111111-1111-4111-8111-111111111111" };
    await expect(repository.appendSavedTurn(input)).resolves.toMatchObject({ jobId: expect.any(String) });
    await expect(repository.appendSavedTurn({ ...input, purpose: "teach" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("opening tutor jobs repository", () => {
  it("discovers only an active pending job in the owner-scoped conversation", async () => {
    const sql = fakeSql((query) => query.includes("FROM opening_tutor_jobs j")
      ? [{
          id: "job-1",
          status: "queued",
          turn_status: "pending",
          error: null,
          updated_at: new Date("2026-09-13T12:00:00.000Z"),
        }]
      : []);
    const repository = createOpeningTutorJobsRepository(sql);

    await expect(repository.findPendingForConversation(scope, "conversation-1")).resolves.toEqual({
      id: "job-1",
      status: "queued",
      error: null,
      updatedAt: "2026-09-13T12:00:00.000Z",
    });
    expect(sql.calls[0]).toContain("owner_user_id");
    expect(sql.calls[0]).toContain("conversation_id");
  });

  it("omits clientKey on unfiltered pending-job discovery and returns exact status+clientKey across active, unknown, and terminal states on scoped lookup", async () => {
    const activeSql = fakeSql((query) => query.includes("FROM opening_tutor_jobs j")
      ? [{
          id: "job-active",
          status: "running",
          turn_status: "pending",
          client_key: "turn-client-key-1",
          error: null,
          updated_at: new Date("2026-09-13T12:00:00.000Z"),
        }]
      : []);
    await expect(createOpeningTutorJobsRepository(activeSql).findPendingForConversation(scope, "conversation-1")).resolves.toEqual({
      id: "job-active",
      status: "running",
      error: null,
      updatedAt: "2026-09-13T12:00:00.000Z",
    });

    const unknownSql = fakeSql((query) => query.includes("FROM opening_tutor_jobs j")
      ? [{
          id: "job-unknown",
          status: "outcome_unknown",
          turn_status: "outcome_unknown",
          client_key: "turn-client-key-2",
          error: null,
          updated_at: new Date("2026-09-13T12:00:00.000Z"),
        }]
      : []);
    await expect(createOpeningTutorJobsRepository(unknownSql).findPendingForConversation(scope, "conversation-1")).resolves.toEqual({
      id: "job-unknown",
      status: "outcome_unknown",
      error: { message: TUTOR_UNKNOWN_MESSAGE },
      updatedAt: "2026-09-13T12:00:00.000Z",
    });

    // clientKey-scoped lookup filters on u.client_key and reports active, outcome_unknown, and terminal states.
    await expect(createOpeningTutorJobsRepository(activeSql).findPendingForConversation(scope, "conversation-1", "turn-client-key-1")).resolves.toEqual({
      id: "job-active",
      status: "running",
      error: null,
      updatedAt: "2026-09-13T12:00:00.000Z",
      clientKey: "turn-client-key-1",
    });
    expect(activeSql.calls.at(-1)).toContain("u.client_key");
    await expect(createOpeningTutorJobsRepository(unknownSql).findPendingForConversation(scope, "conversation-1", "turn-client-key-2")).resolves.toEqual({
      id: "job-unknown",
      status: "outcome_unknown",
      error: { message: TUTOR_UNKNOWN_MESSAGE },
      updatedAt: "2026-09-13T12:00:00.000Z",
      clientKey: "turn-client-key-2",
    });

    const terminalSql = fakeSql((query) => query.includes("FROM opening_tutor_jobs j")
      ? [{
          id: "job-done",
          status: "succeeded",
          turn_status: "complete",
          client_key: "turn-client-key-3",
          error: null,
          updated_at: new Date("2026-09-13T12:00:00.000Z"),
        }]
      : []);
    await expect(createOpeningTutorJobsRepository(terminalSql).findPendingForConversation(scope, "conversation-1", "turn-client-key-3")).resolves.toEqual({
      id: "job-done",
      status: "succeeded",
      error: null,
      updatedAt: "2026-09-13T12:00:00.000Z",
      clientKey: "turn-client-key-3",
    });
  });

  it("discovers a recovered unknown outcome without marking it active", async () => {
    const sql = fakeSql((query) => query.includes("FROM opening_tutor_jobs j")
      ? [{
          id: "job-unknown",
          status: "outcome_unknown",
          turn_status: "outcome_unknown",
          error: { message: "provider timeout" },
          updated_at: "2026-09-13T12:00:00.000Z",
        }]
      : []);
    const repository = createOpeningTutorJobsRepository(sql);

    const recovered = await repository.findPendingForConversation(scope, "conversation-1");
    expect(recovered).toEqual({
      id: "job-unknown",
      status: "outcome_unknown",
      error: { message: TUTOR_UNKNOWN_MESSAGE },
      updatedAt: "2026-09-13T12:00:00.000Z",
    });
    expect(JSON.stringify(recovered)).not.toContain("provider timeout");
  });

  it("returns no pending job when the owner-scoped conversation is empty", async () => {
    const repository = createOpeningTutorJobsRepository(fakeSql());
    await expect(repository.findPendingForConversation(scope, "conversation-1")).resolves.toBeNull();
  });

  it("marks the associated assistant turn failed with the definitive message", async () => {
    const sql = fakeSql(unclaimedTerminalJobUpdate);
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
    const sql = fakeSql(unclaimedTerminalJobUpdate);
    const repository = createOpeningTutorJobsRepository(sql);

    await repository.markUnknown(scope, "job-1", "provider outcome unknown; usage reconciliation pending");

    const assistantUpdate = sql.calls.find((query) => query.includes("UPDATE opening_turns SET text"));
    expect(assistantUpdate).toContain("status = 'outcome_unknown'");
  });

  it("keeps an ordinary failure distinct from outcome_unknown", async () => {
    const sql = fakeSql(unclaimedTerminalJobUpdate);
    const repository = createOpeningTutorJobsRepository(sql);

    await repository.fail(scope, "job-1", "provider rejected the request");

    const assistantUpdate = sql.calls.find((query) => query.includes("UPDATE opening_turns SET text"));
    expect(assistantUpdate).toContain("status = 'failed'");
  });

  it("writes help exposure only after the assistant turn update succeeds", async () => {
    const sql = fakeSql((query) => {
      if (query.includes("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 0 }];
      if (query.includes("SELECT t.attempt_id,t.context_anchor")) return [{ assistant_turn_id: "assistant-turn-1", course_id: null }];
      if (query.includes("UPDATE opening_tutor_jobs SET status = 'succeeded'")) {
        return [{ id: "job-1" }];
      }
      if (query.includes("UPDATE opening_turns SET text")) {
        return [{ id: "assistant-turn-1" }];
      }
      if (query.includes("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("SELECT l.* FROM opening_learning_sessions")) {
        return [{ id: "session-1", course_id: "course-1", source_ids: [], activity_id: null }];
      }
      if (query.includes("SELECT c.id FROM courses")) return [{ id: "course-1" }];
      if (query.includes("SELECT t.id FROM opening_turns")) return [{ id: "assistant-turn-1" }];
      if (query.includes("RETURNING revision")) return [{ revision: 1 }];
      if (query.includes("INSERT INTO opening_help_exposures")) {
        return [{
          id: "exposure-1", workspace_id: scope.workspaceId, session_id: "session-1",
          problem_id: null, turn_id: "assistant-turn-1", level: "hinted", kind: "hint",
          delivered: true, attempt_id: null, activity_id: null, item_version_id: null,
          created_at: "2026-09-28T00:00:00Z", delivered_at: "2026-09-28T00:00:01Z",
          history_revision: 1,
        }];
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
        kind: "hint",
        level: "hinted",
        delivered: true,
      },
    });

    const assistantUpdate = sql.calls.findIndex((query) => query.includes("UPDATE opening_turns SET text"));
    const exposureInsert = sql.calls.findIndex((query) => query.includes("INSERT INTO opening_help_exposures"));
    expect(assistantUpdate).toBeGreaterThanOrEqual(0);
    expect(exposureInsert).toBeGreaterThan(assistantUpdate);
  });

  it("stores destination history versions even for user-selected sources absent from assistant refs", async () => {
    const courseId = "10000000-0000-4000-8000-000000000001";
    const sessionSource = "20000000-0000-4000-8000-000000000001";
    const activitySource = "20000000-0000-4000-8000-000000000002";
    const sharedSource = "20000000-0000-4000-8000-00000000000a";
    let savedRefs: unknown;
    const sql = fakeSql((query, values) => {
      if (query.includes("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 0 }];
      if (query.includes("SELECT t.attempt_id,t.context_anchor")) {
        return [{ assistant_turn_id: "assistant-turn-1", course_id: courseId, source_ids: [sharedSource.toUpperCase()] }];
      }
      if (query.includes("SELECT id FROM courses")) return [{ id: courseId }];
      if (query.includes("SELECT s.id,s.version FROM opening_sources")) {
        expect(values[1]).toEqual([sessionSource, activitySource, sharedSource]);
        return [{ id: sessionSource, version: 4 }, { id: activitySource, version: 2 }, { id: sharedSource, version: 3 }];
      }
      if (query.includes("FROM jsonb_to_recordset")) return [{ admitted: true }];
      if (query.includes("UPDATE opening_tutor_jobs SET status = 'succeeded'")) return [{ id: "job-1" }];
      if (query.includes("UPDATE opening_turns SET text")) {
        savedRefs = values[3];
        return [{ id: "assistant-turn-1" }];
      }
      return [];
    });
    await createOpeningTutorJobsRepository(sql).completeTurn({
      scope, jobId: "job-1", assistantTurnId: "assistant-turn-1", text: "answer",
      citations: [], candidates: [], contextSourceRefs: [],
    }, { historyCourseBindings: [{ courseId, materialUse: "citation",
      sourceIds: [activitySource, sharedSource, sessionSource], sourceRefs: [],
      selectedDestinationSourceIds: [activitySource, sharedSource, sessionSource],
    }] });

    const [contextRefs, backupRefs] = [
      parseContextSourceRefs(savedRefs),
      turnSourceReferences({ context_source_refs: savedRefs, source_ids: [], citations: [] }),
    ];
    expect({ contextRefs, backupRefs }).toEqual({
      contextRefs: [
        { sourceId: sessionSource, sourceVersion: 4 },
        { sourceId: activitySource, sourceVersion: 2 },
        { sourceId: sharedSource, sourceVersion: 3 },
      ],
      backupRefs: [sessionSource, activitySource, sharedSource],
    });
    const locks = [
      "FROM opening_workspace_history_revisions", "SELECT privacy_epoch FROM workspaces", "FROM courses",
      "ORDER BY s.id FOR SHARE OF s", "ORDER BY asset_id,course_id FOR SHARE",
    ].map(clause => sql.calls.findIndex(query => query.includes(clause)));
    expect(locks[0]).toBeGreaterThanOrEqual(0);
    for (const [index, lock] of locks.slice(1).entries()) expect(lock).toBeGreaterThan(locks[index]!);
  });

  it("does not write help exposure when the assistant turn was not persisted", async () => {
    const sql = fakeSql((query) => {
      if (query.includes("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 0 }];
      if (query.includes("SELECT t.attempt_id,t.context_anchor")) return [{ assistant_turn_id: "assistant-turn-1", course_id: null }];
      if (query.includes("SELECT id FROM workspaces") && !query.includes("privacy_epoch")) return [{ id: scope.workspaceId }];
      if (query.includes("INSERT INTO opening_workspace_history_revisions")) return [];
      if (query.includes("SELECT revision FROM opening_workspace_history_revisions")) return [{ revision: 1 }];
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
        kind: "hint",
        level: "hinted",
        delivered: true,
      },
    })).rejects.toThrow("assistant turn was not persisted");

    expect(sql.calls).not.toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO opening_help_exposures"),
    ]));
  });

  it("rejects completeTurn when the locked workspace privacy epoch drifted", async () => {
    const sql = fakeSql((query) => {
      if (query.includes("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("SELECT privacy_epoch FROM workspaces")) {
        return [{ privacy_epoch: 8 }];
      }
      if (query.includes("UPDATE opening_tutor_jobs SET status = 'succeeded'")) {
        return [{ id: "job-1" }];
      }
      if (query.includes("UPDATE opening_turns SET text")) {
        return [{ id: "assistant-turn-1" }];
      }
      return [];
    });
    const repository = createOpeningTutorJobsRepository(sql);

    await expect(repository.completeTurn({
      scope,
      jobId: "job-1",
      assistantTurnId: "assistant-turn-1",
      text: "answer",
      citations: [],
      candidates: [],
      expectedPrivacyEpoch: 7,
    })).rejects.toThrow(/privacy epoch drift/);

    expect(sql.calls[0]).toContain("SELECT id FROM workspaces");
    expect(sql.calls[0]).toContain("owner_user_id");
    expect(sql.calls[0]).not.toContain("FOR UPDATE");
    const historyLock = sql.calls.findIndex(query => query.includes("SELECT revision FROM opening_workspace_history_revisions"));
    const workspaceLock = sql.calls.findIndex(query => query.includes("SELECT privacy_epoch FROM workspaces"));
    expect(historyLock).toBeGreaterThan(0);
    expect(sql.calls[historyLock]).toContain("FOR UPDATE");
    expect(workspaceLock).toBeGreaterThan(historyLock);
    expect(sql.calls[workspaceLock]).toContain("FOR UPDATE");
    for (const table of ["opening_turns", "opening_tutor_jobs", "opening_workspace_history_revisions"]) {
      expect(sql.calls.some(query => query.includes(`UPDATE ${table}`))).toBe(false);
    }
    expect(sql.calls.filter(query => query.includes("INSERT"))).toEqual([
      expect.stringContaining("INSERT INTO opening_workspace_history_revisions"),
    ]);
  });

  it.each([false, true])("preserves permission errors without changing the existing exposure error (exposure=%s)", async exposure => {
    let ownerReads = 0;
    const sql = fakeSql(query => {
      if (query.includes("SELECT id FROM workspaces")) return ++ownerReads === 1 && !exposure ? [{ id: scope.workspaceId }] : [];
      return [];
    });
    const error = await createOpeningTutorJobsRepository(sql).completeTurn({ scope, jobId: "job-1", assistantTurnId: "assistant-turn-1",
      text: "answer", citations: [], candidates: [], ...(exposure ? { helpExposure: {
        id: "exposure-1", sessionId: "session-1", problemId: null, turnId: "assistant-turn-1",
        kind: "hint" as const, level: "hinted" as const, delivered: true as const,
      } } : {}) }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject(exposure ? { code: "NOT_FOUND", message: "workspace not found" } : { message: "workspace permission changed" });
    if (!exposure) expect(error).not.toHaveProperty("code");
    expect(sql.calls.some(query => /UPDATE|INSERT/.test(query))).toBe(false);
  });

  it("still rejects ownership drift at the locked reread after history ensure", async () => {
    const sql = fakeSql(query => query.includes("SELECT id FROM workspaces") ? [{ id: scope.workspaceId }] : []);
    await expect(createOpeningTutorJobsRepository(sql).completeTurn({ scope, jobId: "job-1", assistantTurnId: "assistant-turn-1",
      text: "answer", citations: [], candidates: [] })).rejects.toThrow("workspace permission changed");
    expect(sql.calls.some(query => query.includes("SELECT privacy_epoch FROM workspaces") && query.includes("FOR UPDATE"))).toBe(true);
    expect(sql.calls.some(query => query.includes("UPDATE opening_"))).toBe(false);
    expect(sql.calls.filter(query => query.includes("INSERT"))).toEqual([
      expect.stringContaining("INSERT INTO opening_workspace_history_revisions"),
    ]);
  });

  it.each([
    Object.assign(new Error("workspace not found"), { code: "CONFLICT" }),
    Object.assign(new Error("other entity not found"), { code: "NOT_FOUND" }),
    Object.assign(new Error("query failed"), { code: "23503" }),
  ])("does not mask unrelated history errors: %s", async failure => {
    let reads = 0;
    const sql = fakeSql(query => {
      if (query.includes("SELECT id FROM workspaces") && ++reads === 1) return [{ id: scope.workspaceId }];
      throw failure;
    });
    await expect(createOpeningTutorJobsRepository(sql).completeTurn({ scope, jobId: "job-1", assistantTurnId: "assistant-turn-1",
      text: "answer", citations: [], candidates: [] })).rejects.toBe(failure);
  });

  it("refuses completion before any durable write when workspace ownership no longer matches", async () => {
    const sql = fakeSql();
    await expect(createOpeningTutorJobsRepository(sql).completeTurn({ scope, jobId: "job-1", assistantTurnId: "assistant-turn-1",
      text: "answer", citations: [], candidates: [] })).rejects.toThrow("workspace permission changed");
    expect(sql.calls[0]).toContain("owner_user_id");
    expect(sql.calls.some(query => /UPDATE|INSERT/.test(query.replace("FOR UPDATE", "")))).toBe(false);
  });
});

describe("markTerminal history coordination", () => {
  function terminalSql(options: {
    missing?: boolean;
    helperError?: unknown;
    remaining?: boolean;
    lockedOwner?: string | null;
    jobError?: unknown;
  } = {}) {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    let history = false, rolledBack = false;
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ");
      calls.push({ query, values });
      if (query.includes("SELECT owner_user_id FROM workspaces")) return options.missing ? [] : [{ owner_user_id: "canonical-owner" }];
      if (query.includes("SELECT id, owner_user_id FROM workspaces")) return options.lockedOwner === null ? []
        : [{ id: scope.workspaceId, owner_user_id: options.lockedOwner ?? "canonical-owner" }];
      if (query.includes("SELECT id FROM workspaces")) {
        if (query.includes("owner_user_id") && options.helperError) throw options.helperError;
        return options.remaining === false ? [] : [{ id: scope.workspaceId }];
      }
      if (query.includes("INSERT INTO opening_workspace_history_revisions")) { history = true; return []; }
      if (query.includes("FROM opening_tutor_jobs") || query.includes("UPDATE opening_tutor_jobs")) {
        if (options.jobError) throw options.jobError;
        return [];
      }
      return [];
    }) as unknown as Sql;
    sql.json = ((value: unknown) => value) as Sql["json"];
    sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => {
      const before = history;
      try { return await callback(sql); }
      catch (error) { history = before; rolledBack = true; throw error; }
    }) as Sql["begin"];
    return { sql, calls, state: () => ({ history, rolledBack }) };
  }

  it("uses canonical ownership only for history and keeps stable input-owner mismatch as the legacy CAS no-op", async () => {
    const fake = terminalSql();
    await expect(createOpeningTutorJobsRepository(fake.sql).fail(scope, "job-1", "message")).resolves.toBeUndefined();
    const ensure = fake.calls.find(call => call.query.includes("INSERT INTO opening_workspace_history_revisions"));
    expect(ensure?.values).toEqual([scope.workspaceId, "canonical-owner"]);
    expect(fake.state()).toEqual({ history: true, rolledBack: false });
  });

  it.each(["fail", "markUnknown"] as const)("%s rolls back lazy history on deletion and propagates the original job error", async method => {
    const failure = Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    for (const jobError of [undefined, failure]) {
      const fake = terminalSql({ lockedOwner: null, jobError });
      const jobs = createOpeningTutorJobsRepository(fake.sql);
      const result = method === "fail" ? jobs.fail(scope, "bad-job", "message") : jobs.markUnknown(scope, "bad-job", "message");
      if (jobError) await expect(result).rejects.toBe(jobError);
      else await expect(result).resolves.toBeUndefined();
      expect(fake.state()).toEqual({ history: false, rolledBack: true });
      expect(fake.calls.some(call => call.query.includes("UPDATE opening_tutor_jobs"))).toBe(false);
    }
  });

  it("rejects owner coordination drift after history with rollback rather than false success", async () => {
    const fake = terminalSql({ lockedOwner: "new-owner" });
    await expect(createOpeningTutorJobsRepository(fake.sql).markUnknown(scope, "job-1", "message"))
      .rejects.toThrow("terminal history coordination drift: workspace owner changed");
    expect(fake.state()).toEqual({ history: false, rolledBack: true });
  });

  it.each([true, false])("preserves the exact helper not-found unless deletion is confirmed (remaining=%s)", async remaining => {
    const helperError = Object.assign(new Error("workspace not found"), { code: "NOT_FOUND" });
    const fake = terminalSql({ helperError, remaining });
    const result = createOpeningTutorJobsRepository(fake.sql).fail(scope, "job-1", "message");
    if (remaining) await expect(result).rejects.toBe(helperError);
    else await expect(result).resolves.toBeUndefined();
    expect(fake.state().history).toBe(false);
  });

  it.each([
    Object.assign(new Error("workspace not found"), { code: "CONFLICT" }),
    Object.assign(new Error("other entity not found"), { code: "NOT_FOUND" }),
    Object.assign(new Error("query failed"), { code: "23503" }),
    { code: "NOT_FOUND", message: "workspace not found" },
  ])("does not swallow unrelated helper errors: %s", async helperError => {
    const fake = terminalSql({ helperError, remaining: false });
    await expect(createOpeningTutorJobsRepository(fake.sql).fail(scope, "job-1", "message")).rejects.toBe(helperError);
    expect(fake.state()).toEqual({ history: false, rolledBack: true });
  });

  it("does not mistake a job error with the rollback signal's message for its private identity", async () => {
    const jobError = new Error("terminal workspace deleted after history ensure");
    const fake = terminalSql({ jobError });
    await expect(createOpeningTutorJobsRepository(fake.sql).fail(scope, "job-1", "message")).rejects.toBe(jobError);
    expect(fake.state()).toEqual({ history: false, rolledBack: true });
    expect(fake.calls.some(call => call.query.includes("SELECT id FROM opening_tutor_jobs"))).toBe(false);
  });

  it("keeps job errors when canonical workspace was already absent", async () => {
    const jobError = Object.assign(new Error("invalid job uuid"), { code: "22P02" });
    const fake = terminalSql({ missing: true, lockedOwner: null, jobError });
    await expect(createOpeningTutorJobsRepository(fake.sql).fail(scope, "invalid", "message")).rejects.toBe(jobError);
    expect(fake.state().history).toBe(false);
  });
});

describe("cancel history coordination", () => {
  function cancelSql(options: {
    missing?: boolean;
    helperError?: unknown;
    remaining?: boolean;
    lockedOwner?: string | null;
    jobError?: unknown;
    readError?: unknown;
    turnError?: unknown;
    job?: boolean;
  } = {}) {
    let history = false, job = false, turn = false, rolledBack = false, readbacks = 0;
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("SELECT owner_user_id FROM workspaces")) return options.missing ? [] : [{ owner_user_id: "canonical-owner" }];
      if (query.includes("SELECT id, owner_user_id FROM workspaces")) return options.lockedOwner === null ? []
        : [{ id: scope.workspaceId, owner_user_id: options.lockedOwner ?? "canonical-owner" }];
      if (query.includes("SELECT id FROM workspaces")) {
        if (query.includes("owner_user_id") && options.helperError) throw options.helperError;
        return options.remaining === false ? [] : [{ id: scope.workspaceId }];
      }
      if (query.includes("INSERT INTO opening_workspace_history_revisions")) { history = true; return []; }
      if (query.includes("SELECT j.id FROM opening_tutor_jobs")) {
        readbacks++;
        if (options.readError) throw options.readError;
        return [];
      }
      if (query.includes("UPDATE opening_tutor_jobs")) {
        if (options.jobError) throw options.jobError;
        if (!options.job) return [];
        job = true;
        return [{ id: "job-1", workspace_id: scope.workspaceId, conversation_id: "conversation-1", user_turn_id: "user-turn-1",
          assistant_turn_id: "assistant-turn-1", status: "cancelled", mode: "explain", error: { message: "cancelled by user" },
          created_at: "2026-11-09T00:00:00Z", updated_at: "2026-11-09T00:00:01Z" }];
      }
      if (query.includes("UPDATE opening_turns")) {
        turn = true;
        if (options.turnError) throw options.turnError;
      }
      return [];
    }) as unknown as Sql;
    sql.json = ((value: unknown) => value) as Sql["json"];
    sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => {
      try { return await callback(sql); }
      catch (error) { history = job = turn = false; rolledBack = true; throw error; }
    }) as Sql["begin"];
    return { sql, state: () => ({ history, job, turn, rolledBack, readbacks }) };
  }

  it("maps successful cancellation and returns null without a target", async () => {
    const success = cancelSql({ job: true });
    await expect(createOpeningTutorJobsRepository(success.sql).cancel(scope, "job-1")).resolves.toMatchObject({
      id: "job-1", workspaceId: scope.workspaceId, status: "cancelled", assistantTurnId: "assistant-turn-1",
      createdAt: "2026-11-09T00:00:00.000Z", error: { message: TUTOR_CANCELLED_MESSAGE },
    });
    expect(success.state()).toEqual({ history: true, job: true, turn: true, rolledBack: false, readbacks: 0 });
    const absent = cancelSql();
    await expect(createOpeningTutorJobsRepository(absent.sql).cancel(scope, "job-1")).resolves.toBeNull();
    expect(absent.state()).toEqual({ history: true, job: false, turn: false, rolledBack: false, readbacks: 0 });
  });

  it.each([null, "new-owner"])("rolls back history on locked workspace drift (%s), preserving read-only UUID errors", async lockedOwner => {
    const failure = Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    for (const readError of [undefined, failure]) {
      const fake = cancelSql({ lockedOwner, readError, job: true });
      const result = createOpeningTutorJobsRepository(fake.sql).cancel(scope, "job-1");
      if (readError) await expect(result).rejects.toBe(readError);
      else await expect(result).resolves.toBeNull();
      expect(fake.state()).toEqual({ history: false, job: false, turn: false, rolledBack: true, readbacks: 1 });
    }
  });

  it.each([true, false])("only follows the original null path for exact helper not-found with confirmed deletion (remaining=%s)", async remaining => {
    const helperError = Object.assign(new Error("workspace not found"), { code: "NOT_FOUND" });
    const fake = cancelSql({ helperError, remaining, lockedOwner: null });
    const result = createOpeningTutorJobsRepository(fake.sql).cancel(scope, "job-1");
    if (remaining) await expect(result).rejects.toBe(helperError);
    else await expect(result).resolves.toBeNull();
    expect(fake.state().history).toBe(false);
    expect(fake.state().readbacks).toBe(0);
  });

  it.each([
    Object.assign(new Error("workspace not found"), { code: "CONFLICT" }),
    Object.assign(new Error("other entity not found"), { code: "NOT_FOUND" }),
    Object.assign(new Error("query failed"), { code: "23503" }),
    { code: "NOT_FOUND", message: "workspace not found" },
  ])("propagates unrelated helper errors by identity: %s", async helperError => {
    const fake = cancelSql({ helperError, remaining: false });
    await expect(createOpeningTutorJobsRepository(fake.sql).cancel(scope, "job-1")).rejects.toBe(helperError);
    expect(fake.state()).toEqual({ history: false, job: false, turn: false, rolledBack: true, readbacks: 0 });
  });

  it.each(["job", "turn"] as const)("propagates %s errors without mistaking a matching message for the private rollback signal", async stage => {
    const failure = new Error("cancel workspace changed after history ensure");
    const fake = cancelSql({ job: true, ...(stage === "job" ? { jobError: failure } : { turnError: failure }) });
    await expect(createOpeningTutorJobsRepository(fake.sql).cancel(scope, "job-1")).rejects.toBe(failure);
    expect(fake.state()).toEqual({ history: false, job: false, turn: false, rolledBack: true, readbacks: 0 });
  });

  it("does not swallow invalid job UUIDs on the original missing-workspace path", async () => {
    const failure = Object.assign(new Error("invalid job UUID"), { code: "22P02" });
    const fake = cancelSql({ missing: true, lockedOwner: null, jobError: failure });
    await expect(createOpeningTutorJobsRepository(fake.sql).cancel(scope, "invalid")).rejects.toBe(failure);
    expect(fake.state()).toEqual({ history: false, job: false, turn: false, rolledBack: true, readbacks: 0 });
  });
});

describe("LAB-U01 clarify terminal turn", () => {
  it("ends a page refusal's assistant turn as clarify while the job stays failed with nextAction clarify", async () => {
    const sql = capturingSql(unclaimedTerminalJobUpdate);
    await createOpeningTutorJobsRepository(sql).fail(scope, "job-1", "请重新选择材料和页码", { code: "page_not_in_sources", nextAction: "clarify" });
    const jobUpdate = sql.calls.find((call) => call.query.includes("UPDATE opening_tutor_jobs SET status = 'failed'"));
    expect(jobUpdate?.values).toContainEqual({ message: "请重新选择材料和页码", code: "page_not_in_sources", nextAction: "clarify" });
    const turnUpdate = sql.calls.find((call) => call.query.includes("UPDATE opening_turns SET text"));
    expect(turnUpdate?.query).toContain("status = 'clarify'");
    expect(turnUpdate?.query).not.toContain("status = 'failed'");
  });

  function capturingSql(handler: (query: string) => unknown[]) {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ");
      calls.push({ query, values });
      if (query.includes("FROM workspaces")) return [{ id: scope.workspaceId, owner_user_id: scope.ownerUserId }];
      return handler(query);
    }) as unknown as Sql & { calls: typeof calls };
    sql.calls = calls;
    sql.json = ((value: unknown) => value) as Sql["json"];
    sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];
    return sql;
  }

  it("guards every terminal turn rewrite with the shared terminal list, which includes clarify", async () => {
    const sql = capturingSql(unclaimedTerminalJobUpdate);
    const repository = createOpeningTutorJobsRepository(sql);
    await repository.fail(scope, "job-1", "provider rejected the request");
    await repository.markUnknown(scope, "job-1", "provider outcome unknown");
    const turnUpdates = sql.calls.filter((call) => call.query.includes("UPDATE opening_turns SET text"));
    expect(turnUpdates).toHaveLength(2);
    for (const update of turnUpdates) {
      expect(update.query).toContain("NOT (status = ANY(");
      expect(update.values).toContainEqual(["complete", "failed", "clarify", "outcome_unknown"]);
    }
  });
});
