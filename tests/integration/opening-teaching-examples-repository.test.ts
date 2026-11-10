import { randomUUID } from "node:crypto";
import { createModelGateway } from "@aistudy/ai";
import { createTeachingExampleHandler } from "../../apps/worker/src/jobs/teaching-example";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository, createOpeningTeachingExamplesRepository, createOpeningJobRepository, openingJobScope, teachingExampleJobPayloadSchema, createOpeningLearningRepository, createOpeningTeachingHintRepository, readOpeningLearningEvidenceContext } from "@aistudy/database";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
async function seed() {
  const base = await learningAttemptFixture(fixture), { scope, sql } = fixture;
  const activity = await createOpeningTeachingActivitiesRepository(sql).create(scope, { clientKey: randomUUID(), intentKind: "topic", intentSummary: "高数合成材料", courseId: base.courseId, sourceIds: [base.sourceId], createIntent: {} });
  const exampleId = randomUUID(), q1 = randomUUID(), a1 = randomUUID(), q2 = randomUUID(), a2 = randomUUID();
  const blocks = [
    { id: exampleId, type: "example", content: { text: "求 $\\int x^2 dx$。幂函数积分得 $x^3/3+C$。" } },
    { id: q1, type: "prompt", content: { text: "求 $\\int x^3 dx$。" } },
    { id: a1, type: "answer_key", content: { answer: "$x^4/4+C$", hints: { direction: "比较幂次", concept: "幂函数积分", firstStep: "幂次加一" } } },
    { id: q2, type: "prompt", content: { text: "求极限 $\\lim_{x\\to0}\\sin x/x$。" } },
    { id: a2, type: "answer_key", content: { answer: "1" } },
  ];
  const order = blocks.map((b, position) => ({ blockId: b.id, position, blockType: b.type, role: b.type === "example" ? "example" as const : b.type === "prompt" ? "prompt" as const : "answer_key" as const }));
  const content = createOpeningTeachingContentRepository(sql), unit = await content.createUnit(scope, { title: "高数", blocks });
  const refs = [{ sourceId: base.sourceId, version: 1, chunkId: base.chunkId }];
  await content.publishActivitySpec(scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 1, blockOrder: order, sourceRefs: refs });
  const learning = createOpeningLearningRepository(sql), attempts = createOpeningAttemptService(sql);
  const session = await learning.createSession(scope, { courseId: base.courseId, activityId: activity.id, skillLabel: "高数", sourceIds: [base.sourceId] });
  const target = { activityId: activity.id, documentId: unit.documentId, revisionNumber: 1, blockId: exampleId, contentVersion: 1 };
  const request = { clientKey: randomUUID(), target, consentVersion: "teaching-example-paid-v1" as const, acceptPaidGeneration: true as const };
  const repository = createOpeningTeachingExamplesRepository(sql), jobs = createOpeningJobRepository(sql);
  const start = (blockId: string, contentVersion: number) => attempts.create(scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId, contentVersion } });
  const submit = (id: string) => attempts.submit(scope, id, { clientKey: randomUUID(), answer: "synthetic", outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  return { ...base, activity, unit, content, blocks, order, refs, q1, q2, repository, jobs, request, start, submit };
}
const proposal = { problem: "求 $\\int x^4 dx$。", workedSolution: "幂次加一后除以5，得 $x^5/5+C$；求导核对。" };
it("atomically appends an example, preserves old help grade, and does not reveal unrelated limits", async () => {
  const f = await seed(), old = await f.start(f.q1, 1);
  const hint = await createOpeningTeachingHintRepository(fixture.sql).read(fixture.scope, { attemptId: old.id, level: 1 });
  const before = await fixture.sql`SELECT * FROM opening_help_exposures WHERE id=${hint.exposureReceipt.id}`;
  const queued = await f.repository.request(fixture.scope, f.request, 1);
  expect(await f.repository.request(fixture.scope, f.request, 9)).toEqual(queued);
  const job = (await f.jobs.claim(queued.operationId))!;
  const payload = teachingExampleJobPayloadSchema.parse(job.payload);
  const published = await f.repository.publish(openingJobScope(job), job.id, payload, proposal);
  expect(published).toMatchObject({ state: "succeeded", publication: { mathematicalStatus: "unchecked", masteryEvidence: false } });
  const init = await f.content.getClientInit(fixture.scope, f.activity.id);
  expect(init!.contentVersion).toBe(2); expect(init!.blocks).toHaveLength(7);
  expect(init!.blocks.find(b => b.blockId === f.request.target.blockId)?.content).toMatchObject(f.blocks[0]!.content);
  const q1 = await f.submit((await f.start(f.q1, 2)).id), q2 = await f.submit((await f.start(f.q2, 2)).id);
  expect(q1.eligibility?.independentAttempt).toBe("no");
  expect(q2.eligibility?.independentAttempt).toBe("yes");
  const helped = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, q1);
  const unrelated = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, q2);
  expect(helped.context.helpHistory.exposures.some(exposure => exposure.level === "hinted")).toBe(true);
  expect(helped.context.helpHistory.exposures.some(exposure => exposure.kind === "solution" || exposure.level === "revealed")).toBe(false);
  expect(unrelated.context.helpHistory.exposures.some(exposure => exposure.kind === "solution" || exposure.level === "revealed")).toBe(false);
  expect(await fixture.sql`SELECT * FROM opening_help_exposures WHERE id=${hint.exposureReceipt.id}`).toEqual(before);
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE activity_id=${f.activity.id}`).toHaveLength(1);
  const revision = await fixture.sql`SELECT blocks FROM library_revisions WHERE document_id=${f.unit.documentId} AND revision_number=2`;
  expect(revision[0]!.blocks.slice(0, 5)).toEqual(payload.blocks);
  // A changed condition is a new question even after a trusted example append.
  const changed = revision[0]!.blocks.map((block: { id: string; content: Record<string, unknown> }) => block.id === f.q1
    ? { ...block, content: { ...block.content, text: "求定积分 $\\int_0^1 x^3 dx$。" } } : block);
  const authored = await f.content.writeUnitBlocks(fixture.scope, f.unit.id, changed);
  await f.content.publishActivitySpec(fixture.scope, { activityId: f.activity.id, teachingUnitId: f.unit.id,
    expectedVersion: 2, revisionNumber: authored.revisionNumber, blockOrder: init!.blockOrder, sourceRefs: f.refs });
  expect((await f.submit((await f.start(f.q1, 3)).id)).eligibility?.independentAttempt).toBe("yes");
  expect(await fixture.sql`SELECT * FROM opening_help_exposures WHERE id=${hint.exposureReceipt.id}`).toEqual(before);
});
it("runs the real example worker/gateway with a synthetic provider and never resends on recovery", async () => {
  const f = await seed(), queued = await f.repository.request(fixture.scope, f.request, 1), job = (await f.jobs.claim(queued.operationId))!;
  let calls = 0, claimed = false;
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete: async () => { calls++; return { text: JSON.stringify(proposal), inputTokens: 20, outputTokens: 40, citedChunkIds: [], requestId: null, candidates: [] }; } },
    modelSnapshot: { id: "synthetic", providerId: "synthetic", modelName: "synthetic", inputCentsPerMillion: 1, outputCentsPerMillion: 1 }, inputCentsPerMillion: 1, outputCentsPerMillion: 1 }) });
  const handler = createTeachingExampleHandler({ repository: f.repository, gateway, budget: () => ({
    reserve: async () => ({ id: randomUUID(), state: "reserved" }), release: async () => {},
    claimExecution: async () => { if (claimed) return false; claimed = true; return true; }, settle: async () => {}, markUnknown: async () => {},
  }) });
  const result = await handler(job, job.payload); expect(result.state).toBe("succeeded");
  await handler(job, job.payload); expect(calls).toBe(1);
});
it("blocks a new key while unknown cost remains and reads without modifying the job", async () => {
  const f = await seed(), queued = await f.repository.request(fixture.scope, f.request, 1);
  await fixture.sql`INSERT INTO opening_budget_reservations(workspace_id,purpose,amount_cents,request_id,state,outcome_unknown_at)
    VALUES(${fixture.scope.workspaceId},'grade-text',1,${`teaching-example:${queued.operationId}`},'reserved',now())`;
  await fixture.sql`UPDATE opening_jobs SET state='outcome_unknown' WHERE id=${queued.operationId}`;
  const before = await fixture.sql`SELECT * FROM opening_jobs WHERE id=${queued.operationId}`;
  expect(await f.repository.read(fixture.scope, queued.operationId)).toMatchObject({ state: "outcome_unknown", costState: "unknown", publication: null });
  expect(await fixture.sql`SELECT * FROM opening_jobs WHERE id=${queued.operationId}`).toEqual(before);
  await expect(f.repository.request(fixture.scope, { ...f.request, clientKey: randomUUID() }, 1)).rejects.toThrow("费用未知");
});
it("rejects stale source with zero publication mutation", async () => {
  const f = await seed(), queued = await f.repository.request(fixture.scope, f.request, 1), job = (await f.jobs.claim(queued.operationId))!;
  const payload = teachingExampleJobPayloadSchema.parse(job.payload);
  await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  await expect(f.repository.publish(openingJobScope(job), job.id, payload, proposal)).rejects.toThrow();
  expect((await f.content.getClientInit(fixture.scope, f.activity.id))!.contentVersion).toBe(1);
  expect(await fixture.sql`SELECT id FROM library_revisions WHERE document_id=${f.unit.documentId}`).toHaveLength(1);
});
it.each(["content", "privacy", "foreign_owner"])("fences %s changes without library/spec mutation", async kind => {
  const f = await seed(), queued = await f.repository.request(fixture.scope, f.request, 1), job = (await f.jobs.claim(queued.operationId))!;
  const payload = teachingExampleJobPayloadSchema.parse(job.payload);
  if (kind === "content") await fixture.sql`UPDATE opening_teaching_activities SET content_version=2 WHERE id=${f.activity.id}`;
  if (kind === "privacy") await fixture.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${fixture.scope.workspaceId}`;
  const scope = kind === "foreign_owner" ? { ...openingJobScope(job), ownerUserId: randomUUID() } : openingJobScope(job);
  await expect(f.repository.publish(scope, job.id, payload, proposal)).rejects.toThrow();
  expect(await fixture.sql`SELECT id FROM library_revisions WHERE document_id=${f.unit.documentId}`).toHaveLength(1);
  const [spec] = await fixture.sql`SELECT revision_number,version FROM opening_teaching_activity_specs WHERE activity_id=${f.activity.id}`;
  expect(spec).toMatchObject({ revision_number: 1, version: 1 });
});
it("cancellation and failure of example jobs do not change whole-lesson generation", async () => {
  for (const cancel of [true, false]) {
    const f = await seed(), queued = await f.repository.request(fixture.scope, f.request, 1);
    await fixture.sql`UPDATE opening_teaching_activities SET generate_status='generating' WHERE id=${f.activity.id}`;
    if (cancel) await f.jobs.cancel(fixture.scope, queued.operationId);
    else { const job = (await f.jobs.claim(queued.operationId))!; await f.jobs.finish(job.id, "failed", {}, job.claimToken); }
    const [activity] = await fixture.sql`SELECT generate_status,content_version FROM opening_teaching_activities WHERE id=${f.activity.id}`;
    expect(activity).toMatchObject({ generate_status: "generating", content_version: 1 });
  }
});
