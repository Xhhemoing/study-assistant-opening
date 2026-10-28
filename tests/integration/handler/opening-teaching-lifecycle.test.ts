import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { PATCH as setStatus } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/status/route";
import { GET as getSummary } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/summary/route";
import { GET as getAnswerKey } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/answer-key/route";
import { GET as getClientInit } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/client-init/route";
import { POST as createSession } from "../../../apps/web/src/app/api/opening/learning-sessions/route";
import { POST as createAttempt } from "../../../apps/web/src/app/api/opening/attempts/route";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { POST as reviseObservation } from "../../../apps/web/src/app/api/opening/observations/revisions/route";
import { buildSelfCompareRevision } from "../../../apps/web/src/features/opening/learning/reference-check";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { backupRows } from "../opening-backup-records-fixture";
import { openRaceSession, closeRace, track, waitUntilBlocked } from "../opening-race-helpers";
import { createOpeningAttemptService } from "../../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningTeachingCommandService } from "../../../apps/web/src/features/opening/teaching/command-service";

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function req(method: string, body?: unknown, cookie?: string) {
  return new Request("https://localhost/api/opening/teaching-activities", { method, headers: { cookie: cookie ?? f.cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => {
  await f.sql`TRUNCATE opening_teaching_activity_specs, opening_teaching_units, opening_teaching_activities,
    opening_learning_observations, opening_learning_attempts, opening_learning_sessions, opening_sources,
    library_blocks, library_revisions, library_documents RESTART IDENTITY CASCADE`;
});
afterAll(async () => {
  setAuthRuntimeForTests(null); await runtime?.close();
  if (f) {
    await f.sql`TRUNCATE opening_learning_sessions,opening_teaching_activity_specs,opening_teaching_units,opening_teaching_activities,library_blocks,library_revisions,library_documents CASCADE`;
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.close();
  }
});

async function seedActivity() {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${f.scope.workspaceId},'学习小结',${courseId})`;
  const sourceId = await backupRows(f.sql, f.scope).source();
  const chunkId = await backupRows(f.sql, f.scope).chunk(sourceId);
  const taskId = randomUUID();
  const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
    clientKey: `task:${taskId}`, intentKind: "goal", intentSummary: "核对矩阵练习", courseId, sourceIds: [sourceId], createIntent: { taskId },
  });
  return { activity, courseId, sourceId, chunkId, taskId };
}

describe("starting again after a completed activity (R1)", () => {
  it("continues to a new activity on the same key, idempotently, and keeps plain replays unchanged", async () => {
    const repo = createOpeningTeachingActivitiesRepository(f.sql);
    const input = { clientKey: "today-topic:2026-10-15", intentKind: "topic" as const, intentSummary: "今日主题学习", createIntent: { intentKind: "topic", localDate: "2026-10-15" } };
    const first = await repo.create(f.scope, { ...input, continueAfterCompleted: true });
    expect((await repo.create(f.scope, { ...input, continueAfterCompleted: true })).id).toBe(first.id);
    await repo.setStatus(f.scope, first.id, { status: "completed" });
    const second = await repo.create(f.scope, { ...input, continueAfterCompleted: true });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.clientKey).toBe(`today-topic:2026-10-15:next:${first.id}`);
    // Repeating the same request lands on the same next activity.
    expect((await repo.create(f.scope, { ...input, continueAfterCompleted: true })).id).toBe(second.id);
    await repo.setStatus(f.scope, second.id, { status: "completed" });
    const third = await repo.create(f.scope, { ...input, continueAfterCompleted: true });
    expect(third.clientKey).toBe(`today-topic:2026-10-15:next:${second.id}`);
    // Without the flag a replay still returns the original (completed) activity.
    expect((await repo.create(f.scope, input)).id).toBe(first.id);
  });
});

describe("teaching activity completion handlers", () => {
  it("requires authentication and ownership, and rejects reopening a completed activity", async () => {
    const { activity } = await seedActivity();
    expect((await getSummary(req("GET", undefined, ""), context(activity.id))).status).toBe(401);
    const other = await createOpeningTeachingActivitiesRepository(f.sql).create(f.otherScope, { clientKey: `other-${randomUUID()}`, intentKind: "topic", intentSummary: "他人的活动", createIntent: {} });
    expect((await getSummary(req("GET"), context(other.id))).status).toBe(404);
    const complete = await setStatus(req("PATCH", { status: "completed", expectedUpdatedAt: activity.updatedAt }), context(activity.id));
    expect(complete.status).toBe(200);
    expect((await complete.json()).status).toBe("completed");
    expect((await setStatus(req("PATCH", { status: "active" }), context(activity.id))).status).toBe(409);
    expect((await setStatus(req("PATCH", { status: "paused" }), context(activity.id))).status).toBe(409);
  });
  it("summarizes all activity attempts and checkpoint coverage without completing a task", async () => {
    const { activity, courseId, sourceId, taskId } = await seedActivity();
    const content = createOpeningTeachingContentRepository(f.sql);
    const first = randomUUID(), skipped = randomUUID(), current = randomUUID();
    const unit = await content.createUnit(f.scope, { title: "小结讲义", blocks: [first, skipped, current].map((id) => ({ id, type: "text", content: { text: "讲解" } })) });
    await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: activity.contentVersion, revisionNumber: unit.currentRevisionNumber, expectedRevisionNumber: unit.currentRevisionNumber, blockOrder: [first, skipped, current].map((blockId, position) => ({ blockId, position, blockType: "text", role: "teach" as const })) });
    await f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json({ currentBlockId: current, skippedBlockIds: [skipped] })} WHERE id=${activity.id}`;
    const learning = createOpeningLearningRepository(f.sql);
    const attempts = createOpeningLearningAttemptRepository(f.sql);
    const session = await learning.createSession(f.scope, { courseId, sourceIds: [sourceId], skillLabel: "矩阵" });
    await f.sql`UPDATE opening_learning_sessions SET activity_id=${activity.id} WHERE id=${session.id}`;
    for (const outcome of ["correct", "incorrect", "unverified"] as const) {
      const attempt = await attempts.create(f.scope, { sessionId: session.id, clientKey: `attempt-${randomUUID()}` });
      await learning.insertObservation(f.scope, { sessionId: session.id, attemptId: attempt.id, courseId, skillLabel: "矩阵", sourceIds: [sourceId], answer: "原答案", outcome, assistance: "independent", clientKey: `answer-${randomUUID()}` });
    }
    const response = await getSummary(req("GET"), context(activity.id));
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary).toMatchObject({ coveredBlockIds: [first, current], skippedBlockIds: [skipped], attempts: { total: 3, correct: 1, incorrect: 1, unverified: 1 }, taskId, openQuestions: ["矩阵"] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const [task] = await f.sql`SELECT id FROM opening_tasks WHERE id=${taskId}`;
    expect(task).toBeUndefined();
  });
});

describe("teaching inline attempts and answer gates", () => {
  async function seedQuestion() {
    const seeded = await seedActivity();
    const question = randomUUID(), answer = randomUUID(), otherQuestion = randomUUID(), otherAnswer = randomUUID();
    const content = createOpeningTeachingContentRepository(f.sql);
    const unit = await content.createUnit(f.scope, { title: "内联作答讲义", blocks: [
      { id: question, type: "prompt", content: { text: "求单位矩阵的秩" } },
      { id: answer, type: "answer_key", content: { text: "受保护的参考答案：秩为2", citedChunkIds: [seeded.chunkId] } },
      { id: otherQuestion, type: "prompt", content: { text: "求零矩阵的秩" } },
      { id: otherAnswer, type: "answer_key", content: { text: "另一题参考答案：秩为0" } },
    ] });
    await content.publishActivitySpec(f.scope, { activityId: seeded.activity.id, teachingUnitId: unit.id, expectedVersion: 0,
      revisionNumber: unit.currentRevisionNumber, expectedRevisionNumber: unit.currentRevisionNumber,
      blockOrder: [question, answer, otherQuestion, otherAnswer].map((blockId, position) => ({ blockId, position, blockType: position % 2 ? "answer_key" : "prompt", role: position % 2 ? "answer_key" as const : "prompt" as const })),
      sourceRefs: [{ sourceId: seeded.sourceId, chunkId: seeded.chunkId, version: 1 }],
    });
    return { ...seeded, question, otherQuestion, unit };
  }
  const answerRequest = (activityId: string, blockId: string, attemptId: string) => new Request(`https://localhost/api/opening/teaching-activities/${activityId}/answer-key?${new URLSearchParams({ blockId, attemptId })}`, { headers: { cookie: f.cookie } });

  it("keeps answers hidden until this question's submitted attempt and records activity-scoped comparison", async () => {
    const { activity, sourceId, courseId, question, otherQuestion } = await seedQuestion();
    const init = await getClientInit(req("GET"), context(activity.id));
    expect(init.status).toBe(200);
    expect(await init.text()).not.toContain("受保护的参考答案");
    const sessionResponse = await createSession(req("POST", { activityId: activity.id, courseId, skillLabel: "矩阵秩", sourceIds: [sourceId] }));
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();
    const attemptResponse = await createAttempt(req("POST", { sessionId: session.id, clientKey: `attempt-${randomUUID()}`, teachingBlock: { blockId: question, contentVersion: 1 }, problem: { sourceId, stemSnapshot: "求单位矩阵的秩", artifactKind: "reference_item" } }));
    expect(attemptResponse.status).toBe(201);
    const attempt = await attemptResponse.json();
    expect((await getAnswerKey(answerRequest(activity.id, question, attempt.id), context(activity.id))).status).toBe(404);
    const response = await submitAttempt(req("POST", { clientKey: `answer-${randomUUID()}`, answer: "我的原答案：1", outcome: "unverified", assistance: "independent", verdictSource: "self_report" }), context(attempt.id));
    expect(response.status).toBe(201);
    const observation = await response.json();
    expect(observation.outcome).toBe("unverified");
    const [row] = await f.sql`SELECT activity_id FROM opening_learning_observations WHERE id=${observation.id}`;
    expect(row!.activity_id).toBe(activity.id);
    const reference = await getAnswerKey(answerRequest(activity.id, question, attempt.id), context(activity.id));
    expect(reference.status).toBe(200);
    expect(await reference.json()).toEqual({ answer: "受保护的参考答案：秩为2", referenceSourceId: sourceId });
    expect((await getAnswerKey(answerRequest(activity.id, otherQuestion, attempt.id), context(activity.id))).status).toBe(400);
    const revision = buildSelfCompareRevision({ observation, choice: "mismatch", referenceSourceId: sourceId, clientKey: `compare-${randomUUID()}` });
    const compared = await reviseObservation(req("POST", revision));
    expect(compared.status).toBe(201);
    const checked = await compared.json();
    expect(checked.observation).toMatchObject({ outcome: "incorrect", verdictSource: "self_report", answer: "我的原答案：1",
      eligibility: { verifiedCorrect: "unknown" } });
    const [job] = await f.sql`SELECT id FROM opening_jobs WHERE kind='retest' AND payload->>'observationId'=${observation.id}`;
    expect(job).toBeTruthy();
    const summary = await (await getSummary(req("GET"), context(activity.id))).json();
    expect(summary.attempts).toEqual({ total: 1, correct: 0, incorrect: 1, unverified: 0 });
    await f.sql`UPDATE opening_teaching_activities SET content_version=content_version+1 WHERE id=${activity.id}`;
    expect((await getAnswerKey(answerRequest(activity.id, question, attempt.id), context(activity.id))).status).toBe(409);
  });

  it("rejects a foreign activity, mismatched course, arbitrary block, or stale content version", async () => {
    const { activity, sourceId, courseId, question } = await seedQuestion();
    const foreign = await createOpeningTeachingActivitiesRepository(f.sql).create(f.otherScope, { clientKey: `other-${randomUUID()}`, intentKind: "topic", intentSummary: "他人的活动", createIntent: {} });
    expect((await createSession(req("POST", { activityId: foreign.id, courseId, skillLabel: "矩阵秩", sourceIds: [sourceId] }))).status).toBe(404);
    const anotherCourse = randomUUID();
    await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${anotherCourse},${f.scope.workspaceId},'另一门课程',${anotherCourse})`;
    expect((await createSession(req("POST", { activityId: activity.id, courseId: anotherCourse, skillLabel: "矩阵秩", sourceIds: [sourceId] }))).status).toBe(400);
    const session = await (await createSession(req("POST", { activityId: activity.id, courseId, skillLabel: "矩阵秩", sourceIds: [sourceId] }))).json();
    const start = (blockId: string, contentVersion: number) => createAttempt(req("POST", { sessionId: session.id, clientKey: `attempt-${randomUUID()}`, teachingBlock: { blockId, contentVersion } }));
    expect((await start(randomUUID(), 1)).status).toBe(400);
    expect((await start(question, 99)).status).toBe(409);
    await setStatus(req("PATCH", { status: "completed" }), context(activity.id));
    expect((await start(question, 1)).status).toBe(409);
  });

  async function openAttempt(seeded: Awaited<ReturnType<typeof seedQuestion>>) {
    const session = await createOpeningLearningRepository(f.sql).createSession(f.scope, { activityId: seeded.activity.id, courseId: seeded.courseId, skillLabel: "矩阵秩", sourceIds: [seeded.sourceId] });
    const attempt = await createOpeningLearningAttemptRepository(f.sql).create(f.scope, { sessionId: session.id, clientKey: `attempt-${randomUUID()}`, teachingBlock: { blockId: seeded.question, contentVersion: 1 } });
    const submission = { clientKey: `answer-${randomUUID()}`, answer: "原答案", outcome: "unverified" as const, assistance: "independent" as const };
    return { session, attempt, submission };
  }

  it("does not attribute an uncited answer to another block's material reference", async () => {
    const seeded = await seedQuestion();
    const session = await createOpeningLearningRepository(f.sql).createSession(f.scope, {
      activityId: seeded.activity.id, courseId: seeded.courseId, skillLabel: "矩阵秩", sourceIds: [seeded.sourceId],
    });
    const attempt = await createOpeningLearningAttemptRepository(f.sql).create(f.scope, {
      sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId: seeded.otherQuestion, contentVersion: 1 },
    });
    await createOpeningAttemptService(f.sql).submit(f.scope, attempt.id, {
      clientKey: randomUUID(), answer: "0", outcome: "unverified", assistance: "independent",
    });
    const answer = await getAnswerKey(answerRequest(seeded.activity.id, seeded.otherQuestion, attempt.id), context(seeded.activity.id));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ answer: "另一题参考答案：秩为0", referenceSourceId: null });
  });

  it("rejects changed material versions instead of attributing an old teaching answer to the new material", async () => {
    const seeded = await seedQuestion();
    const { session, attempt, submission } = await openAttempt(seeded);
    await createOpeningAttemptService(f.sql).submit(f.scope, attempt.id, submission);
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${seeded.sourceId}`;
    await backupRows(f.sql, f.scope).chunk(seeded.sourceId, 2);
    const read = await getAnswerKey(answerRequest(seeded.activity.id, seeded.question, attempt.id), context(seeded.activity.id));
    expect(read.status).toBe(409);
    const next = await createAttempt(req("POST", { sessionId: session.id, clientKey: `attempt-${randomUUID()}`, teachingBlock: { blockId: seeded.question, contentVersion: 1 } }));
    expect(next.status).toBe(409);
  });

  it("holds one published version while reading an answer during concurrent publication", async () => {
    const seeded = await seedQuestion();
    const { attempt, submission } = await openAttempt(seeded);
    await createOpeningAttemptService(f.sql).submit(f.scope, attempt.id, submission);
    const content = createOpeningTeachingContentRepository(f.sql);
    const spec = (await content.getActivitySpec(f.scope, seeded.activity.id))!;
    const revision = await content.readRevision(f.scope, spec.documentId, spec.revisionNumber);
    const rewritten = await content.writeUnitBlocks(f.scope, seeded.unit.id, revision.blocks.map((block) => ({ id: block.id, type: block.type, content: block.type === "answer_key" ? { text: "新版参考答案" } : block.content })));
    const holder = await openRaceSession().ready, reader = await openRaceSession().ready, publisher = await openRaceSession().ready;
    let release: () => void = () => undefined;
    let opened: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { opened = resolve; });
    const holding = track(holder.sql.begin(async (tx) => { await tx`SELECT id FROM opening_sources WHERE id=${seeded.sourceId} FOR UPDATE`; opened(); await gate; }));
    let reading: ReturnType<typeof content.getSubmittedAnswerKey> | undefined;
    let publishing: ReturnType<typeof content.publishActivitySpec> | undefined;
    try {
      await locked;
      reading = track(createOpeningTeachingContentRepository(reader.sql).getSubmittedAnswerKey(f.scope, seeded.activity.id, seeded.question, attempt.id));
      await waitUntilBlocked(f.sql, reader.pid, holder.pid, "answer source admission", /opening_sources/);
      publishing = track(createOpeningTeachingContentRepository(publisher.sql).publishActivitySpec(f.scope, { activityId: seeded.activity.id, teachingUnitId: seeded.unit.id, expectedVersion: 1, revisionNumber: rewritten.revisionNumber, expectedRevisionNumber: seeded.unit.currentRevisionNumber, blockOrder: spec.blockOrder, sourceRefs: spec.sourceRefs }));
      // Answer delivery records a help exposure. Both it and publication lock
      // workspace history before the activity, so publication waits there while
      // the reader holds the original activity version and awaits its source.
      await waitUntilBlocked(f.sql, publisher.pid, reader.pid, "publish waits for answer version",
        /^\s*SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id\s*=\s*\$1\s+AND owner_user_id\s*=\s*\$2 FOR UPDATE\s*$/);
      release();
      expect((await reading).answer).toBe("受保护的参考答案：秩为2");
      expect((await publishing).version).toBe(2);
      expect((await getAnswerKey(answerRequest(seeded.activity.id, seeded.question, attempt.id), context(seeded.activity.id))).status).toBe(409);
    } finally {
      release(); await Promise.allSettled([holding, reading, publishing].filter(Boolean));
      await Promise.all([closeRace(holder.sql), closeRace(reader.sql), closeRace(publisher.sql)]);
    }
  }, 20_000);

  it("keeps completed activities closed to late answers, compilation, commands and checkpoint writes", async () => {
    const seeded = await seedQuestion();
    const { attempt, submission } = await openAttempt(seeded);
    await createOpeningTeachingActivitiesRepository(f.sql).setStatus(f.scope, seeded.activity.id, { status: "completed" });
    await expect(createOpeningAttemptService(f.sql).submit(f.scope, attempt.id, submission)).rejects.toMatchObject({ code: "CONFLICT" });
    const activities = createOpeningTeachingActivitiesRepository(f.sql);
    await expect(activities.requestCompile(f.scope, seeded.activity.id, `compile-${randomUUID()}`)).rejects.toMatchObject({ code: "CONFLICT" });
    const content = createOpeningTeachingContentRepository(f.sql);
    await expect(content.saveCheckpoint(f.scope, seeded.activity.id, { expectedVersion: 1, currentBlockId: seeded.question })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(content.saveDraftAnchors(f.scope, seeded.activity.id, { expectedVersion: 1, drafts: [] })).rejects.toMatchObject({ code: "CONFLICT" });
    const spec = (await content.getActivitySpec(f.scope, seeded.activity.id))!;
    await expect(content.publishActivitySpec(f.scope, { activityId: seeded.activity.id, teachingUnitId: seeded.unit.id, expectedVersion: 1, revisionNumber: spec.revisionNumber, blockOrder: spec.blockOrder, sourceRefs: spec.sourceRefs })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createOpeningTeachingCommandService(f.sql).execute(f.scope, seeded.activity.id, { kind: "skip", blockId: seeded.question, expectedVersion: 1, expectedPathVersion: 1, clientKey: `skip-${randomUUID()}` })).rejects.toMatchObject({ code: "CONFLICT" });
    const summary = await (await getSummary(req("GET"), context(seeded.activity.id))).json();
    expect(summary.attempts.total).toBe(0);
  });

  it.each(["end-first", "submit-first"] as const)("serializes %s completion and first-answer submission", async (order) => {
    const seeded = await seedQuestion();
    const { attempt, submission } = await openAttempt(seeded);
    const holder = await openRaceSession().ready, writer = await openRaceSession().ready, completer = await openRaceSession().ready;
    let release: () => void = () => undefined, opened: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { opened = resolve; });
    const holding = track(holder.sql.begin(async (tx) => {
      if (order === "end-first") await tx`UPDATE opening_teaching_activities SET status='completed' WHERE id=${seeded.activity.id}`;
      else await tx`LOCK TABLE opening_learning_observations IN SHARE MODE`;
      opened(); await gate;
    }));
    let writing: ReturnType<ReturnType<typeof createOpeningAttemptService>["submit"]> | undefined;
    let completing: ReturnType<ReturnType<typeof createOpeningTeachingActivitiesRepository>["setStatus"]> | undefined;
    try {
      await locked;
      writing = track(createOpeningAttemptService(writer.sql).submit(f.scope, attempt.id, submission));
      await waitUntilBlocked(f.sql, writer.pid, holder.pid, "answer waits at barrier", order === "end-first" ? /opening_teaching_activities/ : /INSERT INTO opening_learning_observations/);
      if (order === "submit-first") {
        completing = track(createOpeningTeachingActivitiesRepository(completer.sql).setStatus(f.scope, seeded.activity.id, { status: "completed" }));
        // Automatic admission holds the workspace row before the activity row;
        // completion must wait on that earlier owner lock until submission commits.
        await waitUntilBlocked(f.sql, completer.pid, writer.pid, "completion waits for saved answer", /SELECT id FROM workspaces WHERE id\s*=\s*\$1 AND owner_user_id\s*=\s*\$2 FOR SHARE/);
      }
      release();
      if (order === "end-first") await expect(writing).rejects.toMatchObject({ code: "CONFLICT" });
      else { await writing; await completing; }
      const summary = await (await getSummary(req("GET"), context(seeded.activity.id))).json();
      expect(summary.attempts.total).toBe(order === "end-first" ? 0 : 1);
      if (order === "submit-first") await expect(createOpeningAttemptService(writer.sql).submit(f.scope, attempt.id, submission)).resolves.toBeTruthy();
    } finally {
      release(); await Promise.allSettled([holding, writing, completing].filter(Boolean));
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(completer.sql)]);
    }
  }, 20_000);
});
