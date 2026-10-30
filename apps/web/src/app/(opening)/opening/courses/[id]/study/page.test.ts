import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), agendaGet: vi.fn(), scope: vi.fn(), context: vi.fn(), redirect: vi.fn((href: string): never => { throw new Error(`REDIRECT:${href}`); }), notFound: vi.fn((): never => { throw new Error("NOT_FOUND"); }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("@aistudy/ai", () => ({ isTeachingCompilerEnabled: () => true }));
vi.mock("@aistudy/database", () => ({ createOpeningSpanSessionRepository: () => ({ get: mocks.get }), createOpeningLearningAgendaRepository: () => ({ get: mocks.agendaGet }) }));
vi.mock("../../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("../../../../../../features/opening/courses/server/course-study-context", () => ({ loadCourseStudyContext: mocks.context }));
vi.mock("../../../../../../features/opening/courses/course-study-workspace", () => ({ CourseStudyWorkspace: "course-study-workspace" }));
import CourseStudyPage from "./page";
const courseId = "11111111-1111-4111-8111-111111111111", activityId = "22222222-2222-4222-8222-222222222222", retestId = "33333333-3333-4333-8333-333333333333";
const scope = { workspaceId: courseId, ownerUserId: activityId }, sql = {};
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue(null); mocks.agendaGet.mockResolvedValue(null); mocks.scope.mockResolvedValue({ scope, sql }); mocks.context.mockResolvedValue({ sourceIds: [], sourceLoadError: false, teachingEnabled: true, matrixInteractiveEnabled: false, timeZone: "UTC" }); });
it("routes an owned span activity from the generic resume link using its persisted identity", async () => {
  mocks.get.mockResolvedValue({ activityId, courseId, retestId: null });
  await expect(CourseStudyPage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ activity: activityId }) })).rejects.toThrow(`REDIRECT:/opening/courses/${courseId}/study/span?lesson=${activityId}`);
  expect(mocks.get).toHaveBeenCalledWith(scope, activityId);
  expect(mocks.agendaGet).toHaveBeenCalledExactlyOnceWith(scope, courseId, activityId);
  expect(mocks.redirect).toHaveBeenCalledWith(`/opening/courses/${courseId}/study/span?lesson=${activityId}`);
  expect(mocks.context).not.toHaveBeenCalled();
});
it("restores the persisted retest from a standalone activity's saved identity", async () => {
  mocks.get.mockResolvedValue({ activityId, courseId, retestId });
  await expect(CourseStudyPage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ activity: activityId }) })).rejects.toThrow("REDIRECT:");
  expect(mocks.redirect).toHaveBeenCalledWith(`/opening/courses/${courseId}/study/span?lesson=${activityId}&retest=${retestId}`);
});
it.each([
  { activity: activityId, task: retestId, retest: undefined },
  { activity: activityId, task: retestId, retest: courseId },
  { activity: activityId, task: undefined, retest: courseId },
])("keeps combined navigation in the workspace for admission checks: %j", async query => {
  mocks.get.mockResolvedValue({ activityId, courseId, retestId });
  const page = await CourseStudyPage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve(query) });
  expect(page.props).toMatchObject({ courseId, activityId, taskId: query.task, retestId: query.retest });
  expect(mocks.context).toHaveBeenCalledOnce();
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.agendaGet).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
});
it("does not attach an owned span activity to a different course", async () => {
  mocks.get.mockResolvedValue({ activityId, courseId: retestId, retestId: null });
  await expect(CourseStudyPage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ activity: activityId }) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.redirect).not.toHaveBeenCalled(); expect(mocks.context).not.toHaveBeenCalled();
});
it("preserves the generic workspace when no owned span protocol matches", async () => {
  const page = await CourseStudyPage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ activity: activityId }) });
  expect(page.props).toMatchObject({ courseId, activityId });
  expect(mocks.agendaGet).not.toHaveBeenCalled();
  expect(mocks.context).toHaveBeenCalledOnce(); expect(mocks.redirect).not.toHaveBeenCalled();
});

it("carries the original conversation reference without changing the teaching activity identity", async () => {
  const conversation = "77777777-7777-4777-8777-777777777777";
  const page = await CourseStudyPage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ activity: activityId, conversation }) });
  expect(page.props).toMatchObject({ courseId, activityId, originalConversationId: conversation });
  expect(page.key).not.toContain(conversation);
  mocks.get.mockResolvedValue({ activityId, courseId, retestId: null });
  await expect(CourseStudyPage({ params: Promise.resolve({ id: courseId }), searchParams: Promise.resolve({ activity: activityId, conversation }) })).rejects.toThrow(`REDIRECT:/opening/courses/${courseId}/study/span?lesson=${activityId}&conversation=${conversation}`);
});
