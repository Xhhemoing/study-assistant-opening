import { examSprintCommandSchema, type ExamSprintCommand, type ExamSprintOverview } from "@aistudy/contracts";
import { overviewSchema } from "./client-schemas";

export type LessonReturnTarget = { id: string; label: string; runId?: string; attemptId?: string };
export type OpenSprintLesson = (lessonId: string | null, returnTarget: LessonReturnTarget, confirmedEndScoredMock?: boolean) => void | Promise<void>;
type LessonCommand = Extract<ExamSprintCommand, { action: "open_lesson" | "switch_to_teaching" }>;
export type OpenLessonIntent = LessonCommand extends infer C ? C extends LessonCommand ? Omit<C, "clientKey"> : never : never;

export function findSprintLesson<T extends { id: string }>(lessons: T[], lessonId: string | null | undefined) {
  const matches = lessons.filter(lesson => lesson.id === lessonId);
  return matches.length === 1 ? matches[0]! : null;
}

export function sprintLessonUnavailableReason(overview: ExamSprintOverview, lessonId: string | null) {
  const lesson = findSprintLesson(overview.pack.lessons, lessonId);
  if (!lesson) return "暂无对应串讲";
  if (overview.activeRun?.mode.startsWith("mock") && (!overview.currentAttempt || overview.currentAttempt.answeredAt !== null
    || overview.currentAttempt.question.lessonId !== lessonId)) return "仅当前未提交题可转教学；其他串讲请交卷后阅读";
  if (!lesson.exposureIdentity || lesson.exposureIdentity.packVersion !== overview.pack.version) return "这个题包的串讲暂时打不开，请稍后再试";
  return null;
}

export function prepareSprintLesson(overview: ExamSprintOverview, lessonId: string | null, confirmedEndScoredMock = false): OpenLessonIntent | null {
  if (sprintLessonUnavailableReason(overview, lessonId)) return null;
  const lesson = findSprintLesson(overview.pack.lessons, lessonId)!;
  if (overview.activeRun?.mode.startsWith("mock")) {
    if (!confirmedEndScoredMock || !overview.currentAttempt) return null;
    return { action: "switch_to_teaching", lessonId: lesson.id, expectedRunId: overview.activeRun.id,
      expectedAttemptId: overview.currentAttempt.id, confirmedEndScoredMock: true, ...lesson.exposureIdentity! };
  }
  return { action: "open_lesson", lessonId: lesson.id, expectedRunId: overview.activeRun?.id ?? null, expectedAttemptId: overview.currentAttempt?.id ?? null, ...lesson.exposureIdentity! };
}

export function isCurrentSprintLessonRequest(overview: ExamSprintOverview, intent: OpenLessonIntent) {
  if (overview.activeRun?.mode.startsWith("mock") || overview.pack.version !== intent.packVersion) return false;
  if (intent.action === "switch_to_teaching") {
    const run = overview.state.runs.find(run => run.id === intent.expectedRunId), conversion = run?.conversion;
    if (overview.activeRun || !conversion || conversion.attemptId !== intent.expectedAttemptId || conversion.lessonId !== intent.lessonId
      || conversion.runId !== run?.id || conversion.packId !== overview.pack.id || conversion.packVersion !== intent.packVersion
      || conversion.convertedAt !== run.completedAt || conversion.contentFingerprint !== intent.contentFingerprint
      || conversion.mappingVersion !== intent.mappingVersion) return false;
  } else if ((overview.activeRun?.id ?? null) !== intent.expectedRunId || (overview.currentAttempt?.id ?? null) !== intent.expectedAttemptId) return false;
  const identity = findSprintLesson(overview.pack.lessons, intent.lessonId)?.exposureIdentity;
  return !!identity && identity.packVersion === intent.packVersion && identity.contentFingerprint === intent.contentFingerprint && identity.mappingVersion === intent.mappingVersion;
}

export function confirmedSprintLesson(overview: ExamSprintOverview, intent: OpenLessonIntent) {
  if (!isCurrentSprintLessonRequest(overview, intent)) return null;
  const content = findSprintLesson(overview.lessonContents.map(content => ({ id: content.lesson.id, content })), intent.lessonId)?.content ?? null;
  if (intent.action === "switch_to_teaching" && content?.exposureId !== overview.state.runs.find(run => run.id === intent.expectedRunId)?.conversion?.exposureId) return null;
  return content;
}

export function confirmedSprintLessonRequest(request: { intent: OpenLessonIntent }, pending: { intent: OpenLessonIntent } | null, response: ExamSprintOverview, current: ExamSprintOverview | null) {
  if (request !== pending || !current) return null;
  const content = confirmedSprintLesson(response, request.intent);
  return content && confirmedSprintLesson(current, request.intent) ? content : null;
}

/** Validate conversion acknowledgement before the existing client releases its replay key. */
export function sprintLessonFetcher(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (init?.method !== "POST" || !response.ok || typeof init.body !== "string") return response;
    const command = examSprintCommandSchema.safeParse(JSON.parse(init.body));
    if (!command.success || command.data.action !== "switch_to_teaching") return response;
    const conversionCommand = command.data;
    const overview = overviewSchema.parse(await response.clone().json());
    const content = confirmedSprintLesson(overview, conversionCommand);
    const conversion = overview.state.runs.find(run => run.id === conversionCommand.expectedRunId)?.conversion;
    if (!content || conversion?.clientKey !== conversionCommand.clientKey) throw new Error("转教学结果尚未确认，请恢复同一操作；未打开串讲。");
    return response;
  };
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
