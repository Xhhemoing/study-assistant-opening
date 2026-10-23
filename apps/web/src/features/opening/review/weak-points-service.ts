import "server-only";
import type { Scope } from "@aistudy/contracts";
import { buildWeakPoints, type WeakPointsRead } from "./weak-points-model";

type Dependencies = {
  readState: (scope: Scope) => Promise<WeakPointsRead>;
  listCourses: (scope: Scope) => Promise<readonly { id: string; title: string; archivedAt?: Date | string | null }[]>;
};

/** Scope and qualification stay with the existing learner-state and course readers. */
export function createWeakPointsReadService(deps: Dependencies) {
  return { async read(scope: Scope) {
    const [state, courses] = await Promise.all([deps.readState(scope), deps.listCourses(scope)]);
    const visibleCourses = new Map(courses.filter(course => !course.archivedAt).map(course => [course.id, course.title]));
    // Completeness describes the full qualified read, before the current-course filter.
    const summary = buildWeakPoints(state, visibleCourses);
    return { ...summary, points: summary.points.filter(point => visibleCourses.has(point.courseId)) };
  } };
}
