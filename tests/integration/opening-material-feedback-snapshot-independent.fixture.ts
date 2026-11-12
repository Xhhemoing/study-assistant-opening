import { randomUUID } from "node:crypto";
import type { JSONValue, Sql } from "postgres";
import { createLibraryRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository,
  createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import type { MaterialFeedbackAccessRequest, MaterialFeedbackSnapshot } from "../../packages/domain/src/opening/material-attempt-presentation";
import { createOpeningMaterialFeedbackSnapshotRepository, type OpeningMaterialFeedbackBinding,
  type OpeningMaterialFeedbackHost } from "../../packages/database/src/repositories/opening-material-feedback-snapshot";
import { backupRows } from "./opening-backup-records-fixture";
import type { OpeningFixture } from "./opening-fixture";

/** DI host fixture only: NOT an authenticated producer, importer or HTTP host. */
export function feedbackReader(sql: Sql, binding: OpeningMaterialFeedbackBinding | null,
  resolve?: OpeningMaterialFeedbackHost["resolvePostAttemptBinding"]) {
  return createOpeningMaterialFeedbackSnapshotRepository(sql, {
    resolvePostAttemptBinding: resolve ?? (async () => binding),
  });
}

export function accessFor(b: OpeningMaterialFeedbackBinding): MaterialFeedbackAccessRequest {
  return { questionId: b.blockId, attemptId: b.attemptId, mode: "post_attempt",
    source: { file: b.sourceFile, page: b.physicalPage } };
}

/** Normal publication/issuance/submission APIs; no fabricated attempt/item binding. */
export async function seedFeedback(f: OpeningFixture, answer = "两列分别沿两个坐标轴，线性无关，故秩为二。", submitted = true) {
  const { sql, scope } = f, rows = backupRows(sql, scope);
  const sourceId = await rows.source(), chunkId = await rows.chunk(sourceId), courseId = randomUUID();
  await sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${scope.workspaceId},'Feedback teaching fixture',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility,purpose)
    VALUES (${randomUUID()},${scope.workspaceId},${courseId},'source',${sourceId},'core',0,'course',NULL)`;
  const activity = await createOpeningTeachingActivitiesRepository(sql).create(scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "说明单位矩阵的秩", courseId, sourceIds: [sourceId], createIntent: {},
  });
  const content = createOpeningTeachingContentRepository(sql), blockId = randomUUID(), answerBlockId = randomUUID();
  const decoyPrompt = randomUUID(), decoyAnswer = randomUUID();
  // A different answer is physically first: the SELECT must resolve the saved pair, not an arbitrary key.
  const unit = await content.createUnit(scope, { title: "合法的受限文字教学题", blocks: [
    { id: decoyPrompt, type: "prompt", content: { text: "解释零矩阵的秩。" } },
    { id: decoyAnswer, type: "answer_key", content: { text: "DECOY：零矩阵没有线性无关的非零列，秩为零。" } },
    { id: blockId, type: "prompt", content: { text: "说明二阶单位矩阵的两列为何线性无关，并解释其秩。" } },
    { id: answerBlockId, type: "answer_key", content: { text: answer, rubric: "PRIVATE RUBRIC MUST NOT LEAK" } },
  ] });
  await content.publishActivitySpec(scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    expectedRevisionNumber: 1, revisionNumber: 1,
    blockOrder: [{ blockId: decoyPrompt, position: 0, blockType: "prompt", role: "prompt" },
      { blockId: decoyAnswer, position: 1, blockType: "answer_key", role: "answer_key" },
      { blockId, position: 2, blockType: "prompt", role: "prompt" },
      { blockId: answerBlockId, position: 3, blockType: "answer_key", role: "answer_key" }],
    sourceRefs: [{ sourceId, version: 1, page: 1, chunkId }],
  });
  const learning = createOpeningLearningRepository(sql);
  const session = await learning.createSession(scope, { courseId, activityId: activity.id, skillLabel: "矩阵秩", sourceIds: [sourceId] });
  const attempt = await createOpeningLearningAttemptRepository(sql).create(scope, { sessionId: session.id, clientKey: randomUUID(),
    teachingBlock: { blockId, contentVersion: 1 } });
  if (submitted) await learning.insertObservation(scope, { attemptId: attempt.id, sessionId: session.id, courseId,
    skillLabel: "矩阵秩", sourceIds: [sourceId], problemId: attempt.problemId,
    answer: "两列不成倍数，秩为二。", outcome: "unverified", assistance: "independent", clientKey: randomUUID() });
  const [stored] = await sql`SELECT r.id AS revision_id,r.blocks,s.block_order,s.source_refs,source.name,source.sha256
    FROM opening_teaching_activity_specs s JOIN library_revisions r ON r.document_id=s.document_id AND r.revision_number=s.revision_number
    JOIN opening_sources source ON source.id=${sourceId} WHERE s.activity_id=${activity.id}`;
  if (!stored || !attempt.itemVersionId || !attempt.problemId) throw new Error("MODULE_PENDING: normal teaching issuance produced no saved binding");
  const b: OpeningMaterialFeedbackBinding = { ...scope, courseId, activityId: activity.id, teachingUnitId: unit.id,
    documentId: unit.documentId, revisionId: String(stored.revision_id), revisionNumber: 1, contentVersion: 1,
    blockId, answerBlockId, sourceId, sourceVersion: 1, sourceFile: String(stored.name), sourceSha256: String(stored.sha256), physicalPage: 1,
    attemptId: attempt.id, itemVersionId: attempt.itemVersionId, problemId: attempt.problemId,
    revisionBlocks: stored.blocks as JSONValue, blockOrder: stored.block_order as JSONValue, sourceRefs: stored.source_refs as JSONValue };
  return { b, attempt, session, content, unit, decoyAnswer, chunkId, expected: { answer, postAttemptNotes: null } satisfies MaterialFeedbackSnapshot,
    access: accessFor(b), repo: feedbackReader(sql, b),
    async appendRevision() {
      return createLibraryRepository(sql).updateDocument({ workspaceId: scope.workspaceId, documentId: b.documentId,
        expectedRevisionNumber: 1, blocks: [
          { id: blockId, type: "prompt", content: { text: "新版问题不属于旧作答。" } },
          { id: answerBlockId, type: "answer_key", content: { text: "新版解答不属于旧作答。" } },
        ] });
    } };
}

/** Complete public-table data snapshot on this isolated test DB, not PG statistics. */
export async function databaseRows(sql: Sql) {
  const tables = await sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    const [row] = await sql`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${sql(tablename)} t`;
    result[tablename] = row!.rows;
  }
  return result;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
