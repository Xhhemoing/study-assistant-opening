import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { createCourseMembershipRepository, createOpeningCourseReadySourcesRepository, type OpeningScope } from "@aistudy/database";

/** Entirely synthetic manually confirmed single text question. No real source or HTTP/auth fixture. */
export async function materialImportFixture(sql: Sql) {
  const ownerUserId = randomUUID(), workspaceId = randomUUID();
  const scope: OpeningScope = { ownerUserId, workspaceId };
  await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${ownerUserId},${`${ownerUserId}@example.test`},'Synthetic import','test')`;
  await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${workspaceId},${ownerUserId})`;
  const courses = createCourseMembershipRepository(sql);
  const course = await courses.createCourse({ workspaceId, title: "Synthetic text question", slug: randomUUID() });
  const sourceId = randomUUID(), questionChunk = randomUUID(), answerChunk = randomUUID();
  const question = "What is 1 + 1?", answer = "2";
  const bytes = Buffer.from(`${question}\n${answer}`);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${workspaceId},'synthetic.txt','text/plain',${bytes.length},${sourceSha256},1,'uploaded','ready')`;
  for (const [id, text] of [[questionChunk, question], [answerChunk, answer]] as const) {
    await sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${id},${sourceId},1,NULL,${text})`;
  }
  const membershipInput = { workspaceId, courseId: course.id, assetType: "source" as const, assetId: sourceId };
  const membership = await courses.addAssetMembership({ ...membershipInput, purpose: "teaching", role: "core", visibility: "private" });
  const purposePin = await createOpeningCourseReadySourcesRepository(sql).readMaterialPurposePin(scope,
    { courseId: course.id, sourceIds: [sourceId], materialUse: "teaching" });
  const locator = (chunkId: string, text: string) => ({ sourceId, sourceVersion: 1, sourceSha256, chunkId,
    physicalPage: null, printedLabel: null, textRange: { start: 0, end: text.length } });
  const input = { schemaVersion: 1 as const, sourceId, sourceVersion: 1, sourceSha256, expectedManifestRevision: 0,
    mappingId: randomUUID(), questionId: randomUUID(),
    question: { locator: locator(questionChunk, question), content: { schemaVersion: 1 as const, contentVersion: 1, stem: question, interaction: { kind: "numeric" as const } } },
    answer: { locator: locator(answerChunk, answer), content: { schemaVersion: 1 as const, contentVersion: 1, role: "answer_key" as const, text: answer } },
    manualConfirmation: { method: "manual_transcription" as const, confirmed: true as const } };
  const selection = { courseId: course.id, purposePin };
  return { scope, sourceId, course, membership, membershipInput, courses, input, selection,
    selector: { ...selection, sourceId, sourceVersion: 1, mappingId: input.mappingId, expectedManifestRevision: 1 } };
}

export async function importState(sql: Sql, sourceId: string, scope: OpeningScope) {
  return { versions: await sql`SELECT * FROM opening_source_versions WHERE source_id=${sourceId}`,
    history: await sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}` };
}
