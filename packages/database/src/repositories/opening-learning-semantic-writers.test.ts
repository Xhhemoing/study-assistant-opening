import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningSourceRepository } from "./opening-sources";
import { createOpeningSourceActionsRepository } from "./opening-source-actions";
import { createOpeningPrivacyRepository } from "./opening-privacy";
import { deleteOwnedMemory } from "./opening-memory-delete";
import { createOpeningRetestActivityRepository, transitionRetestActivityForTask } from "./opening-retest-activities";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { createOpeningPlansRepository } from "./opening-plans";
import { createOpeningRetestRepository } from "./opening-retests";
import { insertOpeningTask } from "./opening-retest-task";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [workspaceId, ownerUserId, courseId, sourceId, activityId, taskId, candidateId, memoryId, turnId] = Array.from({ length: 9 }, (_, n) => id(n + 1)) as [string, string, string, string, string, string, string, string, string];
const scope = { workspaceId, ownerUserId }, at = "2026-09-30T10:00:00.000Z";
type Row = Record<string, unknown>;
type Fragment = { query: string; values: unknown[] };
const isFragment = (value: unknown): value is Fragment => typeof value === "object" && value !== null && "query" in value && "values" in value;

/** Execute statements lazily like postgres: interpolated SQL fragments do not acquire locks. */
function database(handler: (query: string, values: unknown[]) => Row[]) {
  let locked = false, inTransaction = false, revision = 0, epoch = 0;
  const queries: string[] = [], invalidations: unknown[][] = [];
  const execute = async ({ query, values }: Fragment) => {
    queries.push(query);
    if (/FOR (UPDATE|SHARE)/.test(query) && !query.includes("opening_workspace_history_revisions")) {
      expect(inTransaction).toBe(true);
      expect(locked, `counter must precede ${query}`).toBe(true);
    }
    if (query.startsWith("SELECT id FROM workspaces") || query.startsWith("SELECT id, privacy_epoch FROM workspaces")) return [{ id: workspaceId, privacy_epoch: epoch }];
    if (query.startsWith("INSERT INTO opening_workspace_history_revisions")) return [];
    if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) { locked = true; return [{ revision }]; }
    if (query.startsWith("UPDATE opening_workspace_history_revisions")) { expect(locked).toBe(true); return [{ revision: ++revision }]; }
    if (query.startsWith("UPDATE workspaces SET privacy_epoch")) return [{ privacy_epoch: ++epoch }];
    if (query.startsWith("DELETE FROM opening_learning_eligibility")) { invalidations.push(values); return []; }
    return handler(query, values);
  };
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings, "raw")) return { query: strings.map(() => "?").join(","), values: [...strings] };
    const args: unknown[] = [];
    let query = String(strings[0]);
    values.forEach((value, index) => {
      if (isFragment(value)) { query += value.query; args.push(...value.values); }
      else { query += "?"; args.push(value); }
      query += strings[index + 1];
    });
    const statement = { query: query.replace(/\s+/g, " ").trim(), values: args };
    return { ...statement, then: (resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) => execute(statement).then(resolve, reject) };
  }) as unknown as Sql;
  sql.json = ((value: unknown) => value) as Sql["json"];
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => {
    expect(inTransaction).toBe(false);
    inTransaction = true; locked = false;
    const before = { revision, epoch, invalidations: invalidations.length };
    try { return await callback(sql); }
    catch (error) { revision = before.revision; epoch = before.epoch; invalidations.length = before.invalidations; throw error; }
    finally { inTransaction = false; locked = false; }
  }) as Sql["begin"];
  return { sql, queries, invalidations, revision: () => revision, epoch: () => epoch };
}

function activity(overrides: Row = {}): Row {
  return { id: activityId, evidence_cycle_id: candidateId, workspace_id: workspaceId, owner_user_id: ownerUserId,
    course_id: courseId, skill_label: "fractions", requirement_key: null, task_id: taskId,
    candidate_id: candidateId, status: "accepted", version: 2, ...overrides };
}
function persistedActivity(row: Row, values: unknown[]): Row {
  return { ...row, status: values[0], result: values[1], task_id: values[2], version: values[3], snoozed_until: values[4],
    proposed_at: values[5], accepted_at: values[6], started_at: values[7], completed_at: values[8], cancelled_at: values[10] };
}
function task(overrides: Row = {}): Row {
  return { id: taskId, title: "Retest fractions", minutes: 15, due_at: null, priority: 1, status: "pending", version: 1, ...overrides };
}

describe("learning semantic revision writers", () => {
  it("completes a source with its job once and does not count upload replay", async () => {
    let uploaded = false;
    const source = () => ({ id: sourceId, workspace_id: workspaceId, name: "a.pdf", mime: "application/pdf", bytes: 12,
      sha256: "a".repeat(64), version: 0, upload_state: uploaded ? "uploaded" : "pending", parse_state: "not_started", created_at: at });
    const db = database((query) => {
      if (query.startsWith("SELECT * FROM opening_sources")) return [source()];
      if (query.startsWith("UPDATE opening_sources SET upload_state")) { uploaded = true; return [source()]; }
      if (query.startsWith("INSERT INTO opening_source_versions") || query.startsWith("INSERT INTO opening_jobs") || query.startsWith("INSERT INTO opening_outbox")) return [];
      throw new Error(query);
    });
    const repo = createOpeningSourceRepository(db.sql);
    const input = { key: "parse-key", payload: {}, privacyEpoch: 0, actual: { bytes: 12, sha256: "a".repeat(64), mime: "application/pdf" } };
    await repo.completeWithParseJob(scope, sourceId, input);
    await repo.completeWithParseJob(scope, sourceId, input);
    expect(db.revision()).toBe(1);
    expect(db.invalidations).toHaveLength(1);
    expect(db.queries.filter((query) => query.startsWith("INSERT INTO opening_jobs"))).toHaveLength(1);
  });

  it("records raw privacy exclusions under one owned transaction and skips replay", async () => {
    const exclusions = new Set<string>();
    const db = database((query, values) => {
      if (query.startsWith("INSERT INTO opening_privacy_exclusions")) {
        const source = String(values[2]);
        if (exclusions.has(source)) return [];
        exclusions.add(source); return [{ source_id: source }];
      }
      throw new Error(query);
    });
    const input = { sourceIds: [sourceId, sourceId], memoryId, deletedAt: new Date(at) };
    const repo = createOpeningPrivacyRepository(db.sql);
    expect(await repo.recordExclusions(db.sql, scope, input)).toEqual([sourceId]);
    expect(await repo.recordExclusions(db.sql, scope, input)).toEqual([sourceId]);
    expect(db.revision()).toBe(1);
    expect(db.epoch()).toBe(1);
    expect(db.invalidations).toHaveLength(1);
  });

  it("counts exclusion and later asset deletion separately, but skips both replays", async () => {
    let sourceExists = true, exclusion: Row | null = null;
    const db = database((query, values) => {
      if (query.startsWith("SELECT version, upload_url_expires_at")) return sourceExists ? [{ version: 0 }] : [];
      if (query.startsWith("SELECT * FROM opening_privacy_exclusions")) return exclusion ? [exclusion] : [];
      if (query.startsWith("SELECT m.id") || query.startsWith("SELECT version FROM opening_source_versions") || query.startsWith("SELECT image_object_key")) return [];
      if (query.startsWith("INSERT INTO opening_privacy_exclusions")) { exclusion ??= {}; return []; }
      if (query.startsWith("UPDATE opening_privacy_exclusions SET asset_deleted_at")) { exclusion = { asset_deleted_at: values[0], pending_object_keys: values[1], cleanup_not_before: values[2] }; return []; }
      if (query.startsWith("DELETE FROM opening_sources")) { sourceExists = false; return []; }
      if (query.startsWith("DELETE FROM course_asset_memberships") || query.startsWith("UPDATE opening_source_versions")) return [];
      throw new Error(query);
    });
    const repo = createOpeningSourceActionsRepository(db.sql);
    const keys = { stagingKey: (source: string) => `opening/sources/${source}/staging`, finalKey: (source: string, version: number) => `opening/sources/${source}/${version}` };
    for (const action of ["exclude", "exclude", "delete", "delete"] as const) {
      await repo.apply(scope, sourceId, { action, expectedVersion: 0, expectedMembershipIds: [] }, keys, new Date(at));
    }
    expect(db.revision()).toBe(2);
    expect(db.epoch()).toBe(2);
    expect(db.invalidations).toHaveLength(2);
  });

  it.each([false, true])("memory deletion advances semantic revision only for new exclusions (already excluded: %s)", async (alreadyExcluded) => {
    const db = database((query) => {
      if (query.startsWith("SELECT * FROM opening_memories")) return [{ id: memoryId, status: "active", version: 1, source_turn_ids: [turnId] }];
      if (query.startsWith("SELECT source_ids, context_source_refs")) return [{ source_ids: [sourceId], context_source_refs: null }];
      if (query.startsWith("SELECT source_id FROM opening_privacy_exclusions")) return alreadyExcluded ? [{ source_id: sourceId }] : [];
      if (query.startsWith("UPDATE opening_memories") || query.startsWith("INSERT INTO opening_privacy_exclusions")) return [];
      throw new Error(query);
    });
    await deleteOwnedMemory(db.sql, scope, { id: memoryId, expectedVersion: 1, deleteSourceText: false, clientKey: "delete-memory" });
    expect(db.epoch()).toBe(1);
    expect(db.revision()).toBe(alreadyExcluded ? 0 : 1);
    expect(db.invalidations).toHaveLength(alreadyExcluded ? 0 : 1);
  });

  it("counts a proposed activity once and returns an existing cycle without increment", async () => {
    let row: Row | null = null;
    const db = database((query) => {
      if (query.startsWith("SELECT * FROM opening_retest_activities")) return row ? [row] : [];
      if (query.startsWith("INSERT INTO opening_retest_activities")) { row = activity({ status: "proposed", task_id: null, version: 1 }); return [row]; }
      throw new Error(query);
    });
    const repo = createOpeningRetestActivityRepository(db.sql);
    const input = { activityId, cycleId: candidateId, courseId, skillLabel: "fractions" };
    await repo.createProposed(scope, input);
    await repo.createProposed(scope, input);
    expect(db.revision()).toBe(1);
  });

  it("accept delegates one revision; same snooze does not change either version", async () => {
    let row = activity({ status: "proposed", task_id: null, version: 1 });
    const db = database((query, values) => {
      if (query.startsWith("SELECT * FROM opening_retest_activities")) return [row];
      if (query.startsWith("UPDATE opening_retest_activities")) { row = persistedActivity(row, values); return [row]; }
      throw new Error(query);
    });
    const repo = createOpeningRetestActivityRepository(db.sql);
    await repo.accept(scope, activityId, taskId, at);
    expect(db.revision()).toBe(1);
    const unchanged = await repo.transition(scope, activityId, { type: "snooze", until: null, expectedVersion: 2 });
    expect(unchanged.version).toBe(2);
    expect(db.revision()).toBe(1);
    await repo.transition(scope, activityId, { type: "snooze", until: at, expectedVersion: 2 });
    expect(db.revision()).toBe(2);
    await expect(repo.transition(scope, activityId, { type: "snooze", until: at, expectedVersion: 2 })).rejects.toThrow("stale");
    expect(db.revision()).toBe(2);
  });

  it("completes a linked activity and task with one outer revision", async () => {
    let row = activity();
    const db = database((query, values) => {
      if (query.startsWith("SELECT * FROM opening_retest_activities")) return [row];
      if (query.startsWith("SELECT id, status FROM opening_tasks")) return [task()];
      if (query.startsWith("UPDATE opening_retest_activities")) { row = persistedActivity(row, values); return [row]; }
      if (query.startsWith("UPDATE opening_tasks")) return [];
      throw new Error(query);
    });
    await createOpeningRetestActivityRepository(db.sql).completeForTask(scope, taskId, { type: "complete", at });
    expect(db.revision()).toBe(1);
    expect(row.status).toBe("completed");
  });

  it.each([false, true])("task status updates count only linked activities (linked: %s)", async (linked) => {
    let row = task(), linkedActivity = activity();
    const db = database((query, values) => {
      if (query.includes("FROM opening_retest_activities")) return linked ? [linkedActivity] : [];
      if (query.startsWith("SELECT * FROM opening_tasks")) return [row];
      if (query.startsWith("UPDATE opening_retest_activities")) { linkedActivity = persistedActivity(linkedActivity, values); return [linkedActivity]; }
      if (query.startsWith("UPDATE opening_tasks")) { row = task({ status: values[0], version: Number(row.version) + 1 }); return [row]; }
      throw new Error(query);
    });
    const repo = createOpeningPlansRepository(db.sql);
    await repo.updateTaskStatus(scope, taskId, { status: "skipped", expectedVersion: 1, at });
    await repo.updateTaskStatus(scope, taskId, { status: "skipped", expectedVersion: 2, at });
    expect(db.revision()).toBe(linked ? 1 : 0);
  });

  it("publishes a candidate/activity batch once and does not count suppressed proposals", async () => {
    let proposed = false;
    const db = database((query) => {
      if (query.startsWith("SELECT id FROM courses")) return [{ id: courseId }];
      if (query.startsWith("SELECT p.assessment_enabled")) return [{ account_assessment: true, account_retest: true }];
      if (query.includes("opening_learning_history_revisions")) return [];
      if (query.startsWith("SELECT id FROM opening_retest_activities")) return proposed ? [{ id: activityId }] : [];
      if (query.startsWith("SELECT id, status, reason FROM opening_retest_activities")) return [];
      if (query.startsWith("INSERT INTO opening_jobs")) return [{ id: candidateId }];
      if (query.startsWith("INSERT INTO opening_retest_activities")) { proposed = true; return [{ id: activityId }]; }
      throw new Error(query);
    });
    const repo = createOpeningRetestRepository(db.sql);
    const candidate = { id: candidateId, courseId, skillLabel: "fractions", prompt: "Try fractions", sourceIds: [], dueAt: at, accepted: false };
    expect(await repo.saveCandidates(scope, [candidate])).toHaveLength(1);
    expect(await repo.saveCandidates(scope, [candidate])).toEqual([]);
    expect(db.revision()).toBe(1);
  });

  it("accepts a retest task once and does not increment its accepted-task replay", async () => {
    let payload: Row = { id: candidateId, kind: "task", courseId, skillLabel: "fractions", accepted: false }, currentActivity = activity({ status: "proposed", task_id: null, version: 1 });
    const db = database((query, values) => {
      if (query.startsWith("SELECT c.id AS course_id")) return [{ course_id: courseId }];
      if (query.includes("opening_learning_history_revisions")) return [];
      if (query.startsWith("SELECT payload FROM opening_jobs")) return [{ payload }];
      if (query.startsWith("SELECT c.id FROM courses") || query.startsWith("SELECT j.id FROM opening_jobs")) return [{ id: candidateId }];
      if (query.startsWith("SELECT s.id FROM opening_sources")) return [];
      if (query.startsWith("SELECT id, payload FROM opening_jobs")) return payload.accepted ? [{ id: candidateId, payload }] : [];
      if (query.startsWith("INSERT INTO opening_tasks") || query.startsWith("SELECT * FROM opening_tasks")) return [task()];
      if (query.startsWith("UPDATE opening_jobs")) { payload = { ...payload, ...(values[0] as Row) }; return [{ id: candidateId }]; }
      if (query.startsWith("SELECT * FROM opening_retest_activities")) return [currentActivity];
      if (query.startsWith("UPDATE opening_retest_activities")) { currentActivity = persistedActivity(currentActivity, values); return [currentActivity]; }
      throw new Error(query);
    });
    const input = { title: "Retest fractions", minutes: 15, dueAt: null, priority: 1, candidateId, clientKey: "accept-task-key",
      inputSnapshot: { kind: "retest" as const, candidateId, heuristic: true as const } };
    expect((await insertOpeningTask(db.sql, scope, input)).id).toBe(taskId);
    expect((await insertOpeningTask(db.sql, scope, input)).id).toBe(taskId);
    expect(db.revision()).toBe(1);
  });
});

describe("equivalent snooze timestamp precision", () => {
  function snoozed() {
    let row = activity({ snoozed_until: at });
    const db = database((query, values) => {
      if (query.startsWith("SELECT * FROM opening_retest_activities")) return [row];
      if (query.startsWith("UPDATE opening_retest_activities")) { row = persistedActivity(row, values); return [row]; }
      throw new Error(query);
    });
    return db;
  }
  it("keeps activity and semantic revisions for the same instant, while preserving stale-version rejection", async () => {
    const db = snoozed(), repo = createOpeningRetestActivityRepository(db.sql);
    const same = await repo.transition(scope, activityId, { type: "snooze", until: at.replace(".000Z", "Z"), expectedVersion: 2 });
    expect(same.version).toBe(2);
    expect(db.revision()).toBe(0);
    expect(db.queries.some(query => query.startsWith("UPDATE opening_retest_activities"))).toBe(false);
    await expect(repo.transition(scope, activityId, { type: "snooze", until: at.replace(".000Z", "Z"), expectedVersion: 1 })).rejects.toThrow("stale");
    const changed = await repo.transition(scope, activityId, { type: "snooze", until: "2026-09-30T11:00:00Z", expectedVersion: 2 });
    expect(changed.version).toBe(3);
    expect(db.revision()).toBe(1);
  });
  it("treats equivalent instants as no-op in the nested task helper without owning a semantic revision", async () => {
    const db = snoozed();
    await db.sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      const same = await transitionRetestActivityForTask(tx, scope, taskId, { type: "snooze", until: at.replace(".000Z", "Z"), expectedVersion: 2 });
      expect(same?.version).toBe(2);
      expect(db.queries.some(query => query.startsWith("UPDATE opening_retest_activities"))).toBe(false);
      await expect(transitionRetestActivityForTask(tx, scope, taskId, { type: "snooze", until: at.replace(".000Z", "Z"), expectedVersion: 1 })).rejects.toThrow("stale");
      const changed = await transitionRetestActivityForTask(tx, scope, taskId, { type: "snooze", until: "2026-09-30T11:00:00Z", expectedVersion: 2 });
      expect(changed?.version).toBe(3);
    });
    expect(db.revision()).toBe(0);
  });
});