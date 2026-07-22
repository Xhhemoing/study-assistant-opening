import {
  createCourseForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
} from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";

export async function POST(request: Request): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const body = await request.json();
    const course = await createCourseForPrincipal(runtime, principal, body);
    return Response.json({ course }, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
