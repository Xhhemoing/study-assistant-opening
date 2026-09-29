import { z } from "zod";
import {
  getCourseForPrincipal,
  setCourseArchivedForPrincipal,
  jsonError,
  mapDomainError,
  requirePrincipal,
} from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { id } = await context.params;
    const course = await getCourseForPrincipal(runtime, principal, id);
    return Response.json({ course });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function PATCH(request: Request, context: Params): Promise<Response> {
  const runtime = getAuthRuntime();
  try {
    const principal = await requirePrincipal(runtime, request);
    const { archived } = z.object({ archived: z.boolean() }).strict().parse(await request.json());
    const id = z.string().uuid().parse((await context.params).id);
    const course = await setCourseArchivedForPrincipal(runtime, principal, id, archived);
    return Response.json({ course });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
