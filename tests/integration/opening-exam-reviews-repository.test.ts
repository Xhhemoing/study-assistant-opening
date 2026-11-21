import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExamCourseBinding, ExamPack, ExamWorkReviewInput, ExamWorkReviewProposal, Scope } from "@aistudy/contracts";
import type { ModelGateway } from "@aistudy/ai";
import { createExamPhotoReviewService } from "../../apps/web/src/features/opening/exam-sprint/review-service";
import { createExamSprintClient } from "../../apps/web/src/features/opening/exam-sprint/client";
import { examSprintResponse } from "../../apps/web/src/features/opening/exam-sprint/http";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
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

  it("replays the same paid review after a lost response, archive and restoration", async () => {
    type Options = Parameters<ModelGateway["call"]>[2];
    const output = { text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 20, citedChunkIds: [], candidates: [], requestId: null };
    const call = vi.fn(async (_scope: Scope, _task: string, options: Options) => {
      await options.beforeSend?.();
      await options.persistResult?.(output, { reservationId: randomUUID(), settledCents: 1 });
      return output;
    });
    const service = createExamPhotoReviewService({ repository, gateway: { call },
      images: async () => [{ mediaType: "image/png", data: "data:image/png;base64,AAAA" }],
      budget: () => ({} as Options["budget"]) });
    const sprint = createOpeningExamSprintRepository(f.sql, pack);
    const keys = vi.fn(() => randomUUID());
    const posted: string[] = [];
    const responses: Response[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      if (init?.method === "GET") return Response.json(await sprint.read(f.scope));
      const body = JSON.parse(String(init?.body)) as ExamWorkReviewInput;
      posted.push(body.clientKey);
      const response = await examSprintResponse(() => service.review(f.scope, body));
      responses.push(response.clone());
      if (posted.length === 1) throw new TypeError("response lost after commit");
      return response;
    };
    const client = createExamSprintClient({ fetcher, keyFactory: keys });
    const { clientKey: _unused, ...photo } = input();
    const command = { action: "review", input: photo } as const;
    await client.sendIntegration(command);
    const receipts = () => f.sql`SELECT id FROM opening_exam_reviews WHERE workspace_id=${f.scope.workspaceId}`;
    const first = await receipts();
    expect(first).toHaveLength(1);
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${binding.courseId}`;
    await client.recover();
    expect(await receipts()).toEqual(first);
    expect(client.getSnapshot().uncertain).toBe(false);
    await f.sql`UPDATE courses SET archived_at=NULL WHERE id=${binding.courseId}`;
    await client.sendIntegration(command);
    expect(await receipts()).toEqual(first);
    expect(client.getSnapshot().review).toMatchObject({ id: first[0]!.id, status: "ready" });
    expect(responses.map(response => response.status)).toEqual([200, 409, 200]);
    expect(await responses[1]!.json()).toMatchObject({ error: { businessCode: "EXAM_RECEIPT_COMMITTED" } });
    expect(posted).toEqual(Array(3).fill(posted[0]));
    expect(keys).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledOnce();
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

  it("reuses the same unresolved intent across a fresh client key", async () => {
    const first = await repository.begin(f.scope, input({ clientKey: randomUUID(), answerText: "  My explanation  " }));
    const retry = await repository.begin(f.scope, input({ clientKey: randomUUID(), answerText: "My explanation" }));
    expect(retry.review.id).toBe(first.review.id);
    expect(retry.review.status).toBe("pending");
    expect(await f.sql`SELECT id FROM opening_exam_reviews WHERE workspace_id=${f.scope.workspaceId}`).toEqual([{ id: first.review.id }]);
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

  it.each(["pending", "unknown"] as const)("does not reuse an unresolved %s review from an earlier privacy epoch when called with a fresh client key", async status => {
    const first = await repository.begin(f.scope, input({ clientKey: randomUUID(), answerText: "My explanation" }));
    if (status === "unknown") await repository.fail(f.scope, first.review.id, "unknown");
    const unrelated = await source();
    await createOpeningPrivacyRepository(f.sql).recordExclusions(f.sql, f.scope, {
      sourceIds: [unrelated], memoryId: randomUUID(), deletedAt: new Date(),
    });
    const fresh = await repository.begin(f.scope, input({ clientKey: randomUUID(), answerText: "My explanation" }));
    expect(fresh.review.id).not.toBe(first.review.id);
    expect(fresh.reusedUnresolved).toBeUndefined();
    expect(fresh.privacyEpoch).toBe(first.privacyEpoch + 1);
    expect(fresh.review.status).toBe("pending");
    const reusedInNewEpoch = await repository.begin(f.scope, input({ clientKey: randomUUID(), answerText: "My explanation" }));
    expect(reusedInNewEpoch.review.id).toBe(fresh.review.id);
    expect(reusedInNewEpoch.reusedUnresolved).toBe(true);
    const rows = await f.sql`SELECT id, status, privacy_epoch FROM opening_exam_reviews
      WHERE workspace_id=${f.scope.workspaceId} ORDER BY privacy_epoch, id`;
    expect(rows.map(row => ({ id: row.id, status: row.status, privacyEpoch: Number(row.privacy_epoch) }))).toEqual([
      { id: first.review.id, status, privacyEpoch: first.privacyEpoch },
      { id: fresh.review.id, status: "pending", privacyEpoch: fresh.privacyEpoch },
    ]);
  });

  it("persists secondary reused keys so a lost Tab B retry replays A's ready receipt without double billing, rejects intent mismatch, and expires on privacy_epoch bump", async () => {
    type Options = Parameters<ModelGateway["call"]>[2];
    const output = { text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 20, citedChunkIds: [], candidates: [], requestId: null };
    let releaseGateway!: () => void;
    let enteredGateway!: () => void;
    const gatewayEntered = new Promise<void>(resolve => { enteredGateway = resolve; });
    const gatewayGate = new Promise<void>(resolve => { releaseGateway = resolve; });
    const call = vi.fn(async (_scope: Scope, _task: string, options: Options) => {
      await options.beforeSend?.();
      enteredGateway();
      await gatewayGate;
      await options.persistResult?.(output, { reservationId: randomUUID(), settledCents: 1 });
      return output;
    });
    const service = createExamPhotoReviewService({ repository, gateway: { call },
      images: async () => [{ mediaType: "image/png", data: "data:image/png;base64,AAAA" }],
      budget: () => ({} as Options["budget"]) });

    const keyA = randomUUID(), keyB = randomUUID();
    const intentA = input({ clientKey: keyA, answerText: "My explanation" });
    const intentB = input({ clientKey: keyB, answerText: "  My explanation  " });

    // Tab A starts review (pending, in-flight in gateway).
    const tabAPromise = service.review(f.scope, intentA);
    await gatewayEntered;
    const [rowA] = await f.sql`SELECT id FROM opening_exam_reviews WHERE workspace_id=${f.scope.workspaceId}`;
    expect(rowA).toBeDefined();

    // Tab B submits same intent with keyB while A is pending -> reuses A, persists alias, no second charge.
    const tabBFirst = await service.review(f.scope, intentB);
    expect(tabBFirst).toMatchObject({ id: rowA!.id, status: "pending" });
    expect(call).toHaveBeenCalledTimes(1);

    // Tab B loses response and retries keyB while A is STILL pending -> still reuses A, no second charge.
    const tabBPendingReplay = await service.review(f.scope, intentB);
    expect(tabBPendingReplay).toMatchObject({ id: rowA!.id, status: "pending" });
    expect(call).toHaveBeenCalledTimes(1);

    // Tab A finishes -> row A becomes ready.
    releaseGateway();
    const tabAResult = await tabAPromise;
    expect(tabAResult).toMatchObject({ id: rowA!.id, status: "ready", proposal });

    // Tab B retries keyB AFTER A completed -> returns A's ready receipt, ZERO new row, ZERO second gateway.call!
    const tabBReadyReplay = await service.review(f.scope, intentB);
    expect(tabBReadyReplay).toMatchObject({ id: rowA!.id, status: "ready", proposal });
    expect(call).toHaveBeenCalledTimes(1);
    expect(await f.sql`SELECT id FROM opening_exam_reviews WHERE workspace_id=${f.scope.workspaceId}`).toEqual([{ id: rowA!.id }]);

    // Mismatched intent on keyB must conflict just like primary client_key.
    await expect(repository.begin(f.scope, { ...intentB, answerText: "Different answer" })).rejects.toMatchObject({ code: "CONFLICT" });

    // Course archive blocks keyB replay with EXAM_RECEIPT_COMMITTED; restoring lets keyB replay without double billing.
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${binding.courseId}`;
    const archivedResponse = await examSprintResponse(() => service.review(f.scope, intentB));
    expect(archivedResponse.status).toBe(409);
    expect(await archivedResponse.json()).toMatchObject({ error: { businessCode: "EXAM_RECEIPT_COMMITTED" } });
    await f.sql`UPDATE courses SET archived_at=NULL WHERE id=${binding.courseId}`;
    expect(await service.review(f.scope, intentB)).toMatchObject({ id: rowA!.id, status: "ready", proposal });
    expect(call).toHaveBeenCalledTimes(1);

    // Privacy epoch bump invalidates keyB replay with EXAM_REVIEW_EPOCH_EXPIRED; client resets key and fresh submit succeeds.
    const unrelated = await source();
    await createOpeningPrivacyRepository(f.sql).recordExclusions(f.sql, f.scope, {
      sourceIds: [unrelated], memoryId: randomUUID(), deletedAt: new Date(),
    });
    const expiredResponse = await examSprintResponse(() => service.review(f.scope, intentB));
    expect(expiredResponse.status).toBe(409);
    expect(await expiredResponse.json()).toMatchObject({ error: { businessCode: "EXAM_REVIEW_EPOCH_EXPIRED" } });

    const sprint = createOpeningExamSprintRepository(f.sql, pack);
    const immediateCall = vi.fn(async (_scope: Scope, _task: string, options: Options) => {
      await options.beforeSend?.();
      await options.persistResult?.(output, { reservationId: randomUUID(), settledCents: 1 });
      return output;
    });
    const freshService = createExamPhotoReviewService({ repository, gateway: { call: immediateCall },
      images: async () => [{ mediaType: "image/png", data: "data:image/png;base64,AAAA" }],
      budget: () => ({} as Options["budget"]) });
    const postedKeys: string[] = [];
    const clientFetcher: typeof fetch = async (_url, init) => {
      if (init?.method === "GET") return Response.json(await sprint.read(f.scope));
      const body = JSON.parse(String(init?.body)) as ExamWorkReviewInput;
      postedKeys.push(body.clientKey);
      return examSprintResponse(() => freshService.review(f.scope, body));
    };
    const keyC = randomUUID();
    const clientKeys = vi.fn().mockReturnValueOnce(keyB).mockReturnValueOnce(keyC);
    const client = createExamSprintClient({ fetcher: clientFetcher, keyFactory: clientKeys });
    const { clientKey: _unused, ...photo } = intentA;
    await client.sendIntegration({ action: "review", input: photo });
    expect(client.getSnapshot()).toMatchObject({ uncertain: false, review: null });
    expect(immediateCall).not.toHaveBeenCalled();
    await client.sendIntegration({ action: "review", input: photo });
    expect(postedKeys).toEqual([keyB, keyC]);
    expect(client.getSnapshot().review).toMatchObject({ status: "ready", proposal });
    expect(client.getSnapshot().review?.id).not.toBe(rowA!.id);
    expect(immediateCall).toHaveBeenCalledOnce();
  });
});
