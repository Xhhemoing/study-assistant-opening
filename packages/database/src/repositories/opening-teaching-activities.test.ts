import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningTeachingActivitiesRepository } from "./opening-teaching-activities";
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
  writes.filter((w) => w.query.trimStart().startsWith("INSERT") || w.query.trimStart().startsWith("UPDATE"));

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
      if (query.includes("FROM workspaces") && query.includes("FOR SHARE")) {
        return [{ id: workspaceId }];
      }
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
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
