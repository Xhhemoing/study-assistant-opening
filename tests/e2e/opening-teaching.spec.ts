import { randomUUID } from "node:crypto";
import type { APIRequestContext, Locator } from "@playwright/test";
import { learningAttemptSchema, learningObservationSchema, spanHintResponseSchema, spanLessonSnapshotSchema, type LearningAttemptSubmitInput } from "@aistudy/contracts";
import { z } from "zod";
import { expect, test } from "./fixtures";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";
import { createTeachingCourse, makeTeachingRetestDue, readTeachingEvidence, readTeachingRetest } from "./opening-teaching-fixture";

// Real HTTP + PostgreSQL, without business API mocks or a model. The ready-source
// fixture does not certify parsing; the controlled due date does not certify retention.
const lessonEndpoint = "/api/opening/teaching/span/lesson";
const hintEndpoint = "/api/opening/teaching/span/hint";
const submittedObservationSchema = learningObservationSchema.extend({ allowsIndependent: z.boolean() });

async function readLesson(request: APIRequestContext, courseId: string, activityId: string, retestId?: string) {
  const query = new URLSearchParams({ courseId, activityId, ...(retestId ? { retestId } : {}) });
  const response = await request.get(`${lessonEndpoint}?${query}`);
  expect(response.status()).toBe(200);
  return await response.json() as {
    session: ReturnType<typeof spanLessonSnapshotSchema.parse>;
    attempts: ReturnType<typeof learningAttemptSchema.parse>[];
    observations: ReturnType<typeof learningObservationSchema.parse>[];
    assistance: Record<string, string>;
    hintLevels: Record<string, number[]>;
  };
}

async function fillNonmemberAnswer(practice: Locator) {
  // Independent oracle: coordinates 1 and 3 force alpha=beta=2, giving (2,4,2),
  // which contradicts u=(2,3,2). Do not use the production solver as an oracle.
  await practice.getByLabel("我的 α(…)+β(…)=… 中的 v", { exact: true }).fill("1, 1, 0");
  await practice.getByLabel("我的 α(…)+β(…)=… 中的 w", { exact: true }).fill("0, 1, 1");
  await practice.getByLabel("我的 α(…)+β(…)=… 中的 u", { exact: true }).fill("2, 3, 2");
  await practice.getByLabel("α（候选系数）", { exact: true }).fill("2");
  await practice.getByLabel("β（候选系数）", { exact: true }).fill("2");
  await practice.getByLabel("我算出的 αv+βw 各坐标", { exact: true }).fill("2, 4, 2");
  await practice.getByLabel("我的判断", { exact: true }).selectOption("not_in_span");
  await practice.getByLabel("方程组的解结构", { exact: true }).selectOption("none");
  await practice.getByLabel("所有组合构成什么几何集合？", { exact: true }).selectOption("plane");
  await practice.getByLabel("导出系数所用坐标 1", { exact: true }).selectOption("0");
  await practice.getByLabel("导出系数所用坐标 2", { exact: true }).selectOption("2");
  await practice.getByLabel("我的理由（如无解冲突、几何约束）", { exact: true }).fill("第一和第三坐标强制 α=β=2，但第二坐标算出 4，不等于 3。");
}

test.describe("Opening span durable teaching flow", () => {
  test.beforeAll(async () => { await seedOpeningOwner(); });

  test("goal → hints → sealed answer → new authenticated context → summary → delayed task", async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(240_000);
    const origin = baseURL!;
    let context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const pageErrors: string[] = [];
    try {
      await loginOpeningOwner(context.request, origin);
      const course = await createTeachingCourse(context.request, origin);
      const path = `/opening/courses/${course.courseId}/study/span`;
      let page = await context.newPage();
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.goto(path);
      await expect(page.getByText(/目标：建立向量等式，求系数并检查所有坐标/)).toBeVisible();
      const createdResponse = page.waitForResponse(response => response.url().endsWith(lessonEndpoint) && response.request().method() === "POST");
      await page.getByRole("button", { name: "开始本次学习", exact: true }).click();
      const created = await createdResponse;
      expect(created.ok()).toBe(true);
      const lesson = spanLessonSnapshotSchema.parse(await created.json());
      await expect(page).toHaveURL(new RegExp(`lesson=${lesson.activityId}`));
      await page.getByLabel("时间预算（分钟）", { exact: true }).fill("12");
      await page.getByRole("button", { name: "揭示如何建立方程", exact: true }).click();
      await expect(page.getByText("第1坐标：1α + 0β = 3", { exact: true })).toBeVisible();
      const steps = page.getByRole("navigation", { name: "span 教学步骤" });
      await steps.getByRole("button", { name: "3. 独立新题", exact: true }).click();
      const issuedResponse = page.waitForResponse(response => response.url().endsWith("/api/opening/attempts") && response.request().method() === "POST");
      await page.getByRole("button", { name: "开始这道题", exact: true }).click();
      const issued = await issuedResponse;
      expect(issued.status()).toBe(201);
      const attempt = learningAttemptSchema.parse(await issued.json());
      expect(attempt.spanExercise).toMatchObject({ id: "span-independent-3d", target: ["2", "3", "2"] });
      expect(attempt.sessionId).toBe(lesson.sessionId);
      let practice = page.getByRole("region", { name: "span 真实作答", exact: true });
      await fillNonmemberAnswer(practice);

      // Keyboard editing must not navigate; focus mode must preserve the same form.
      await practice.getByLabel("α（候选系数）", { exact: true }).press("ArrowRight");
      await expect(steps.getByRole("button", { name: "3. 独立新题", exact: true })).toHaveAttribute("aria-current", "step");
      const focusTrigger = page.getByRole("button", { name: "专注学习", exact: true });
      await focusTrigger.focus();
      await page.keyboard.press("Enter");
      const focusDialog = page.getByRole("dialog", { name: "线性组合与 span", exact: true });
      await expect(focusDialog).toBeVisible();
      await expect(focusDialog.getByLabel("α（候选系数）", { exact: true })).toHaveValue("2");
      await page.keyboard.press("Escape");
      await expect(focusDialog).toHaveCount(0);
      await expect(focusTrigger).toBeFocused();
      await expect(practice.getByLabel("我的理由（如无解冲突、几何约束）", { exact: true })).toHaveValue(/强制 α=β=2/);

      const hints = [];
      for (const [index, label] of ["方向提示", "定义提醒", "第一步"].entries()) {
        const response = page.waitForResponse(value => value.url().endsWith(hintEndpoint) && value.request().method() === "POST");
        await practice.getByRole("button", { name: `查看${label}`, exact: true }).click();
        const result = await response;
        expect(result.status()).toBe(200);
        const hint = spanHintResponseSchema.parse(await result.json());
        expect(hint).toMatchObject({ attemptId: attempt.id, level: index + 1 });
        hints.push(hint);
        await expect(practice.getByText(`${index + 1}. ${label}`, { exact: true })).toBeVisible();
      }
      await expect(practice.getByRole("button", { name: "查看完整示范", exact: true })).toBeDisabled();
      const deniedSolution = await context.request.post(hintEndpoint, { headers: { origin }, data: { attemptId: attempt.id, level: 4 } });
      expect(deniedSolution.status()).toBe(400);
      expect((await readTeachingEvidence(course, attempt.id)).observations).toHaveLength(0);

      const submittedResponse = page.waitForResponse(response => response.url().endsWith(`/attempts/${attempt.id}/submit`) && response.request().method() === "POST");
      await practice.getByRole("button", { name: "封存首答并精确核对", exact: true }).click();
      const submitted = await submittedResponse;
      expect(submitted.status()).toBe(201);
      const submission = submitted.request().postDataJSON() as LearningAttemptSubmitInput;
      const observation = submittedObservationSchema.parse(await submitted.json());
      expect(observation).toMatchObject({ attemptId: attempt.id, assistance: "hinted", outcome: "correct", allowsIndependent: false, serverEvaluation: { decision: "correct" } });
      await expect(practice.getByRole("heading", { name: "本题精确核对通过", exact: true })).toBeVisible();
      const solutionResponse = page.waitForResponse(response => response.url().endsWith(hintEndpoint) && response.request().method() === "POST");
      await practice.getByRole("button", { name: "查看完整示范", exact: true }).click();
      const solution = await solutionResponse;
      expect(solution.status()).toBe(200);
      const fullHint = spanHintResponseSchema.parse(await solution.json());
      expect(fullHint).toMatchObject({ attemptId: attempt.id, level: 4, exposureReceipt: { origin: "history_solution" } });
      hints.push(fullHint);
      await expect(practice.getByText("4. 完整示范", { exact: true })).toBeVisible();

      // A real pending attempt lets late-submit rejection prove more than replay.
      const pendingResponse = await context.request.post("/api/opening/attempts", { headers: { origin }, data: {
        sessionId: lesson.sessionId, clientKey: `pending:${randomUUID()}`,
        spanExercise: { sourceId: course.sourceId, problemId: "span-geometry-transfer", version: 1 },
      } });
      expect(pendingResponse.status()).toBe(201);
      const pendingAttempt = learningAttemptSchema.parse(await pendingResponse.json());
      const beforePause = await readLesson(context.request, course.courseId, lesson.activityId);
      const pauseResponse = page.waitForResponse(response => response.url().includes(lessonEndpoint) && response.request().method() === "PATCH");
      await page.getByRole("button", { name: "暂停并保存", exact: true }).click();
      expect((await pauseResponse).status()).toBe(200);
      await expect(page.getByRole("heading", { name: "本次学习已暂停", exact: true })).toBeVisible();
      const paused = await readLesson(context.request, course.courseId, lesson.activityId);
      expect(paused.session).toMatchObject({ sessionId: lesson.sessionId, status: "paused", moveId: "self-independent", intent: { timeBudgetMinutes: 12 } });
      const stale = await context.request.patch(`${lessonEndpoint}?activityId=${lesson.activityId}`, { headers: { origin }, data: {
        expectedRevision: beforePause.session.revision, intent: beforePause.session.intent, moveId: "self-faded", status: "active",
      } });
      expect(stale.status()).toBe(409);
      const persisted = await readTeachingEvidence(course, attempt.id);
      expect(persisted.observations).toHaveLength(1);
      expect(persisted.observations[0]).toMatchObject({ id: observation.id, answer: submission.answer, assistance: "hinted" });
      expect(persisted.exposures.map(row => row.id).sort()).toEqual(hints.map(hint => hint.exposureReceipt.id).sort());
      const savedUrl = page.url();

      // Do not copy cookies, sessionStorage, localStorage, or Playwright storageState.
      await context.close();
      context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
      await loginOpeningOwner(context.request, origin);
      page = await context.newPage();
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.goto(savedUrl);
      await expect(page.getByRole("heading", { name: "本次学习已暂停", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "继续原来的步骤", exact: true }).click();
      practice = page.getByRole("region", { name: "span 真实作答", exact: true });
      await expect(page.getByLabel("时间预算（分钟）", { exact: true })).toHaveValue("12");
      await expect(page.getByRole("navigation", { name: "span 教学步骤" }).getByRole("button", { name: "3. 独立新题", exact: true })).toHaveAttribute("aria-current", "step");
      await expect(practice.getByRole("heading", { name: "本题精确核对通过", exact: true })).toBeVisible();
      await practice.getByText("封存的原答案", { exact: true }).click();
      await expect(practice.locator("pre")).toHaveText(submission.answer);
      await expect(practice.getByRole("region", { name: "已收到的提示", exact: true }).locator(":scope > ol > li")).toHaveCount(4);
      const recovered = await readLesson(context.request, course.courseId, lesson.activityId);
      expect(recovered.attempts.find(row => row.id === attempt.id)).toMatchObject({ itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, observationId: observation.id });
      expect(recovered.hintLevels[attempt.id]).toEqual([1, 2, 3, 4]);
      expect((await readTeachingEvidence(course, attempt.id)).exposures).toEqual(persisted.exposures);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath("span-mobile-restored.png"), fullPage: true });

      await page.getByRole("button", { name: "结束并看小结", exact: true }).click();
      await expect(page.getByRole("heading", { name: "本次学习已结束", exact: true })).toBeVisible();
      const summary = page.getByRole("region", { name: "本次 span 学习小结", exact: true });
      await expect(summary.getByRole("heading", { name: "本次学习小结", exact: true })).toBeVisible();
      await expect(summary.locator("dl > div").filter({ hasText: "已封存作答" }).locator("dd")).toHaveText("1");
      await expect(summary.locator("dl > div").filter({ hasText: "独立核对正确" }).locator("dd")).toHaveText("0");
      await expect(summary.locator("dl > div").filter({ hasText: "使用帮助作答" }).locator("dd")).toHaveText("1");
      const replay = await context.request.post(`/api/opening/attempts/${attempt.id}/submit`, { headers: { origin }, data: submission });
      expect(replay.status()).toBe(201);
      expect(submittedObservationSchema.parse(await replay.json())).toMatchObject({ id: observation.id, answer: submission.answer, allowsIndependent: false });
      const changedReplay = await context.request.post(`/api/opening/attempts/${attempt.id}/submit`, { headers: { origin }, data: { ...submission, answer: '{"membership":"in_span"}' } });
      expect(changedReplay.status()).toBe(409);
      const lateInput: LearningAttemptSubmitInput = { clientKey: `late:${randomUUID()}`, answer: '{"membership":"in_span"}', outcome: "unverified", assistance: "independent", verdictSource: "self_report" };
      const late = await context.request.post(`/api/opening/attempts/${pendingAttempt.id}/submit`, { headers: { origin }, data: lateInput });
      expect(late.status()).toBe(409);
      expect((await readTeachingEvidence(course, pendingAttempt.id)).attempt?.submitted_at).toBeNull();

      const delayedResponse = page.waitForResponse(response => response.url().endsWith("/api/opening/teaching/span/delayed") && response.request().method() === "POST");
      await summary.getByRole("button", { name: "安排 3 天后的正式延迟复测", exact: true }).click();
      const delayed = await delayedResponse;
      expect(delayed.ok()).toBe(true);
      const scheduled = await delayed.json() as { candidateId: string; activityId: string; taskId: string; notBeforeAt: string; href: string };
      expect(new URL(scheduled.href, origin).searchParams.get("retest")).toBe(scheduled.activityId);
      expect(Date.parse(scheduled.notBeforeAt)).toBeGreaterThan(Date.parse(observation.recordedAt!) + 71 * 60 * 60 * 1000);
      const scheduleReplay = await context.request.post("/api/opening/teaching/span/delayed", { headers: { origin }, data: delayed.request().postDataJSON() });
      expect(scheduleReplay.ok()).toBe(true);
      expect(await scheduleReplay.json()).toMatchObject({ candidateId: scheduled.candidateId, activityId: scheduled.activityId, taskId: scheduled.taskId, href: scheduled.href });
      await summary.getByRole("link", { name: "打开这项延迟复测", exact: true }).click();
      const retestLessonResponse = page.waitForResponse(response => response.url().endsWith(lessonEndpoint) && response.request().method() === "POST");
      await page.getByRole("button", { name: "开始本次延迟复测", exact: true }).click();
      const retestLessonCreated = await retestLessonResponse;
      expect(retestLessonCreated.ok()).toBe(true);
      const retestLesson = spanLessonSnapshotSchema.parse(await retestLessonCreated.json());
      expect(retestLesson).toMatchObject({ status: "active", retestId: scheduled.activityId });
      const earlyResponse = page.waitForResponse(response => response.url().endsWith("/api/opening/teaching/span/session") && response.request().method() === "POST");
      await page.getByRole("button", { name: "开始这道题", exact: true }).click();
      const early = await earlyResponse;
      expect(early.status()).toBe(400);
      expect(await early.json()).toMatchObject({ error: { businessCode: "RETEST_SUBMIT_TOO_EARLY" } });
      await expect(page.getByRole("region", { name: "span 真实作答", exact: true }).getByRole("alert")).toBeVisible();
      expect(await readTeachingRetest(course, scheduled.candidateId)).toMatchObject({ task_status: "pending" });
      // Bypassing UI preparation cannot issue a question from the new active
      // retest lesson early. The old completed lesson's late submission is 409 above.
      const earlyIssue = await context.request.post("/api/opening/teaching/span/reserved", { headers: { origin }, data: {
        sessionId: retestLesson.sessionId, sourceId: course.sourceId, clientKey: `early-reserved:${randomUUID()}`, mode: "self_study",
      } });
      expect(earlyIssue.status()).toBe(400);
      expect(await earlyIssue.json()).toMatchObject({ error: { businessCode: "RETEST_SUBMIT_TOO_EARLY" } });
      const earlyRetest = await readLesson(context.request, course.courseId, retestLesson.activityId, scheduled.activityId);
      expect(earlyRetest.attempts).toHaveLength(0);
      // Old candidate links remain aliases of the same persisted retest activity.
      expect((await readLesson(context.request, course.courseId, retestLesson.activityId, scheduled.candidateId)).session).toEqual(earlyRetest.session);

      await makeTeachingRetestDue(course, scheduled.candidateId);
      testInfo.annotations.push({ type: "controlled-time", description: "Only the isolated retest time gate is advanced. No real 3-day retention or learning benefit is asserted." });
      const reservedResponse = page.waitForResponse(response => response.url().endsWith("/api/opening/teaching/span/reserved") && response.request().method() === "POST");
      await page.getByRole("button", { name: "恢复原题与保存回执", exact: true }).click();
      const reserved = await reservedResponse;
      expect(reserved.ok()).toBe(true);
      const retestAttempt = learningAttemptSchema.parse(await reserved.json());
      expect(retestAttempt.spanExercise!.id).toMatch(/^span-reserved-/);
      expect(retestAttempt.spanExercise!.familyId).not.toBe(attempt.spanExercise!.familyId);
      expect(retestAttempt.itemVersionId).not.toBe(attempt.itemVersionId);
      practice = page.getByRole("region", { name: "span 真实作答", exact: true });
      // Deliberately wrong new-item answer proves task completion does not imply mastery.
      const problem = retestAttempt.spanExercise!;
      expect(problem.target.some(value => Number(value) !== 0)).toBe(true);
      for (const [label, value] of [["v", problem.vectors[0]], ["w", problem.vectors[1]], ["u", problem.target]] as const) {
        await practice.getByLabel(`我的 α(…)+β(…)=… 中的 ${label}`, { exact: true }).fill(value.join(", "));
      }
      await practice.getByLabel("α（候选系数）", { exact: true }).fill("0");
      await practice.getByLabel("β（候选系数）", { exact: true }).fill("0");
      await practice.getByLabel("我算出的 αv+βw 各坐标", { exact: true }).fill(problem.target.map(() => "0").join(", "));
      await practice.getByLabel("我的判断", { exact: true }).selectOption("in_span");
      const retestedResponse = page.waitForResponse(response => response.url().endsWith(`/attempts/${retestAttempt.id}/submit`) && response.request().method() === "POST");
      await practice.getByRole("button", { name: "封存首答并精确核对", exact: true }).click();
      const retested = await retestedResponse;
      expect(retested.status()).toBe(201);
      const retestObservation = submittedObservationSchema.parse(await retested.json());
      expect(retestObservation).toMatchObject({ attemptId: retestAttempt.id, outcome: "incorrect", allowsIndependent: false, serverEvaluation: { decision: "incorrect" } });
      await expect(practice.getByRole("heading", { name: "本题有需要修正的数学步骤", exact: true })).toBeVisible();
      expect(await readTeachingRetest(course, scheduled.candidateId)).toMatchObject({ status: "completed", task_status: "done" });
      expect((await readTeachingEvidence(course, attempt.id)).observations).toHaveLength(1);
      expect(pageErrors).toEqual([]);
      await testInfo.attach("durable-flow-identities", { body: JSON.stringify({ courseId: course.courseId, activityId: lesson.activityId,
        sessionId: lesson.sessionId, attemptId: attempt.id, itemVersionId: attempt.itemVersionId, observationId: observation.id,
        helpReceiptIds: hints.map(hint => hint.exposureReceipt.id), retestTaskId: scheduled.taskId, retestActivityId: scheduled.activityId, retestAttemptId: retestAttempt.id,
        retestObservationId: retestObservation.id, controlledTime: true, learningEffect: "not_measured", parser: "separate_spec" }, null, 2), contentType: "application/json" });
    } finally { await context.close(); }
  });
});
