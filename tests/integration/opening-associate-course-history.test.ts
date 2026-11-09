import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { TeachingActivityAssociateCourseInput } from "@aistudy/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCardRepository, createOpeningCardVariantRepository, createOpeningTeachingActivitiesRepository } from "@aistudy/database";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { openRaceSession } from "./opening-race-helpers";
import { assertHistoryWait, observeTransaction, signal } from "./outer-caller-history-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const repo = (sql = f.sql) => createOpeningTeachingActivitiesRepository(sql);
const history = () => f.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId} ORDER BY owner_user_id`;
async function course() {
  const id = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.scope.workspaceId},'Association test',${id})`;
  return id;
}
async function source(activityId: string, courseId: string) {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${id},${f.scope.workspaceId},'test.png','image/png',8,${"a".repeat(64)},1,'uploaded','ready')`;
  await f.sql`UPDATE opening_teaching_activities SET source_ids=${[id]} WHERE id=${activityId}`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${id},'reference',0,'private')`;
  return id;
}
async function state() {
  return {
    activities: await f.sql`SELECT * FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    courses: await f.sql`SELECT * FROM courses WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    memberships: await f.sql`SELECT * FROM course_asset_memberships WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    versions: await f.sql`SELECT * FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId} ORDER BY source_id,version`,
    observations: await f.sql`SELECT * FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    attempts: await f.sql`SELECT * FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
    cards: await f.sql`SELECT * FROM cards WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
  };
}

describe("associateCourse PG history boundary", () => {
  it.each(["manual", "unassociate", "auto"] as const)("%s waits on real history before business locks, lazy/nonzero/other workspace", async kind => {
    // Each iteration uses fresh activity/materials; only the lazy case lacks a counter.
    for (const mode of ["lazy", "nonzero", "other-workspace"] as const) {
      const courseId = await course();
      const activityId = await insertTestTeachingActivity(f.sql, f.scope, kind === "unassociate" ? courseId : null);
      const sourceId = await source(activityId, courseId);
      const input: TeachingActivityAssociateCourseInput = kind === "auto" ? { auto: true }
        : { courseId: kind === "manual" ? courseId : null };
      if (mode !== "lazy") {
        await f.sql.begin(tx => lockWorkspaceLearningHistory(tx, f.scope));
        await f.sql`UPDATE opening_workspace_history_revisions SET revision=23 WHERE workspace_id=${f.scope.workspaceId}`;
      }
      const before = await state(), held = signal(), release = signal();
      const holder = openRaceSession(), writer = openRaceSession();
      let holding: Promise<unknown> | undefined, writing: Promise<unknown> | undefined;
      try {
        await Promise.all([holder.ready, writer.ready]);
        holding = holder.sql.begin(async tx => {
          await lockWorkspaceLearningHistory(tx, mode === "other-workspace" ? f.otherScope : f.scope);
          held.resolve(); await release.ready;
        });
        holding.catch(held.resolve);
        await Promise.race([held.ready, holding]);
        let finished = false;
        writing = repo(writer.sql).associateCourse(f.scope, activityId, input);
        writing.then(() => { finished = true; }, () => { finished = true; });
        if (mode !== "other-workspace") {
          await assertHistoryWait(f.sql, writer.pid, holder.pid, () => finished);
          // The blocked transaction has not journaled sources or changed business data.
          expect(await state()).toEqual(before);
          release.resolve(); await holding;
        }
        await expect(writing).resolves.toMatchObject({ id: activityId, courseId: kind === "unassociate" ? null : courseId });
        expect(await history()).toMatchObject([{ revision: mode === "lazy" ? "0" : "23" }]);
        const after = await state();
        expect(after.observations).toEqual(before.observations);
        expect(after.attempts).toEqual(before.attempts);
        expect(after.courses).toEqual(before.courses);
        if (kind !== "unassociate") expect(after.versions).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: sourceId, version: 1 })]));
      } finally {
        release.resolve();
        await Promise.allSettled([holding, writing].filter(Boolean));
        await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
      }
    }
  });

  it.each(["owner", "execution", "missing", "uuid", "cas", "course", "course-uuid", "completed", "source", "purpose", "auto-purpose"])(
    "preserves original %s failure with no history/lock/journal", async failure => {
      const courseId = await course(), activityId = await insertTestTeachingActivity(f.sql, f.scope);
      const sourceId = await source(activityId, courseId);
      let scope = f.scope, id = activityId;
      let input: TeachingActivityAssociateCourseInput = { courseId };
      const expected: Record<string, { code: string; message?: string }> = {
        owner: { code: "NOT_FOUND", message: "workspace not found" },
        execution: { code: "CONFLICT", message: "job execution is no longer current" },
        missing: { code: "NOT_FOUND", message: "teaching activity not found" }, uuid: { code: "22P02" },
        cas: { code: "CONFLICT", message: "teaching activity updated_at mismatch" },
        course: { code: "NOT_FOUND", message: "course not found" }, "course-uuid": { code: "22P02" },
        completed: { code: "CONFLICT", message: "已结束的学习不能自动更换课程" },
        source: { code: "VALIDATION", message: "source unavailable or privacy-excluded" },
        purpose: { code: "CONFLICT" }, "auto-purpose": { code: "CONFLICT" },
      };
      if (failure === "owner") scope = { ...f.scope, ownerUserId: f.otherScope.ownerUserId };
      if (failure === "execution") scope = { ...f.scope, jobExecution: { id: randomUUID(), token: randomUUID(), privacyEpoch: 0 } } as typeof scope;
      if (failure === "missing") id = randomUUID();
      if (failure === "uuid") id = "bad-uuid";
      if (failure === "cas") input = { courseId: "bad-course", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" };
      if (failure === "course") input = { courseId: randomUUID() };
      if (failure === "course-uuid") input = { courseId: "bad-course" };
      if (failure === "completed") {
        input = { auto: true };
        await f.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${activityId}`;
      }
      if (failure === "source") await f.sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${sourceId}`;
      if (["purpose", "auto-purpose"].includes(failure)) {
        if (failure === "auto-purpose") {
          input = { auto: true };
          // Candidate is inferred from one source, but another source has no teaching membership.
          await f.sql`UPDATE opening_teaching_activities SET source_ids=array_append(source_ids,${await extraSource()}::uuid) WHERE id=${activityId}`;
        } else await f.sql`DELETE FROM course_asset_memberships WHERE asset_id=${sourceId}`;
      }
      const before = await state(), queries: string[] = [];
      await expect(repo(observeTransaction(f.sql, async query => { queries.push(query); }))
        .associateCourse(scope, id, input)).rejects.toMatchObject(expected[failure]!);
      expect(queries.some(q => /FOR SHARE|FOR UPDATE|^(INSERT|UPDATE|DELETE)/.test(q) || q.includes("opening_workspace_history_revisions"))).toBe(false);
      expect(await state()).toEqual(before);
      expect(await history()).toEqual([]);
    });

  it.each(["owner", "course", "cas", "source", "purpose", "execution"])("rejects dynamic %s drift and rolls back lazy history", async drift => {
    const courseId = await course(), activityId = await insertTestTeachingActivity(f.sql, f.scope);
    const sourceId = await source(activityId, courseId);
    const [activity] = await f.sql`SELECT updated_at FROM opening_teaching_activities WHERE id=${activityId}`;
    let scope = f.scope;
    const jobId = randomUUID(), token = randomUUID();
    if (drift === "execution") {
      await f.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state,claim_token,privacy_epoch)
        VALUES(${jobId},${f.scope.workspaceId},${f.scope.ownerUserId},${jobId},'parse','{}','running',${token},0)`;
      scope = { ...f.scope, jobExecution: { id: jobId, token, privacyEpoch: 0 } } as typeof scope;
    }
    if (drift === "owner") await f.sql`DELETE FROM workspaces WHERE id=${f.otherScope.workspaceId}`;
    let changed = false, expectedState: Awaited<ReturnType<typeof state>> | undefined;
    const sql = observeTransaction(f.sql, async query => {
      if (changed || !query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return;
      changed = true;
      if (drift === "owner") await f.sql`UPDATE workspaces SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${f.scope.workspaceId}`;
      if (drift === "course") await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
      if (drift === "cas") await f.sql`UPDATE opening_teaching_activities SET updated_at=updated_at+interval '1 second' WHERE id=${activityId}`;
      if (drift === "source") await f.sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${sourceId}`;
      if (drift === "purpose") await f.sql`DELETE FROM course_asset_memberships WHERE asset_id=${sourceId}`;
      if (drift === "execution") await f.sql`UPDATE opening_jobs SET claim_token=${randomUUID()} WHERE id=${jobId}`;
      expectedState = await state();
    });
    await expect(repo(sql).associateCourse(scope, activityId, { courseId,
      ...(drift === "cas" ? { expectedUpdatedAt: new Date(activity!.updated_at).toISOString() } : {}) }))
      .rejects.toMatchObject({ code: ["owner", "course"].includes(drift) ? "NOT_FOUND" : drift === "source" ? "VALIDATION" : "CONFLICT" });
    expect(changed).toBe(true);
    expect(await state()).toEqual(expectedState);
    expect(await history()).toEqual([]);
  });

  it.each(["manual", "unassociate", "auto-new"])("rolls back %s actual writes, materials and lazy history after later SQL failure", async kind => {
    const courseId = await course(), activityId = await insertTestTeachingActivity(f.sql, f.scope, kind === "unassociate" ? courseId : null);
    await source(activityId, courseId);
    if (kind === "auto-new") await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${courseId}`;
    const before = await state();
    let updated = false;
    const sql = observeTransaction(f.sql, async (query, tx) => {
      if (!query.startsWith("UPDATE opening_teaching_activities")) return;
      updated = true;
      expect(await tx`SELECT course_id FROM opening_teaching_activities WHERE id=${activityId}`)
        .not.toEqual(before.activities.map(a => ({ course_id: a.course_id })));
      await tx`SELECT 1/0`;
    });
    await expect(repo(sql).associateCourse(f.scope, activityId, kind === "auto-new" ? { auto: true }
      : { courseId: kind === "manual" ? courseId : null })).rejects.toMatchObject({ code: "22012" });
    expect(updated).toBe(true);
    expect(await state()).toEqual(before);
    expect(await history()).toEqual([]);
  });

  it("keeps auto concurrent replay and existing completed binding without revision advance", async () => {
    const activityId = await insertTestTeachingActivity(f.sql, f.scope);
    const results = await Promise.all([repo().associateCourse(f.scope, activityId, { auto: true }),
      repo().associateCourse(f.scope, activityId, { auto: true })]);
    expect(results[0]!.courseId).toBe(results[1]!.courseId);
    await f.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${activityId}`;
    expect((await repo().associateCourse(f.scope, activityId, { auto: true })).courseId).toBe(results[0]!.courseId);
    expect(await history()).toMatchObject([{ revision: "0" }]);
    expect((await state()).courses).toHaveLength(1);
  });

  it("cardvariant rolls back its new course, activity, card binding and lazy history together", async () => {
    const card = await createCardRepository(f.sql).createCard({ ...f.scope, reviewKind: "question", front: "1+1?", back: "2" });
    await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}`;
    const before = await state();
    let updated = false;
    const sql = observeTransaction(f.sql, async (query, tx) => {
      if (!query.startsWith("UPDATE cards SET course_id")) return;
      updated = true;
      expect((await tx`SELECT course_id FROM cards WHERE id=${card.id}`)[0]!.course_id).toBeTruthy();
      await tx`SELECT 1/0`;
    });
    await expect(createOpeningCardVariantRepository(sql).begin(f.scope, card.id)).rejects.toMatchObject({ code: "22012" });
    expect(updated).toBe(true);
    expect(await state()).toEqual(before);
    expect(await history()).toEqual([]);
  });

  it("cardvariant unbound path uses existing history, one create savepoint, no association root/history re-entry", async () => {
    const card = await createCardRepository(f.sql).createCard({ ...f.scope, reviewKind: "question", front: "1+1?", back: "2" });
    // Card creation may coordinate history; start this assertion at a lazy counter.
    await f.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}`;
    const queries: string[] = [];
    let savepoints = 0;
    const wrap = (tx: TransactionSql): TransactionSql => new Proxy(tx, {
      get(target, property) {
        if (property === "savepoint") return (callback: (nested: TransactionSql) => Promise<unknown>) => {
          savepoints++;
          return target.savepoint(nested => callback(wrap(nested)));
        };
        return Reflect.get(target, property);
      },
      apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        // Preserve native SQL fragments/builders and lazy query execution.
        const pending = Reflect.apply(target, thisArg, args);
        if (!Array.isArray(args[0]) || !("raw" in args[0])) return pending;
        const query = args[0].join("?").replace(/\s+/g, " ").trim();
        return new Proxy(pending, { get(targetQuery, property) {
          if (property !== "then") return Reflect.get(targetQuery, property);
          return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
            targetQuery.then((rows: unknown) => { queries.push(query); return rows; }).then(resolve, reject);
        } });
      },
    });
    const sql = new Proxy(f.sql, { get(target, property) {
      if (property === "begin") return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => callback(wrap(tx)));
      return Reflect.get(target, property);
    } });
    const result = await createOpeningCardVariantRepository(sql).begin(f.scope, card.id);
    expect(savepoints).toBe(1);
    expect(result.review.activity.courseId).toBeTruthy();
    const inserted = queries.findIndex(q => q.startsWith("INSERT INTO opening_teaching_activities"));
    const associated = queries.findIndex(q => q.startsWith("UPDATE opening_teaching_activities SET course_id"));
    const cardLocked = queries.findIndex(q => q.includes("FROM cards") && q.includes("FOR UPDATE"));
    const historyLocks = queries.flatMap((q, i) => q.startsWith("SELECT revision FROM opening_workspace_history_revisions") ? [i] : []);
    // current() legitimately reacquires history after association, as before.
    expect(historyLocks).toHaveLength(2);
    expect(historyLocks[0]).toBeLessThan(cardLocked);
    expect(inserted).toBeGreaterThan(cardLocked);
    expect(associated).toBeGreaterThan(inserted);
    expect(historyLocks[1]).toBeGreaterThan(associated);
    expect(queries.slice(inserted + 1, associated).some(q => q.includes("opening_workspace_history_revisions"))).toBe(false);
    expect(await f.sql`SELECT course_id FROM cards WHERE id=${card.id}`).toEqual([{ course_id: result.review.activity.courseId }]);
    expect(await history()).toMatchObject([{ revision: "0" }]);
    expect((await createOpeningCardVariantRepository(f.sql).begin(f.scope, card.id)).review.activity.id).toBe(result.review.activity.id);
  });
});

async function extraSource() {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${id},${f.scope.workspaceId},'extra.png','image/png',8,${"b".repeat(64)},1,'uploaded','ready')`;
  return id;
}
