import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, type APIRequestContext } from "@playwright/test";
import { learningAttemptSchema, learningObservationSchema, spanHintResponseSchema, spanLessonSnapshotSchema, type LearningAttemptSubmitInput } from "@aistudy/contracts";
import postgres from "postgres";
import { z } from "zod";
import { loginOpeningOwner, seedOpeningOwner } from "../e2e/opening-auth";
import { test } from "../e2e/fixtures";
import { createTeachingCourse, readTeachingEvidence, readTeachingRetest, type TeachingCourse } from "../e2e/opening-teaching-fixture";
import { createOpeningRestartServices } from "./opening-restart-fixture";

const lessonEndpoint = "/api/opening/teaching/span/lesson";
const submittedObservationSchema = learningObservationSchema.extend({ allowsIndependent: z.boolean() });
const intent = { purpose: "self_study", timeBudgetMinutes: 12, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function readLesson(request: APIRequestContext, course: TeachingCourse, activityId: string) {
  const response = await request.get(`${lessonEndpoint}?${new URLSearchParams({ courseId: course.courseId, activityId })}`);
  expect(response.status()).toBe(200);
  return await response.json() as { session: ReturnType<typeof spanLessonSnapshotSchema.parse>; attempts: unknown[]; observations: unknown[]; hintLevels: Record<string, number[]> };
}
async function readScanJob(course: TeachingCourse, observationId: string) {
  const sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, connect_timeout: 5 });
  try {
    const rows = await sql`SELECT id,state FROM opening_jobs WHERE workspace_id=${course.workspaceId}
      AND owner_user_id=${course.ownerUserId} AND key=${`retest-scan:${course.courseId}:${observationId}`}`;
    if (rows.length !== 1) throw new Error("Expected one owned retest scan from the saved answer");
    return { id: String(rows[0]!.id), state: String(rows[0]!.state) };
  } finally { await sql.end({ timeout: 5 }); }
}

async function submitFreshPractice(request: APIRequestContext, origin: string, course: TeachingCourse, submission: LearningAttemptSubmitInput) {
  const created = await request.post(lessonEndpoint, { headers: { origin }, data: {
    courseId: course.courseId, sourceIds: [course.sourceId], intent, clientKey: `restart-next-lesson:${randomUUID()}`,
  } });
  expect(created.status()).toBe(200);
  const lesson = spanLessonSnapshotSchema.parse(await created.json());
  const issued = await request.post("/api/opening/attempts", { headers: { origin }, data: {
    sessionId: lesson.sessionId, clientKey: `restart-next-attempt:${randomUUID()}`,
    spanExercise: { sourceId: course.sourceId, problemId: "span-independent-3d", version: 1 },
  } });
  expect(issued.status()).toBe(201);
  const attempt = learningAttemptSchema.parse(await issued.json());
  const input = { ...submission, clientKey: `restart-next-answer:${randomUUID()}`, assistance: "independent" as const };
  const submitted = await request.post(`/api/opening/attempts/${attempt.id}/submit`, { headers: { origin }, data: input });
  expect(submitted.status()).toBe(201);
  return { lesson, attempt, input, observation: submittedObservationSchema.parse(await submitted.json()) };
}

for (const mode of ["graceful", "crash"] as const) {
test(`same-version ${mode} Web and worker restart restores the persisted learning session`, async ({ browser, baseURL }, testInfo) => {
  const services = createOpeningRestartServices(process.env);
  const origin = baseURL!;
  const storage = new S3Client({ endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION!, forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const Bucket = process.env.S3_BUCKET!, Key = `restart-probes/${randomUUID()}`, probe = Buffer.from(`retained object ${randomUUID()}`);
  let probeWritten = false;
  let context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const pageErrors: string[] = [];
  try {
    // Refuse a live unowned server/worker before the one permitted initial reset.
    await services.assertIdle();
    await seedOpeningOwner();
    const first = await services.start();
    await loginOpeningOwner(context.request, origin);
    const course = await createTeachingCourse(context.request, origin);
    await storage.send(new PutObjectCommand({ Bucket, Key, Body: probe })); probeWritten = true;
    const initialObject = await storage.send(new GetObjectCommand({ Bucket, Key }));
    expect(digest(await initialObject.Body!.transformToByteArray())).toBe(digest(probe));

    const created = await context.request.post(lessonEndpoint, { headers: { origin }, data: {
      courseId: course.courseId, sourceIds: [course.sourceId], intent, clientKey: `restart-lesson:${randomUUID()}`,
    } });
    expect(created.status()).toBe(200);
    let lesson = spanLessonSnapshotSchema.parse(await created.json());
    const moved = await context.request.patch(`${lessonEndpoint}?activityId=${lesson.activityId}`, { headers: { origin }, data: {
      expectedRevision: lesson.revision, intent, moveId: "self-independent", status: "active",
    } });
    expect(moved.status()).toBe(200); lesson = spanLessonSnapshotSchema.parse(await moved.json());
    const issued = await context.request.post("/api/opening/attempts", { headers: { origin }, data: {
      sessionId: lesson.sessionId, clientKey: `restart-attempt:${randomUUID()}`,
      spanExercise: { sourceId: course.sourceId, problemId: "span-independent-3d", version: 1 },
    } });
    expect(issued.status()).toBe(201);
    const attempt = learningAttemptSchema.parse(await issued.json());
    const hint = await context.request.post("/api/opening/teaching/span/hint", { headers: { origin }, data: { attemptId: attempt.id, level: 1 } });
    expect(hint.status()).toBe(200); const firstHint = spanHintResponseSchema.parse(await hint.json());
    // Independent fixed oracle: coordinates 1 and 3 force 2,2; coordinate 2
    // then gives 4 rather than 3. No production solver generates this answer.
    const submission: LearningAttemptSubmitInput = { clientKey: `restart-answer:${randomUUID()}`, outcome: "unverified", assistance: "hinted", verdictSource: "self_report",
      answer: JSON.stringify({ equation: { vectors: [["1", "1", "0"], ["0", "1", "1"]], target: ["2", "3", "2"] },
        coefficients: ["2", "2"], coordinateChecks: ["2", "4", "2"], coefficientDerivationCoordinates: [0, 2], membership: "not_in_span",
        representations: { system: "none", geometry: "plane" }, explanation: "第一与第三坐标强制两个系数均为2，但第二坐标产生4而非3。" }) };
    const submitted = await context.request.post(`/api/opening/attempts/${attempt.id}/submit`, { headers: { origin }, data: submission });
    expect(submitted.status()).toBe(201);
    const observation = submittedObservationSchema.parse(await submitted.json());
    expect(observation).toMatchObject({ outcome: "correct", assistance: "hinted", allowsIndependent: false });
    const solution = await context.request.post("/api/opening/teaching/span/hint", { headers: { origin }, data: { attemptId: attempt.id, level: 4 } });
    expect(solution.status()).toBe(200); const fullHint = spanHintResponseSchema.parse(await solution.json());
    // This succeeds only if the actual worker handles the durable outbox job.
    await expect.poll(async () => (await readScanJob(course, observation.id)).state, { timeout: 45_000 }).toBe("succeeded");
    const scan = await readScanJob(course, observation.id);
    const scheduleInput = { observationId: observation.id, clientKey: `restart-delayed:${observation.id}` };
    const scheduled = await context.request.post("/api/opening/teaching/span/delayed", { headers: { origin }, data: scheduleInput });
    expect(scheduled.status()).toBe(200);
    const task = await scheduled.json() as { candidateId: string; taskId: string; notBeforeAt: string };
    const taskBefore = await readTeachingRetest(course, task.candidateId);
    expect(taskBefore).toMatchObject({ status: "accepted", task_status: "pending" });
    const paused = await context.request.patch(`${lessonEndpoint}?activityId=${lesson.activityId}`, { headers: { origin }, data: {
      expectedRevision: lesson.revision, intent, moveId: "self-independent", status: "paused",
    } });
    expect(paused.status()).toBe(200); lesson = spanLessonSnapshotSchema.parse(await paused.json());
    const before = await readTeachingEvidence(course, attempt.id);
    expect(before.observations).toHaveLength(1);
    expect(before.exposures.map(row => row.id).sort()).toEqual([firstHint.exposureReceipt.id, fullHint.exposureReceipt.id].sort());

    let pending: Awaited<ReturnType<typeof submitFreshPractice>> | undefined;
    let pendingScan: Awaited<ReturnType<typeof readScanJob>> | undefined;
    let pendingEvidence: Awaited<ReturnType<typeof readTeachingEvidence>> | undefined;
    const workerCrash = mode === "crash" ? await services.crash(["worker"]) : [];
    if (mode === "crash") {
      // Commit an answer while its consumer is dead. The real HTTP route must
      // retain the outbox work; no direct SQL job creation or manual replay.
      pending = await submitFreshPractice(context.request, origin, course, submission);
      pendingScan = await readScanJob(course, pending.observation.id);
      expect(pendingScan.state).toBe("queued");
      pendingEvidence = await readTeachingEvidence(course, pending.attempt.id);
      expect(pendingEvidence.observations).toHaveLength(1);
    }
    await context.close();

    const stopped = mode === "graceful" ? await services.stop() : [...workerCrash, ...await services.crash(["web"])];
    expect(stopped).toHaveLength(2);
    expect(stopped.every(exit => mode === "graceful" ? exit.graceful : exit.signal === "SIGKILL" && !exit.graceful)).toBe(true);
    // No reset, Redis flush, bucket creation, seed, or build occurs between these cycles.
    const second = await services.start();
    expect(second.webPid).not.toBe(first.webPid); expect(second.workerPid).not.toBe(first.workerPid);
    expect(second.buildId).toBe(first.buildId);
    expect(second.workerClientIds.some(id => first.workerClientIds.includes(id))).toBe(false);
    context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await loginOpeningOwner(context.request, origin);
    const recovered = await readLesson(context.request, course, lesson.activityId);
    expect(recovered.session).toEqual(lesson);
    expect(recovered.attempts).toHaveLength(1); expect(recovered.observations).toHaveLength(1);
    expect(recovered.hintLevels[attempt.id]).toEqual([1, 4]);
    expect(await readTeachingRetest(course, task.candidateId)).toEqual(taskBefore);
    const scheduleReplay = await context.request.post("/api/opening/teaching/span/delayed", { headers: { origin }, data: scheduleInput });
    expect(scheduleReplay.status()).toBe(200); expect(await scheduleReplay.json()).toMatchObject(task);
    expect(await readScanJob(course, observation.id)).toEqual(scan);
    const retainedObject = await storage.send(new GetObjectCommand({ Bucket, Key }));
    expect(digest(await retainedObject.Body!.transformToByteArray())).toBe(digest(probe));
    if (pending && pendingScan) {
      await expect.poll(async () => (await readScanJob(course, pending.observation.id)).state, { timeout: 45_000 }).toBe("succeeded");
      expect(await readScanJob(course, pending.observation.id)).toEqual({ id: pendingScan.id, state: "succeeded" });
      expect(await readTeachingEvidence(course, pending.attempt.id)).toEqual(pendingEvidence);
      const replay = await context.request.post(`/api/opening/attempts/${pending.attempt.id}/submit`, { headers: { origin }, data: pending.input });
      expect(replay.status()).toBe(201);
      expect(submittedObservationSchema.parse(await replay.json())).toEqual(pending.observation);
      expect(await readTeachingEvidence(course, pending.attempt.id)).toEqual(pendingEvidence);
      expect(await readScanJob(course, pending.observation.id)).toEqual({ id: pendingScan.id, state: "succeeded" });
    }

    const page = await context.newPage(); page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`/opening/courses/${course.courseId}/study?activity=${lesson.activityId}`);
    await expect(page).toHaveURL(new RegExp(`/study/span\\?lesson=${lesson.activityId}`));
    await expect(page.getByRole("heading", { name: "本次学习已暂停", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "继续原来的步骤", exact: true }).click();
    const practice = page.getByRole("region", { name: "span 真实作答", exact: true });
    await expect(practice.getByRole("heading", { name: "本题精确核对通过", exact: true })).toBeVisible();
    await expect(page.getByLabel("时间预算（分钟）", { exact: true })).toHaveValue("12");
    await practice.getByText("封存的原答案", { exact: true }).click();
    await expect(practice.locator("pre")).toHaveText(submission.answer);
    await expect(practice.getByRole("region", { name: "已收到的提示", exact: true }).locator(":scope > ol > li")).toHaveCount(2);
    expect(await readTeachingEvidence(course, attempt.id)).toEqual(before);
    const replay = await context.request.post(`/api/opening/attempts/${attempt.id}/submit`, { headers: { origin }, data: submission });
    expect(replay.status()).toBe(201);
    expect(submittedObservationSchema.parse(await replay.json())).toMatchObject({ id: observation.id, answer: submission.answer, assistance: "hinted", allowsIndependent: false });
    expect(await readTeachingEvidence(course, attempt.id)).toEqual(before);

    // A new ordinary session produces a new durable job after restart. This
    // repeated practice item tests worker consumption, not independent retention.
    const next = await submitFreshPractice(context.request, origin, course, submission);
    expect(next.lesson.sessionId).not.toBe(lesson.sessionId);
    await expect.poll(async () => (await readScanJob(course, next.observation.id)).state, { timeout: 45_000 }).toBe("succeeded");
    const postRestartScan = await readScanJob(course, next.observation.id);
    expect(postRestartScan.id).not.toBe(scan.id);
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`learning-after-${mode}-restart.png`), fullPage: true });
    await testInfo.attach("restart-persistence-evidence", { contentType: "application/json", body: JSON.stringify({
      kind: `same-version-${mode}-restart`, first, stopped, second, activityId: lesson.activityId, sessionId: lesson.sessionId,
      attemptId: attempt.id, itemVersionId: attempt.itemVersionId, observationId: observation.id,
      receiptIds: [firstHint.exposureReceipt.id, fullHint.exposureReceipt.id], taskId: task.taskId, scan, postRestartScan,
      originalAnswerSha256: digest(Buffer.from(submission.answer)), retainedS3ObjectSha256: digest(probe),
      pendingScan: pendingScan ? { ...pendingScan, recoveredState: "succeeded", observationId: pending!.observation.id } : null,
      parser: "pre-parsed teaching fixture; real PDF parsing is tested separately",
      crashRecovery: mode === "crash" ? "SIGKILL of owned Web/worker; committed answers and queued work recovered" : "not tested",
      limits: "same build; PG/Redis/S3 stay running; no host crash, in-flight model execution or paid-provider retry", learningEffect: "not measured",
    }, null, 2) });
  } finally {
    try { await context.close(); }
    finally {
      try { await services.dispose(); }
      finally {
        await testInfo.attach("owned-service-lifecycle", { contentType: "application/json", body: JSON.stringify(services.diagnostics(), null, 2) });
        try { if (probeWritten) await storage.send(new DeleteObjectCommand({ Bucket, Key })); }
        finally { storage.destroy(); }
      }
    }
  }
});
}
