import type { ExamSprintCommand, ExamSprintOverview } from "@aistudy/contracts";

export type LessonReturnTarget = { id: string; label: string; runId?: string; attemptId?: string };
export type OpenSprintLesson = (lessonId: string | null, returnTarget: LessonReturnTarget) => void | Promise<void>;
export type OpenLessonIntent = Omit<Extract<ExamSprintCommand, { action: "open_lesson" }>, "clientKey">;

export function findSprintLesson<T extends { id: string }>(lessons: T[], lessonId: string | null | undefined) {
  const matches = lessons.filter(lesson => lesson.id === lessonId);
  return matches.length === 1 ? matches[0]! : null;
}

export function sprintLessonUnavailableReason(overview: ExamSprintOverview, lessonId: string | null) {
  const lesson = findSprintLesson(overview.pack.lessons, lessonId);
  if (!lesson) return "暂无对应串讲";
  if (overview.activeRun?.mode.startsWith("mock")) return "短模拟交卷后才能阅读串讲";
  if (!lesson.exposureIdentity || lesson.exposureIdentity.packVersion !== overview.pack.version) return "该题包串讲暂不可用，请核对内容版本";
  return null;
}

export function prepareSprintLesson(overview: ExamSprintOverview, lessonId: string | null): OpenLessonIntent | null {
  if (sprintLessonUnavailableReason(overview, lessonId)) return null;
  const lesson = findSprintLesson(overview.pack.lessons, lessonId)!;
  return { action: "open_lesson", lessonId: lesson.id, expectedRunId: overview.activeRun?.id ?? null, expectedAttemptId: overview.currentAttempt?.id ?? null, ...lesson.exposureIdentity! };
}

export function isCurrentSprintLessonRequest(overview: ExamSprintOverview, intent: OpenLessonIntent) {
  if (overview.activeRun?.mode.startsWith("mock") || overview.pack.version !== intent.packVersion) return false;
  if ((overview.activeRun?.id ?? null) !== intent.expectedRunId || (overview.currentAttempt?.id ?? null) !== intent.expectedAttemptId) return false;
  const identity = findSprintLesson(overview.pack.lessons, intent.lessonId)?.exposureIdentity;
  return !!identity && identity.packVersion === intent.packVersion && identity.contentFingerprint === intent.contentFingerprint && identity.mappingVersion === intent.mappingVersion;
}

export function confirmedSprintLesson(overview: ExamSprintOverview, intent: OpenLessonIntent) {
  if (!isCurrentSprintLessonRequest(overview, intent)) return null;
  return findSprintLesson(overview.lessonContents.map(content => ({ id: content.lesson.id, content })), intent.lessonId)?.content ?? null;
}

export function confirmedSprintLessonRequest(request: { intent: OpenLessonIntent }, pending: { intent: OpenLessonIntent } | null, response: ExamSprintOverview, current: ExamSprintOverview | null) {
  if (request !== pending || !current) return null;
  const content = confirmedSprintLesson(response, request.intent);
  return content && confirmedSprintLesson(current, request.intent) ? content : null;
}

export const lessonElementId = (lessonId: string) => `lesson-${lessonId}`;
export const attemptElementId = (attemptId: string) => `sprint-attempt-${attemptId}`;

export function focusSprintTarget(document: Pick<Document, "getElementById">, id: string) {
  const target = document.getElementById(id);
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start", behavior: "instant" });
  return true;
}

// Run on every navigation request, including repeated clicks on the same lesson.
export function revealSprintLesson(document: Pick<Document, "getElementById">, lessonId: string) {
  const target = document.getElementById(lessonElementId(lessonId)) as HTMLDetailsElement | null;
  const summary = target?.querySelector("summary");
  if (!target || !summary) return false;
  target.open = true;
  summary.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start", behavior: "instant" });
  return true;
}
