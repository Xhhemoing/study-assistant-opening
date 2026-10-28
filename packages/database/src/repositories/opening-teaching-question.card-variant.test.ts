import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { readTeachingQuestionForGrading, type TeachingQuestionSpec } from "./opening-teaching-question";

const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
function fixture() {
  const activityId = randomUUID(), revisionId = randomUUID(), blockId = randomUUID(), sourceId = randomUUID(), photoId = randomUUID();
  const spec: TeachingQuestionSpec = { kind: "teaching_question", specVersion: "teaching-question-v1", activityId,
    teachingUnitId: randomUUID(), contentVersion: 1, documentId: randomUUID(), revisionId, revisionNumber: 1, blockId,
    answerBlockId: randomUUID(), sourceRefs: [{ sourceId, version: 1 }, { sourceId: photoId, version: 2 }] };
  const intent: Record<string, unknown> = { kind: "card_review_variant", cardId: randomUUID(), cardContentVersion: 1, reviewReps: 0,
    privacyEpoch: 0, sourceVersions: { [sourceId]: 1, [photoId]: 2 }, variantRevisionId: revisionId, variantBlockId: blockId, variantContentVersion: 1 };
  const row: Record<string, unknown> = { activity_id: activityId, teaching_revision_id: revisionId, teaching_block_id: blockId, create_intent: intent,
    blocks: [{ id: blockId, type: "prompt", content: { text: "What limit defines the derivative?" } },
      { id: spec.answerBlockId, type: "answer_key", content: { answer: "The limit of the difference quotient." } }] };
  const sql = vi.fn(async () => [row]);
  const item = { id: randomUUID(), activity_id: activityId, teaching_revision_id: revisionId, teaching_block_id: blockId, evaluation_spec: spec };
  return { spec, intent, row, sql, item, sourceId, photoId, read: () => readTeachingQuestionForGrading(sql as never, scope, item) };
}

it.each(["original", "null_locators", "string_version"])("uses the generated question/rubric while preserving %s card lineage metadata", async mode => {
  const f = fixture();
  if (mode === "null_locators") f.spec.sourceRefs = f.spec.sourceRefs!.map(ref => ({ ...ref, page: null, chunkId: null }));
  if (mode === "string_version") f.spec.sourceRefs![0]!.version = "1";
  const original = structuredClone(f.spec);
  expect(await f.read()).toMatchObject({ stem: "What limit defines the derivative?", sourceRefs: [] });
  expect((await f.read())!.referenceText).toContain("The limit of the difference quotient.");
  expect(f.spec).toEqual(original);
});

it.each(["ordinary", "activity", "revision", "block", "content_version", "missing_source", "extra_source", "duplicate", "wrong_version", "chunk", "page"])(
  "retains strict teaching references for a noncanonical %s binding", async mode => {
    const f = fixture();
    if (mode === "ordinary") f.intent.kind = "course_continue";
    if (mode === "activity") f.row.activity_id = randomUUID();
    if (mode === "revision") f.intent.variantRevisionId = randomUUID();
    if (mode === "block") f.intent.variantBlockId = randomUUID();
    if (mode === "content_version") f.intent.variantContentVersion = 2;
    if (mode === "missing_source") f.spec.sourceRefs = f.spec.sourceRefs!.slice(0, 1);
    if (mode === "extra_source") f.spec.sourceRefs!.push({ sourceId: randomUUID(), version: 1 });
    if (mode === "duplicate") f.spec.sourceRefs = [f.spec.sourceRefs![0]!, f.spec.sourceRefs![0]!];
    if (mode === "wrong_version") f.spec.sourceRefs![0]!.version = 3;
    if (mode === "chunk") f.spec.sourceRefs![0]!.chunkId = randomUUID();
    if (mode === "page") f.spec.sourceRefs![0]!.page = 1;
    expect((await f.read())!.sourceRefs).toEqual(f.spec.sourceRefs);
  },
);
