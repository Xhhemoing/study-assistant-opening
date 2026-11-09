import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";
import { createOpeningCourseExamRepository, createOpeningTeachingContentRepository, createOpeningLearningRepository,
  createOpeningAiGradingRepository, createOpeningExamSprintRepository, createScopedOpeningSystemQueryReader } from "@aistudy/database";
import type { CourseExamProposal, ExamPack } from "@aistudy/contracts";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
const proposal = (chunkId: string): CourseExamProposal => ({ title: "线性代数模拟练习", topics: [{ label: "矩阵秩", evidenceChunkIds: [chunkId] }],
  questions: [1,2,3].map(index => ({ topic: "矩阵秩", prompt: `第${index}题：计算二阶单位矩阵的秩并说明理由。`,
    referenceAnswer: "两列线性无关，因此秩等于2。", rubric: ["识别线性无关列", "秩等于2"],
    hints: { direction: "观察列向量。", concept: "秩是线性无关列的最大数量。", firstStep: "写出两个列向量。" },
    evidenceChunkIds: [chunkId], estimatedMinutes: 5 })) });
async function seed() {
  const f = await learningAttemptFixture(fixture);
  await fixture.sql`UPDATE course_asset_memberships SET role='reference',visibility='private'
    WHERE workspace_id=${fixture.scope.workspaceId} AND course_id=${f.courseId} AND asset_type='source' AND asset_id=${f.sourceId}`;
  await fixture.sql`UPDATE opening_source_chunks SET text='线性代数期末真题：求矩阵的秩；判断列向量是否线性无关。' WHERE id=${f.chunkId}`;
  const repo = createOpeningCourseExamRepository(fixture.sql), input = { clientKey: randomUUID(), sourceId: f.sourceId, questionCount: 3 };
  return { ...f, repo, input, begin: () => repo.begin(fixture.scope, f.courseId, input) };
}

it.each(["begin", "read-expiry", "complete", "fail"] as const)("%s fences the nonempty exam graph before owner/course/source/sprint locks", async operation => {
  const f = await seed(), ctx = await f.begin();
  if (operation === "read-expiry") {
    const earlier = new Date(Date.now() - 11 * 60_000).toISOString();
    await fixture.sql`UPDATE opening_exam_sprints SET pack_snapshot=jsonb_set(pack_snapshot,'{requests,0,createdAt}',to_jsonb(${earlier}::text)) WHERE course_id=${f.courseId}`;
  }
  await fixture.sql`UPDATE opening_workspace_history_revisions SET revision=17 WHERE workspace_id=${fixture.scope.workspaceId}`;
  const graph = () => fixture.sql`SELECT to_jsonb(s) AS sprint,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM opening_teaching_activities a WHERE a.course_id=${f.courseId}) AS activities
    FROM opening_exam_sprints s WHERE course_id=${f.courseId}`;
  const before = await graph();
  expect(before).toHaveLength(1);
  const holder = await openRaceSession().ready, writer = await openRaceSession().ready, probe = await openRaceSession().ready;
  let release = () => {}, entered = () => {};
  const opened = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const holding = track(holder.sql.begin(async tx => {
    await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId} FOR UPDATE`;
    entered(); await held;
  }));
  const pending: Promise<unknown>[] = [holding];
  try {
    await opened;
    const repo = createOpeningCourseExamRepository(writer.sql);
    const scope = { ...fixture.scope, workspaceId: fixture.scope.workspaceId.toUpperCase() };
    const work = track<unknown>(operation === "begin" ? repo.begin(scope, f.courseId, { ...f.input, clientKey: randomUUID() })
      : operation === "read-expiry" ? repo.read(scope, f.courseId)
        : operation === "complete" ? repo.complete(scope, f.courseId, ctx.request.id, proposal(f.chunkId), null)
          : repo.fail(scope, f.courseId, ctx.request.id, "failed"));
    pending.push(work);
    await waitUntilBlocked(fixture.sql, writer.pid, holder.pid, operation, /opening_workspace_history_revisions/);
    expect(await graph()).toEqual(before);
    await probe.sql.begin(async tx => {
      await tx`SELECT id FROM workspaces WHERE id=${fixture.scope.workspaceId} FOR UPDATE NOWAIT`;
      await tx`SELECT id FROM courses WHERE id=${f.courseId} FOR UPDATE NOWAIT`;
      await tx`SELECT id FROM opening_sources WHERE id=${f.sourceId} FOR UPDATE NOWAIT`;
      await tx`SELECT id FROM opening_exam_sprints WHERE course_id=${f.courseId} FOR UPDATE NOWAIT`;
    });
    expect((await createOpeningCourseExamRepository(probe.sql).read(fixture.otherScope, await otherCourse())).papers).toEqual([]);
    release(); await holding; await work;
    expect(await fixture.sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`).toEqual([{ revision: "17" }]);
    expect(await graph()).not.toEqual(before);
  } finally { release(); await Promise.allSettled(pending); await closeRace(holder.sql); await closeRace(writer.sql); await closeRace(probe.sql); }
});

async function otherCourse() {
  const id = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${fixture.otherScope.workspaceId},'Other',${id})`;
  return id;
}

it("rolls back a lazy history ensure on source conflict, while preserving input and missing request errors", async () => {
  const f = await seed();
  await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
  await expect(f.repo.begin(fixture.scope, f.courseId, { ...f.input, sourceId: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.repo.fail(fixture.scope, f.courseId, randomUUID(), "failed")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(f.repo.begin(fixture.scope, "not-a-uuid", f.input)).rejects.toMatchObject({ code: "22P02" });
  expect(await fixture.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`).toEqual([]);
  expect(await fixture.sql`SELECT * FROM opening_exam_sprints WHERE course_id=${f.courseId}`).toEqual([]);
});

it("rejects course deletion after precheck and rolls the lazy history ensure back without retry", async () => {
  const f = await seed();
  await fixture.sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`;
  const writer = await openRaceSession().ready;
  let release = () => {}, enter = () => {};
  const opened = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const wrapped = new Proxy(writer.sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => work(new Proxy(tx, {
      apply(query, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        const result = Reflect.apply(query, thisArg, args);
        if (!/SELECT id FROM courses/.test(args[0].join("?"))) return result;
        return Promise.resolve(result).then(async rows => { enter(); await held; return rows; });
      },
    })));
  } }) as Sql;
  const work = track(createOpeningCourseExamRepository(wrapped).begin(fixture.scope, f.courseId, f.input));
  try {
    await Promise.race([opened, work.then(() => { throw new Error("precheck barrier bypassed"); })]);
    await fixture.sql`DELETE FROM courses WHERE id=${f.courseId}`;
    release();
    await expect(work).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fixture.sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${fixture.scope.workspaceId}`).toEqual([]);
  } finally { release(); await Promise.allSettled([work]); await closeRace(writer.sql); }
});

it("publishes a course-specific mock with hidden answers and grades free answers through the canonical loop", async () => {
  const f = await seed(), ctx = await f.begin();
  const activityId = await f.repo.complete(fixture.scope, f.courseId, ctx.request.id, proposal(f.chunkId), "fixture-model");
  const overview = await f.repo.read(fixture.scope, f.courseId);
  expect(overview.papers[0]).toMatchObject({ status: "ready", activityId, topics: ["矩阵秩"] });
  expect(JSON.stringify(overview)).not.toContain("两列线性无关");
  const client = await createOpeningTeachingContentRepository(fixture.sql).getClientInit(fixture.scope, activityId);
  expect(JSON.stringify(client)).not.toContain("两列线性无关");
  const prompt = client.blocks.find(block => block.role === "prompt")!;
  const learning = createOpeningLearningRepository(fixture.sql), attempts = createOpeningAttemptService(fixture.sql);
  const session = await learning.createSession(fixture.scope, { courseId: f.courseId, activityId, skillLabel: String(prompt.content?.skillLabel), sourceIds: [f.sourceId] });
  const attempt = await attempts.create(fixture.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId: prompt.blockId, contentVersion: 1 } });
  const original = await attempts.submit(fixture.scope, attempt.id, { clientKey: randomUUID(), answer: "秩为2，因为两列线性无关。",
    outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  const grading = createOpeningAiGradingRepository(fixture.sql);
  expect((await grading.context(fixture.scope, { observationId: original.id })).referenceText).toContain("秩等于2");
  const graded = await grading.apply(fixture.scope, { observationId: original.id }, { outcome: "correct", confidence: 0.93,
    questionMatch: true, feedback: "正确", criteria: [{ label: "矩阵秩", verdict: "correct", feedback: "两列线性无关" }] }, "fixture-model");
  expect(graded.eligibility).toMatchObject({ verifiedCorrect: "unknown", independentAttempt: "yes" });
  expect(graded.skillLabel).toBe("矩阵秩");
  expect((await f.repo.begin(fixture.scope, f.courseId, f.input)).request.activityId).toBe(activityId);
  expect(await f.repo.complete(fixture.scope, f.courseId, ctx.request.id, proposal(f.chunkId), "fixture-model")).toBe(activityId);
  const [count] = await fixture.sql`SELECT count(*) AS n FROM opening_teaching_activities WHERE client_key=${`course-exam:${ctx.request.id}`}`;
  expect(Number(count!.n)).toBe(1);
  const records = await createScopedOpeningSystemQueryReader(fixture.sql, fixture.scope)({ name: "exam_sprint", arguments: {} }, new AbortController().signal);
  expect(records.status).toBe("ok");
  expect(records.data).toEqual(expect.arrayContaining([expect.objectContaining({ attemptCount: 1, completedCount: 1 })]));
  expect(records.evidence.some(item => item.href === `/opening/courses/${f.courseId}/exam`)).toBe(true);
  expect(JSON.stringify(records)).not.toContain("两列线性无关");
});

it("keeps different courses independent and prevents cross-owner and cross-course source selection", async () => {
  const a = await seed(), b = await seed();
  await a.begin(); await b.begin();
  expect((await a.repo.read(fixture.scope, a.courseId)).papers).toHaveLength(1);
  expect((await b.repo.read(fixture.scope, b.courseId)).papers).toHaveLength(1);
  await expect(a.repo.read(fixture.otherScope, a.courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(a.repo.begin(fixture.scope, a.courseId, { ...a.input, clientKey: randomUUID(), sourceId: b.sourceId })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(a.repo.begin(fixture.scope, a.courseId, { ...a.input, questionCount: 5 })).rejects.toMatchObject({ code: "CONFLICT" });
});

it.each(["version", "membership", "privacy"])("rechecks %s before model send and publication", async cause => {
  const f = await seed(), ctx = await f.begin();
  if (cause === "version") await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
  if (cause === "membership") await fixture.sql`DELETE FROM course_asset_memberships WHERE course_id=${f.courseId} AND asset_id=${f.sourceId}`;
  if (cause === "privacy") await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId);
  await expect(f.repo.assertCurrent(fixture.scope, f.courseId, ctx.request.id)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.repo.complete(fixture.scope, f.courseId, ctx.request.id, proposal(f.chunkId), null)).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await f.repo.read(fixture.scope, f.courseId)).papers[0]).toMatchObject({ available: false, activityId: null, topics: [] });
});

it("rejects invented citations and inconsistent question counts without publishing partial activities", async () => {
  const f = await seed(), ctx = await f.begin();
  await expect(f.repo.complete(fixture.scope, f.courseId, ctx.request.id, proposal(randomUUID()), null)).rejects.toMatchObject({ code: "VALIDATION" });
  const changed = proposal(f.chunkId); changed.questions.push(changed.questions[0]!);
  await expect(f.repo.complete(fixture.scope, f.courseId, ctx.request.id, changed, null)).rejects.toMatchObject({ code: "VALIDATION" });
  expect((await f.repo.read(fixture.scope, f.courseId)).papers[0]).toMatchObject({ status: "pending", activityId: null });
});

it("ends an interrupted request on refresh and refuses both replay sends and late publication", async () => {
  const f = await seed(), ctx = await f.begin();
  const earlier = new Date(Date.now() - 11 * 60_000).toISOString();
  await fixture.sql`UPDATE opening_exam_sprints SET pack_snapshot=jsonb_set(pack_snapshot,'{requests,0,createdAt}',to_jsonb(${earlier}::text))
    WHERE course_id=${f.courseId}`;
  // A missing web process cannot publish an arbitrarily late response, even before a refresh.
  await expect(f.repo.assertCurrent(fixture.scope, f.courseId, ctx.request.id)).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.repo.complete(fixture.scope, f.courseId, ctx.request.id, proposal(f.chunkId), null)).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await f.repo.read(fixture.scope, f.courseId)).papers[0]!.status).toBe("unknown");
  expect((await f.begin()).request.status).toBe("unknown");
  const [count] = await fixture.sql`SELECT count(*) AS n FROM opening_teaching_activities WHERE client_key=${`course-exam:${ctx.request.id}`}`;
  expect(Number(count!.n)).toBe(0);
});

it("requires an explicit page range for an oversized paper and does not silently omit later pages", async () => {
  const f = await seed();
  await fixture.sql`UPDATE opening_source_chunks SET text=${"A".repeat(49000)} WHERE id=${f.chunkId}`;
  await expect(f.begin()).rejects.toMatchObject({ code: "VALIDATION" });
  await fixture.sql`UPDATE opening_source_chunks SET text='page one' WHERE id=${f.chunkId}`;
  const second = randomUUID();
  await fixture.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${second},${f.sourceId},1,2,'page two ending')`;
  const range = await f.repo.begin(fixture.scope, f.courseId, { ...f.input, firstPage: 2, lastPage: 2 });
  expect(range.chunks.map(chunk => chunk.text)).toEqual(["page two ending"]);
});

it("keeps the legacy Math I repository isolated when generic course sprints coexist", async () => {
  const f = await seed(); await f.begin();
  const pack: ExamPack = { id: "legacy", version: "1", title: "Legacy", description: "", topics: [{ id: "t", title: "Topic" }],
    lessons: [{ id: "l", topicId: "t", title: "Lesson", summary: "", steps: [], workedExample: "", pitfalls: [] }],
    questions: [{ id: "q", topicId: "t", skillId: "s", familyId: "f", lessonId: "l", pool: "training", difficulty: "foundation",
      prompt: "1+1", options: [{ id: "a", label: "2" }, { id: "b", label: "3" }], answer: "a", explanation: "sum", hint: "add", estimatedMinutes: 1 }],
    sourceItems: [], weekPlan: [], limitations: [] };
  const legacy = createOpeningExamSprintRepository(fixture.sql, pack);
  expect((await legacy.read(fixture.scope)).pack.id).toBe("legacy");
  await legacy.act(fixture.scope, { action: "start", clientKey: randomUUID(), mode: "diagnostic" });
  expect((await legacy.read(fixture.scope)).attempts).toHaveLength(1);
  expect((await f.repo.read(fixture.scope, f.courseId)).papers).toHaveLength(1);
});
