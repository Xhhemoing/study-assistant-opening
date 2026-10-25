import {
  addMembershipForPrincipal,
  removeMembershipForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
} from "../../../../../features/auth/service";
import { getAuthRuntime } from "../../../../../server/runtime";
import { addMembershipBodySchema, courseIdParamSchema, parseCourseRequest, readCourseJson, removeMembershipBodySchema } from "../../../../../features/courses/server/course-request-schemas";

type Params = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: Params,
): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const id = parseCourseRequest(courseIdParamSchema, (await context.params).id);
    const body = parseCourseRequest(addMembershipBodySchema, await readCourseJson(request));
    const membership = await addMembershipForPrincipal(
      runtime,
      principal,
      id,
      body,
    );
    return Response.json({ membership }, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function DELETE(
  request: Request,
  context: Params,
): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const id = parseCourseRequest(courseIdParamSchema, (await context.params).id);
    const body = parseCourseRequest(removeMembershipBodySchema, await readCourseJson(request));
    await removeMembershipForPrincipal(runtime, principal, id, body);
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

