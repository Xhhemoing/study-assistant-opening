import "server-only";
import { uuidSchema } from "@aistudy/contracts";
import { createOpeningSpanSessionRepository } from "@aistudy/database";
import { requireOpeningScope } from "../../runtime";

/** Generic activity links dispatch only from an authenticated, persisted protocol. */
export async function loadCourseSpanResume(request: Request, activityId: string) {
  if (!uuidSchema.safeParse(activityId).success) return null;
  const { scope, sql } = await requireOpeningScope(request);
  const lesson = await createOpeningSpanSessionRepository(sql).get(scope, activityId);
  return lesson ? { activityId: lesson.activityId, courseId: lesson.courseId, retestId: lesson.retestId } : null;
}
