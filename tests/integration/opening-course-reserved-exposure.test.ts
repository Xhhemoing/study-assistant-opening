import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readCourseQuestionExposure, recordCourseQuestionExposure, refreshCourseQuestionExposure } from "../../packages/database/src/repositories/opening-course-question-exposure";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const question = () => ({ reservedQuestionId: randomUUID(), identityRefId: randomUUID(), courseId: randomUUID(),
  requirementId: randomUUID(), requirementRevision: 1, sourceVersions: {}, text: "137*19",
  interaction: { kind: "numeric" as const }, familyId: "arithmetic:*" });
it("requires sticky protection beyond DB genesis and cannot retrofit unknown historical coverage", async () => {
  const [genesis] = await f.sql`SELECT complete,invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
  expect(genesis).toMatchObject({ complete: false, invalidated: false });
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
  await f.sql`DELETE FROM opening_course_question_exposure_coverage WHERE workspace_id=${f.scope.workspaceId}`;
  await expect(f.sql`INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,complete,covered_surface_count)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},'course-question-exposure-1',0,true,0)`).rejects.toMatchObject({ code: "23514" });
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
it("persists a presentation before answer, keeps replay idempotent and rolls back failed writes", async () => {
  const input = { surfaceKey: "presented:question", kind: "presented" as const, text: "137*19", sourceVersions: {} };
  await Promise.all([1, 2].map(() => f.sql.begin(tx => recordCourseQuestionExposure(tx, f.scope, input))));
  const rows = await f.sql`SELECT kind,exact_content FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "presented", exact_content: { complete: true, expressions: ["137*19"], families: ["arithmetic:*"] } });
  await expect(f.sql.begin(async tx => {
    await recordCourseQuestionExposure(tx, f.scope, { ...input, surfaceKey: "failed", kind: "hint" });
    throw new Error("presentation failed");
  })).rejects.toThrow("presentation failed");
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
  await expect(f.sql.begin(tx => recordCourseQuestionExposure(tx, f.scope, { ...input, text: "139*23" })))
    .rejects.toMatchObject({ code: "CONFLICT" });
});
it("does not claim unseen for examples, hints, unanswered prompts or old versions with missing history guards", async () => {
  const rows = backupRows(f.sql, f.scope), sourceId = await rows.source(), chunkId = randomUUID();
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${chunkId},${sourceId},1,1,'Example: 137*19')`;
  await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${sourceId},2,1,'Current rational arithmetic lesson.')`;
  const conversation = await rows.conversation();
  await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids,source_versions)
    VALUES(${randomUUID()},${f.scope.workspaceId},${conversation},'assistant','Hint: 139*23','hint','complete','{}','{}')`;
  const documentId = randomUUID();
  await f.sql`INSERT INTO library_documents(id,workspace_id,title,lifecycle,current_revision_number)
    VALUES(${documentId},${f.scope.workspaceId},'Practice','published',1)`;
  await f.sql`INSERT INTO library_revisions(id,workspace_id,document_id,revision_number,title,lifecycle,reason,blocks)
    VALUES(${randomUUID()},${f.scope.workspaceId},${documentId},1,'Practice','published','test',
      ${f.sql.json([{ id: randomUUID(), type: "prompt", position: 0, content: { text: "141*29" } }])})`;
  for (const text of ["计算 137 × 19", "139*23", "141*29"]) {
    expect(await readCourseQuestionExposure(f.sql, f.scope, { ...question(), text }))
      .toMatchObject({ coverage: "unknown" });
  }
  expect(await f.sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  await f.sql`DELETE FROM opening_sources WHERE id=${sourceId}`;
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
it("never promotes partial extraction or unknown old history to unseen", async () => {
  await f.sql.begin(tx => recordCourseQuestionExposure(tx, f.scope, { surfaceKey: "unparsed", kind: "example",
    body: { text: "See (137+2)*19 in figure", imageObjectKey: "figure" }, sourceVersions: {} }));
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
it("rejects a scan immediately when a concurrent surface writer already owns its table", async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const writer = f.sql.begin(async tx => {
    await tx`INSERT INTO cards(id,workspace_id,owner_user_id,front,back)
      VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'137*19','example')`;
    entered(); await held;
  });
  await ready;
  try { await expect(readCourseQuestionExposure(f.sql, f.scope, question())).rejects.toMatchObject({ code: "55P03" }); }
  finally { release(); await writer; }
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
it("holds every surface fence through the scanner transaction, releasing it on rollback", async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const scanner = f.sql.begin(async tx => { expect(await refreshCourseQuestionExposure(tx, f.scope)).toBe(false); entered(); await held; });
  await ready;
  try {
    await expect(f.sql.begin(async tx => { await tx`SET LOCAL lock_timeout='100ms'`;
      await tx`INSERT INTO cards(id,workspace_id,owner_user_id,front,back)
        VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'137*19','example')`;
    })).rejects.toMatchObject({ code: "55P03" });
  } finally { release(); await scanner; }
  await f.sql`INSERT INTO cards(id,workspace_id,owner_user_id,front,back)
    VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},'137*19','example')`;
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
