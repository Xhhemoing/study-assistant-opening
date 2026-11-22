import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamPack, ExamWorkReviewInput, ExamWorkReviewProposal, Scope } from "@aistudy/contracts";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { createOpeningExamReviewsRepository } from "../../packages/database/src/repositories/opening-exam-reviews";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const pack: ExamPack = {
  id: "review-fixture", version: "1", title: "Review", description: "Reviewed fixture",
  topics: [{ id: "limits", title: "Limits" }],
  lessons: [{ id: "lesson", topicId: "limits", title: "Limits", summary: "Review",
    steps: ["Check the conditions"], workedExample: "Public worked example", pitfalls: [] }],
  questions: [{ id: "question", topicId: "limits", skillId: "limit-rules", familyId: "family", lessonId: "lesson",
    pool: "training", difficulty: "foundation", prompt: "Practice question",
    options: [{ id: "a", label: "First" }, { id: "b", label: "Second" }],
    answer: "a", explanation: "Catalog explanation", hint: "Catalog hint", estimatedMinutes: 2 }],
  sourceItems: [{ id: "worksheet-1", topicId: "limits", label: "Exercise 1", sourceTitle: "Worksheet.pdf", sourcePage: 2,
    kind: "exercise", suggestedDay: 1, skills: ["limit-rules"] }],
  weekPlan: [], limitations: ["Practice only"],
};
const proposal: ExamWorkReviewProposal = {
  transcription: "Learner's handwritten argument", questionMatch: true, outcome: "correct",
  steps: [{ label: "Check conditions", verdict: "correct", feedback: "The written conditions match the reference." }],
  summary: "Candidate review; the learner still needs to confirm it.", errorCause: null,
};
let f: OpeningFixture;
let repository: ReturnType<typeof createOpeningExamReviewsRepository>;
let workId: string;
let referenceId: string;

beforeAll(async () => {
  f = await createOpeningFixture();
  repository = createOpeningExamReviewsRepository(f.sql);
});
beforeEach(async () => {
  await f.sql`DELETE FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}`;
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${f.scope.workspaceId},'Review course',${courseId})`;
  referenceId = await source({ mime: "application/pdf", page: 2 });
  workId = await source();
  await createOpeningExamIntegrationRepository(f.sql, pack).bind(f.scope, {
    clientKey: randomUUID(), courseId, milestoneId: null, expectedPackVersion: pack.version,
    createKnowledgeNodes: true, skills: [],
    materials: [{ sourceTitle: "Worksheet.pdf", sourceId: referenceId, sourceVersion: 1 }],
  });
});
afterAll(async () => {
  if (!f) return;
  await f.sql`DELETE FROM opening_exam_sprints WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.sql`DELETE FROM opening_source_versions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.close();
});

async function source(options: { scope?: Scope; mime?: string; page?: number } = {}): Promise<string> {
  const id = randomUUID(), scope = options.scope ?? f.scope, mime = options.mime ?? "image/png";
  const image = mime.startsWith("image/");
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${id},${scope.workspaceId},${image ? "My work.png" : "Worksheet.pdf"},${mime},12,${"a".repeat(64)},1,'uploaded','ready')`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES(${id},1,${scope.workspaceId},12,${"a".repeat(64)},'available')`;
  // Repository tests exercise persisted availability. Object bytes are loaded by the review service.
  await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text,image_object_key)
    VALUES(${id},1,${options.page ?? 1},${image ? "" : "Exercise and reference method"},${image ? `images/${id}.png` : null})`;
  return id;
}

function input(overrides: Partial<ExamWorkReviewInput> = {}): ExamWorkReviewInput {
  return { clientKey: randomUUID(), sourceItemId: "worksheet-1", workSourceId: workId, workSourceVersion: 1,
    referenceSourceId: referenceId, referenceSourceVersion: 1, answerText: "My explanation", ...overrides };
}
describe("exam review restore", () => {
  it("finds a valid ready sibling after restore removes supersession pointers, while preserving a lone unknown", async () => {
    const old = await repository.begin(f.scope, input());
    await repository.fail(f.scope, old.review.id, "unknown");
    expect(await repository.read(f.scope, old.review.id)).toMatchObject({ id: old.review.id, status: "unknown" });
    const winnerInput = { ...old.input, clientKey: randomUUID() }, winnerId = randomUUID();
    const [record] = await f.sql`SELECT sprint_id,privacy_epoch FROM opening_exam_reviews WHERE id=${old.review.id}`;
    await f.sql`INSERT INTO opening_exam_reviews(id,sprint_id,workspace_id,owner_user_id,source_item_id,
      work_source_id,work_source_version,reference_source_id,reference_source_version,answer_text,
      client_key,intent,status,proposal,model_label,privacy_epoch)
      VALUES(${winnerId},${record!.sprint_id},${f.scope.workspaceId},${f.scope.ownerUserId},${winnerInput.sourceItemId},
      ${winnerInput.workSourceId},${winnerInput.workSourceVersion},${winnerInput.referenceSourceId},${winnerInput.referenceSourceVersion},
      ${winnerInput.answerText},${winnerInput.clientKey},${f.sql.json(winnerInput)},'ready',${f.sql.json(proposal)},'winner',${record!.privacy_epoch})`;
    expect((await repository.begin(f.scope, winnerInput)).review.id).toBe(winnerId);
    await f.sql`DELETE FROM opening_exam_integration_commands WHERE sprint_id=${record!.sprint_id}`;
    expect(await repository.read(f.scope, old.review.id)).toMatchObject({ id: winnerId, status: "ready", proposal });
    await f.sql`UPDATE opening_exam_reviews SET proposal='{}'::jsonb WHERE id=${winnerId}`;
    expect(await repository.read(f.scope, old.review.id)).toMatchObject({ id: old.review.id, status: "unknown" });
    await f.sql`UPDATE opening_exam_reviews SET proposal=${f.sql.json(proposal)},
      intent=${f.sql.json({ ...winnerInput, answerText: "different" })} WHERE id=${winnerId}`;
    expect(await repository.read(f.scope, old.review.id)).toMatchObject({ id: old.review.id, status: "unknown" });
  });

});
