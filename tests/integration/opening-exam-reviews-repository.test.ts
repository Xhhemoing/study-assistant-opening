import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamCourseBinding, ExamPack, ExamWorkReviewInput, ExamWorkReviewProposal, Scope } from "@aistudy/contracts";
import { createOpeningPrivacyRepository } from "@aistudy/database";
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
let binding: ExamCourseBinding;
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
  const result = await createOpeningExamIntegrationRepository(f.sql, pack).bind(f.scope, {
    clientKey: randomUUID(), courseId, milestoneId: null, expectedPackVersion: pack.version,
    createKnowledgeNodes: true, skills: [],
    materials: [{ sourceTitle: "Worksheet.pdf", sourceId: referenceId, sourceVersion: 1 }],
  });
  binding = result.binding!;
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
async function rawReview(id: string) {
  const [row] = await f.sql`SELECT status,proposal,model_label FROM opening_exam_reviews WHERE id=${id}`;
  return row;
}

describe("exam photo review repository integration", () => {
  it("uses the actual owned work image and bound reference page without treating a proposal as learning evidence", async () => {
    const facts = () => f.sql`SELECT
      (SELECT count(*) FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}) AS observations,
      (SELECT count(*) FROM opening_learning_attempts WHERE workspace_id=${f.scope.workspaceId}) AS attempts,
      (SELECT count(*) FROM opening_learning_sessions WHERE workspace_id=${f.scope.workspaceId}) AS sessions,
      (SELECT state FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}) AS sprint_state`;
    const before = await facts(), intent = input();
    const pending = await repository.begin(f.scope, intent);
    expect(pending).toMatchObject({ input: intent, referencePage: 2,
      questionLabel: "Worksheet.pdf，物理页 2，Exercise 1",
      review: { status: "pending", sourceItemId: "worksheet-1", workSourceId: workId,
        referenceSourceId: referenceId, proposal: null, modelLabel: null } });
    await repository.complete(f.scope, pending.review.id, proposal, "review-model");
    expect(await repository.read(f.scope, pending.review.id)).toMatchObject({ status: "ready", proposal, modelLabel: "review-model" });
    await repository.begin(f.scope, intent);
    await repository.fail(f.scope, pending.review.id, "failed");
    expect(await facts()).toEqual(before);
  });

  it("checks both workspace and owner for creation, reading, completion and failure updates", async () => {
    const pending = await repository.begin(f.scope, input()), id = pending.review.id;
    const forged = { workspaceId: f.scope.workspaceId, ownerUserId: f.otherScope.ownerUserId };
    for (const scope of [f.otherScope, forged]) {
      await expect(repository.read(scope, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(repository.assertCurrent(scope, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(repository.complete(scope, id, proposal, "foreign-model")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await repository.fail(scope, id, "failed");
    }
    await expect(repository.begin(forged, input())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await rawReview(id)).toMatchObject({ status: "pending", proposal: null, model_label: null });
  });

  it("serializes simultaneous retries by client key and rejects a changed intent", async () => {
    const intent = input();
    const [first, retry] = await Promise.all([repository.begin(f.scope, intent), repository.begin(f.scope, intent)]);
    expect(retry).toEqual(first);
    await expect(repository.begin(f.scope, { ...intent, answerText: "A different answer" })).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await f.sql`SELECT id FROM opening_exam_reviews WHERE workspace_id=${f.scope.workspaceId}`;
    expect(rows.map(row => row.id)).toEqual([first.review.id]);
  });

  it("keeps the first completed proposal when later completions or failure callbacks arrive", async () => {
    const { review } = await repository.begin(f.scope, input());
    await repository.fail(f.scope, review.id, "unknown");
    expect((await repository.read(f.scope, review.id)).status).toBe("unknown");
    await repository.complete(f.scope, review.id, proposal, "first-model");
    await repository.complete(f.scope, review.id, { ...proposal, outcome: "incorrect", summary: "A different candidate" }, "later-model");
    await repository.fail(f.scope, review.id, "unknown");
    await repository.fail(f.scope, review.id, "failed");
    expect(await rawReview(review.id)).toMatchObject({ status: "ready", proposal, model_label: "first-model" });
  });

  it("requires a real binding, known source item, exact reference identity and the item's physical page", async () => {
    const unbound = await source({ mime: "application/pdf", page: 2 });
    for (const overrides of [
      { sourceItemId: "unknown-item" }, { referenceSourceId: unbound }, { referenceSourceVersion: 0 }, { referenceSourceVersion: 2 },
    ]) await expect(repository.begin(f.scope, input(overrides))).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE opening_source_chunks SET page=3 WHERE source_id=${referenceId}`;
    await expect(repository.begin(f.scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`DELETE FROM opening_exam_bindings WHERE sprint_id IN
      (SELECT id FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId})`;
    await expect(repository.begin(f.scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM opening_exam_reviews WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  });

  it("rejects reference materials, catalog lessons, non-images, foreign images and unrecorded image versions as learner work", async () => {
    const document = await source({ mime: "application/pdf" }), foreign = await source({ scope: f.otherScope });
    for (const workSourceId of [referenceId, binding.packSourceId, document]) {
      await expect(repository.begin(f.scope, input({ workSourceId, workSourceVersion: workSourceId === binding.packSourceId ? 0 : 1 })))
        .rejects.toMatchObject({ code: "VALIDATION" });
    }
    for (const overrides of [{ workSourceId: foreign }, { workSourceVersion: 0 }, { workSourceVersion: 2 }]) {
      await expect(repository.begin(f.scope, input(overrides))).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(await f.sql`SELECT id FROM opening_exam_reviews WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  });

  it.each(["work", "reference"] as const)("revalidates the current %s version before returning or publishing a result", async kind => {
    const intent = input(), { review } = await repository.begin(f.scope, intent);
    const sourceId = kind === "work" ? workId : referenceId;
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
    await expect(repository.begin(f.scope, intent)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.read(f.scope, review.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.assertCurrent(f.scope, review.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.complete(f.scope, review.id, proposal, "stale-model")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rawReview(review.id)).toMatchObject({ status: "pending", proposal: null });
  });

  it.each(["work", "reference"] as const)("rejects unavailable or excluded %s materials, including already-created reviews", async kind => {
    const { review } = await repository.begin(f.scope, input()), sourceId = kind === "work" ? workId : referenceId;
    await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${sourceId}`;
    await expect(repository.begin(f.scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.complete(f.scope, review.id, proposal, "unavailable-model")).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE opening_source_versions SET availability='available' WHERE source_id=${sourceId}`;
    await createOpeningPrivacyRepository(f.sql).recordExclusions(f.sql, f.scope, {
      sourceIds: [sourceId], memoryId: randomUUID(), deletedAt: new Date(),
    });
    await expect(repository.begin(f.scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.read(f.scope, review.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.complete(f.scope, review.id, proposal, "excluded-model")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await rawReview(review.id)).toMatchObject({ status: "pending", proposal: null });
  });

  it("invalidates an in-flight proposal when the workspace privacy epoch changes, even if its own materials remain available", async () => {
    const intent = input(), pending = await repository.begin(f.scope, intent), unrelated = await source();
    await createOpeningPrivacyRepository(f.sql).recordExclusions(f.sql, f.scope, {
      sourceIds: [unrelated], memoryId: randomUUID(), deletedAt: new Date(),
    });
    await expect(repository.assertCurrent(f.scope, pending.review.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.complete(f.scope, pending.review.id, proposal, "old-context-model")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.begin(f.scope, intent)).rejects.toMatchObject({ code: "CONFLICT" });
    const fresh = await repository.begin(f.scope, input());
    expect(fresh.privacyEpoch).toBe(pending.privacyEpoch + 1);
    expect(fresh.review.id).not.toBe(pending.review.id);
  });
});
