import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { createLibraryRepository, createOpeningCourseReadySourcesRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); });

async function setup() {
  const courseId = randomUUID(), sourceId = await backupRows(f.sql, f.scope).source("uploaded", 1);
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Atomic',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const activityId = await insertTestTeachingActivity(f.sql, f.scope, courseId);
  await f.sql`UPDATE opening_teaching_activities SET source_ids=ARRAY[${sourceId}]::uuid[] WHERE id=${activityId}`;
  const content = createOpeningTeachingContentRepository(f.sql), library = createLibraryRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "Atomic", blocks: [{ id: randomUUID(), type: "meta", content: { text: "draft" } }] });
  const blocks = [{ id: randomUUID(), type: "text", content: { text: "Compiled body, not yet published" } }];
  const input = { activityId, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 2,
    blockOrder: [{ blockId: blocks[0]!.id, blockType: "text", position: 0, role: "teach" as const }],
    sourceRefs: [{ sourceId, version: 1 }], verificationStatus: "needs_check" as const };
  const compiled = { blocks, expectedDocumentRevision: 1, revisionId: randomUUID() };
  const purposes = createOpeningCourseReadySourcesRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId, sourceIds: [sourceId], materialUse: "teaching" });
  return { courseId, sourceId, activityId, unit, library, content, input, compiled,
    assertPin: (tx: TransactionSql) => purposes.assertSourcePurposePin(f.scope, pin, tx) };
}

async function snapshot() {
  const rows = [];
  for (const table of ["library_documents", "library_blocks", "library_revisions", "opening_teaching_units", "opening_teaching_activity_specs", "opening_teaching_activities"]) {
    rows.push(await f.sql`SELECT to_jsonb(t) AS row FROM ${f.sql(table)} t WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`);
  }
  return JSON.stringify(rows);
}

// Intercept SQL execution, not its result: the real body/projection writes have
// completed on the same tx when the barrier/fault runs immediately before spec.
function beforeSpec(effect: (tx: TransactionSql) => Promise<void>): Sql {
  return new Proxy(f.sql, { get(target, property) {
    if (property === "begin") return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => {
      const wrapped = new Proxy(tx, { apply(client, _self, args: [TemplateStringsArray, ...unknown[]]) {
        const query = Array.isArray(args[0]) && args[0].join("?");
        if (query && query.includes("INSERT INTO opening_teaching_activity_specs")) {
          return effect(tx).then(() => Reflect.apply(client, client, args));
        }
        return Reflect.apply(client, client, args);
      } });
      return callback(wrapped);
    });
    return Reflect.get(target, property);
  } });
}

it("keeps ordinary library reads on the old complete graph until body/projection/spec/activity commit together", async () => {
  const x = await setup(), old = await snapshot();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const sql = beforeSpec(async tx => {
    expect(await tx`SELECT id FROM library_blocks WHERE document_id=${x.unit.documentId} AND id=${x.compiled.blocks[0]!.id}`).toHaveLength(1);
    expect(await tx`SELECT id FROM library_revisions WHERE id=${x.compiled.revisionId}`).toHaveLength(1);
    entered(); await held;
  });
  const publication = createOpeningTeachingContentRepository(sql).publishCompiledActivity(f.scope, x.input, x.compiled, x.assertPin);
  await ready;
  try {
    expect(await snapshot()).toBe(old);
    expect((await x.library.getDocument({ workspaceId: f.scope.workspaceId, documentId: x.unit.documentId })).blocks[0]!.content).toEqual({ text: "draft" });
    expect((await x.library.getRevision({ workspaceId: f.scope.workspaceId, documentId: x.unit.documentId, revisionNumber: 1 })).blocks[0]!.content).toEqual({ text: "draft" });
    await expect(x.library.getRevision({ workspaceId: f.scope.workspaceId, documentId: x.unit.documentId, revisionNumber: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.sql.begin(async tx => { await tx`SET LOCAL lock_timeout='100ms'`;
      await tx`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
    })).rejects.toMatchObject({ code: "55P03" });
  } finally { release(); await publication; }
  expect((await x.library.getDocument({ workspaceId: f.scope.workspaceId, documentId: x.unit.documentId })).blocks.map(({ position: _p, ...block }) => block)).toEqual(x.compiled.blocks);
  expect(await x.content.readRevision(f.scope, x.unit.documentId, 2)).toMatchObject({ id: x.compiled.revisionId });
  expect(await x.content.getActivitySpec(f.scope, x.activityId)).toMatchObject({ revisionNumber: 2, version: 1 });
  await f.sql`UPDATE course_asset_memberships SET purpose='reference' WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
});

it.each([false, true])("refuses a pre-lock purpose change (changed back=%s) without changing any graph byte/row", async changedBack => {
  const x = await setup();
  await f.sql`UPDATE course_asset_memberships SET purpose='reference',updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  if (changedBack) await f.sql`UPDATE course_asset_memberships SET purpose=NULL,updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  const old = await snapshot();
  await expect(x.content.publishCompiledActivity(f.scope, x.input, x.compiled, x.assertPin)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot()).toBe(old);
});

it("rolls back actual body/revision/projection writes when the spec write fails", async () => {
  const x = await setup(), old = await snapshot();
  const sql = beforeSpec(async tx => {
    expect(await tx`SELECT id FROM library_revisions WHERE id=${x.compiled.revisionId}`).toHaveLength(1);
    throw new Error("injected after body before spec");
  });
  await expect(createOpeningTeachingContentRepository(sql).publishCompiledActivity(f.scope, x.input, x.compiled, x.assertPin)).rejects.toThrow("injected after body before spec");
  expect(await snapshot()).toBe(old);
});

it("replays and promotes only the exact body/revision/full graph without creating another revision", async () => {
  const x = await setup();
  const first = await x.content.publishCompiledActivity(f.scope, x.input, x.compiled, x.assertPin);
  const old = await snapshot();
  expect(await x.content.publishCompiledActivity(f.scope, x.input, x.compiled, x.assertPin)).toEqual(first);
  expect(await snapshot()).toBe(old);
  const promoted = { ...x.input, expectedVersion: 1, verificationStatus: "structure_ok" as const };
  await x.content.publishCompiledActivity(f.scope, promoted, x.compiled, x.assertPin);
  expect(await f.sql`SELECT id FROM library_revisions WHERE document_id=${x.unit.documentId}`).toHaveLength(2);
  const stable = await snapshot();
  for (const compiled of [{ ...x.compiled, revisionId: randomUUID() }, { ...x.compiled, blocks: [{ ...x.compiled.blocks[0]!, content: { text: "different" } }] }]) {
    await expect(x.content.publishCompiledActivity(f.scope, promoted, compiled, x.assertPin)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toBe(stable);
  }
  await expect(x.content.publishCompiledActivity(f.scope, { ...promoted, goals: [{ goalId: randomUUID(), statement: "different" }] }, x.compiled, x.assertPin)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot()).toBe(stable);
  await expect(x.content.publishCompiledActivity(f.scope, promoted, x.compiled, undefined!)).rejects.toMatchObject({ code: "CONFLICT" });
  await f.sql`UPDATE course_asset_memberships SET updated_at=updated_at+interval '1 microsecond'
    WHERE workspace_id=${f.scope.workspaceId} AND course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  await expect(x.content.publishCompiledActivity(f.scope, promoted, x.compiled, x.assertPin)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot()).toBe(stable);
});

it("proves the predicted revision using the original document CAS without half writes", async () => {
  const x = await setup();
  await x.library.updateDocument({ workspaceId: f.scope.workspaceId, documentId: x.unit.documentId, expectedRevisionNumber: 1,
    blocks: [{ id: randomUUID(), type: "text", content: { text: "concurrent library edit" } }] });
  const old = await snapshot();
  await expect(x.content.publishCompiledActivity(f.scope, x.input, x.compiled, x.assertPin)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await snapshot()).toBe(old);
});
