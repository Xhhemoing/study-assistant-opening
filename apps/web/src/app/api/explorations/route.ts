import {
  createExplorationForPrincipal,
  listExplorationsForPrincipal,
} from "../../../features/auth/exploration-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../features/auth/service";
import { getAuthRuntime } from "../../../server/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const explorations = await listExplorationsForPrincipal(runtime, principal);
    return Response.json({ explorations });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const exploration = await createExplorationForPrincipal(runtime, principal, await request.json());
    return Response.json({ exploration }, { status: 201 });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
