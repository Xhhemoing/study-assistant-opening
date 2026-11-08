import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterEach, beforeEach, expect, it } from "vitest";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";

// Storage lifecycle only: run against real migrated PG, without a scanner,
// complete=true fixture, reservation port or production consumer dependency.
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
type Db = Sql | TransactionSql;

async function seedStorage() {
  const rows = backupRows(f.sql, f.scope), sourceId = await rows.source(), chunkId = await rows.chunk(sourceId);
  const courseId = randomUUID(), requirementId = randomUUID(), privateId = randomUUID(), keyId = randomUUID(), exposureId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${f.scope.workspaceId},'Storage lifecycle',${courseId})`;
  await f.sql`INSERT INTO course_requirements(id,workspace_id,owner_user_id,course_id,stable_skill_id,requirement_key,title,verification)
    VALUES(${requirementId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${randomUUID()},'storage-lifecycle','Storage lifecycle','{}')`;
  const identity = { identityRefId: privateId }, versions = { [sourceId]: 1 };
  await f.sql`INSERT INTO opening_course_reserved_questions(id,workspace_id,owner_user_id,course_id,requirement_id,requirement_revision,
    source_versions,identity_ref_id,identity_json,family_id,content_ref_id,key_ref_id,question_json,interaction_json,key_json)
    VALUES(${privateId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${requirementId},1,
      ${f.sql.json(versions)},${privateId},${f.sql.json(identity)},'storage-family',${randomUUID()},${keyId},
      ${f.sql.json({ text: 'historical prompt' })},${f.sql.json({ kind: 'text' })},${f.sql.json({ keyRefId: keyId, identity, answer: 'private answer' })})`;
  await f.sql`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,exact_content,source_versions,history_revision)
    VALUES(${exposureId},${f.scope.workspaceId},${f.scope.ownerUserId},${`presented:${exposureId}`},'presented',
      ${f.sql.json({ question: 'historical prompt', interaction: { kind: 'text' }, figures: [] })},${f.sql.json(versions)},0)`;
  return { sourceId, chunkId, courseId, requirementId, privateId, exposureId, versions };
}
async function coverage(db: Db = f.sql, workspaceId = f.scope.workspaceId) {
  return db`SELECT owner_user_id,history_revision,complete,invalidated,covered_surface_count
    FROM opening_course_question_exposure_coverage WHERE workspace_id=${workspaceId} ORDER BY owner_user_id`;
}
async function snapshot(x: Awaited<ReturnType<typeof seedStorage>>, db: Db = f.sql) {
  return {
    workspace: await db`SELECT * FROM workspaces WHERE id=${f.scope.workspaceId}`,
    course: await db`SELECT * FROM courses WHERE id=${x.courseId}`,
    requirement: await db`SELECT * FROM course_requirements WHERE id=${x.requirementId}`,
    source: await db`SELECT * FROM opening_sources WHERE id=${x.sourceId}`,
    chunk: await db`SELECT * FROM opening_source_chunks WHERE id=${x.chunkId}`,
    supply: await db`SELECT * FROM opening_course_reserved_questions WHERE id=${x.privateId}`,
    exposure: await db`SELECT * FROM opening_course_question_exposures WHERE id=${x.exposureId}`,
    coverage: await coverage(db),
  };
}

it.each(['workspace', 'owner'] as const)('cascades the %s parent through requirements, private supply and exposure atomically', async parent => {
  const x = await seedStorage(), before = await snapshot(x), otherCoverage = await coverage(f.sql, f.otherScope.workspaceId);
  for (const rows of Object.values(before)) expect(rows).toHaveLength(1);
  const remove = async (db: Db) => {
    if (parent === 'workspace') await db`DELETE FROM workspaces WHERE id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
    else await db`DELETE FROM users WHERE id=${f.scope.ownerUserId}`;
  };
  await expect(f.sql.begin(async tx => {
    await remove(tx);
    for (const rows of Object.values(await snapshot(x, tx))) expect(rows).toHaveLength(0);
    if (parent === 'owner') expect(await tx`SELECT id FROM users WHERE id=${f.scope.ownerUserId}`).toHaveLength(0);
    throw new Error('parent cascade rollback');
  })).rejects.toThrow('parent cascade rollback');
  expect(await snapshot(x)).toEqual(before);
  expect(await f.sql`SELECT id FROM users WHERE id=${f.scope.ownerUserId}`).toHaveLength(1);
  await remove(f.sql);
  for (const rows of Object.values(await snapshot(x))) expect(rows).toHaveLength(0);
  expect(await f.sql`SELECT id FROM users WHERE id=${f.scope.ownerUserId}`).toHaveLength(parent === 'owner' ? 0 : 1);
  expect(await coverage(f.sql, f.otherScope.workspaceId)).toEqual(otherCoverage);
});

it.each(['course', 'requirement'] as const)('cascades the %s private supply without erasing independent exposure history', async parent => {
  const x = await seedStorage(), before = await snapshot(x);
  const remove = async (db: Db) => {
    if (parent === 'course') await db`DELETE FROM courses WHERE id=${x.courseId} AND workspace_id=${f.scope.workspaceId}`;
    else await db`DELETE FROM course_requirements WHERE id=${x.requirementId} AND workspace_id=${f.scope.workspaceId}`;
  };
  const expected = { ...before, requirement: [], supply: [], ...(parent === 'course' ? { course: [] } : {}) };
  await expect(f.sql.begin(async tx => {
    await remove(tx);
    expect(await snapshot(x, tx)).toEqual(expected);
    throw new Error('course scope rollback');
  })).rejects.toThrow('course scope rollback');
  expect(await snapshot(x)).toEqual(before);
  await remove(f.sql);
  expect(await snapshot(x)).toEqual(expected);
});

it('cascades source chunks but retains exposure and private historical source versions after rollback and commit', async () => {
  const x = await seedStorage(), before = await snapshot(x), otherCoverage = await coverage(f.sql, f.otherScope.workspaceId);
  const expected = { ...before, source: [], chunk: [], coverage: before.coverage.map(row => ({ ...row, invalidated: true })) };
  await expect(f.sql.begin(async tx => {
    await tx`DELETE FROM opening_sources WHERE id=${x.sourceId} AND workspace_id=${f.scope.workspaceId}`;
    expect(await snapshot(x, tx)).toEqual(expected);
    throw new Error('source cascade rollback');
  })).rejects.toThrow('source cascade rollback');
  expect(await snapshot(x)).toEqual(before);
  await f.sql`DELETE FROM opening_sources WHERE id=${x.sourceId} AND workspace_id=${f.scope.workspaceId}`;
  expect(await snapshot(x)).toEqual(expected);
  expect(expected.supply[0]!.source_versions).toEqual(x.versions);
  expect(expected.exposure[0]!.source_versions).toEqual(x.versions);
  expect(await coverage(f.sql, f.otherScope.workspaceId)).toEqual(otherCoverage);
});

it('rejects moving coverage to another valid scope or rewriting an exposure watermark', async () => {
  const x = await seedStorage(), before = await snapshot(x), otherCoverage = await coverage(f.sql, f.otherScope.workspaceId);
  // Both destination IDs are real and match one another: immutability, not just
  // a missing owner/workspace FK, must reject retargeting the existing row.
  await expect(f.sql`UPDATE opening_course_question_exposure_coverage SET workspace_id=${f.otherScope.workspaceId},owner_user_id=${f.otherScope.ownerUserId}
    WHERE workspace_id=${f.scope.workspaceId}`).rejects.toMatchObject({ code: '23514' });
  await expect(f.sql`UPDATE opening_course_question_exposures SET workspace_id=${f.otherScope.workspaceId},owner_user_id=${f.otherScope.ownerUserId}
    WHERE id=${x.exposureId}`).rejects.toMatchObject({ code: '23514' });
  await expect(f.sql`UPDATE opening_course_question_exposures SET history_revision=history_revision+1 WHERE id=${x.exposureId}`)
    .rejects.toMatchObject({ code: '23514' });
  expect(await snapshot(x)).toEqual(before);
  expect(await coverage(f.sql, f.otherScope.workspaceId)).toEqual(otherCoverage);
});

it('conservatively invalidates workspace coverage for a different owner historical item without inventing multi-owner coverage', async () => {
  const x = await seedStorage(), itemId = randomUUID();
  // Legacy item storage permits a different owner in the same workspace. The
  // ledger does not: workspace ownership is singular and coverage scope stays
  // guarded. This proves workspace-wide invalidation, not owner precision.
  const activityId = await insertTestTeachingActivity(f.sql, f.scope, x.courseId);
  await f.sql`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,activity_id,problem_id,source_id,source_version,stem_snapshot,artifact_kind)
    VALUES(${itemId},${f.scope.workspaceId},${f.otherScope.ownerUserId},${x.courseId},${activityId},${randomUUID()},${x.sourceId},1,'Other owner historical item','unknown')`;
  const before = await coverage(), otherCoverage = await coverage(f.sql, f.otherScope.workspaceId);
  expect(before).toEqual([{ owner_user_id: f.scope.ownerUserId, history_revision: '0', complete: false, invalidated: false, covered_surface_count: '0' }]);
  const expected = before.map(row => ({ ...row, invalidated: true }));
  await expect(f.sql.begin(async tx => {
    await tx`DELETE FROM opening_learning_item_versions WHERE id=${itemId} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.otherScope.ownerUserId}`;
    expect(await coverage(tx)).toEqual(expected);
    expect(await coverage(tx, f.otherScope.workspaceId)).toEqual(otherCoverage);
    throw new Error('different owner history rollback');
  })).rejects.toThrow('different owner history rollback');
  expect(await coverage()).toEqual(before);
  expect(await f.sql`SELECT id FROM opening_learning_item_versions WHERE id=${itemId}`).toHaveLength(1);
  await f.sql`DELETE FROM opening_learning_item_versions WHERE id=${itemId} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.otherScope.ownerUserId}`;
  expect(await coverage()).toEqual(expected);
  expect(await coverage(f.sql, f.otherScope.workspaceId)).toEqual(otherCoverage);
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE id=${x.exposureId}`).toHaveLength(1);
});
