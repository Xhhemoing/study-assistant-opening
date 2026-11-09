import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningTeachingActivitiesRepository, ensureCourseContinueActivity } from "./opening-teaching-activities";
import { OPENING_BACKUP_TABLES } from "./opening-backup-records";
import {
  nextLearningActivityHistoryRevision,
  lockLearningSession,
} from "./opening-learning-facts";
import type { TransactionSql } from "postgres";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const otherOwner = "00000000-0000-4000-8000-000000000099";
const courseId = "00000000-0000-4000-8000-000000000003";
const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const scope = { workspaceId, ownerUserId };

function db(handler: (query: string, values: unknown[]) => unknown[]) {
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings as object, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    if (/INSERT|UPDATE|DELETE/.test(query)) writes.push({ query, values });
    return Promise.resolve(handler(query, values));
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return { sql, writes };
}

describe("opening teaching activities repository (unit)", () => {
  it("creates an activity without a course", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("client_key")) return [];
      if (query.includes("INSERT INTO opening_teaching_activities")) {
        return [{
          id: activityId,
          workspace_id: workspaceId,
          owner_user_id: ownerUserId,
          course_id: null,
          status: "active",
          generate_status: "ready",
          intent_kind: "question",
          intent_summary: "Why?",
          source_ids: [],
          path_version: 1,
          content_version: 0,
          checkpoint_json: {},
          client_key: "activity-key-01",
          create_intent: { intentKind: "question" },
          created_at: "2026-10-11T02:00:00.000Z",
          updated_at: "2026-10-11T02:00:00.000Z",
        }];
      }
      return [];
    });
    const created = await createOpeningTeachingActivitiesRepository(sql).create(scope, {
      clientKey: "activity-key-01",
      intentKind: "question",
      intentSummary: "Why?",
      createIntent: { intentKind: "question" },
    });
    expect(created.courseId).toBeNull();
    expect(created.intentKind).toBe("question");
    expect(writes.some((w) => w.query.includes("INSERT INTO opening_teaching_activities"))).toBe(true);
  });

  it("rejects cross-owner activity access", async () => {
    const { sql } = db((query) => {
      if (query.includes("FROM opening_teaching_activities")) return [];
      return [];
    });
    await expect(
      createOpeningTeachingActivitiesRepository(sql).assertOwnedActivity(
        { workspaceId, ownerUserId: otherOwner },
        activityId,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("replays the same clientKey with the same create intent", async () => {
    const row = {
      id: activityId,
      workspace_id: workspaceId,
      owner_user_id: ownerUserId,
      course_id: null,
      status: "active",
      generate_status: "ready",
      intent_kind: "topic",
      intent_summary: "Review",
      source_ids: [],
      path_version: 1,
      content_version: 0,
      checkpoint_json: {},
      client_key: "activity-key-02",
      create_intent: { intentKind: "topic", intentSummary: "Review" },
      created_at: "2026-10-11T02:00:00.000Z",
      updated_at: "2026-10-11T02:00:00.000Z",
    };
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("client_key")) return [row];
      return [];
    });
    const replayed = await createOpeningTeachingActivitiesRepository(sql).create(scope, {
      clientKey: "activity-key-02",
      intentKind: "topic",
      intentSummary: "Review",
      createIntent: { intentKind: "topic", intentSummary: "Review" },
    });
    expect(replayed.id).toBe(activityId);
    expect(writes.some((w) => w.query.includes("INSERT INTO opening_teaching_activities"))).toBe(false);
  });

  it("conflicts when the same clientKey carries a different intent", async () => {
    const row = {
      id: activityId,
      workspace_id: workspaceId,
      owner_user_id: ownerUserId,
      course_id: null,
      status: "active",
      generate_status: "ready",
      intent_kind: "topic",
      intent_summary: "Review",
      source_ids: [],
      path_version: 1,
      content_version: 0,
      checkpoint_json: {},
      client_key: "activity-key-03",
      create_intent: { intentKind: "topic", intentSummary: "Review" },
      created_at: "2026-10-11T02:00:00.000Z",
      updated_at: "2026-10-11T02:00:00.000Z",
    };
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("client_key")) return [row];
      return [];
    });
    await expect(
      createOpeningTeachingActivitiesRepository(sql).create(scope, {
        clientKey: "activity-key-03",
        intentKind: "question",
        intentSummary: "Different",
        createIntent: { intentKind: "question", intentSummary: "Different" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("associate/unassociate updates activity.course_id only and never rewrites observation.course_id", async () => {
    const activityRow = {
      id: activityId,
      workspace_id: workspaceId,
      owner_user_id: ownerUserId,
      course_id: null,
      status: "active",
      generate_status: "ready",
      intent_kind: "material",
      intent_summary: "Notes",
      source_ids: [],
      path_version: 1,
      content_version: 0,
      checkpoint_json: {},
      client_key: "activity-key-04",
      create_intent: { intentKind: "material" },
      created_at: "2026-10-11T02:00:00.000Z",
      updated_at: "2026-10-11T02:00:00.000Z",
    };
    const { sql, writes } = db((query, values) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [activityRow];
      }
      if (query.includes("FROM courses")) return [{ id: courseId }];
      if (query.includes("UPDATE opening_teaching_activities")) {
        return [{ ...activityRow, course_id: values[0] ?? null, updated_at: "2026-10-11T03:00:00.000Z" }];
      }
      return [];
    });
    const repo = createOpeningTeachingActivitiesRepository(sql);
    const associated = await repo.associateCourse(scope, activityId, { courseId });
    expect(associated.courseId).toBe(courseId);
    const unassociated = await repo.associateCourse(scope, activityId, { courseId: null });
    expect(unassociated.courseId).toBeNull();
    const mutationWrites = writes.filter((w) => /\b(INSERT|UPDATE|DELETE)\b/i.test(w.query) && !/FOR UPDATE/i.test(w.query));
    expect(mutationWrites.length).toBeGreaterThan(0);
    expect(mutationWrites.every((w) => w.query.includes("UPDATE opening_teaching_activities"))).toBe(true);
    expect(mutationWrites.every((w) => !w.query.includes("opening_learning_observations"))).toBe(true);
    expect(writes.some((w) => /UPDATE\s+opening_learning_observations/i.test(w.query))).toBe(false);
  });

  it("registers new backup tables and skill_evidence", () => {
    expect(OPENING_BACKUP_TABLES).toContain("opening_teaching_activities");
    expect(OPENING_BACKUP_TABLES).toContain("opening_learning_activity_history_revisions");
    expect(OPENING_BACKUP_TABLES).toContain("opening_skill_evidence");
    expect(OPENING_BACKUP_TABLES).not.toContain("opening_learning_eligibility");
  });

  it("advances the option A activity history revision counter", async () => {
    let revision = 0;
    const { sql } = db((query) => {
      if (query.includes("INSERT INTO opening_learning_activity_history_revisions")) {
        revision += 1;
        return [{ revision }];
      }
      return [];
    });
    const first = await nextLearningActivityHistoryRevision(sql as unknown as TransactionSql, scope, activityId);
    const second = await nextLearningActivityHistoryRevision(sql as unknown as TransactionSql, scope, activityId);
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it("locks no-course sessions via activity ownership without a courses JOIN archive check", async () => {
    const queries: string[] = [];
    const { sql } = db((query) => {
      queries.push(query);
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_learning_sessions")) {
        return [{
          id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
          workspace_id: workspaceId,
          owner_user_id: ownerUserId,
          course_id: null,
          activity_id: activityId,
          skill_label: "topic",
          source_ids: [],
        }];
      }
      if (query.includes("FROM opening_teaching_activities")) return [{ id: activityId }];
      return [];
    });
    const session = await lockLearningSession(
      sql as unknown as TransactionSql,
      scope,
      "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    );
    expect(session.course_id).toBeNull();
    expect(queries.some((q) => q.includes("JOIN courses") || q.includes("archived_at"))).toBe(false);
    expect(queries.some((q) => q.includes("FROM opening_teaching_activities"))).toBe(true);
  });
});


describe("V2-07 enqueueCompileTeachingUnit / setGenerateStatus", () => {
  it("enqueues compile-teaching-unit with outbox and sets generate_status queued", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("SELECT status FROM opening_teaching_activities")) return [{ status: "active" }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("JOIN workspaces")) {
        return [{
          id: activityId,
          workspace_id: workspaceId,
          owner_user_id: ownerUserId,
          course_id: null,
          status: "active",
          generate_status: "ready",
          intent_kind: "question",
          intent_summary: "Why?",
          source_ids: [],
          path_version: 1,
          content_version: 0,
          checkpoint_json: {},
          client_key: "activity-key-01",
          create_intent: { intentKind: "question" },
          created_at: "2026-10-11T02:00:00.000Z",
          updated_at: "2026-10-11T02:00:00.000Z",
        }];
      }
      if (query.includes("SELECT privacy_epoch FROM workspaces")) {
        return [{ privacy_epoch: 2 }];
      }
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("INSERT INTO opening_jobs")) {
        return [{ id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1" }];
      }
      return [];
    });
    const repo = createOpeningTeachingActivitiesRepository(sql);
    const result = await repo.enqueueCompileTeachingUnit(scope, {
      activityId,
      mode: "generate",
      clientKey: "compile-client-01",
      expectedContentVersion: 0,
    });
    expect(result.created).toBe(true);
    expect(result.kind).toBe("compile-teaching-unit");
    expect(writes.some((w) => w.query.includes("INSERT INTO opening_outbox"))).toBe(true);
    expect(writes.some((w) => w.query.includes("generate_status") && w.query.includes("UPDATE"))).toBe(true);
  });

  it("setGenerateStatus fences from-set", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("SELECT id,generate_status FROM opening_teaching_activities")) return [{ id: activityId, generate_status: "queued" }];
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("UPDATE opening_teaching_activities") && query.includes("generate_status")) {
        return [{ id: activityId }];
      }
      return [];
    });
    const ok = await createOpeningTeachingActivitiesRepository(sql).setGenerateStatus(
      scope,
      activityId,
      "generating",
      { from: ["queued", "generating"] },
    );
    expect(ok).toBe(true);
    expect(writes.some((w) => w.query.includes("generate_status"))).toBe(true);
  });
});

/** Statement writes only; the harness also records SELECT … FOR UPDATE. */
const mutations = (writes: Array<{ query: string }>) =>
  writes.filter((w) => (w.query.trimStart().startsWith("INSERT") || w.query.trimStart().startsWith("UPDATE"))
    && !w.query.includes("INSERT INTO opening_workspace_history_revisions"));

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: activityId,
    workspace_id: workspaceId,
    owner_user_id: ownerUserId,
    course_id: null,
    status: "active",
    generate_status: "ready",
    intent_kind: "topic",
    intent_summary: "今日主题学习",
    source_ids: [],
    path_version: 1,
    content_version: 0,
    checkpoint_json: {},
    client_key: "today-topic:2026-10-13",
    create_intent: { intentKind: "topic" },
    created_at: "2026-10-13T02:00:00.000Z",
    updated_at: "2026-10-13T02:00:00.000Z",
    ...overrides,
  };
}

describe("create + compile enqueue", () => {
  const input = {
    clientKey: "today-topic:2026-10-13",
    intentKind: "topic" as const,
    intentSummary: "今日主题学习",
    createIntent: { intentKind: "topic" },
  };

  it("enqueueCompile creates the activity queued with a generate job + outbox in one transaction", async () => {
    let inserted: unknown[] = [];
    const { sql, writes } = db((query, values) => {
      if (query.includes("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 3 }];
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("INSERT INTO opening_teaching_activities")) {
        inserted = values;
        return [activityRow({ generate_status: "queued" })];
      }
      if (query.includes("INSERT INTO opening_jobs")) return [{ id: "job-1" }];
      return [];
    });
    const created = await createOpeningTeachingActivitiesRepository(sql).create(scope, input, {
      enqueueCompile: true,
    });
    expect(created.generateStatus).toBe("queued");
    expect(inserted).toContain("queued");
    const job = writes.find((w) => w.query.includes("INSERT INTO opening_jobs"))!;
    expect(job.values).toContain("compile-teaching-unit");
    expect(job.values).toContain(3);
    expect(job.values).toContainEqual({
      mode: "generate",
      activityId: inserted[0],
      expectedContentVersion: 0,
      clientKey: input.clientKey,
      sourceIds: [],
    });
    expect(writes.some((w) => w.query.includes("INSERT INTO opening_outbox"))).toBe(true);
  });

  it("without enqueueCompile keeps the legacy ready shell and writes no job", async () => {
    let inserted: unknown[] = [];
    const { sql, writes } = db((query, values) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("INSERT INTO opening_teaching_activities")) {
        inserted = values;
        return [activityRow()];
      }
      return [];
    });
    await createOpeningTeachingActivitiesRepository(sql).create(scope, input);
    expect(inserted).toContain("ready");
    expect(writes.some((w) => w.query.includes("opening_jobs"))).toBe(false);
  });

  it("a clientKey replay returns the existing activity and never enqueues again", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("client_key")) {
        return [activityRow({ generate_status: "needs_check", content_version: 1 })];
      }
      return [];
    });
    const replay = await createOpeningTeachingActivitiesRepository(sql).create(scope, input, {
      enqueueCompile: true,
    });
    expect(replay.generateStatus).toBe("needs_check");
    expect(mutations(writes)).toEqual([]);
  });
});

describe("requestCompile", () => {
  function setup(row: Record<string, unknown>, jobInserted = true) {
    return db((query) => {
      if (query.includes("SELECT privacy_epoch FROM workspaces")) return [{ privacy_epoch: 0 }];
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_sources")) {
        return (row.source_ids as string[]).map((id) => ({ id, version: 1, bytes: 1, sha256: "x" }));
      }
      if (query.includes("SELECT * FROM opening_teaching_activities")) return [row];
      if (query.includes("INSERT INTO opening_jobs")) return jobInserted ? [{ id: "job-2" }] : [];
      if (query.includes("UPDATE opening_teaching_activities")) return [{ ...row, generate_status: "queued" }];
      return [];
    });
  }

  it("queues a generate job for the legacy ready shell with no content (Hermes cv 0)", async () => {
    const sourceId = "00000000-0000-4000-8000-0000000000aa";
    const { sql, writes } = setup(activityRow({ source_ids: [sourceId] }));
    const result = await createOpeningTeachingActivitiesRepository(sql).requestCompile(
      scope,
      activityId,
      "compile:abc123",
    );
    expect(result).toMatchObject({ jobId: expect.any(String), activity: { generateStatus: "queued" } });
    const job = writes.find((w) => w.query.includes("INSERT INTO opening_jobs"))!;
    expect(job.values).toContain(`compile-teaching-unit:${activityId}:generate:compile:abc123`);
    expect(job.values).toContainEqual(expect.objectContaining({ sourceIds: [sourceId], expectedContentVersion: 0 }));
    expect(writes.some((w) => w.query.includes("INSERT INTO opening_source_versions"))).toBe(true);
  });

  it("retries a failed compile from the current content version", async () => {
    const { sql, writes } = setup(activityRow({ generate_status: "failed", content_version: 2 }));
    await createOpeningTeachingActivitiesRepository(sql).requestCompile(scope, activityId, "compile:retry1");
    const job = writes.find((w) => w.query.includes("INSERT INTO opening_jobs"))!;
    expect(job.values).toContainEqual(expect.objectContaining({ expectedContentVersion: 2 }));
  });

  it.each([
    ["queued", 0],
    ["generating", 0],
    ["ready", 1],
    ["needs_check", 1],
  ])("rejects %s (cv %i) without writing a job", async (status, contentVersion) => {
    const { sql, writes } = setup(activityRow({ generate_status: status, content_version: contentVersion }));
    await expect(
      createOpeningTeachingActivitiesRepository(sql).requestCompile(scope, activityId, "compile:dup0001"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mutations(writes)).toEqual([]);
  });

  it("rejects a reused clientKey instead of silently returning", async () => {
    const { sql, writes } = setup(activityRow(), false);
    await expect(
      createOpeningTeachingActivitiesRepository(sql).requestCompile(scope, activityId, "compile:dup0002"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(writes.some((w) => w.query.includes("UPDATE opening_teaching_activities"))).toBe(false);
  });
});


describe("V2-14 setStatus active↔paused (T15)", () => {
  it("updates status to paused with optional CAS", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces")) {
        return [{ id: workspaceId }];
      }
      if (query.includes("FROM opening_teaching_activities")) {
        return [{
          id: activityId,
          workspace_id: workspaceId,
          owner_user_id: ownerUserId,
          course_id: null,
          status: "active",
          generate_status: "ready",
          intent_kind: "question",
          intent_summary: "Why?",
          source_ids: [],
          path_version: 1,
          content_version: 0,
          checkpoint_json: {},
          client_key: "long-enough-key",
          created_at: "2026-10-11T04:00:00.000Z",
          updated_at: "2026-10-11T04:00:00.000Z",
        }];
      }
      if (query.includes("UPDATE opening_teaching_activities") && query.includes("status")) {
        return [{
          id: activityId,
          workspace_id: workspaceId,
          owner_user_id: ownerUserId,
          course_id: null,
          status: "paused",
          generate_status: "ready",
          intent_kind: "question",
          intent_summary: "Why?",
          source_ids: [],
          path_version: 1,
          content_version: 0,
          checkpoint_json: {},
          client_key: "long-enough-key",
          created_at: "2026-10-11T04:00:00.000Z",
          updated_at: "2026-10-11T04:05:00.000Z",
        }];
      }
      return [];
    });
    const repo = createOpeningTeachingActivitiesRepository(sql);
    const updated = await repo.setStatus(scope, activityId, { status: "paused" });
    expect(updated.status).toBe("paused");
    expect(writes.some((w) => /UPDATE opening_teaching_activities/.test(w.query) && w.query.includes("status"))).toBe(true);
  });
});

describe("teaching root history fence", () => {
  const roots = ["ensure", "status", "generate", "request", "enqueue"] as const;
  function run(sql: Sql, root: typeof roots[number]) {
    const repo = createOpeningTeachingActivitiesRepository(sql);
    switch (root) {
      case "ensure": return ensureCourseContinueActivity(sql, scope, courseId);
      case "status": return repo.setStatus(scope, activityId, { status: "paused" });
      case "generate": return repo.setGenerateStatus(scope, activityId, "generating", { from: ["queued"] });
      case "request": return repo.requestCompile(scope, activityId, "history-request");
      case "enqueue": return repo.enqueueCompileTeachingUnit(scope, {
        activityId, mode: "generate", clientKey: "history-enqueue", expectedContentVersion: 0,
      });
    }
  }

  it.each(roots)("%s propagates the history barrier error before any business lock or mutation", async root => {
    const queries: string[] = [], barrier = Object.assign(new Error("history lock unavailable"), { code: "55P03" });
    const { sql } = db(query => {
      queries.push(query);
      if (query.includes("SELECT revision FROM opening_workspace_history_revisions")) throw barrier;
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities")) return [activityRow({ generate_status: root === "generate" ? "queued" : "ready" })];
      return [];
    });
    await expect(run(sql, root)).rejects.toBe(barrier);
    expect(queries.filter(q => /FOR SHARE|FOR UPDATE/.test(q))).toHaveLength(1);
    expect(queries.at(-1)).toContain("SELECT revision FROM opening_workspace_history_revisions");
    expect(queries.filter(q => /^\s*(INSERT|UPDATE|DELETE)/.test(q)))
      .toEqual([expect.stringContaining("INSERT INTO opening_workspace_history_revisions")]);
  });

  it.each([
    ["missing status", "NOT_FOUND", "teaching activity not found"],
    ["status CAS", "CONFLICT", "teaching activity updated_at mismatch"],
    ["completed status", "CONFLICT", "completed teaching activity cannot be reopened"],
    ["missing request", "NOT_FOUND", "teaching activity not found"],
    ["completed request", "CONFLICT", "completed teaching activity cannot generate new content"],
    ["queued request", "CONFLICT", "teaching content is already being generated"],
    ["source request", "VALIDATION", "source unavailable or privacy-excluded"],
    ["purpose request", "CONFLICT", "课程资料用途已变化，不能作为本次教材；请重新选择材料。"],
    ["dedup request", "CONFLICT", "compile request clientKey already used"],
    ["completed enqueue", "CONFLICT", "completed teaching activity cannot generate new content"],
    ["purpose enqueue", "CONFLICT", "课程资料用途已变化，不能作为本次教材；请重新选择材料。"],
    ["dedup enqueue", "CONFLICT", "idempotency payload differs for the same key"],
    ["missing course", "NOT_FOUND", "course not found"],
    ["stale worker", "CONFLICT", "job execution is no longer current"],
  ])("%s keeps its original error without history, locks or writes", async (name, code, message) => {
    const queries: string[] = [];
    const row = activityRow({ status: name.startsWith("completed") ? "completed" : "active",
      generate_status: name === "queued request" ? "queued" : "ready",
      course_id: name.startsWith("purpose") ? courseId : null,
      source_ids: name.startsWith("source") || name.startsWith("purpose") ? [activityId] : [] });
    const { sql, writes } = db(query => {
      queries.push(query);
      if (query.includes("opening_workspace_history_revisions")) throw new Error("unexpected history");
      if (query.includes("FROM workspaces w JOIN opening_jobs")) return [];
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities")) return name.startsWith("missing") ? [] : [row];
      if (query.includes("FROM opening_sources")) return name.startsWith("purpose") ? [{ id: activityId }] : [];
      if (query.includes("FROM opening_jobs")) return name.startsWith("dedup") ? [{ id: activityId, payload: {} }] : [];
      return [];
    });
    const repo = createOpeningTeachingActivitiesRepository(sql);
    const result = name.includes("status") ? repo.setStatus(scope, activityId, { status: "active",
      ...(name === "status CAS" ? { expectedUpdatedAt: "2020-01-01T00:00:00.000Z" } : {}) })
      : name.includes("request") ? repo.requestCompile(scope, activityId, "precheck-request")
      : name.includes("enqueue") ? repo.enqueueCompileTeachingUnit(scope, { activityId, mode: "generate", clientKey: "precheck-enqueue", expectedContentVersion: 0 })
      : name === "missing course" ? ensureCourseContinueActivity(sql, scope, courseId)
      : repo.setGenerateStatus({ ...scope, jobExecution: { id: activityId, token: activityId, privacyEpoch: 0 } } as typeof scope, activityId, "failed");
    await expect(result).rejects.toMatchObject({ code, message });
    expect(writes).toEqual([]);
    expect(queries.some(q => /FOR SHARE|FOR UPDATE/.test(q))).toBe(false);
  });

  it("ordinary generate from-set mismatch returns false without history or writes", async () => {
    const { sql, writes } = db(query => {
      if (query.includes("FROM opening_teaching_activities")) return [activityRow()];
      throw new Error("unexpected history or owner lock");
    });
    expect(await createOpeningTeachingActivitiesRepository(sql).setGenerateStatus(scope, activityId, "failed", { from: ["queued"] })).toBe(false);
    expect(writes).toEqual([]);
  });

  it("rechecks status CAS after history instead of treating the probe as an authorization snapshot", async () => {
    const { sql, writes } = db(query => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities")) return [activityRow(query.includes("FOR UPDATE")
        ? { updated_at: "2026-10-13T03:00:00.000Z" } : {})];
      return [];
    });
    await expect(createOpeningTeachingActivitiesRepository(sql).setStatus(scope, activityId,
      { status: "paused", expectedUpdatedAt: "2026-10-13T02:00:00.000Z" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "teaching activity updated_at mismatch" });
    expect(mutations(writes)).toEqual([]);
  });

  it("worker revalidates execution under the original locks after the read-only probe", async () => {
    const { sql, writes } = db(query => {
      if (query.includes("FROM workspaces w JOIN opening_jobs")) return [{ id: activityId }];
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities")) return [activityRow()];
      return [];
    });
    await expect(createOpeningTeachingActivitiesRepository(sql).setGenerateStatus({ ...scope,
      jobExecution: { id: activityId, token: activityId, privacyEpoch: 0 } } as typeof scope, activityId, "failed"))
      .rejects.toMatchObject({ code: "CONFLICT", message: "job execution is no longer current" });
    expect(writes.some(w => w.query.includes("INSERT INTO opening_workspace_history_revisions"))).toBe(true);
    expect(mutations(writes)).toEqual([]);
  });

  it("ensure replays the original key without advancing or creating another activity", async () => {
    const { sql, writes } = db(query => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities")) return [{ id: activityId }];
      return [];
    });
    expect(await ensureCourseContinueActivity(sql, scope, courseId)).toBe(activityId);
    expect(mutations(writes)).toEqual([]);
  });

  it("status preserves updated_at CAS precedence and message", async () => {
    const { sql, writes } = db(query => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities")) return [activityRow({ status: "completed" })];
      return [];
    });
    await expect(createOpeningTeachingActivitiesRepository(sql).setStatus(scope, activityId,
      { status: "active", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "teaching activity updated_at mismatch" });
    expect(mutations(writes)).toEqual([]);
  });

  it("generate refuses ownership drift after the ordinary target probe without mutating the target", async () => {
    const { sql, writes } = db(query => query.includes("FROM opening_teaching_activities") ? [{ id: activityId }] : []);
    await expect(createOpeningTeachingActivitiesRepository(sql).setGenerateStatus(scope, activityId, "failed"))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "workspace not found" });
    expect(writes).toEqual([]);
  });

  it("generate does not translate PostgreSQL UUID errors from the original target predicates", async () => {
    const cast = Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    const { sql, writes } = db(() => { throw cast; });
    await expect(createOpeningTeachingActivitiesRepository(sql).setGenerateStatus(scope, "bad-uuid", "failed")).rejects.toBe(cast);
    expect(writes).toEqual([]);
  });

  it("generate keeps false for an unowned workspace and never writes history", async () => {
    const { sql, writes } = db(() => []);
    expect(await createOpeningTeachingActivitiesRepository(sql).setGenerateStatus(scope, activityId, "failed")).toBe(false);
    expect(writes).toEqual([]);
    await expect(createOpeningTeachingActivitiesRepository(sql).setGenerateStatus({ ...scope,
      jobExecution: { id: activityId, token: activityId, privacyEpoch: 0 } } as typeof scope, activityId, "failed"))
      .rejects.toMatchObject({ code: "CONFLICT", message: "job execution is no longer current" });
    expect(writes).toEqual([]);
  });
});
