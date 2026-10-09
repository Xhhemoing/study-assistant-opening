import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import {
  listTutorActionsForCourse,
  type TutorActionObservationDeps,
} from "../../../../../../features/opening/learning/tutor-actions";

/** K02 tutor-actions: thin page/skillLabel path, or nodeId + server SkillEvidence flags; no mastery %. */
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
