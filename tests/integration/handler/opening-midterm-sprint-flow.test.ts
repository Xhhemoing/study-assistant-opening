import { randomUUID } from "node:crypto";
import type { ExamSprintCommand } from "@aistudy/contracts";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { POST as createCourse } from "../../../apps/web/src/app/api/courses/route";
import { GET as readCourseSprint } from "../../../apps/web/src/app/api/opening/courses/[id]/exam-sprint/route";
import { GET as exportSprint } from "../../../apps/web/src/app/api/opening/exam-sprint/export/route";
import { POST as bindSprint } from "../../../apps/web/src/app/api/opening/exam-sprint/integration/route";
import { GET as readSprint, POST as actOnSprint } from "../../../apps/web/src/app/api/opening/exam-sprint/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { integrationSchema, overviewSchema } from "../../../apps/web/src/features/opening/exam-sprint/client-schemas";
import { prepareSprintLesson } from "../../../apps/web/src/features/opening/exam-sprint/lesson-navigation";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

const sprintPath = "/api/opening/exam-sprint";
const courseSprintSchema = z.object({ integration: integrationSchema, overview: overviewSchema });

let fixture: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({
    databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await fixture?.close();
});

function request(path: string, body?: unknown) {
  const headers = new Headers({ cookie: fixture.cookie });
  if (body === undefined) return new Request(`http://localhost${path}`, { headers });
  headers.set("content-type", "application/json");
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function responseJson(response: Response, status = 200): Promise<unknown> {
  const body = await response.json();
  expect(response.status, response.ok ? undefined : JSON.stringify(body)).toBe(status);
  return body;
}

async function act(command: ExamSprintCommand) {
  return overviewSchema.parse(await responseJson(await actOnSprint(request(sprintPath, command))));
}

async function courseSprintResponse(courseId: string) {
  const path = `/api/opening/courses/${courseId}/exam-sprint`;
  return responseJson(await readCourseSprint(request(path), { params: Promise.resolve({ id: courseId }) }));
}

it("resumes a bound midterm sprint from diagnostic feedback into practice and replays saved commands once", async () => {
  const created = await createCourse(request("/api/courses", {
    title: "Math I midterm sprint",
    slug: `midterm-sprint-${randomUUID()}`,
  }));
  const { course: { id: courseId } } = z.object({ course: z.object({ id: z.uuid() }) })
    .parse(await responseJson(created, 201));
  expect(await courseSprintResponse(courseId)).toBeNull();

  const initial = overviewSchema.parse(await responseJson(await readSprint(request(sprintPath))));
  const bound = integrationSchema.parse(await responseJson(await bindSprint(request(`${sprintPath}/integration`, {
    courseId,
    expectedPackVersion: initial.pack.version,
    createKnowledgeNodes: true,
    clientKey: randomUUID(),
  }))));
  expect(bound.binding).toMatchObject({ courseId });

  const diagnostic = await act({ action: "start", mode: "diagnostic", clientKey: randomUUID() });
  expect(diagnostic.activeRun).toMatchObject({ mode: "diagnostic" });
  const diagnosticRun = diagnostic.activeRun!;
  expect(diagnostic.currentAttempt).toMatchObject({ runId: diagnosticRun.id, answer: null, feedback: null });
  const wrongAttempt = diagnostic.currentAttempt!;
  const question = EXAM_SPRINT_PACK.questions.find(item => item.id === wrongAttempt.questionId)!;
  const wrongOption = wrongAttempt.question.options.find(option => option.id !== question.answer)!;
  const answeredWrong = await act({
    action: "answer", attemptId: wrongAttempt.id, answer: wrongOption.id, confidence: 2, clientKey: randomUUID(),
  });
  expect(answeredWrong.currentAttempt).toMatchObject({
    id: wrongAttempt.id,
    answer: wrongOption.id,
    correct: false,
    feedback: { answer: question.answer, explanation: question.explanation },
  });
  expect(answeredWrong.skills).toContainEqual(expect.objectContaining({ skillId: question.skillId, status: "weak" }));

  const lesson = prepareSprintLesson(answeredWrong, question.lessonId);
  expect(lesson).toMatchObject({ action: "open_lesson", expectedRunId: diagnosticRun.id, expectedAttemptId: wrongAttempt.id });
  const opened = await act({ ...lesson!, clientKey: randomUUID() });
  expect(opened.lessonContents).toContainEqual(expect.objectContaining({
    lesson: expect.objectContaining({ id: question.lessonId, workedExample: expect.stringMatching(/\S/) }),
  }));

  const resumed = courseSprintSchema.parse(await courseSprintResponse(courseId));
  expect(resumed.integration.binding).toEqual(bound.binding);
  expect(resumed.overview.activeRun).toEqual(diagnosticRun);
  expect(resumed.overview.currentAttempt).toEqual(answeredWrong.currentAttempt);
  expect(resumed.overview.lessonContents).toEqual(opened.lessonContents);
  expect(resumed.integration.links).toEqual([expect.objectContaining({
    examAttemptId: wrongAttempt.id, publication: "published", observationId: expect.any(String),
  })]);

  const finished = await act({ action: "finish", runId: diagnosticRun.id, clientKey: randomUUID() });
  expect(finished.activeRun).toBeNull();
  const practiceStart = { action: "start", mode: "practice", clientKey: randomUUID() } satisfies ExamSprintCommand;
  const practice = await act(practiceStart);
  expect(practice.activeRun).toMatchObject({ mode: "practice" });
  const practiceRun = practice.activeRun!;
  expect(practiceRun.id).not.toBe(diagnosticRun.id);
  const freshQuestionsForWeakSkill = EXAM_SPRINT_PACK.questions
    .filter(item => item.skillId === question.skillId && item.familyId !== question.familyId);
  expect(practiceRun.questionIds.some(id => freshQuestionsForWeakSkill.some(item => item.id === id))).toBe(true);
  expect(practice.currentAttempt).toMatchObject({ runId: practiceRun.id, answer: null, feedback: null });
  const newAttempt = practice.currentAttempt!;
  expect(newAttempt.questionId).not.toBe(wrongAttempt.questionId);
  const practiceQuestion = EXAM_SPRINT_PACK.questions.find(item => item.id === newAttempt.questionId)!;
  const practiceAnswer = {
    action: "answer", attemptId: newAttempt.id, answer: practiceQuestion.answer, confidence: 4, clientKey: randomUUID(),
  } satisfies ExamSprintCommand;
  const answered = await act(practiceAnswer);
  expect(answered.currentAttempt).toMatchObject({ id: newAttempt.id, answer: practiceQuestion.answer, correct: true });

  const saved = courseSprintSchema.parse(await courseSprintResponse(courseId));
  expect(saved.integration.binding).toEqual(bound.binding);
  expect(saved.overview.activeRun).toEqual(practiceRun);
  expect(saved.overview.currentAttempt).toEqual(answered.currentAttempt);
  expect(saved.overview.attempts.map(attempt => [attempt.id, attempt.correct])).toEqual([
    [wrongAttempt.id, false], [newAttempt.id, true],
  ]);
  expect(saved.integration.links).toHaveLength(2);
  expect(saved.integration.links).toContainEqual(expect.objectContaining({
    examAttemptId: newAttempt.id, publication: "published", observationId: expect.any(String),
  }));

  for (const command of [practiceStart, practiceAnswer]) {
    const replayed = await act(command);
    expect(replayed.state.runs).toEqual(saved.overview.state.runs);
    expect(replayed.attempts).toEqual(saved.overview.attempts);
  }
  const afterReplay = courseSprintSchema.parse(await courseSprintResponse(courseId));
  expect(afterReplay.integration.links).toEqual(saved.integration.links);
  expect(afterReplay.overview.state.runs).toEqual(saved.overview.state.runs);
  expect(afterReplay.overview.attempts).toEqual(saved.overview.attempts);
  expect(afterReplay.overview.summary.onlineAnswered).toBe(2);

  const exported = z.object({ commands: z.array(z.object({ clientKey: z.string() })) })
    .parse(await responseJson(await exportSprint(request(`${sprintPath}/export`))));
  for (const command of [practiceStart, practiceAnswer]) {
    expect(exported.commands.filter(receipt => receipt.clientKey === command.clientKey)).toHaveLength(1);
  }
});
