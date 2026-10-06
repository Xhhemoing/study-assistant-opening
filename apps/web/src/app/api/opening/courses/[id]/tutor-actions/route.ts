import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import {
  listTutorActionsForCourse,
  type TutorActionObservationDeps,
} from "../../../../../../features/opening/learning/tutor-actions";

/** K02a thin tutor-actions: page/skillLabel path; nodeId optional; no mastery %. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
  deps?: TutorActionObservationDeps,
): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const courseId = (await context.params).id;
    const actions = await listTutorActionsForCourse(
      sql,
      scope,
      courseId,
      new URL(request.url).searchParams,
      deps,
    );
    return Response.json({ actions });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
