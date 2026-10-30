import "server-only";
import { uuidSchema } from "@aistudy/contracts";
import { createOpeningSpanSessionRepository, createOpeningLearningAgendaRepository } from "@aistudy/database";
import { requireOpeningScope } from "../../runtime";

/** Generic activity links dispatch only from an authenticated, persisted protocol. */
export async function loadCourseSpanResume(request: Request, activityId: string) {
  if (!uuidSchema.safeParse(activityId).success) return null;
  const { scope, sql } = await requireOpeningScope(request);
  const lesson = await createOpeningSpanSessionRepository(sql).get(scope, activityId);
  if (!lesson) return null;
  const agenda = await createOpeningLearningAgendaRepository(sql).get(scope, lesson.courseId, lesson.activityId);
  return { activityId: lesson.activityId, courseId: lesson.courseId, retestId: lesson.retestId, agenda };
}
