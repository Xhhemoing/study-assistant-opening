import { randomUUID } from "node:crypto";
import { createModelGateway } from "@aistudy/ai";
import { createTeachingExampleHandler } from "../../apps/worker/src/jobs/teaching-example";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository, createOpeningTeachingExamplesRepository, createOpeningJobRepository, openingJobScope, teachingExampleJobPayloadSchema, createOpeningLearningRepository, createOpeningTeachingHintRepository, readOpeningLearningEvidenceContext } from "@aistudy/database";
import { createOpeningTeachingCommandService } from "../../apps/web/src/features/opening/teaching/command-service";
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
it.each(["append-rephrase", "rephrase-append", "append-reference", "reference-append"] as const)("composes %s with no intermediate attempt and preserves only the real hint", async chain => {
  const f = await seed(), old = await f.start(f.q1, 1);
  const hint = await createOpeningTeachingHintRepository(fixture.sql).read(fixture.scope, { attemptId: old.id, level: 1 });
  const originalReceipt = await fixture.sql`SELECT * FROM opening_help_exposures WHERE id=${hint.exposureReceipt.id}`;
  let version = 1;
  for (const step of chain.split("-")) {
    const init = (await f.content.getClientInit(fixture.scope, f.activity.id))!;
    if (step === "append") {
      const queued = await f.repository.request(fixture.scope, { ...f.request, target: { ...f.request.target, revisionNumber: init.revisionNumber, contentVersion: version } }, 1);
      const job = (await f.jobs.claim(queued.operationId))!;
      await f.repository.publish(openingJobScope(job), job.id, teachingExampleJobPayloadSchema.parse(job.payload), proposal);
    } else if (step === "rephrase") {
      const changed = await createOpeningTeachingCommandService(fixture.sql).execute(fixture.scope, f.activity.id,
        { clientKey: randomUUID(), kind: "rephrase", blockId: f.q1, expectedVersion: version, expectedRevisionNumber: init.revisionNumber });
      expect(changed.ok).toBe(true);
    } else {
      const [saved] = await fixture.sql`SELECT blocks FROM library_revisions WHERE document_id=${f.unit.documentId} AND revision_number=${init.revisionNumber}`;
      const revised = saved!.blocks.map((block: { id: string; type: string; content: Record<string, unknown> }) => block.type === "answer_key"
        ? { ...block, content: { ...block.content, answer: `${String(block.content.answer)}（等价写法）` } } : block);
      const revision = await f.content.writeUnitBlocks(fixture.scope, f.unit.id, revised);
      await f.content.adoptReferenceRevision(fixture.scope, f.activity.id, { expectedContentVersion: version,
        expectedRevisionNumber: init.revisionNumber, revisionNumber: revision.revisionNumber });
    }
    version++;
  }
  // Neither R2 path above issues an attempt. Identity must follow the proven edges.
  const observed = await f.submit((await f.start(f.q1, version)).id);
  const unrelated = await f.submit((await f.start(f.q2, version)).id);
  expect(observed.eligibility?.independentAttempt).toBe("no");
  expect(unrelated.eligibility?.independentAttempt).toBe("yes");
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, observed);
  expect(evidence.context.helpHistory!.exposures.some(item => item.level === "hinted")).toBe(true);
  expect(evidence.context.helpHistory!.exposures.some(item => item.level === "revealed")).toBe(false);
  expect(await fixture.sql`SELECT * FROM opening_help_exposures WHERE id=${hint.exposureReceipt.id}`).toEqual(originalReceipt);
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE activity_id=${f.activity.id}`).toHaveLength(1);
});
it.each(["conditions", "options", "unit", "figure", "refs"] as const)("does not compose changed %s with a later example append", async change => {
  const f = await seed(), old = await f.start(f.q1, 1);
  await createOpeningTeachingHintRepository(fixture.sql).read(fixture.scope, { attemptId: old.id, level: 1 });
  const revised = f.blocks.map(block => block.id !== f.q1 ? block : { ...block, content: { ...block.content,
    ...(change === "conditions" ? { text: "求定积分 x³ 从0到1。" } : {}),
    ...(change === "options" ? { interaction: { kind: "choice", options: [{ id: "A", label: "0" }, { id: "B", label: "1" }] } } : {}),
    ...(change === "unit" ? { interaction: { kind: "numeric", unit: "平方单位" } } : {}),
    ...(change === "figure" ? { figure: { label: "新增必要图形条件" } } : {}),
  } });
  const refs = change === "refs" ? f.refs.map(ref => ({ ...ref, page: 1 })) : f.refs;
  const revision = await f.content.writeUnitBlocks(fixture.scope, f.unit.id, revised);
  await f.content.publishActivitySpec(fixture.scope, { activityId: f.activity.id, teachingUnitId: f.unit.id,
    expectedVersion: 1, revisionNumber: revision.revisionNumber, blockOrder: f.order, sourceRefs: refs });
  const queued = await f.repository.request(fixture.scope, { ...f.request, target: { ...f.request.target, revisionNumber: revision.revisionNumber, contentVersion: 2 } }, 1);
  const job = (await f.jobs.claim(queued.operationId))!;
  await f.repository.publish(openingJobScope(job), job.id, teachingExampleJobPayloadSchema.parse(job.payload), proposal);
  const observed = await f.submit((await f.start(f.q1, 3)).id);
  const evidence = await readOpeningLearningEvidenceContext(fixture.sql, fixture.scope, observed);
  expect(evidence.context.helpHistory!.exposures.some(item => item.level === "hinted" || item.level === "revealed")).toBe(false);
});
async function secondCourse(f: Awaited<ReturnType<typeof seed>>) {
  const id = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${fixture.scope.workspaceId},'Synthetic second course',${id})`;
  await fixture.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility,purpose)
    VALUES(${fixture.scope.workspaceId},${id},'source',${f.sourceId},'core',0,'course','teaching')`;
  return id;
}
it("rejects rebinding between request preparation and final enqueue without a job/outbox", async () => {
  const f = await seed(), c2 = await secondCourse(f), context = f.repository.context.bind(f.repository);
  vi.spyOn(f.repository, "context").mockImplementationOnce(async (...args) => {
    const pinned = await context(...args);
    await createOpeningTeachingActivitiesRepository(fixture.sql).associateCourse(fixture.scope, f.activity.id, { courseId: c2 });
    return pinned;
  });
  await expect(f.repository.request(fixture.scope, f.request, 1)).rejects.toThrow("课程绑定");
  expect(await f.repository.find(fixture.scope, f.request.clientKey)).toBeNull();
});
it.each(["before_send", "after_output", "purpose_revoked"] as const)("rejects %s against the actual activity course with zero publication", async stage => {
  const f = await seed(), c2 = await secondCourse(f);
  const queued = await f.repository.request(fixture.scope, f.request, 1), job = (await f.jobs.claim(queued.operationId))!;
  const payload = teachingExampleJobPayloadSchema.parse(job.payload), scope = openingJobScope(job);
  if (stage === "after_output") await f.repository.assertCurrent(scope, payload);
  if (stage === "purpose_revoked") {
    await fixture.sql`UPDATE course_asset_memberships SET purpose='mock_exam',updated_at=now() WHERE workspace_id=${fixture.scope.workspaceId}
      AND course_id=${f.courseId} AND asset_id=${f.sourceId}`;
  } else {
    await createOpeningTeachingActivitiesRepository(fixture.sql).associateCourse(fixture.scope, f.activity.id, { courseId: c2 });
    await fixture.sql`UPDATE course_asset_memberships SET purpose='mock_exam',updated_at=now() WHERE workspace_id=${fixture.scope.workspaceId}
      AND course_id=${c2} AND asset_id=${f.sourceId}`;
  }
  await expect(f.repository.assertCurrent(scope, payload)).rejects.toThrow();
  await expect(f.repository.publish(scope, job.id, payload, proposal)).rejects.toThrow();
  expect(await fixture.sql`SELECT id FROM library_revisions WHERE document_id=${f.unit.documentId}`).toHaveLength(1);
  const [spec] = await fixture.sql`SELECT version,revision_number FROM opening_teaching_activity_specs WHERE activity_id=${f.activity.id}`;
  expect(spec).toMatchObject({ version: 1, revision_number: 1 });
  const [activity] = await fixture.sql`SELECT content_version FROM opening_teaching_activities WHERE id=${f.activity.id}`;
  expect(activity!.content_version).toBe(1);
});
it.each(["exact", "normalized"] as const)("refuses %s current prompt collision after synthetic output without publication, resend or unrelated help", async spelling => {
  const f = await seed(), queued = await f.repository.request(fixture.scope, f.request, 1), job = (await f.jobs.claim(queued.operationId))!;
  const collision = spelling === "exact" ? String(f.blocks[1]!.content.text) : String(f.blocks[1]!.content.text).replace(/\s+/g, "");
  const release = vi.fn(async () => {}), settle = vi.fn(async () => {}), markUnknown = vi.fn(async () => {});
  let ledger: "unsent" | "unknown" = "unsent";
  const provider = { complete: vi.fn(async () => ({ text: JSON.stringify({ problem: collision, workedSolution: "幂次加一后除以4，得 $x^4/4+C$；求导核对。" }),
    inputTokens: 20, outputTokens: 40, citedChunkIds: [], requestId: null, candidates: [] })) };
  const gateway = createModelGateway({ resolve: async () => ({ provider, modelSnapshot: { id: "synthetic", providerId: "synthetic", modelName: "synthetic", inputCentsPerMillion: 1, outputCentsPerMillion: 1 }, inputCentsPerMillion: 1, outputCentsPerMillion: 1 }) });
  const handler = createTeachingExampleHandler({ repository: { ...f.repository, ledger: async () => ledger }, gateway, budget: () => ({
    reserve: async () => ({ id: randomUUID(), state: "reserved" }), claimExecution: async () => true, release, settle,
    markUnknown: async () => { ledger = "unknown"; await markUnknown(); },
  }) });
  await expect(handler(job, job.payload)).rejects.toThrow("当前练习题");
  expect(provider.complete).toHaveBeenCalledTimes(1);
  expect(markUnknown).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
  await expect(handler(job, job.payload)).rejects.toThrow("不会重发");
  expect(provider.complete).toHaveBeenCalledTimes(1);
  const init = (await f.content.getClientInit(fixture.scope, f.activity.id))!;
  expect(init.contentVersion).toBe(1); expect(init.revisionNumber).toBe(1); expect(init.blocks).toHaveLength(5);
  expect(await fixture.sql`SELECT id FROM library_revisions WHERE document_id=${f.unit.documentId}`).toHaveLength(1);
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE activity_id=${f.activity.id}`).toHaveLength(0);
  expect((await f.submit((await f.start(f.q1, 1)).id)).eligibility?.independentAttempt).toBe("yes");
  expect((await f.submit((await f.start(f.q2, 1)).id)).eligibility?.independentAttempt).toBe("yes");
});
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
  expect(helped.context.helpHistory!.exposures.some(exposure => exposure.level === "hinted")).toBe(true);
  expect(helped.context.helpHistory!.exposures.some(exposure => exposure.kind === "solution" || exposure.level === "revealed")).toBe(false);
  expect(unrelated.context.helpHistory!.exposures.some(exposure => exposure.kind === "solution" || exposure.level === "revealed")).toBe(false);
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
